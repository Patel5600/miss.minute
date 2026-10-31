//! A tiny loopback HTTP endpoint used to receive OAuth redirects on `127.0.0.1`. It parses
//! only the request line (method + target), returns a friendly themed page and hands the
//! query parameters back to the caller. It never proxies, never keeps connections open and
//! only ever binds to the loopback interface.

use std::collections::HashMap;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// Parsed callback: the query parameters from the redirect URL.
pub struct Callback {
    pub query: HashMap<String, String>,
}

/// Binds `127.0.0.1:preferred`, falling back to an OS-assigned free port when the preferred
/// one is taken. Binding to `127.0.0.1` (not `localhost`) matches the exact redirect URI the
/// ChatGPT flow requires.
pub async fn bind_preferred(preferred: u16) -> Result<TcpListener, String> {
    if preferred != 0 {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", preferred)).await {
            return Ok(listener);
        }
    }
    TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| format!("Could not start the local sign-in listener: {error}"))
}

/// Waits for a request whose path starts with `accept_path`, serving 404s to anything else
/// (favicon probes, etc.). Resolves with the redirect's query parameters, or an error if the
/// deadline passes first.
pub async fn wait_for_callback(listener: &TcpListener, accept_path: &str, timeout: Duration) -> Result<Callback, String> {
    let serve = async {
        loop {
            let (mut stream, _) = listener
                .accept()
                .await
                .map_err(|error| format!("The sign-in listener failed: {error}"))?;
            let head = read_request_head(&mut stream).await?;
            let (path, query) = parse_target(&head);
            if path.starts_with(accept_path) {
                let succeeded = query.contains_key("code") && !query.contains_key("error");
                let _ = respond(&mut stream, "200 OK", page(succeeded)).await;
                return Ok(Callback { query });
            }
            let _ = respond(&mut stream, "404 Not Found", NOT_FOUND).await;
        }
    };

    match tokio::time::timeout(timeout, serve).await {
        Ok(result) => result,
        Err(_) => Err("The sign-in timed out. Please try again.".to_owned()),
    }
}

/// Reads until the end of the HTTP request headers (or a sane cap), returning the bytes as a
/// lossy string. Only the request line is needed downstream.
async fn read_request_head(stream: &mut TcpStream) -> Result<String, String> {
    let mut buffer = Vec::with_capacity(1024);
    let mut scratch = [0_u8; 1024];
    loop {
        let read = stream
            .read(&mut scratch)
            .await
            .map_err(|error| format!("Could not read the sign-in callback: {error}"))?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&scratch[..read]);
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") || buffer.len() > 32 * 1024 {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&buffer).into_owned())
}

/// Extracts the path and decoded query map from an HTTP request head.
fn parse_target(head: &str) -> (String, HashMap<String, String>) {
    let request_line = head.lines().next().unwrap_or("");
    let target = request_line.split_whitespace().nth(1).unwrap_or("/");
    let (path, raw_query) = match target.split_once('?') {
        Some((path, query)) => (path.to_owned(), query),
        None => (target.to_owned(), ""),
    };
    let query = url::form_urlencoded::parse(raw_query.as_bytes())
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    (path, query)
}

async fn respond(stream: &mut TcpStream, status: &str, body: &str) -> Result<(), String> {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|error| format!("Could not answer the sign-in callback: {error}"))?;
    let _ = stream.flush().await;
    let _ = stream.shutdown().await;
    Ok(())
}

fn page(succeeded: bool) -> &'static str {
    if succeeded {
        SUCCESS
    } else {
        FAILURE
    }
}

const SUCCESS: &str = r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Miss Minutes</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#1a1205;color:#ffce6b;font-family:system-ui,sans-serif}
.card{text-align:center;padding:2rem 3rem;border:1px solid #6b4a12;border-radius:16px;background:#241a08;box-shadow:0 12px 40px #0008}
h1{margin:.2rem 0;font-size:1.4rem}p{color:#e7c98c;margin:.4rem 0}</style></head>
<body><div class="card"><h1>All set, darlin'!</h1><p>Miss Minutes is connected.</p><p>You can close this tab and head back to the app.</p></div></body></html>"#;

const FAILURE: &str = r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Miss Minutes</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#1a0505;color:#ff9b9b;font-family:system-ui,sans-serif}
.card{text-align:center;padding:2rem 3rem;border:1px solid #6b1212;border-radius:16px;background:#240808;box-shadow:0 12px 40px #0008}
h1{margin:.2rem 0;font-size:1.4rem}p{color:#e79c9c;margin:.4rem 0}</style></head>
<body><div class="card"><h1>That didn't go through</h1><p>Sign-in was cancelled or failed.</p><p>You can close this tab and try again in the app.</p></div></body></html>"#;

const NOT_FOUND: &str = "<!doctype html><title>Not found</title><p>Not found.</p>";
