//! The global show/hide shortcut.
//!
//! Registering a shortcut globally takes it away from every other app, so a
//! failure here is worth saying out loud rather than swallowing — and the
//! combination is a setting precisely because no default is right for everyone.

use tauri::{AppHandle, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub fn register<R: Runtime>(app: &AppHandle<R>, accelerator: &str) -> Result<(), String> {
    let shortcut: Shortcut = accelerator
        .parse()
        .map_err(|_| format!("\"{accelerator}\" is not a valid shortcut"))?;

    app.global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            // Fires on press and release; toggling on both would cancel itself out.
            if event.state() == ShortcutState::Pressed {
                crate::window::toggle(app);
            }
        })
        .map_err(|err| {
            format!(
                "\"{accelerator}\" could not be registered — another app probably owns it ({err})"
            )
        })
}

pub fn unregister<R: Runtime>(app: &AppHandle<R>, accelerator: &str) {
    let Ok(shortcut) = accelerator.parse::<Shortcut>() else {
        return;
    };
    let _ = app.global_shortcut().unregister(shortcut);
}

/// Swap one shortcut for another, putting the old one back if the new one will
/// not take — losing the shortcut entirely because of a typo would be worse
/// than refusing the change.
pub fn rebind<R: Runtime>(app: &AppHandle<R>, previous: &str, next: &str) -> Result<(), String> {
    unregister(app, previous);

    register(app, next).inspect_err(|_| {
        if let Err(err) = register(app, previous) {
            eprintln!("shotshelf: could not restore the previous shortcut: {err}");
        }
    })
}
