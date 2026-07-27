//! In-place updates from the internal release feed.
//!
//! This is the *only* thing Shotshelf ever sends over the network, and it sends
//! nothing but its own version: the endpoint is asked whether something newer
//! exists. No capture ever leaves the device, and there is no telemetry.
//!
//! Updates are refused unless they are signed by the key whose public half is
//! in `tauri.conf.json`, so a compromised feed cannot push arbitrary code.

use tauri::{AppHandle, Runtime};
use tauri_plugin_updater::UpdaterExt;

/// Look for a newer build in the background at startup.
///
/// Deliberately quiet: an unreachable feed is the normal case on a laptop that
/// is offline, and it must never stop the shelf from doing its job.
pub fn check_on_launch<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        match app.updater() {
            Ok(updater) => match updater.check().await {
                Ok(Some(update)) => {
                    println!(
                        "shotshelf: update {} available (running {})",
                        update.version, update.current_version
                    );

                    match update.download_and_install(|_, _| {}, || {}).await {
                        Ok(()) => println!("shotshelf: update installed — restart to run it"),
                        Err(err) => eprintln!("shotshelf: could not install the update: {err}"),
                    }
                }
                Ok(None) => println!("shotshelf: already up to date"),
                Err(err) => eprintln!("shotshelf: update check failed: {err}"),
            },
            Err(err) => eprintln!("shotshelf: updater unavailable: {err}"),
        }
    });
}
