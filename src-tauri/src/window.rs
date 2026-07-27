//! The shelf popover: where it appears, and when it goes away.
//!
//! Shotshelf hangs off the tray icon rather than docking to a screen edge. Two
//! ways in, and they behave differently on purpose:
//!
//! * **Opened** — a tray click or the global shortcut. Takes focus, so Esc and
//!   clicking outside can dismiss it the way every other popover does.
//! * **Peeked** — a capture just landed. Never takes focus, because the shelf
//!   appearing mid-sentence and swallowing your keystrokes is the single
//!   complaint people have about shelves that do this. It closes itself.

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use tauri_plugin_positioner::{Position, WindowExt};

/// Label of the shelf window — must match `tauri.conf.json`.
pub const SHELF: &str = "main";

/// Anchor the popover to the tray icon.
///
/// `tauri-plugin-positioner` is fed the tray rectangle by the tray event
/// handler, so it already knows where the icon sits — below the menu bar on
/// macOS, above the notification area on Windows — and it keeps the popover on
/// screen near the edges. No coordinate maths here.
fn anchor<R: Runtime>(shelf: &WebviewWindow<R>) {
    if let Err(err) = shelf.move_window(anchor_position()) {
        eprintln!("shotshelf: could not anchor the shelf to the tray: {err}");
    }
}

/// `TrayCenter` is only meaningful once a tray event has told the positioner
/// where the icon is — before that it lands in the corner of the screen, which
/// is how a launch peek ended up at the top-left. Until then, aim for the
/// corner the tray actually lives in.
fn anchor_position() -> Position {
    if crate::tray::tray_located() {
        return Position::TrayCenter;
    }

    // Windows keeps its notification area bottom-right; the macOS menu bar is
    // along the top.
    #[cfg(target_os = "windows")]
    {
        Position::BottomRight
    }
    #[cfg(not(target_os = "windows"))]
    {
        Position::TopRight
    }
}

/// Open the popover deliberately: anchored, on top, and focused.
pub fn open<R: Runtime>(app: &AppHandle<R>) {
    let Some(shelf) = app.get_webview_window(SHELF) else {
        return;
    };

    anchor(&shelf);
    let _ = shelf.show();
    let _ = shelf.set_focus();
}

/// Show the popover without taking focus, for a capture that just landed.
/// The front-end decides how long it stays; this only puts it on screen.
pub fn peek<R: Runtime>(app: &AppHandle<R>) {
    let Some(shelf) = app.get_webview_window(SHELF) else {
        return;
    };

    // Re-anchor every time: the tray can move between monitors, and a peek
    // should never appear where the icon used to be.
    anchor(&shelf);
    let _ = shelf.show();
}

pub fn hide<R: Runtime>(app: &AppHandle<R>) {
    let Some(shelf) = app.get_webview_window(SHELF) else {
        return;
    };
    let _ = shelf.hide();

    // Hiding the window alone leaves macOS treating Shotshelf as the active
    // app, so the app you were actually using does not get its focus back.
    #[cfg(target_os = "macos")]
    let _ = app.hide();
}

/// Tray click, tray menu, or the global shortcut.
pub fn toggle<R: Runtime>(app: &AppHandle<R>) {
    let Some(shelf) = app.get_webview_window(SHELF) else {
        return;
    };

    match shelf.is_visible() {
        Ok(true) => hide(app),
        Ok(false) => open(app),
        Err(err) => eprintln!("shotshelf: could not read shelf visibility: {err}"),
    }
}

/// Frosted glass behind the popover — acrylic on Windows, vibrancy on macOS.
/// Cosmetic only: a failure here leaves a solid panel, which still works.
pub fn apply_material<R: Runtime>(shelf: &WebviewWindow<R>) {
    #[cfg(target_os = "windows")]
    if let Err(err) = window_vibrancy::apply_acrylic(shelf, Some((16, 18, 26, 190))) {
        eprintln!("shotshelf: no acrylic backdrop ({err}) — falling back to a solid panel");
    }

    #[cfg(target_os = "macos")]
    if let Err(err) = window_vibrancy::apply_vibrancy(
        shelf,
        window_vibrancy::NSVisualEffectMaterial::HudWindow,
        None,
        Some(14.0),
    ) {
        eprintln!("shotshelf: no vibrancy backdrop ({err}) — falling back to a solid panel");
    }
}

/// Commands the front-end uses to drive the peek timer.
#[tauri::command]
pub fn show_shelf<R: Runtime>(app: AppHandle<R>, focus: bool) {
    if focus {
        open(&app);
    } else {
        peek(&app);
    }
}

#[tauri::command]
pub fn hide_shelf<R: Runtime>(app: AppHandle<R>) {
    hide(&app);
}
