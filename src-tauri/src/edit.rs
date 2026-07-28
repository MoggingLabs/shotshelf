//! Making a new capture out of ones you already have.
//!
//! Putting a before and an after side by side. It produces a **new file**
//! and leaves the originals exactly where the OS wrote them — the shelf has
//! never modified a capture and does not start here.
//!
//! Edits are written to Shotshelf's own data directory rather than back into
//! your Pictures folder. Two reasons: the folder Shotshelf watches is the
//! folder it would be writing into, so an edit saved there would be caught as
//! a fresh capture and bounce; and an app that writes into the directory it is
//! watching is one bug away from a loop.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

use crate::imaging::{self, compare};

/// Where edits live, under the app's data directory.
const EDITS_DIR: &str = "edits";

/// How many edits to keep. They are captures in their own right rather than a
/// cache, so this is generous — but not unbounded: a comparison of two 4K
/// screenshots is a full-resolution PNG, and this was the only picture-holding
/// directory in the app with no ceiling at all.
const EDITS_LIMIT: usize = 200;

/// Let the webview display edits from previous sessions.
///
/// Called at start-up, beside the grants for the watch folders and the poster
/// cache. It used to be done only by `write_edit`, i.e. only in the session
/// that wrote the file — so a pinned edit came back after a restart, was
/// refused by the asset protocol, and rendered as the "file has gone" glyph
/// while sitting on disk. Drag and copy still worked, which is exactly what
/// made it quiet.
pub fn allow_reading_edits<R: Runtime>(app: &AppHandle<R>) {
    let Ok(dir) = edits_dir(app) else {
        return;
    };
    if let Err(err) = app.asset_protocol_scope().allow_directory(&dir, false) {
        eprintln!("shotshelf: saved edits may not display ({err})");
    }
}

/// Drop the oldest edits once there are more than the ceiling allows.
///
/// Oldest first by modified time, like the other two caches. These are the
/// user's own work, so the ceiling is high and the removal is quiet.
pub fn prune<R: Runtime>(app: &AppHandle<R>) {
    let Ok(dir) = edits_dir(app) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };

    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|entry| entry.path().is_file())
        .filter_map(|entry| {
            let modified = entry.metadata().and_then(|meta| meta.modified()).ok()?;
            Some((modified, entry.path()))
        })
        .collect();

    if files.len() <= EDITS_LIMIT {
        return;
    }

    files.sort_unstable_by_key(|(modified, _)| *modified);
    for (_, path) in files.iter().take(files.len() - EDITS_LIMIT) {
        let _ = std::fs::remove_file(path);
    }
}

fn edits_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join(EDITS_DIR);
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

/// Put two captures side by side, with what changed outlined on the second.
#[tauri::command]
pub async fn compare_captures<R: Runtime>(
    app: AppHandle<R>,
    before: String,
    after: String,
) -> Result<String, String> {
    let before_path = existing(&before)?;
    let after_path = existing(&after)?;
    let name_source = after_path.clone();

    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let before = imaging::load(&before_path)?;
        let after = imaging::load(&after_path)?;
        let changes = compare::changed_regions(&before, &after, compare::Sensitivity::default());
        imaging::to_png(&compare::side_by_side(&before, &after, &changes))
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(String::from)?;

    write_edit(&app, &name_source, "compared", &bytes)
}

/// Save an annotated copy of a capture.
///
/// The bytes are a PNG the front-end has already composited on a canvas, which
/// is what makes redaction real rather than decorative: the marks are drawn
/// *into* the pixels before encoding, so what arrives here has no layer to
/// peel off and no original underneath. Rust's job is to put it somewhere and
/// tell the shelf where — deliberately not to re-render it, because a second
/// renderer would drift from the one the user was looking at.
///
/// The source is taken only for its name, so the result is recognisable in a
/// folder. It is never read, and never written to.
#[tauri::command]
pub async fn save_edit<R: Runtime>(
    app: AppHandle<R>,
    source: String,
    png: Vec<u8>,
) -> Result<String, String> {
    let source = existing(&source)?;

    if png.is_empty() {
        return Err("the edited capture came back empty".to_owned());
    }

    // A ceiling on bytes that arrive from the webview. A full-resolution
    // annotated screenshot is a few megabytes; anything past this is not an
    // edit of a capture, and writing it unbounded because the sender said so
    // is how a renderer bug becomes a full disk.
    const MAX_BYTES: usize = 64 * 1024 * 1024;
    if png.len() > MAX_BYTES {
        return Err(format!(
            "the edited capture is {} MB, past the {} MB ceiling",
            png.len() / 1_048_576,
            MAX_BYTES / 1_048_576,
        ));
    }

    write_edit(&app, &source, "edited", &png)
}

/// Write a new capture beside the shelf's own data, and hand back its path.
///
/// The name keeps the original's stem so the result is recognisable in a
/// folder, with the kind of edit and a counter appended — an edit of an edit
/// is normal and must not overwrite its own input.
fn write_edit<R: Runtime>(
    app: &AppHandle<R>,
    source: &Path,
    kind: &str,
    bytes: &[u8],
) -> Result<String, String> {
    let dir = edits_dir(app)?;

    let stem = source.file_stem().map_or_else(
        || "capture".to_owned(),
        |stem| stem.to_string_lossy().into_owned(),
    );

    // Created exclusively rather than probed-then-written. `unique` checking
    // `!exists()` and writing afterwards is a race the doc below says this
    // function exists to prevent: two comparisons started by a double click
    // both picked the same name and the second silently overwrote the first.
    let mut target = unique(&dir, &stem, kind);
    loop {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(mut file) => {
                use std::io::Write;
                file.write_all(bytes).map_err(|err| err.to_string())?;
                break;
            }
            // Someone else took this name between the probe and the create.
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                target = unique(&dir, &stem, kind);
            }
            Err(err) => return Err(err.to_string()),
        }
    }

    Ok(target.to_string_lossy().into_owned())
}

/// A filename nothing is using yet.
///
/// Counting up rather than stamping the time: two edits of the same capture in
/// the same second is easy to do by double-clicking, and a timestamp collision
/// would silently overwrite the first.
fn unique(dir: &Path, stem: &str, kind: &str) -> PathBuf {
    let first = dir.join(format!("{stem} ({kind}).png"));
    if !first.exists() {
        return first;
    }

    (2..)
        .map(|n| dir.join(format!("{stem} ({kind} {n}).png")))
        .find(|candidate| !candidate.exists())
        // The range is unbounded, so a name is always found eventually.
        .unwrap_or(first)
}

/// Reject anything that is not an absolute path to a file that exists.
///
/// The absolute check is not decoration. These commands are reachable from the
/// webview and take a path from it, so a relative path would be resolved
/// against whatever the process's working directory happens to be. Its sibling
/// in `share.rs` has always enforced this; this one had drifted.
fn existing(path: &str) -> Result<PathBuf, String> {
    let source = PathBuf::from(path);
    if !source.is_absolute() {
        return Err(format!("{path} is not an absolute path"));
    }
    if !source.is_file() {
        return Err(format!("{path} is no longer on disk"));
    }
    Ok(source)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_edit_of_an_edit_does_not_overwrite_its_own_input() {
        let dir = std::env::temp_dir().join("shotshelf-edit-unique-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");

        let first = unique(&dir, "Screenshot", "compared");
        assert_eq!(first.file_name().unwrap(), "Screenshot (compared).png");
        std::fs::write(&first, b"x").expect("write");

        let second = unique(&dir, "Screenshot", "compared");
        assert_eq!(second.file_name().unwrap(), "Screenshot (compared 2).png");
        assert_ne!(first, second);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_capture_that_has_gone_is_reported_rather_than_panicking() {
        assert!(existing("/definitely/not/here.png").is_err());
    }

    #[test]
    fn a_relative_path_from_the_webview_is_refused() {
        // These commands take a path from the least-trusted process in the
        // app; a relative one would resolve against the working directory.
        assert!(existing("../../etc/passwd").is_err());
        assert!(existing("Screenshot.png").is_err());
    }
}
