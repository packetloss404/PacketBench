//! Bounded PTY output coalescing. Input writes never pass through this queue.

use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender};
use std::time::{Duration, Instant};

pub(crate) const OUTPUT_QUEUE_CAPACITY: usize = 8;
const MAX_BATCH_BYTES: usize = 32 * 1024;
const MAX_BATCH_DELAY: Duration = Duration::from_millis(8);

/// The reader produces at most one decoded 8 KiB read per entry (at most
/// approximately 24 KiB after invalid UTF-8 replacement). Backpressure bounds
/// queued data even if transcript persistence or the webview slows down.
pub(crate) fn output_channel() -> (SyncSender<String>, Receiver<String>) {
    sync_channel(OUTPUT_QUEUE_CAPACITY)
}

/// Flush on size, an 8 ms deadline measured from the first byte, or EOF.
/// The callback owns BOTH transcript append and emission: one sequence must
/// describe exactly one emitted batch for replay snapshot deduplication.
pub(crate) fn dispatch_output(receiver: Receiver<String>, mut emit: impl FnMut(String)) {
    dispatch_with_clock(receiver, &mut emit, Instant::now);
}

fn dispatch_with_clock(
    receiver: Receiver<String>,
    mut emit: impl FnMut(String),
    now: impl Fn() -> Instant,
) {
    let mut batch = String::with_capacity(MAX_BATCH_BYTES);
    let mut deadline = None;
    loop {
        let next = match deadline {
            None => receiver.recv().map_err(|_| RecvTimeoutError::Disconnected),
            Some(until) => {
                let current = now();
                // Check explicitly: recv_timeout(0) can keep accepting a hot
                // queue forever, starving the deadline under sustained output.
                if current >= until {
                    Err(RecvTimeoutError::Timeout)
                } else {
                    receiver.recv_timeout(until - current)
                }
            }
        };
        match next {
            Ok(chunk) => {
                let mut remaining = chunk.as_str();
                while !remaining.is_empty() {
                    let mut take = (MAX_BATCH_BYTES - batch.len()).min(remaining.len());
                    while !remaining.is_char_boundary(take) {
                        take -= 1;
                    }
                    if take > 0 {
                        if batch.is_empty() {
                            deadline = Some(now() + MAX_BATCH_DELAY);
                        }
                        batch.push_str(&remaining[..take]);
                        remaining = &remaining[take..];
                    }
                    // If the next code point cannot fit, flush at a UTF-8
                    // boundary; never replace or split valid characters.
                    if batch.len() == MAX_BATCH_BYTES || !remaining.is_empty() {
                        emit(std::mem::replace(
                            &mut batch,
                            String::with_capacity(MAX_BATCH_BYTES),
                        ));
                        deadline = None;
                    }
                }
            }
            Err(reason) => {
                if !batch.is_empty() {
                    emit(std::mem::replace(
                        &mut batch,
                        String::with_capacity(MAX_BATCH_BYTES),
                    ));
                }
                deadline = None;
                if reason == RecvTimeoutError::Disconnected {
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::{channel, TrySendError};
    use std::thread;

    #[test]
    fn coalesces_reads_in_order_and_flushes_final_bytes_on_disconnect() {
        let (sender, receiver) = output_channel();
        for chunk in ["first ", "", "second\r\n", "last prompt> "] {
            sender.send(chunk.to_owned()).unwrap();
        }
        drop(sender);
        let mut emitted = Vec::new();
        dispatch_output(receiver, |data| emitted.push(data));
        assert_eq!(emitted, ["first second\r\nlast prompt> "]);
    }

    #[test]
    fn eight_read_bursts_reduce_to_two_events_per_pane() {
        for pane_count in [1, 4, 8] {
            let mut event_count = 0;
            for pane in 0..pane_count {
                let (sender, receiver) = output_channel();
                let mut expected = String::new();
                for read in 0..8 {
                    let chunk = format!("{pane}:{read} ").repeat(2048);
                    assert_eq!(chunk.len(), 8192);
                    expected.push_str(&chunk);
                    sender.send(chunk).unwrap();
                }
                drop(sender);
                let mut emitted = Vec::new();
                // Freeze time to isolate the byte limit from OS scheduling.
                // The separate open-channel test exercises the real deadline.
                let now = Instant::now();
                dispatch_with_clock(receiver, |data| emitted.push(data), || now);
                assert_eq!(emitted.concat(), expected);
                assert_eq!(
                    emitted.iter().map(String::len).collect::<Vec<_>>(),
                    [32768, 32768]
                );
                event_count += emitted.len();
            }
            // Simulated ready output only: this measures IPC/transcript batch
            // count, not native terminal rendering or frame rate.
            assert_eq!(event_count, pane_count * 2);
        }
    }

    #[test]
    fn flushes_an_idle_prompt_without_waiting_for_more_output_or_eof() {
        let (sender, receiver) = output_channel();
        let (emitted, observed) = channel();
        let dispatcher = thread::spawn(move || {
            dispatch_output(receiver, |data| emitted.send(data).unwrap());
        });
        sender.send("prompt> ".to_owned()).unwrap();
        // Generous scheduling allowance; the sender remains open, proving
        // the deadline (not disconnect or another read) releases the prompt.
        assert_eq!(
            observed.recv_timeout(Duration::from_millis(500)).unwrap(),
            "prompt> "
        );
        drop(sender);
        dispatcher.join().unwrap();
        assert!(observed.recv().is_err());
    }

    #[test]
    fn caps_batches_without_splitting_multibyte_text() {
        let text = "a".repeat(MAX_BATCH_BYTES - 1) + &"🦀日本語".repeat(10_000);
        let (sender, receiver) = output_channel();
        sender.send(text.clone()).unwrap();
        drop(sender);
        let mut emitted = Vec::new();
        dispatch_output(receiver, |data| emitted.push(data));
        assert!(emitted.len() > 2);
        assert!(emitted
            .iter()
            .all(|data| !data.is_empty() && data.len() <= MAX_BATCH_BYTES));
        assert_eq!(emitted.concat(), text);
    }

    #[test]
    fn bounded_queue_applies_backpressure_without_discarding_data() {
        let (sender, receiver) = output_channel();
        for index in 0..OUTPUT_QUEUE_CAPACITY {
            sender.try_send(index.to_string()).unwrap();
        }
        assert!(matches!(
            sender.try_send("overflow".to_owned()),
            Err(TrySendError::Full(_))
        ));
        assert_eq!(receiver.recv().unwrap(), "0");
        sender.try_send("after".to_owned()).unwrap();
        drop(sender);
        let mut emitted = String::new();
        dispatch_output(receiver, |data| emitted.push_str(&data));
        assert_eq!(emitted, "1234567after");
    }

    #[test]
    fn empty_reads_and_empty_eof_emit_nothing() {
        let (sender, receiver) = output_channel();
        sender.send(String::new()).unwrap();
        drop(sender);
        dispatch_output(receiver, |_| panic!("empty output must not get a sequence"));
    }
}
