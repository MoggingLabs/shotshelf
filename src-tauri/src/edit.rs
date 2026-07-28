//! Making a new capture out of ones you already have.
//!
//! Redacting a region, or putting a before and an after side by side. Both
//! produce a **new file** and leave the originals exactly where the OS wrote
//! them — the shelf has never modified a capture and does not start here.
//!
//! Edits are written to Shotshelf's own data directory rather than back into
//! your Pictures folder. Two reasons: the folder Shotshelf watches is the
//! folder it would be writing into, so an edit saved there would be caught as
//! a fresh capture and bounce; and an app that writes into the directory it is
//! watching is one bug away from a loop.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

use crate::imaging::{self, compare, redact::Region};

/// Where edits live, under the app's data directory.
const EDITS_DIR: &str = "edits";

/// Redact regions of a capture, permanently, into a new file.
///
/// The regions are in image pixels, not screen or card pixels — the caller
/// scales them, because only the caller knows what it was showing.
#[tauri::command]
pub async fn redact_capture<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    regions: Vec<Region>,
) -> Result<String, String> {
    let source = existing(&path)?;

    // Decoding, filling and re-encoding a full-resolution screenshot is real
    // work; it does not belong on the runtime that also serves the shelf.
    tauri::async_runtime::spawn_blocking(move || {
        let image = imaging::load(&source)?;
        let redacted = redact::apply(image, &regions);
        let bytes = imaging::to_png(&redacted)?;
        Ok::<_, imaging::ImageError>((bytes, source))
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(String::from)
    .and_then(|(bytes, source)| write_edit(&app, &source, "redacted", &bytes))
}

use crate::imaging::redact;

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
        let changes = compare::changed_regions(&before, &after, compare::Settings::default());
        imaging::to_png(&compare::side_by_side(&before, &after, &changes))
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(String::from)?;

    write_edit(&app, &name_source, "compared", &bytes)
}

/// Whether this build can read text out of a capture.
///
/// Asked by the front-end so it can say why nothing is searchable, rather than
/// leaving someone to conclude the feature is broken.
#[tauri::command]
#[must_use]
pub const fn text_recognition_available() -> bool {
    crate::enrich::ocr::available()
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
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join(EDITS_DIR);
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;

    let stem = source.file_stem().map_or_else(
        || "capture".to_owned(),
        |stem| stem.to_string_lossy().into_owned(),
    );

    let target = unique(&dir, &stem, kind);
    std::fs::write(&target, bytes).map_err(|err| err.to_string())?;

    // The webview renders it through the asset protocol, which only serves
    // directories it has been told about.
    if let Err(err) = app.asset_protocol_scope().allow_directory(&dir, false) {
        eprintln!("shotshelf: edits may not display ({err})");
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

fn existing(path: &str) -> Result<PathBuf, String> {
    let source = PathBuf::from(path);
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

        let first = unique(&dir, "Screenshot", "redacted");
        assert_eq!(first.file_name().unwrap(), "Screenshot (redacted).png");
        std::fs::write(&first, b"x").expect("write");

        let second = unique(&dir, "Screenshot", "redacted");
        assert_eq!(second.file_name().unwrap(), "Screenshot (redacted 2).png");
        assert_ne!(first, second);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_capture_that_has_gone_is_reported_rather_than_panicking() {
        assert!(existing("/definitely/not/here.png").is_err());
    }
}
