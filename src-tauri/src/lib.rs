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
mod edit;
mod enrich;
mod handoff;
mod hotkey;
mod imaging;
mod poster;
mod settings;
mod share;
mod tray;
mod update;
mod window;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        // Two Shotshelves would both watch the same folders, both catch every
        // capture, and both write the settings file. A second launch just
        // brings the shelf that is already running to the front.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            window::open(app);
        }))
        .invoke_handler(tauri::generate_handler![
            catch::catch_watch_dirs,
            share::prepare_drag,
            share::copy_capture,
            share::describe_capture,
            edit::compare_captures,
            edit::save_edit,
            enrich::ocr::text_recognition_available,
            poster::video_details,
            poster::forget_video,
            settings::get_settings,
            settings::set_settings,
            settings::set_pinned,
            tray::set_capture_count,
            window::show_shelf,
            window::preview_shelf,
            window::close_preview,
            window::hide_shelf,
        ])
        // ── Adopted plugins — don't hand-roll what these already solve ──
        .plugin(tauri_plugin_clipboard::init()) // clipboard images (phase 02)
        .plugin(tauri_plugin_drag::init()) // native drag-out (phase 04)
        .plugin(tauri_plugin_shell::init()) // runs the bundled ffmpeg sidecar
        .plugin(tauri_plugin_global_shortcut::Builder::new().build()) // show/hide hotkey
        .plugin(tauri_plugin_updater::Builder::new().build()) // internal release feed
        .setup(|app| {
            // macOS: `skipTaskbar` is Windows/Linux only. The Accessory
            // activation policy is what keeps Shotshelf out of the Dock and
            // the ⌘-Tab switcher, the way a menu-bar utility should be.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            tray::init(app.handle())?;

            // Everything below reads settings, so they load first.
            let stored = settings::load(app.handle());
            let current = stored.get();
            app.manage(stored);

            // A shortcut another app already owns is worth saying out loud —
            // the shelf still works, it just can't be summoned that way.
            if let Err(err) = hotkey::register(app.handle(), &current.hotkey) {
                eprintln!("shotshelf: {err}");
            }

            // The one and only network call Shotshelf makes: "is there a newer
            // build?". No capture data, no telemetry.
            update::check_on_launch(app.handle());

            // Watch the OS capture folders + the clipboard. Emits `capture://new`.
            catch::start(app.handle(), &catch::overrides_from_env());
            poster::allow_reading_posters(app.handle());
            poster::prune_cache(app.handle());
            // Sized copies are a cache too, and a cache that only grows is a
            // leak with a nicer name.
            handoff::prune(app.handle());

            if let Some(shelf) = app.get_webview_window(window::SHELF) {
                window::apply_material(&shelf);
            }

            // A menu-bar app that starts by showing nothing at all looks
            // broken. Open it once so it can be found, then let it behave.
            window::open(app.handle());

            Ok(())
        })
        .on_window_event(|shelf, event| {
            // The shelf has no close button, but Alt+F4 / ⌘W still fire.
            // Hiding instead of closing keeps the app alive in the tray.
            //
            // Through `window::hide` rather than `shelf.hide()`: hiding is not
            // just making the window invisible. It clears the opened flag and
            // emits `shelf://hidden`, without which the front-end goes on
            // believing the shelf is open — so every later capture is filed
            // away silently instead of popping the column, and a hover hold
            // left armed by hiding under the cursor freezes the column's
            // expiry for the rest of the session. One keystroke, two features
            // dead, no error anywhere.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                window::hide(shelf.app_handle());
            }
        })
        .run(tauri::generate_context!())
        .expect("shotshelf: fatal error while running the app");
}
