//! Asking the internal release feed whether a newer build exists.
//!
//! This is the *only* thing Shotshelf ever sends over the network, and it sends
//! nothing but its own version. No capture ever leaves the device, and there is
//! no telemetry.
//!
//! **It asks, and stops there.** It used to call `download_and_install` at every
//! launch — unattended, with no prompt and no way to decline — while this file,
//! `lib.rs` and the usage guide all described it as a check. Silently replacing
//! its own executable is not something an app whose entire pitch is restraint
//! gets to do without being asked, and an app that says it only checks must
//! only check. Installing is the user's decision, taken by running the
//! installer they choose to download.
//!
//! It can be turned off. An app that talks to exactly one endpoint, once, on
//! behalf of a user who chose it for being local-only should let that user
//! decline even that — `checkForUpdates` in the settings file, on by default.
//!
//! Releases are signed, and the plugin verifies that signature — but it does
//! so inside `download`, which this never calls. Nothing is verified here
//! because nothing is fetched here: the check reads a manifest and reports a
//! version string. The signature matters to whoever installs the build, not to
//! this file, and saying otherwise would claim a protection this code does not
//! apply.

use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_updater::UpdaterExt;

/// Event carrying the version that is available, for the shelf to mention.
pub const UPDATE_EVENT: &str = "update://available";

/// How long the feed has to answer before the check gives up.
const CHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// Look for a newer build in the background at startup.
///
/// Deliberately quiet: an unreachable feed is the normal case on a laptop that
/// is offline, and it must never stop the shelf from doing its job.
pub fn check_on_launch<R: Runtime>(app: &AppHandle<R>, wanted: bool) {
    if !wanted {
        crate::diag::info("update check is off");
        return;
    }

    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        // A deadline, because the plugin's default is none.
        //
        // The feed is an internal hostname, so off the network the lookup
        // fails fast — but a host that accepts a connection and then says
        // nothing would leave this task alive for the life of the app.
        let updater = app.updater_builder().timeout(CHECK_TIMEOUT).build();
        match updater {
            Ok(updater) => match updater.check().await {
                Ok(Some(update)) => {
                    println!(
                        "shotshelf: update {} available (running {})",
                        update.version, update.current_version
                    );
                    // Told, not done. The shelf mentions it once; nothing is
                    // downloaded and nothing is replaced.
                    let _ = app.emit(UPDATE_EVENT, update.version.clone());
                }
                Ok(None) => crate::diag::info("already up to date"),
                Err(err) => crate::diag::warn(&format!("update check failed: {err}")),
            },
            Err(err) => crate::diag::warn(&format!("updater unavailable: {err}")),
        }
    });
}
