//! Shelf window placement and visibility.

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use tauri_plugin_positioner::{Position, WindowExt};

/// Label of the shelf window — must match `tauri.conf.json`.
pub const SHELF: &str = "main";

/// Dock the shelf flush against the right edge of the active monitor.
///
/// Placement is `tauri-plugin-positioner`'s job: it already accounts for the
/// work area (Windows taskbar, macOS menu bar/Dock) and per-monitor DPI, so we
/// never compute screen coordinates by hand.
pub fn dock<R: Runtime>(shelf: &WebviewWindow<R>) {
    if let Err(err) = shelf.move_window(Position::RightCenter) {
        eprintln!("shotshelf: could not dock the shelf to the right edge: {err}");
    }
}

/// Tray click / tray menu: hide the shelf if it is on screen, otherwise dock
/// it back to the edge and show it.
pub fn toggle<R: Runtime>(app: &AppHandle<R>) {
    let Some(shelf) = app.get_webview_window(SHELF) else {
        return;
    };

    match shelf.is_visible() {
        Ok(true) => {
            let _ = shelf.hide();
        }
        Ok(false) => {
            dock(&shelf);
            let _ = shelf.show();
            let _ = shelf.set_focus();
        }
        Err(err) => eprintln!("shotshelf: could not read shelf visibility: {err}"),
    }
}
