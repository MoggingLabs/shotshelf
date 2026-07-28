//! Where captures land, per OS.
//!
//! Windows has a fixed set of folders; macOS stores the destination in a
//! preference domain, so it has to be resolved at runtime.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use tauri::{AppHandle, Manager, Runtime};

/// Resolve the folders to watch.
///
/// A non-empty `overrides` list replaces the per-OS defaults entirely. Either
/// way the result is filtered to directories that exist and de-duplicated —
/// on Windows, Pictures redirected into OneDrive would otherwise be watched twice.
pub fn resolve_watch_dirs<R: Runtime>(app: &AppHandle<R>, overrides: &[PathBuf]) -> Vec<PathBuf> {
    let candidates = if overrides.is_empty() {
        defaults(app)
    } else {
        overrides.to_vec()
    };

    settle(candidates)
}

/// Turn a candidate list into the folders actually watched.
///
/// Split from `resolve_watch_dirs` so the create-and-filter rule can be tested
/// without an `AppHandle` — the rule is where the interesting decisions are,
/// and it had no coverage while it was inlined above `defaults()`.
fn settle(candidates: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        // Created if it is missing — but only where the *parent* is already
        // there, which is the whole of the rule.
        //
        // `Pictures\Screenshots` does not exist on a Windows machine until the
        // first Win+PrtSc, so filtering on `is_dir()` alone meant a fresh
        // install reported "no capture folders found", watched nothing, and
        // stayed that way until it was restarted — the app's one job failing
        // on first run for the most ordinary user there is.
        //
        // The first attempt at that used `create_dir_all` on every candidate,
        // and the candidate list is full of *guesses*: on a machine that has
        // never used OneDrive it invented `%USERPROFILE%\OneDrive\Pictures\
        // Screenshots`, parents and all, from an app whose pitch is that it
        // does not touch your things — and `allow_reading_captures` then
        // granted the asset scope over a directory Shotshelf had made up.
        //
        // Requiring the parent turns "create the leaf the OS is about to
        // create anyway" into exactly that: `Pictures` exists, so
        // `Pictures\Screenshots` is created; `OneDrive` does not, so nothing
        // is. `create_dir` rather than `create_dir_all` for the same reason —
        // it cannot build a tree.
        .inspect(|dir| {
            let parent_is_there = dir.parent().is_some_and(Path::is_dir);
            if parent_is_there && !dir.exists() {
                let _ = std::fs::create_dir(dir);
            }
        })
        .filter(|dir| dir.is_dir())
        .filter(|dir| seen.insert(dedupe_key(dir)))
        .collect()
}

/// Canonical form is only used to compare paths, never to watch them — keeping
/// the original spelling keeps Windows' `\\?\` prefix out of event payloads.
fn dedupe_key(dir: &Path) -> PathBuf {
    std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf())
}

/// Windows: Snip & Sketch / Win+PrtSc, Xbox Game Bar, Snipping Tool video, and
/// the OneDrive copy of Pictures when backup is on.
#[cfg(target_os = "windows")]
fn defaults<R: Runtime>(app: &AppHandle<R>) -> Vec<PathBuf> {
    let path = app.path();
    let mut dirs = Vec::new();

    if let Ok(pictures) = path.picture_dir() {
        dirs.push(pictures.join("Screenshots"));
    }
    if let Ok(videos) = path.video_dir() {
        dirs.push(videos.join("Captures")); // Xbox Game Bar
        dirs.push(videos.join("Screen Recordings")); // Snipping Tool video
    }
    if let Ok(home) = path.home_dir() {
        // Present when OneDrive backs up Pictures but the known folder has not
        // been redirected, so `picture_dir()` still points at the local copy.
        dirs.push(home.join("OneDrive").join("Pictures").join("Screenshots"));
    }

    dirs
}

/// macOS: one folder, but the user can move it, so ask the preference domain.
/// ⌘⇧5 recordings are written to the same place.
#[cfg(target_os = "macos")]
fn defaults<R: Runtime>(app: &AppHandle<R>) -> Vec<PathBuf> {
    let home = app.path().home_dir().ok();

    let configured = screencapture_location(home.as_deref());
    let fallback = home.map(|home| home.join("Desktop"));

    configured.or(fallback).into_iter().collect()
}

/// Reads `defaults read com.apple.screencapture location`. This is a local
/// preference lookup — no network, and it fails quietly when the key was never
/// set (the common case, meaning `~/Desktop`).
///
/// Changing the location takes effect on the next Shotshelf start, which is what
/// `defaults write com.apple.screencapture location …` users expect.
#[cfg(target_os = "macos")]
fn screencapture_location(home: Option<&Path>) -> Option<PathBuf> {
    let output = std::process::Command::new("defaults")
        .args(["read", "com.apple.screencapture", "location"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let raw = String::from_utf8(output.stdout).ok()?;
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }

    Some(expand_tilde(raw, home))
}

#[cfg(target_os = "macos")]
fn expand_tilde(raw: &str, home: Option<&Path>) -> PathBuf {
    match (raw.strip_prefix("~/"), home) {
        (Some(rest), Some(home)) => home.join(rest),
        _ if raw == "~" => home.map(Path::to_path_buf).unwrap_or_else(|| raw.into()),
        _ => PathBuf::from(raw),
    }
}

/// Linux: no single agreed location, so watch the handful the common tools
/// actually use.
///
/// GNOME Screenshot and the XDG desktop portal write to `~/Pictures/Screenshots`;
/// KDE's Spectacle and Flameshot default to `~/Pictures`; GNOME's recorder puts
/// screencasts in `~/Videos`. Missing directories are filtered out by the
/// caller, so listing all of them costs nothing on a desktop that uses one.
///
/// Untested: this is compile-verified only — there is no Linux machine here.
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn defaults<R: Runtime>(app: &AppHandle<R>) -> Vec<PathBuf> {
    let path = app.path();
    let mut dirs = Vec::new();

    if let Ok(pictures) = path.picture_dir() {
        dirs.push(pictures.join("Screenshots"));
        dirs.push(pictures);
    }
    if let Ok(videos) = path.video_dir() {
        dirs.push(videos.join("Screencasts"));
        dirs.push(videos);
    }

    dirs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_capture_folder_is_created_only_beside_an_existing_parent() {
        // The leaf the OS is about to create anyway: yes. A speculative tree
        // on a machine that has never used OneDrive: no — an earlier version
        // called `create_dir_all` on every candidate and invented exactly
        // that, then granted the asset scope over it.
        let root = std::env::temp_dir().join("shotshelf-watch-create-test");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("Pictures")).expect("a real parent");

        let leaf = root.join("Pictures").join("Screenshots");
        let invented = root.join("OneDrive").join("Pictures").join("Screenshots");

        let watched = settle(vec![leaf.clone(), invented.clone()]);

        assert!(
            leaf.is_dir(),
            "the leaf beside an existing parent is created"
        );
        assert!(!invented.exists(), "a speculative tree is left alone");
        assert!(!root.join("OneDrive").exists(), "and so is its root");
        assert_eq!(watched, vec![leaf]);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_same_folder_named_twice_is_watched_once() {
        let root = std::env::temp_dir().join("shotshelf-watch-dedupe-test");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("Pictures")).expect("a real dir");

        let dir = root.join("Pictures");
        assert_eq!(settle(vec![dir.clone(), dir.clone()]).len(), 1);

        let _ = std::fs::remove_dir_all(&root);
    }
}
