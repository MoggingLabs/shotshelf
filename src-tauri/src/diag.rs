//! Diagnostics that can actually be read.
//!
//! `main.rs` sets `windows_subsystem = "windows"` for release builds, which is
//! correct — a tray utility must not open a console window — and means a
//! packaged Windows build has no stdout or stderr attached to anything. Every
//! `eprintln!` in this crate went nowhere, including the ones that explain the
//! failures the UI cannot: "no capture folders found", "cannot watch {dir}",
//! "could not save the clipboard image", "{accelerator} could not be
//! registered", "could not save settings". The usage guide said to run the
//! installed binary from a terminal to see them; on Windows that produces
//! nothing at all.
//!
//! So these go to a file as well as to stderr. A file is readable on every
//! platform, survives the session, and is something a user can attach to a bug
//! report — which is the only reason any of this is written down.
//!
//! Hand-rolled rather than adopting `tauri-plugin-log`, and the reason first
//! given for that was wrong: it said the manifest could not be edited, which
//! turned out to be false when it was actually tested (see SECURITY.md). So
//! the decision has to stand on its own merits, and it does — this is a
//! **policy boundary, not a logging framework**.
//!
//! What earns its place is the contract below: two levels, one destination,
//! and a stated rule about what may be written. A general-purpose logger takes
//! whatever any call site passes it, which is precisely the property this must
//! not have — the app's whole privacy claim is that captures do not leave the
//! machine, and this writes to a file that outlives the session. Sixty lines
//! with the rule enforced by the vocabulary beats a dependency that would
//! happily log a window title.
//!
//! If richer plumbing is ever wanted — rotation, levels, forwarding to the
//! webview — the plugin is the right way to get it, and `warn`/`info` are the
//! right things to keep in front of it.
//!
//! **What may go through here, exactly.** Two things, and no others:
//!
//! * **Watch-folder paths.** A folder the user chose, and the only useful
//!   answer to "why is nothing appearing" — which is what this file exists to
//!   answer, and what `docs/USAGE.md` tells the user to attach to a report.
//! * **Capture *file names*.** Never full capture paths.
//!
//! Never: a capture's directory, a window title, or recognised text. The
//! reasoning is `catch/mod.rs`'s — a capture's *path* carries client and
//! project names as readily as a window title does — and it applies with more
//! force here, because this file outlives the session.
//!
//! The distinction is not a hedge. A user pointing `SHOTSHELF_WATCH_DIRS` at
//! `D:\Clients\Acme\Captures` has told Shotshelf to watch that folder and
//! needs to see it named when the watch fails; they have not asked for every
//! screenshot's full path written down. An earlier version of this paragraph
//! said "never paths" while three call sites logged folder paths, which is the
//! defect this whole review cycle keeps finding.

use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Runtime};

/// Where the log goes, once the app handle is available.
///
/// `OnceLock` because diagnostics start before `setup` runs — `settings::load`
/// and `hotkey::register` both report — and a log that only works after
/// start-up would miss the failures most worth having.
static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

/// One writer, so two threads cannot interleave half-lines.
fn writer() -> &'static Mutex<()> {
    static LOCK: Mutex<()> = Mutex::new(());
    &LOCK
}

/// How large the log may get before it is started over.
///
/// This is a tray app expected to run for weeks: an append-only file with a
/// line per capture is a slow leak. Restarted rather than rotated — one
/// previous generation is not worth the complexity when the whole point is the
/// last few minutes before something went wrong.
const MAX_LOG_BYTES: u64 = 512 * 1024;

/// Point diagnostics at the app's own data directory. Called once, at start-up.
///
/// Local app data, not `%APPDATA%`: this file names what the app was doing,
/// and the roaming profile is copied to a network share at logoff. Same rule
/// `catch/clipboard.rs` states for captures themselves.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    // Local app data, never roaming — see `dirs::local`. This file names
    // what the app was doing, and the roaming profile is copied to a network
    // share at logoff.
    let Ok(dir) = crate::dirs::local(app, "") else {
        return;
    };
    init_in(&dir);
}

/// The directory half, so the behaviour can be tested without an app handle.
fn init_in(dir: &std::path::Path) {
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let _ = LOG_PATH.set(dir.join("shotshelf.log"));
}

/// Something went wrong that a user might need to know about.
pub fn warn(message: &str) {
    record("WARN", message);
}

/// Something happened that is worth following in a bug report.
pub fn info(message: &str) {
    record("INFO", message);
}

fn record(level: &str, message: &str) {
    // Still to stderr: a dev build has a console, and that is where anyone
    // running `npm run tauri dev` is looking.
    eprintln!("shotshelf: {message}");

    let Some(path) = LOG_PATH.get() else {
        return;
    };
    let Ok(_guard) = writer().lock() else {
        return;
    };

    if std::fs::metadata(path).is_ok_and(|meta| meta.len() > MAX_LOG_BYTES) {
        let _ = std::fs::remove_file(path);
    }

    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    else {
        return;
    };
    // No timestamp: formatting one needs a date library this crate does not
    // have, and ordering within the file already answers "what happened
    // before what", which is what these lines are read for.
    let _ = writeln!(file, "[{level}] {message}");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One test, because `LOG_PATH` is a `OnceLock` and can only be set once
    /// per process. The three properties it covers are each load-bearing.
    #[test]
    fn diagnostics_reach_a_file_and_that_file_stays_bounded() {
        // 1. Safe before `init`. Diagnostics start before `setup` runs —
        //    `settings::load` and `hotkey::register` both report — so writing
        //    with nowhere to write must be a no-op, not a panic.
        assert!(LOG_PATH.get().is_none(), "not initialised yet");
        warn("a warning with nowhere to go");

        let dir = std::env::temp_dir().join(format!("shotshelf-diag-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        init_in(&dir);
        let path = LOG_PATH.get().expect("initialised");

        // 2. It actually lands. This is the whole point: on a packaged Windows
        //    build there is no console, so a diagnostic that only reaches
        //    stderr reaches nobody.
        warn("cannot watch a folder");
        info("caught Image shot.png");
        let written = std::fs::read_to_string(path).expect("the log exists");
        assert!(written.contains("[WARN] cannot watch a folder"));
        assert!(written.contains("[INFO] caught Image shot.png"));

        // 3. It is bounded. A tray app runs for weeks and writes a line per
        //    capture; an append-only file is a slow leak. Started over rather
        //    than rotated, because what is worth keeping is the last few
        //    minutes before something went wrong.
        std::fs::write(
            path,
            vec![b'x'; usize::try_from(MAX_LOG_BYTES).unwrap() + 1],
        )
        .expect("a large log");
        warn("the line that triggers the restart");
        let after = std::fs::read_to_string(path).expect("the log still exists");
        assert!(
            after.len() < usize::try_from(MAX_LOG_BYTES).unwrap(),
            "the log was not restarted: {} bytes",
            after.len(),
        );
        assert!(after.contains("the line that triggers the restart"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
