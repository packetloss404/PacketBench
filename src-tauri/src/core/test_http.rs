//! Local HTTP fixture; never reads account credentials or contacts a provider.
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub async fn serve(body: &str, content_type: &str) -> (String, tokio::task::JoinHandle<String>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let response = format!("HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        loop {
            let mut chunk = [0; 4096];
            let count =
                tokio::time::timeout(std::time::Duration::from_secs(5), stream.read(&mut chunk))
                    .await
                    .unwrap()
                    .unwrap();
            assert!(count > 0, "request ended prematurely");
            bytes.extend_from_slice(&chunk[..count]);
            if let Some(end) = bytes.windows(4).position(|s| s == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]);
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|n| n.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if bytes.len() >= end + 4 + length {
                    break;
                }
            }
        }
        // Split every UTF-8 code point across writes to exercise byte buffering.
        for chunk in response.as_bytes().chunks(3) {
            stream.write_all(chunk).await.unwrap();
        }
        String::from_utf8(bytes).unwrap()
    });
    (url, task)
}
