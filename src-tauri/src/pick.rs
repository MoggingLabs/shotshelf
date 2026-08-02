//! The one native dialog in the app: the settings window's folder picker.
//!
//! Native on purpose, where everything else is themed: a folder picker is a
//! security surface, not a widget. The webview never types a path — it asks,
//! the OS shows the user their own filesystem, and only what the user
//! actually clicked comes back. That is the same shape as `links.rs`: the
//! webview chooses from what Rust offers, it does not compose.

/// Ask the user for a folder to watch. `None` is the user closing the dialog,
/// which is an answer, not an error.
///
/// Unparented, deliberately: rfd's parenting wants a raw window handle Tauri
/// only hands out on the main thread, and an unparented picker beats a
/// deadlock.
#[tauri::command]
pub async fn choose_watch_folder() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Watch a folder for captures")
        .pick_folder()
        .await
        .map(|folder| folder.path().display().to_string())
}
