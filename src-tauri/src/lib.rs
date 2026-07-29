//! Shotshelf — the shelf that catches every capture.
//!
//! This file is wiring: the commands the webview may call, the plugins the app
//! is built on, and the order start-up happens in. Every rule lives in the
//! module it belongs to.
//!
//! Local-only, with one stated exception. No telemetry or analytics plugin is
//! registered and none will be; the updater below is the single component that
//! opens a socket, and all it asks is whether there is a newer build. Captures
//! never leave the machine — this used to claim no network plugin was
//! registered at all, forty-nine lines above the line registering one.

mod cache;
mod catch;
mod diag;
mod dirs;
mod edit;
mod enrich;
mod handoff;
mod hotkey;
mod imaging;
mod limits;
mod poster;
mod settings;
mod share;
mod tray;
mod update;
mod webview_path;
mod window;
mod wire;

use tauri::Manager;

/// How often the derived caches are swept.
///
/// Both hold re-derivable copies under the app's own cache directory, and
/// neither sweep touches anything the shelf presents as a capture.
const PRUNE_EVERY: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// Sweep the poster and hand-off caches now, and keep doing it.
fn prune_caches<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            // On a blocking worker, not on the runtime that serves every
            // command: both sweeps do `read_dir` plus a `metadata` and a
            // `remove_*` per entry. Cheap at this cadence, and the same class
            // of work `share.rs` and `edit.rs` are careful to move off.
            let sweeping = app.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                poster::prune_cache(&sweeping);
                handoff::prune(&sweeping);
            })
            .await;
            tokio::time::sleep(PRUNE_EVERY).await;
        }
    });
}

pub fn run() {
    tauri::Builder::default()
        // Two Shotshelves would both watch the same folders, both catch every
        // capture, and both write the settings file. A second launch just
        // brings the shelf that is already running to the front.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch is someone asking for the shelf.
            window::open(app, true);
        }))
        .invoke_handler(tauri::generate_handler![
            catch::catch_watch_dirs,
            catch::catch_backfill,
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
            window::hide_shelf,
        ])
        // ── Adopted plugins — don't hand-roll what these already solve ──
        .plugin(tauri_plugin_clipboard::init()) // clipboard images, incl. Win+Shift+S
        .plugin(tauri_plugin_drag::init()) // native drag-out to other apps
        .plugin(tauri_plugin_shell::init()) // runs the bundled ffmpeg sidecar
        .plugin(tauri_plugin_global_shortcut::Builder::new().build()) // show/hide hotkey
        .plugin(tauri_plugin_updater::Builder::new().build()) // internal release feed
        .setup(|app| {
            // macOS: `skipTaskbar` is Windows/Linux only. The Accessory
            // activation policy is what keeps Shotshelf out of the Dock and
            // the ⌘-Tab switcher, the way a menu-bar utility should be.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // First, so everything below has somewhere to report to. A
            // packaged Windows build has no console at all.
            diag::init(app.handle());

            tray::init(app.handle())?;

            // Everything below reads settings, so they load first.
            let stored = settings::load(app.handle());
            let current = stored.get();
            app.manage(stored);

            // No scope grant from the stored pin list, deliberately.
            //
            // Pinned tiles render before the engine's grant lands, and a round
            // fixed that by granting each stored pin. But `pinned.json` is
            // hand-editable and both `set_pinned` and `set_settings` let the
            // webview write it, with `allowed_pins` keeping anything that merely
            // parses as absolute — so one pin plus a restart admitted an
            // arbitrary file to `describe_capture`, `copy_capture` and
            // `prepare_drag`. That is the capability this module's header says
            // the scope removes.
            //
            // The race is real; the grant was the wrong end of it. The front end
            // retries a thumbnail once the catch engine reports ready, which
            // fixes the rendering without widening what Rust will read.

            // A shortcut another app already owns is worth saying out loud —
            // the shelf still works, it just can't be summoned that way.
            if let Err(err) = hotkey::register(app.handle(), &current.hotkey) {
                crate::diag::warn(&err.to_string());
            }

            // The one and only network call Shotshelf makes: "is there a newer
            // build?". No capture data, no telemetry, and the user can decline
            // even this.
            update::check_on_launch(app.handle(), current.check_for_updates);

            // Watch the OS capture folders + the clipboard. Emits `capture://new`.
            //
            // On a worker, because this can block for a long time. Resolving
            // the watch folders does `exists`, `is_dir`, `create_dir` and
            // `canonicalize` per candidate, and opening a watch takes a
            // directory handle each — and under Windows folder redirection
            // `picture_dir()` can be a `\server\share\…` path where every
            // one of those is an SMB round trip with a multi-second timeout.
            // Run inline it delayed `window::open` below by that whole amount,
            // with nothing on screen and the event loop not yet started, so the
            // tray icon was unresponsive too.
            // Reserved synchronously, before the slow half runs on a worker:
            // Tauri creates the window before `setup`, so the webview asks
            // within milliseconds and both catch commands must be able to say
            // "still starting" rather than "nothing".
            catch::reserve(app.handle());
            let engine = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                catch::start(&engine, &catch::overrides_from_env());
            });
            poster::allow_reading_posters(app.handle());
            // Caches are swept on a timer, not once at launch.
            //
            // "Prune at startup" is a reasonable cadence for an app you open
            // and close. This one lives in the tray and is expected to run for
            // weeks, so within a session it never pruned at all — while the
            // usage guide said the hand-off cache "keeps the 60 most recent".
            prune_caches(app.handle());
            // Edits are the user's own work; this only lets the webview show
            // the ones from previous sessions.
            edit::allow_reading_edits(app.handle());

            if let Some(shelf) = app.get_webview_window(window::SHELF) {
                window::apply_material(&shelf);
            }

            // A menu-bar app that starts by showing nothing at all looks
            // broken. Open it once so it can be found, then let it behave.
            // The one appearance nobody asked for, which is why it puts itself
            // away again. `false` is what lets the front end tell it apart from
            // a tray or hotkey open — both of which come through this same
            // function and emit the same event.
            window::open(app.handle(), false);

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
