//! Where Shotshelf keeps things, and which root each thing belongs in.
//!
//! Three roots, and the difference between them is a privacy rule rather than a
//! filing preference. On Windows `app_data_dir()` is `%APPDATA%` — the
//! **roaming** profile, which a domain roaming profile or Enterprise State
//! Roaming copies to a network share at logoff. Anything that is a capture, a
//! path to one, or a record of what the app did with them must not go there,
//! and SECURITY.md's promise that nothing a capture touches leaves the machine
//! rests on that.
//!
//! One module rather than a call site per consumer, because the rule was written out
//! four times in four modules, each pointing at the others, and held by four
//! people remembering four docstrings. It also lives here rather than in
//! `cache.rs`, whose header says everything in it is re-derivable and safe to
//! delete — which is true of the poster and hand-off caches and false of the
//! pins file, the log, saved edits and clipboard captures, the last of which
//! are the only copy that exists.
//!
//! Three roots, and every one of them is resolved here: `preferences` (roaming
//! — settings only), `local` (never roaming — anything naming a capture) and
//! `cache` (re-derivable). `scripts/check-dirs.mjs` is what keeps it that way,
//! and `clippy.toml` refuses the underlying calls anywhere else.

// No blanket `#![allow(clippy::disallowed_methods)]` here.
//
// This module is allowed to resolve a root — that is the whole point of it —
// but a file-scope allowance covers *every* entry in `clippy.toml`, including
// `Scope::allow_directory`, which this module has no business calling. A
// reviewer put a directory grant in `dirs::cache` and the whole gate accepted
// it: the script skipped this file outright and the allowance below covered
// the rest. Each root resolver now carries its own, at the call.

use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime};

/// A named directory under the app's **cache** root, created if absent.
///
/// For derived data only: a poster frame, a sized copy. Everything under here
/// can be worked out again from the captures, which is what makes
/// `cache::prune` acceptable at all.
pub fn cache<R: Runtime>(app: &AppHandle<R>, name: &str) -> Result<PathBuf, String> {
    // On the statement, not the function. A function-scope allowance covers the
    // whole body — including a `Scope::allow_directory` this module must never
    // call, which is exactly what a reviewer planted here and clippy accepted.
    #[allow(clippy::disallowed_methods)]
    let root = app.path().app_cache_dir().map_err(|err| err.to_string())?;
    under(root, name)
}

/// The **preferences** root, created if absent.
///
/// The one place roaming is acceptable, and the only place: a hotkey and an
/// item cap are settings a person would want to follow them between machines.
///
/// On Windows `app_config_dir()` and `app_data_dir()` resolve to **the same
/// directory** — `dirs` maps both to `known_folder_roaming_app_data` — so this
/// is the roaming profile under a different name. That is exactly why it lives
/// here rather than being called wherever it is needed: the rule is not "avoid
/// one function", it is "know which root you are in and what may go in it".
/// A gate that forbade only the `app_data_dir` spelling reported success on a
/// tree calling `app_config_dir` for the same directory.
///
/// **Nothing that names a capture may be written here.** `check-dirs.mjs`
/// keeps this to one caller — `settings.rs`, for `settings.json` alone —
/// because this function being `pub` was otherwise the whole enforcement: a
/// module could call the correct helper for the wrong data and both gates
/// would pass, since they check that a root is resolved *through* here, not
/// that the right root was chosen. `settings.rs::persist`
/// blanks `pinned` before serialising for that reason, and a test asserts it.
pub fn preferences<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    #[allow(clippy::disallowed_methods)]
    let root = app.path().app_config_dir().map_err(|err| err.to_string())?;
    under(root, "")
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
    #[allow(clippy::disallowed_methods)]
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|err| err.to_string())?;
    under(root, name)
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
