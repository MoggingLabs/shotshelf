//! The About section's links, opened in the system browser.
//!
//! A command with an allowlist rather than an `open_url(url)` — a webview
//! that can hand any URL to the OS browser is a phishing primitive, and the
//! settings window needs exactly three destinations. The names cross the
//! wire; the URLs never do.

/// Open one of the known destinations, by name. Unknown names are refused.
#[tauri::command]
pub async fn open_link(which: String) -> Result<(), String> {
    let url = match which.as_str() {
        "repo" => "https://github.com/MoggingLabs/shotshelf",
        "usage" => "https://github.com/MoggingLabs/shotshelf/blob/main/docs/USAGE.md",
        "issues" => "https://github.com/MoggingLabs/shotshelf/issues/new/choose",
        other => return Err(format!("no such link: {other}")),
    };

    // On a blocking worker: `opener::open` spawns and, on some platforms,
    // waits on a process — same reasoning as `share::reveal_capture`.
    tauri::async_runtime::spawn_blocking(move || {
        opener::open(url).map_err(|err| {
            crate::diag::warn(&format!("could not open {url}: {err}"));
            "the browser could not be opened".to_owned()
        })
    })
    .await
    .map_err(|err| format!("the opener worker died: {err}"))?
}
