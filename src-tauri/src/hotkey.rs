//! The global show/hide shortcut.
//!
//! Registering a shortcut globally takes it away from every other app, so a
//! failure here is worth saying out loud rather than swallowing — and the
//! combination is a setting precisely because no default is right for everyone.
//!
//! **On Linux this can report success when the OS never took the key, and
//! there is no fix available from here.** `global-hotkey`'s Linux backend is
//! X11 only — `XGrabKey` through `x11rb` — and its `register` is
//! `if let Ok(result) = rx.recv() { result?; } Ok(())`: when the worker
//! thread is gone, because there is no reachable X display, `recv` returns
//! `Err`, the arm is skipped and `Ok(())` is returned anyway. So under
//! Wayland without XWayland the settings window shows a live shortcut that
//! does nothing, and `shotshelf.log` stays silent — against
//! `docs/USAGE.md`'s promise that a taken combination "says so in its log".
//!
//! `is_registered` cannot close it: the plugin's map is written from the same
//! `Ok`. Verifying would mean grabbing the key back and watching for an
//! event, which is a synthetic keypress this app has no business making.
//! Documented in `docs/USAGE.md` instead, next to the tray note — because
//! `tray-icon`'s GTK constructor is infallible too, so on a desktop with
//! neither a StatusNotifier host nor XWayland there is no way to summon the
//! shelf once it is hidden.

use tauri::{AppHandle, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub fn register<R: Runtime>(app: &AppHandle<R>, accelerator: &str) -> Result<(), String> {
    let shortcut: Shortcut = accelerator
        .parse()
        .map_err(|_| format!("\"{accelerator}\" is not a valid shortcut"))?;

    // Identified rather than guessed at. The plugin has no distinct
    // "already registered" error — every cause arrives as one opaque
    // `GlobalHotkey(String)` — so the single case we can name is checked here,
    // where the answer is knowable, instead of being asserted downstream.
    if app.global_shortcut().is_registered(shortcut) {
        return Err(format!("\"{accelerator}\" is already in use by Shotshelf"));
    }

    app.global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            // Fires on press and release; toggling on both would cancel itself out.
            if event.state() == ShortcutState::Pressed {
                crate::window::toggle(app);
            }
        })
        .map_err(|err| {
            // "may own it", not "probably owns it". This string is rendered
            // verbatim in the settings window and the plugin flattens every
            // cause into one opaque `GlobalHotkey(String)`, so the specific
            // claim was a guess presented to the user as a diagnosis. The one
            // cause we *can* identify is checked above, by name.
            format!("\"{accelerator}\" could not be registered — another app may own it ({err})")
        })
}

/// Give a combination back to the rest of the desktop.
///
/// Reports, rather than discarding the one error that matters. In the plugin,
/// `unregister` calls the OS with `?` **before** removing its own handler
/// entry, so a failure leaves the combination live at both layers: it still
/// toggles the shelf and it is still taken from every other app.
///
/// `Ok(())` when nothing was registered — that is the caller getting what it
/// asked for, not an error — which is why the check is `is_registered` and not
/// a blanket swallow. The blanket swallow could not tell the two apart, so it
/// treated "still held by us" exactly like "already gone".
pub fn unregister<R: Runtime>(app: &AppHandle<R>, accelerator: &str) -> Result<(), String> {
    let Ok(shortcut) = accelerator.parse::<Shortcut>() else {
        // Unparseable means it was never registered; there is nothing to undo.
        return Ok(());
    };

    let shortcuts = app.global_shortcut();
    if !shortcuts.is_registered(shortcut) {
        return Ok(());
    }

    shortcuts
        .unregister(shortcut)
        .map_err(|err| format!("\"{accelerator}\" could not be released ({err})"))
}

/// Swap one shortcut for another, putting the old one back if the new one will
/// not take — losing the shortcut entirely because of a typo would be worse
/// than refusing the change.
pub fn rebind<R: Runtime>(app: &AppHandle<R>, previous: &str, next: &str) -> Result<(), String> {
    // Refused rather than continued. Registering the new combination on top of
    // an old one that is still live leaves *both* toggling the shelf, with the
    // old one still stolen from every other app for the life of the process —
    // and `settings.rs` would store the new one, so the window would show a
    // combination that is only half true. Returning the error keeps the stored
    // setting equal to what the OS actually has.
    unregister(app, previous).inspect_err(|err| {
        crate::diag::warn(&format!("the previous shortcut is still held: {err}"));
    })?;

    register(app, next).inspect_err(|_| {
        if let Err(err) = register(app, previous) {
            crate::diag::warn(&format!("could not restore the previous shortcut: {err}"));
        }
    })
}
