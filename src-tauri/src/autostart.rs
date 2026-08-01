//! The login item, kept in step with the roaming setting.
//!
//! `startAtLogin` lives in the roaming half of the settings on purpose: opting
//! in is a statement about your account, not about one machine. The OS
//! registration, though, is strictly per-machine — a registry `Run` entry on
//! Windows, a LaunchAgent on macOS, an autostart `.desktop` file on Linux — so
//! the two can disagree the first time a roamed profile lands somewhere new.
//! [`reconcile`] runs once at launch and makes the machine match the account.
//!
//! Everything goes through `tauri-plugin-autostart` rather than hand-written
//! per-OS registration, per the reuse rule. The plugin is registered in
//! `lib.rs` and driven from Rust only: the webview gains no permission, and
//! the single writer is `set_settings` — the same one-owner shape the hotkey
//! uses.

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_autostart::AutoLaunchManager;

/// Make the OS login item match `wanted`.
///
/// Errors are returned rather than logged-and-swallowed because the caller is
/// `set_settings`, whose contract is "the OS took it before the file says so" —
/// a refusal must reach the panel note, exactly as a hotkey another app owns
/// does.
///
/// **Tolerates the plugin being absent**, answering `Ok` after a log line: the
/// IPC gate's mock runtime and the unit tests build apps with no plugins, and a
/// settings save there is exercising the settings, not the launcher.
pub fn apply<R: Runtime>(app: &AppHandle<R>, wanted: bool) -> Result<(), String> {
    let Some(manager) = app.try_state::<AutoLaunchManager>() else {
        crate::diag::info("no autostart manager here; leaving the login item alone");
        return Ok(());
    };

    let outcome = if wanted {
        manager.enable()
    } else {
        manager.disable()
    };
    outcome.map_err(|err| format!("the login item could not be changed: {err}"))
}

/// Make this machine match the account, once, at launch.
///
/// The stored setting wins over whatever the OS currently has: the setting is
/// the user's recorded choice, and the OS state is just whichever machine they
/// happened to make it on. Quiet on success either way — a launch is not the
/// moment to announce plumbing — and a failure is a warning, not a startup
/// error: a shelf that cannot register itself should still catch captures.
pub fn reconcile<R: Runtime>(app: &AppHandle<R>, wanted: bool) {
    let Some(manager) = app.try_state::<AutoLaunchManager>() else {
        return;
    };

    match manager.is_enabled() {
        Ok(actual) if actual == wanted => {}
        Ok(_) => match apply(app, wanted) {
            Ok(()) => crate::diag::info(if wanted {
                "start-at-login is on for this account; registered on this machine"
            } else {
                "start-at-login is off for this account; unregistered on this machine"
            }),
            Err(err) => crate::diag::warn(&err),
        },
        Err(err) => crate::diag::warn(&format!("could not read the login item: {err}")),
    }
}
