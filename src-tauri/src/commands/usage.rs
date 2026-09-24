use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::commands::shared::home_dir;
use crate::core::brand::DATA_DIR_NAME;

/// One append-only row of `~/.packetbench/usage.jsonl`.
///
/// Token counts are the vendor's **raw** numbers — for OpenAI-family models
/// `input_tokens` is a superset that already contains `cache_read`. Callers
/// normalise at the cost call site via `pricing::billable_input_tokens`; the
/// stored row keeps the vendor's own figures.
///
/// Rows rewritten by the one-time historical reprice (`core::reprice`) carry
/// two extra keys not modelled here: `repriced_at` (ISO timestamp of the pass)
/// and `cost_usd_before` (the figure computed with the pre-CE2 rates). Serde
/// ignores unknown fields, so those rows still deserialize into this struct —
/// but a rewrite of this record shape must preserve them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageEntry {
    pub ts: String,
    pub source: String,
    pub model: String,
    /// Canonical provider id that served the turn (`anthropic`, `ollama`, …).
    /// Added 2026-08 (LM7) so local-vs-metered spend can be split without
    /// guessing from `source`/`model`. Absent on historical rows — same
    /// backwards-compatibility posture as `repriced_at`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    pub agent_id: Option<String>,
    pub session_id: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub cost_usd: f64,
}

/// Returns `<home>/.packetbench/usage.jsonl` if the home directory is resolvable.
pub fn usage_log_path() -> Option<PathBuf> {
    let home = home_dir()?;
    let mut p = PathBuf::from(home);
    p.push(DATA_DIR_NAME);
    p.push("usage.jsonl");
    Some(p)
}

/// A failed write remains unhealthy for this process, even if its journal could
/// not be created. Persisted journals additionally survive application restart.
#[derive(Default)]
struct LedgerHealth {
    failure: Option<String>,
}
static LEDGER_HEALTH: std::sync::Mutex<LedgerHealth> =
    std::sync::Mutex::new(LedgerHealth { failure: None });

#[derive(Serialize, Deserialize)]
struct PendingUsage {
    /// None means the position could not be established or another entry is
    /// unresolved. This writer never appends such a row; retain for reconciliation.
    prior_len: Option<u64>,
    line: String,
}

fn pending_directory(path: &Path) -> PathBuf {
    path.with_file_name("usage-pending")
}

fn accounting_error(path: &Path, detail: impl std::fmt::Display) -> String {
    format!("Usage accounting is incomplete: {detail}. Further API requests and budget admission are blocked. Preserve and reconcile the retained records in {} against {} before restarting; do not replay or delete pending records without checking whether their bytes were already written.", pending_directory(path).display(), path.display())
}

fn check_health(health: &LedgerHealth, path: &Path) -> Result<(), String> {
    if let Some(error) = &health.failure {
        return Err(error.clone());
    }
    match fs::read_dir(pending_directory(path)) {
        Ok(mut entries) => match entries.next() {
            None => Ok(()),
            Some(Ok(_)) => Err(accounting_error(path, "unreconciled usage journal exists")),
            Some(Err(error)) => Err(accounting_error(path, error)),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(accounting_error(path, error)),
    }
}

pub fn ensure_usage_accounting_healthy() -> Result<(), String> {
    let mut health = LEDGER_HEALTH
        .lock()
        .map_err(|error| format!("Usage accounting lock unavailable: {error}"))?;
    let path = usage_log_path().ok_or("Could not resolve usage ledger directory")?;
    ensure_healthy_at(&mut health, &path)
}

fn ensure_healthy_at(health: &mut LedgerHealth, path: &Path) -> Result<(), String> {
    // This is only the application API ledger, not the potentially gigabytes
    // of CLI transcripts. Validate before spending even when no budget is set.
    read_ledger_at(health, path).map(|_| ()).map_err(|error| {
        health.failure = Some(error.clone());
        error
    })
}

/// Write-ahead evidence is synced before touching the ledger. A unique journal
/// retains every already-completed in-flight request, including completions
/// arriving after another request failed. Recovery is deliberately explicit:
/// append errors can follow a partial OR complete write, so replay is unsafe.
pub fn append_usage_entry(entry: &UsageEntry) -> Result<(), String> {
    let mut health = LEDGER_HEALTH
        .lock()
        .map_err(|error| format!("Usage accounting lock unavailable: {error}"))?;
    let path = match usage_log_path() {
        Some(path) => path,
        None => {
            let error = "Usage accounting failed: could not resolve usage ledger directory; budget admission is blocked".to_string();
            health.failure = Some(error.clone());
            return Err(error);
        }
    };
    append_at(&mut health, &path, entry, write_ledger)
}

fn append_at(
    health: &mut LedgerHealth,
    path: &Path,
    entry: &UsageEntry,
    write: impl FnOnce(&Path, &[u8]) -> std::io::Result<()>,
) -> Result<(), String> {
    let result = (|| -> Result<(), String> {
        let previous_failure = check_health(health, path).err();
        let prior_len = if previous_failure.is_none() {
            match fs::metadata(path) {
                Ok(meta) => Some(meta.len()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(0),
                Err(_) => None,
            }
        } else {
            None
        };
        let mut line = serde_json::to_string(entry).map_err(|error| error.to_string())?;
        line.push('\n');
        let directory = pending_directory(path);
        fs::create_dir_all(&directory)
            .map_err(|error| format!("could not create usage journal: {error}"))?;
        let journal_path = directory.join(format!("{}.json", uuid::Uuid::new_v4()));
        let mut journal = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&journal_path)
            .map_err(|error| format!("could not open usage journal: {error}"))?;
        serde_json::to_writer(
            &mut journal,
            &PendingUsage {
                prior_len,
                line: line.clone(),
            },
        )
        .map_err(|error| format!("could not write usage journal: {error}"))?;
        journal
            .sync_all()
            .map_err(|error| format!("could not sync usage journal: {error}"))?;
        drop(journal);
        if let Some(error) = previous_failure {
            return Err(error);
        }
        if prior_len.is_none() {
            return Err(
                "could not establish prior ledger length; retained entry was not appended".into(),
            );
        }
        if !entry.cost_usd.is_finite() || entry.cost_usd < 0.0 {
            return Err("invalid usage cost; retained entry needs reconciliation".into());
        }
        write(path, line.as_bytes())
            .map_err(|error| format!("ledger append or sync failed: {error}"))?;
        fs::remove_file(&journal_path)
            .map_err(|error| format!("ledger was written but journal cleanup failed: {error}"))?;
        Ok(())
    })();
    result.map_err(|detail| {
        let error = if detail.starts_with("Usage accounting is incomplete:") {
            detail
        } else {
            accounting_error(path, detail)
        };
        health.failure = Some(error.clone());
        error
    })
}

fn write_ledger(path: &Path, line: &[u8]) -> std::io::Result<()> {
    let mut file = OpenOptions::new()
        .read(true)
        .append(true)
        .create(true)
        .open(path)?;
    if file.metadata()?.len() > 0 {
        file.seek(SeekFrom::End(-1))?;
        let mut tail = [0];
        file.read_exact(&mut tail)?;
        if tail[0] != b'\n' {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "ledger has an unterminated final row",
            ));
        }
    }
    file.write_all(line)?;
    file.sync_all()
}

/// Reads and validates under the same lock as writes, so a budget read cannot
/// observe half a row or omit an append that has already begun.
pub fn read_usage_ledger(path: &Path) -> Result<Option<String>, String> {
    let health = LEDGER_HEALTH
        .lock()
        .map_err(|error| format!("Usage accounting lock unavailable: {error}"))?;
    read_ledger_at(&health, path)
}

fn read_ledger_at(health: &LedgerHealth, path: &Path) -> Result<Option<String>, String> {
    check_health(health, path)?;
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(accounting_error(
                path,
                format!("Could not read usage ledger: {error}"),
            ))
        }
    };
    if !contents.is_empty() && !contents.ends_with('\n') {
        return Err(accounting_error(path, "unterminated final usage row"));
    }
    for (index, line) in contents.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let row: UsageEntry = serde_json::from_str(line).map_err(|error| {
            accounting_error(path, format!("invalid usage row {}: {error}", index + 1))
        })?;
        if !row.cost_usd.is_finite() || row.cost_usd < 0.0 {
            return Err(accounting_error(
                path,
                format!("invalid cost on usage row {}", index + 1),
            ));
        }
    }
    Ok(Some(contents))
}

/// Returns an ISO 8601 UTC timestamp (e.g. `2026-04-16T12:34:56Z`).
///
/// Hand-rolled because `chrono` is not a dependency. Uses the proleptic
/// Gregorian calendar and handles leap years; output is parseable by any
/// ISO 8601 / RFC 3339 consumer.
pub fn current_timestamp_iso() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let total_secs = now.as_secs() as i64;

    let days = total_secs.div_euclid(86_400);
    let secs_in_day = total_secs.rem_euclid(86_400);
    let hour = (secs_in_day / 3600) as u32;
    let minute = ((secs_in_day % 3600) / 60) as u32;
    let second = (secs_in_day % 60) as u32;

    let (year, month, day) = days_to_ymd(days);

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hour, minute, second
    )
}

/// Convert a millisecond Unix timestamp into a `YYYY-MM-DD` UTC date string —
/// the shape `pricing::pricing_for_at` / `calculate_cost_at` expect.
///
/// Needed when re-pricing a historical record whose timestamp is ms-epoch
/// rather than an ISO string (persisted conversation messages carry
/// `timestamp: number`). Negative/pre-epoch inputs are impossible for a `u64`,
/// so this never has to handle them.
pub fn iso_date_from_millis(ms: u64) -> String {
    let days = (ms / 1000) as i64 / 86_400;
    let (year, month, day) = days_to_ymd(days);
    format!("{:04}-{:02}-{:02}", year, month, day)
}

/// Convert a count of days since the Unix epoch (1970-01-01) into a
/// (year, month, day) triple. Correctly handles leap years.
fn days_to_ymd(days_since_epoch: i64) -> (i32, u32, u32) {
    // Algorithm: civil_from_days from Howard Hinnant's date library.
    // Shifts epoch to 0000-03-01 so leap-day is at the end of each cycle.
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };
    (year as i32, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    fn entry(session: &str) -> UsageEntry {
        UsageEntry {
            ts: "2026-09-24T12:00:00Z".into(),
            source: "test".into(),
            model: "gpt-5.5".into(),
            provider: Some("openai".into()),
            agent_id: None,
            session_id: session.into(),
            input_tokens: 10,
            output_tokens: 20,
            cache_read: 0,
            cache_write: 0,
            cost_usd: 0.25,
        }
    }

    #[test]
    fn successful_commit_has_one_complete_row_and_no_pending_journal() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("usage.jsonl");
        let mut health = LedgerHealth::default();
        append_at(&mut health, &path, &entry("one"), write_ledger).unwrap();
        let contents = read_ledger_at(&health, &path).unwrap().unwrap();
        assert_eq!(contents.lines().count(), 1);
        assert_eq!(fs::read_dir(pending_directory(&path)).unwrap().count(), 0);
        assert_eq!(
            serde_json::from_str::<UsageEntry>(contents.trim())
                .unwrap()
                .session_id,
            "one"
        );
    }

    #[test]
    fn partial_append_retains_exact_row_and_blocks_reads_after_restart_without_replay() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("usage.jsonl");
        let mut health = LedgerHealth::default();
        let row = entry("partial");
        let expected = format!("{}\n", serde_json::to_string(&row).unwrap());
        let error = append_at(&mut health, &path, &row, |path, line| {
            fs::write(path, &line[..17])?;
            Err(std::io::Error::other(
                "injected disk full after partial write",
            ))
        })
        .unwrap_err();
        assert!(error.contains("reconcile"));
        let journal = fs::read_dir(pending_directory(&path))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let pending: PendingUsage = serde_json::from_slice(&fs::read(journal).unwrap()).unwrap();
        assert_eq!(pending.prior_len, Some(0));
        assert_eq!(pending.line, expected);
        let fresh_process = LedgerHealth::default();
        assert!(read_ledger_at(&fresh_process, &path).is_err());
        assert_eq!(fs::read(&path).unwrap(), expected.as_bytes()[..17]);
    }

    #[test]
    fn complete_write_with_failed_confirmation_is_not_replayed_and_other_completions_are_retained()
    {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("usage.jsonl");
        let mut health = LedgerHealth::default();
        append_at(&mut health, &path, &entry("first"), |path, line| {
            write_ledger(path, line)?;
            Err(std::io::Error::other("injected failure after full write"))
        })
        .unwrap_err();
        append_at(&mut health, &path, &entry("already-in-flight"), |_, _| {
            panic!("must never append again while accounting is uncertain")
        })
        .unwrap_err();
        assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), 1);
        let mut records: Vec<PendingUsage> = fs::read_dir(pending_directory(&path))
            .unwrap()
            .map(|entry| serde_json::from_slice(&fs::read(entry.unwrap().path()).unwrap()).unwrap())
            .collect();
        assert_eq!(records.len(), 2);
        records.sort_by_key(|record| record.prior_len.is_none());
        assert_eq!(records[0].prior_len, Some(0));
        assert_eq!(records[1].prior_len, None);
        assert!(records[1].line.contains("already-in-flight"));
        assert!(check_health(&LedgerHealth::default(), &path).is_err());
    }

    #[test]
    fn simultaneous_inflight_failures_keep_every_row_without_more_ledger_writes() {
        use std::sync::{Arc, Mutex};
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("usage.jsonl");
        let health = Arc::new(Mutex::new(LedgerHealth::default()));
        let writes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let workers: Vec<_> = (0..4)
            .map(|index| {
                let path = path.clone();
                let health = Arc::clone(&health);
                let writes = Arc::clone(&writes);
                std::thread::spawn(move || {
                    append_at(
                        &mut health.lock().unwrap(),
                        &path,
                        &entry(&format!("session-{index}")),
                        |_, _| {
                            writes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            Err(std::io::Error::other("injected write failure"))
                        },
                    )
                    .unwrap_err();
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(writes.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(fs::read_dir(pending_directory(&path)).unwrap().count(), 4);
        assert!(read_ledger_at(&LedgerHealth::default(), &path).is_err());
    }

    #[test]
    fn journal_creation_failure_latches_failure_even_without_persistent_storage() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("usage.jsonl");
        fs::write(pending_directory(&path), "directory blocked").unwrap();
        let mut health = LedgerHealth::default();
        append_at(&mut health, &path, &entry("one"), |_, _| {
            panic!("ledger must not be touched")
        })
        .unwrap_err();
        fs::remove_file(pending_directory(&path)).unwrap();
        assert!(check_health(&health, &path).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn request_preflight_refuses_existing_corrupt_or_unreadable_ledger_and_latches() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("usage.jsonl");
        let mut health = LedgerHealth::default();
        fs::write(&path, "malformed\n").unwrap();
        assert!(ensure_healthy_at(&mut health, &path).is_err());
        fs::write(&path, "").unwrap();
        assert!(ensure_healthy_at(&mut health, &path).is_err());
        let mut fresh = LedgerHealth::default();
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(ensure_healthy_at(&mut fresh, &path).is_err());
    }

    #[test]
    fn malformed_truncated_and_negative_ledger_rows_are_not_ignored() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("usage.jsonl");
        let health = LedgerHealth::default();
        fs::write(&path, "not json\n").unwrap();
        assert!(read_ledger_at(&health, &path)
            .unwrap_err()
            .contains("invalid usage row"));
        fs::write(&path, serde_json::to_string(&entry("truncated")).unwrap()).unwrap();
        assert!(read_ledger_at(&health, &path)
            .unwrap_err()
            .contains("unterminated"));
        let mut negative = entry("negative");
        negative.cost_usd = -1.0;
        fs::write(
            &path,
            format!("{}\n", serde_json::to_string(&negative).unwrap()),
        )
        .unwrap();
        assert!(read_ledger_at(&health, &path)
            .unwrap_err()
            .contains("invalid cost"));
    }

    use super::*;

    #[test]
    fn timestamp_is_iso_shape() {
        let ts = current_timestamp_iso();
        assert_eq!(ts.len(), 20, "expected YYYY-MM-DDTHH:MM:SSZ, got {}", ts);
        assert!(ts.ends_with('Z'));
        assert_eq!(&ts[4..5], "-");
        assert_eq!(&ts[7..8], "-");
        assert_eq!(&ts[10..11], "T");
        assert_eq!(&ts[13..14], ":");
        assert_eq!(&ts[16..17], ":");
    }

    #[test]
    fn days_to_ymd_known_dates() {
        // 1970-01-01 is day 0.
        assert_eq!(days_to_ymd(0), (1970, 1, 1));
        // 2000-01-01 is day 10957.
        assert_eq!(days_to_ymd(10_957), (2000, 1, 1));
        // 2020-02-29 (leap day) is day 18321.
        assert_eq!(days_to_ymd(18_321), (2020, 2, 29));
    }

    #[test]
    fn usage_log_path_ends_correctly() {
        if let Some(p) = usage_log_path() {
            let s = p.to_string_lossy().to_string();
            assert!(s.ends_with("usage.jsonl"));
            assert!(s.contains(DATA_DIR_NAME));
        }
    }
}
