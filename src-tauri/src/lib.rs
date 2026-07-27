//! Shotshelf — the shelf that catches every capture.
//!
//! Phase 01 is the shell only: a frameless, always-on-top, taskbar-less window
//! docked to a screen edge, plus a tray icon that toggles it. Every adopted
//! plugin (see `prompts/RESEARCH.md`) is registered here so the later phases
//! add code, not dependencies.
//!
//! Local-only by construction: no network, telemetry or analytics plugin is
//! registered, and none will be.

mod catch;
mod poster;
mod share;
mod tray;
mod window;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            catch::catch_watch_dirs,
            share::prepare_drag,
            share::copy_capture,
            poster::video_details,
            poster::forget_video,
        ])
        // ── Adopted plugins — don't hand-roll what these already solve ──
        .plugin(tauri_plugin_fs::init()) // read captures off disk
        .plugin(tauri_plugin_positioner::init()) // edge/tray window placement
        .plugin(tauri_plugin_clipboard::init()) // clipboard images (phase 02)
        .plugin(tauri_plugin_drag::init()) // native drag-out (phase 04)
        .plugin(tauri_plugin_shell::init()) // runs the bundled ffmpeg sidecar
        .setup(|app| {
            // macOS: `skipTaskbar` is Windows/Linux only. The Accessory
            // activation policy is what keeps Shotshelf out of the Dock and
            // the ⌘-Tab switcher, the way a menu-bar utility should be.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            tray::init(app.handle())?;

            // Watch the OS capture folders + the clipboard. Emits `capture://new`.
            catch::start(app.handle(), &catch::overrides_from_env());
            poster::allow_reading_posters(app.handle());

            if let Some(shelf) = app.get_webview_window(window::SHELF) {
                // The window starts hidden (`"visible": false`): dock first,
                // then show, so it never flashes in the middle of the screen.
                window::dock(&shelf);
                let _ = shelf.show();
            }

            Ok(())
        })
        .on_window_event(|shelf, event| {
            // The shelf has no close button, but Alt+F4 / ⌘W still fire.
            // Hiding instead of closing keeps the app alive in the tray.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = shelf.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("shotshelf: fatal error while running the app");
}
