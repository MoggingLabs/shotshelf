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
/// way the user's settings are applied on top — folders they added joined,
/// folders they removed subtracted — and the result is filtered to
/// directories that exist and de-duplicated — on Windows, Pictures redirected
/// into OneDrive would otherwise be watched twice.
pub fn resolve_watch_dirs<R: Runtime>(app: &AppHandle<R>, overrides: &[PathBuf]) -> Vec<PathBuf> {
    let candidates = if overrides.is_empty() {
        defaults(app)
    } else {
        overrides.to_vec()
    };

    // Read from state rather than disk: `set_settings` has already stored the
    // lists by the time it asks for a rewatch, and at launch `reserve` put the
    // store in place before the engine starts. Absent state (unit tests build
    // bare apps) means no choices, which is the default install.
    let (added, removed) = app
        .try_state::<crate::settings::SettingsStore>()
        .map(|store| {
            let settings = store.get();
            (settings.watch_added, settings.watch_removed)
        })
        .unwrap_or_default();

    settle(
        apply_choices(candidates, &added, &removed),
        app.path().home_dir().ok().as_deref(),
    )
}

/// The user's watch choices, applied to the platform's candidates.
///
/// Added folders join the end, and removals are applied *after* — so a path
/// somehow present in both lists stays unwatched, which is the predictable
/// reading of "stop watching this". Order is preserved: the first entry stays
/// the primary screenshots location the tray's "Open the screenshots folder"
/// opens, unless the user removed exactly that.
fn apply_choices(candidates: Vec<PathBuf>, added: &[String], removed: &[String]) -> Vec<PathBuf> {
    let removed: HashSet<PathBuf> = removed.iter().map(PathBuf::from).collect();
    candidates
        .into_iter()
        .chain(added.iter().map(PathBuf::from))
        .filter(|dir| !removed.contains(dir))
        .collect()
}

/// Turn a candidate list into the folders actually watched.
///
/// Split from `resolve_watch_dirs` so the create-and-filter rule can be tested
/// without an `AppHandle` — the rule is where the interesting decisions are,
/// and it had no coverage while it was inlined above `defaults()`.
fn settle(candidates: Vec<PathBuf>, home: Option<&Path>) -> Vec<PathBuf> {
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
            // Only a leaf *inside* an existing capture folder, never a folder
            // directly under `$HOME`.
            //
            // The rule was "create it if its parent is a directory", justified
            // as making the leaf the OS is about to make anyway. On Linux the
            // candidate list carries `~/Pictures` and `~/Videos` themselves,
            // whose parent is `$HOME` and therefore always there — so on a
            // machine with neither, an app whose pitch is that it does not touch
            // your things created two top-level folders and then granted the
            // webview read over them. That is not the leaf anyone was about to
            // make.
            // Compared through `dedupe_key`, not by spelling.
            //
            // `home` comes from `app.path().home_dir()`, and a candidate's
            // parent comes from `picture_dir()`/`video_dir()` — XDG on Linux,
            // which reads `user-dirs.dirs` — or from `home.join(..)`. Any
            // difference in how the same directory is written makes `==` false
            // and the guard inert: a symlinked home (`/home/me` against
            // `/var/home/me` on an rpm-ostree distro), a trailing separator out
            // of `user-dirs.dirs`, a case difference on a case-insensitive
            // mount. `dedupe_key` two functions down already canonicalises for
            // exactly this reason, and this comparison was the one that did not.
            let parent = dir.parent();
            let parent_is_there = parent.is_some_and(Path::is_dir);
            let parent_is_home = match (parent, home) {
                (Some(parent), Some(home)) => dedupe_key(parent) == dedupe_key(home),
                _ => false,
            };
            if parent_is_there && !parent_is_home && !dir.exists() {
                let _ = std::fs::create_dir(dir);
            }
        })
        // Said out loud. `docs/USAGE.md` sends the user to `shotshelf.log` to
        // find out "which folder failed and why" when nothing appears, and
        // this is one of the two places a folder can vanish from the watch
        // list — the other is `mod.rs::scan`. Both were silent, so the one
        // documented diagnostic for the app's central failure printed nothing
        // at all and the user was told to read an empty answer.
        //
        // Not an error: a machine without `~/Desktop` is ordinary, and this
        // list is candidates rather than requirements. It is written down
        // because "the folder I expected is not being watched" is otherwise
        // indistinguishable from "the watcher is broken".
        .filter(|dir| {
            let there = dir.is_dir();
            if !there {
                crate::diag::info(&format!("not watching {} — no such folder", dir.display()));
            }
            there
        })
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
    let home = path.home_dir().ok();
    let mut dirs = Vec::new();

    // `home_dir()` really is the fallback here now.
    //
    // The Linux branch's comment claimed Windows already had one — "which
    // Windows and macOS both avoid by falling back (`home_dir()` and
    // `~/Desktop` respectively)" — and it did not: `home_dir()` was used only
    // to add the OneDrive candidate. So on the machine this module's own
    // history keeps citing, a known folder redirected to an offline share,
    // `picture_dir()` errs and three of the four candidates simply vanish,
    // leaving "clipboard watch only" on the primary platform.
    //
    // `settle` filters what is not there, so naming a folder that does not
    // exist costs nothing; naming none costs the user every screenshot.
    let pictures = under_home(path.picture_dir().ok(), home.as_deref(), "Pictures");
    let videos = under_home(path.video_dir().ok(), home.as_deref(), "Videos");

    if let Some(pictures) = pictures {
        dirs.push(pictures.join("Screenshots"));
    }
    if let Some(videos) = videos {
        dirs.push(videos.join("Captures")); // Xbox Game Bar
        dirs.push(videos.join("Screen Recordings")); // Snipping Tool video
    }
    if let Some(home) = home {
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

    macos_candidates(
        screencapture_location(home.as_deref()),
        home.map(|home| home.join("Desktop")),
    )
}

/// A known folder, or the same-named folder under `$HOME` when the OS will not
/// say where it is.
///
/// Not `cfg`-gated, so it has a test on every platform — the same reason
/// [`macos_candidates`] and `settle` were pulled out of platform-specific code,
/// with the same history behind it: while the Windows fallback was eight lines
/// inline in `cfg(windows)` `defaults`, deleting it left every test green.
///
/// `settle` filters what is not there, so naming a folder that does not exist
/// costs nothing; naming none costs the user every screenshot.
// Compiled everywhere, called from the Windows and Linux branches — which was
// asserted before it was true. The Linux branch restated the same rule inline
// instead, so on Linux this had no non-test caller at all and `-D warnings`
// failed the build with `function 'under_home' is never used`. CI builds all
// three, which is the only reason that would have been caught.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn under_home(known: Option<PathBuf>, home: Option<&Path>, name: &str) -> Option<PathBuf> {
    known.or_else(|| home.map(|home| home.join(name)))
}

/// The macOS candidate list: the configured location if it is really there,
/// otherwise `~/Desktop`.
///
/// Not `cfg`-gated, so it has a test on every platform.
///
/// This was `configured.or(fallback)`, which branches on `Option`-ness and not
/// on whether the folder exists: `screencapture_location` returns `Some(..)` for
/// any non-empty `defaults read`, with no `is_dir` check and no requirement that
/// the path be absolute. One stale preference — an unmounted volume, a deleted
/// folder — took the fallback out of play, `settle` dropped the dead path, and
/// macOS ended with *nothing* watched on a machine whose `~/Desktop` is right
/// there. It is the only platform whose list had a single element.
///
/// The fix for that was briefly "push both", which fixed the emptiness and
/// bought a worse problem: a Mac that has deliberately moved its screenshots
/// elsewhere had its **whole Desktop** watched anyway — every image and video
/// sitting in it granted to the webview, up to twenty of them backfilled onto
/// the shelf as captures, and the column popping when anything was saved there.
/// README.md, the folder table in `docs/USAGE.md` and that file's own
/// broad-watching disclosure all said "else"/"otherwise", and all three were
/// then wrong about the one platform they were describing.
///
/// Checking the folder instead of the `Option` fixes the original defect
/// without widening anything: a configured location that is not a directory is
/// not a place captures are landing right now, so `~/Desktop` takes over — and
/// when the configured one is real, it is the only thing watched, which is what
/// every document already promised.
// Compiled everywhere, called from the macOS branch and from the test below.
// That is the point: while this decision lived inside `cfg(macos)` it was
// unreachable from the machine this is developed on, which is how it shipped.
// `dead_code` only — nothing here silences a `clippy.toml` rule.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn macos_candidates(configured: Option<PathBuf>, desktop: Option<PathBuf>) -> Vec<PathBuf> {
    configured
        .filter(|dir| dir.is_dir())
        .or(desktop)
        .into_iter()
        .collect()
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

    // `picture_dir()` reads XDG user-dirs and nothing else — no `$HOME/Pictures`
    // fallback, no `$XDG_PICTURES_DIR` — so on an install without
    // `xdg-user-dirs` it returns `Err` and this returned an empty list. The user
    // then got "no capture folders found — clipboard watch only" on a machine
    // that has `~/Pictures`, which Windows and macOS both avoid by falling back
    // (`home_dir()` and `~/Desktop` respectively). Linux was the one OS with no
    // fallback at all.
    let home = path.home_dir().ok();
    let pictures = under_home(path.picture_dir().ok(), home.as_deref(), "Pictures");
    let videos = under_home(path.video_dir().ok(), home.as_deref(), "Videos");

    // The specific folder first, then its parent.
    //
    // The parent is deliberate and it is broad: `catch::allow_reading_captures`
    // grants the webview asset-protocol read over exactly this list, so on Linux
    // that is every image and video sitting directly in `~/Pictures` and
    // `~/Videos`. Windows grants several leaf folders and macOS one — `docs/USAGE.md` has the list. It is here
    // because Linux has no single conventional screenshot directory — GNOME,
    // KDE and Flameshot each choose differently, and several write straight into
    // `~/Pictures` — so watching only the leaf would catch nothing on most
    // desktops. `docs/USAGE.md` states the breadth rather than leaving it to be
    // discovered.
    if let Some(pictures) = pictures {
        dirs.push(pictures.join("Screenshots"));
        dirs.push(pictures);
    }
    if let Some(videos) = videos {
        dirs.push(videos.join("Screencasts"));
        dirs.push(videos);
    }

    dirs
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_known_folder_falls_back_to_the_same_name_under_home() {
        // The Windows fallback, testable on every platform.
        //
        // While it was eight lines inline in `cfg(windows)` `defaults`, deleting
        // it left all 144 tests green — and its own comment credited Windows
        // with a fallback it did not have, which is what prompted adding one.
        // The failure it covers is a known folder the OS will not resolve: three
        // of the four Windows candidates vanish and the user gets "clipboard
        // watch only" on the primary platform.
        let home = PathBuf::from("/home/someone");
        let known = PathBuf::from("/mnt/media/Pictures");

        assert_eq!(
            under_home(Some(known.clone()), Some(&home), "Pictures"),
            Some(known),
            "a known folder the OS did resolve is used as it is"
        );
        assert_eq!(
            under_home(None, Some(&home), "Pictures"),
            Some(home.join("Pictures")),
            "and one it would not resolve falls back under $HOME"
        );
        // No home either is not an error; the caller simply has no candidate.
        assert_eq!(under_home(None, None, "Pictures"), None);
    }

    #[test]
    fn the_macos_desktop_fallback_survives_a_stale_preference() {
        // `configured.or(desktop)` branched on `Option`-ness, so a
        // `com.apple.screencapture location` pointing at an unmounted volume
        // took `~/Desktop` out of play and macOS — the only platform with a
        // one-element list — watched nothing at all.
        //
        // Testable here because the decision is no longer inside the
        // `cfg(macos)` function: it was unreachable from this machine, which is
        // how it shipped.
        let gone = PathBuf::from("/Volumes/gone/Shots");
        let desktop = std::env::temp_dir().join("shotshelf-macos-desktop-test");
        std::fs::create_dir_all(&desktop).expect("a real desktop");

        assert_eq!(
            macos_candidates(Some(gone.clone()), Some(desktop.clone())),
            vec![desktop.clone()],
            "a configured location that is not there hands over to the desktop"
        );

        // The other half, and the one that keeps the watch list narrow: a
        // configured location that really exists is watched *instead of* the
        // desktop, not as well as it. Pushing both was the previous fix, and it
        // meant a Mac that had deliberately moved its screenshots elsewhere had
        // its whole Desktop watched, granted to the webview and backfilled —
        // while all three documents said "otherwise".
        let real = std::env::temp_dir().join("shotshelf-macos-configured-test");
        std::fs::create_dir_all(&real).expect("a real configured folder");
        assert_eq!(
            macos_candidates(Some(real.clone()), Some(desktop.clone())),
            vec![real.clone()],
            "a configured location that is there is the only one watched"
        );

        // Either one missing is not an error; `settle` filters the rest.
        assert_eq!(
            macos_candidates(None, Some(desktop.clone())),
            vec![desktop.clone()]
        );
        assert_eq!(macos_candidates(Some(gone), None), Vec::<PathBuf>::new());
        assert!(macos_candidates(None, None).is_empty());

        let _ = std::fs::remove_dir_all(&desktop);
        let _ = std::fs::remove_dir_all(&real);
    }

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

        // `Some(&root)` standing in for `$HOME`, which is what production
        // passes. Both callers here used to pass `None`, and with no home the
        // `parent_is_home` term is `false` for every candidate — so the guard
        // could not change any assertion in the suite, and deleting it left all
        // 142 tests and clippy green. The one configuration it was written for
        // was the only one never tested.
        let watched = settle(vec![leaf.clone(), invented.clone()], Some(&root));

        assert!(
            leaf.is_dir(),
            "the leaf beside an existing parent is created"
        );
        assert!(!invented.exists(), "a speculative tree is left alone");
        assert!(!root.join("OneDrive").exists(), "and so is its root");
        assert_eq!(watched, vec![leaf]);

        // And nothing is created directly under the home directory itself.
        //
        // This is the Linux case, not a hypothetical: `defaults()` there pushes
        // `~/Pictures` and `~/Videos` *themselves* into the candidate list, and
        // their parent — `$HOME` — always exists. Without the guard, a machine
        // with neither folder gets both invented by an app whose pitch is that
        // it does not touch your things, and `allow_reading_captures` then
        // grants the webview read over the two directories it just made.
        let home_level = root.join("Videos");
        let watched_home = settle(vec![home_level.clone()], Some(&root));
        assert!(
            !home_level.exists(),
            "a folder whose parent is $HOME is not created"
        );
        assert!(
            watched_home.is_empty(),
            "and nothing that is not there is watched"
        );

        // The same thing with the home directory written differently, because
        // this comparison used to be `==` on the spelling and so went inert the
        // moment the two sides disagreed about how to write one path — a
        // symlinked home (`/home/me` against `/var/home/me` on an rpm-ostree
        // distro), a trailing separator out of `user-dirs.dirs`, a case
        // difference on a case-insensitive mount. None of those is portably
        // constructible in a test.
        //
        // `Pictures/..` is, and it is the same directory. It has to be `..`
        // rather than `.` or a trailing separator: `Path`'s own `==` compares
        // `components()`, which normalises both of those away, so they are not
        // different spellings as far as the code under test is concerned —
        // a fixture that looks like it varies the input and does not. `..` is a
        // `ParentDir` component that survives, and `canonicalize` resolves it.
        let spelled_differently = root.join("Pictures").join("..");
        let beside_it = root.join("Videos2");
        let watched_other = settle(vec![beside_it.clone()], Some(&spelled_differently));
        assert!(
            !beside_it.exists(),
            "the guard holds however the home directory is spelled"
        );
        assert!(watched_other.is_empty());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_same_folder_named_twice_is_watched_once() {
        let root = std::env::temp_dir().join("shotshelf-watch-dedupe-test");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("Pictures")).expect("a real dir");

        let dir = root.join("Pictures");
        assert_eq!(settle(vec![dir.clone(), dir.clone()], None).len(), 1);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_users_choices_shape_the_watch_list() {
        let defaults = vec![PathBuf::from("/d/one"), PathBuf::from("/d/two")];

        // A removed default is gone; an added folder joins the end; order —
        // and with it the tray's "first watched folder" — is preserved.
        let shaped = apply_choices(
            defaults.clone(),
            &["/mine/extra".to_owned()],
            &["/d/two".to_owned()],
        );
        assert_eq!(
            shaped,
            vec![PathBuf::from("/d/one"), PathBuf::from("/mine/extra")]
        );

        // Removals the defaults do not contain are harmless — they may name a
        // default on the *other* machine this file roams to.
        let unknown = apply_choices(defaults.clone(), &[], &["/not/here".to_owned()]);
        assert_eq!(unknown, defaults);

        // A path in both lists stays unwatched: "stop watching" always wins.
        let both = apply_choices(
            defaults,
            &["/mine/extra".to_owned()],
            &["/mine/extra".to_owned()],
        );
        assert_eq!(both, vec![PathBuf::from("/d/one"), PathBuf::from("/d/two")]);
    }
}
