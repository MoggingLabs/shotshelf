//! Where Shotshelf keeps things, and which root each thing belongs in.
//!
//! Two roots, and the difference between them is a privacy rule rather than a
//! filing preference. On Windows `app_data_dir()` is `%APPDATA%` — the
//! **roaming** profile, which a domain roaming profile or Enterprise State
//! Roaming copies to a network share at logoff. Anything that is a capture, a
//! path to one, or a record of what the app did with them must not go there,
//! and SECURITY.md's promise that nothing a capture touches leaves the machine
//! rests on that.
//!
//! One module rather than seven call sites, because the rule was written out
//! four times in four modules, each pointing at the others, and held by four
//! people remembering four docstrings. It also lives here rather than in
//! `cache.rs`, whose header says everything in it is re-derivable and safe to
//! delete — which is true of the poster and hand-off caches and false of the
//! pins file, the log, saved edits and clipboard captures, the last of which
//! are the only copy that exists.
//!
//! `app_data_dir` is used nowhere in this crate, and `scripts/check-dirs.mjs`
//! is what keeps it that way.

use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime};

/// A named directory under the app's **cache** root, created if absent.
///
/// For derived data only: a poster frame, a sized copy. Everything under here
/// can be worked out again from the captures, which is what makes
/// `cache::prune` acceptable at all.
pub fn cache<R: Runtime>(app: &AppHandle<R>, name: &str) -> Result<PathBuf, String> {
    under(
        app.path().app_cache_dir().map_err(|err| err.to_string())?,
        name,
    )
}

/// A named directory under the app's **local data** root, created if absent.
///
/// For things that are not re-derivable: the pins file, the diagnostic log,
/// saved edits, and clipboard captures — which never touched the disk anywhere
/// else and are the only copy in existence. Local, never roaming; see the
/// module header for why that is a privacy rule.
///
/// An empty `name` gives the root itself.
pub fn local<R: Runtime>(app: &AppHandle<R>, name: &str) -> Result<PathBuf, String> {
    under(
        app.path()
            .app_local_data_dir()
            .map_err(|err| err.to_string())?,
        name,
    )
}

fn under(root: PathBuf, name: &str) -> Result<PathBuf, String> {
    let dir = if name.is_empty() {
        root
    } else {
        root.join(name)
    };
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}
