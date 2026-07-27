//! Shelf window placement and visibility.

use tauri::{AppHandle, Manager, PhysicalPosition, Runtime, WebviewWindow};
use tauri_plugin_positioner::{Position, WindowExt};

use crate::settings::{Edge, Settings, SettingsStore};

/// Label of the shelf window — must match `tauri.conf.json`.
pub const SHELF: &str = "main";

/// Dock the shelf flush against its configured screen edge.
///
/// Placement is `tauri-plugin-positioner`'s job: it already accounts for the
/// work area (Windows taskbar, macOS menu bar/Dock) and per-monitor DPI, so we
/// never compute screen coordinates by hand.
pub fn dock<R: Runtime>(shelf: &WebviewWindow<R>, settings: &Settings) {
    if let Some(monitor) = settings.monitor.as_deref() {
        move_to_monitor(shelf, monitor);
    }

    let position = match settings.edge {
        Edge::Left => Position::LeftCenter,
        Edge::Right => Position::RightCenter,
    };

    if let Err(err) = shelf.move_window(position) {
        eprintln!("shotshelf: could not dock the shelf: {err}");
    }
}

/// The positioner works on whichever monitor the window currently occupies, so
/// reaching another screen means nudging the window onto it first. A monitor
/// that has been unplugged simply isn't in the list and the shelf stays put —
/// which is the sane fallback, since wherever it is now is somewhere visible.
fn move_to_monitor<R: Runtime>(shelf: &WebviewWindow<R>, name: &str) {
    let Ok(monitors) = shelf.available_monitors() else {
        return;
    };

    let found = monitors
        .into_iter()
        .find(|monitor| monitor.name().is_some_and(|found| found == name));

    let Some(monitor) = found else {
        eprintln!("shotshelf: monitor \"{name}\" is not connected — leaving the shelf where it is");
        return;
    };

    let origin = monitor.position();
    let _ = shelf.set_position(PhysicalPosition::new(origin.x + 1, origin.y + 1));
}

/// Tray click, tray menu, or the global shortcut: hide the shelf if it is on
/// screen, otherwise dock it back to its edge and show it.
pub fn toggle<R: Runtime>(app: &AppHandle<R>) {
    let Some(shelf) = app.get_webview_window(SHELF) else {
        return;
    };

    match shelf.is_visible() {
        Ok(true) => {
            let _ = shelf.hide();
        }
        Ok(false) => {
            if let Some(store) = app.try_state::<SettingsStore>() {
                dock(&shelf, &store.get());
            }
            let _ = shelf.show();
            let _ = shelf.set_focus();
        }
        Err(err) => eprintln!("shotshelf: could not read shelf visibility: {err}"),
    }
}
