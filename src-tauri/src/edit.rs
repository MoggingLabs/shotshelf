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

use crate::{
    imaging::{self, compare},
    webview_path::{absolute, existing_file},
};

/// Where edits live, under the app's data directory.
const EDITS_DIR: &str = "edits";

// Deliberately no prune here, unlike the poster and hand-off caches.
//
// Those hold derived data nobody chose to keep. An edit is a capture in its
// own right: it goes on the shelf, it can be pinned, and pinning is the one
// piece of shelf state documented as surviving a restart. A ceiling that
// deleted oldest-first would delete pinned work, silently, and bring it back
// next launch as a "file has gone" tile — which would make this the first
// path in the app that destroys something the shelf presents as a capture.
// The directory is documented, and clearing it is the user's call.

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

fn edits_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        // Local, not roaming: see `catch/clipboard.rs`. An edit is a picture
        // of the user's screen, and `%APPDATA%` is copied to a network share
        // under a roaming profile.
        .app_local_data_dir()
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
    let before_path = existing_file(&app, &before)?;
    let after_path = existing_file(&app, &after)?;
    let name_source = after_path.clone();

    // Rate-limited from the same pool the sizing uses — two at once, not one:
    // the single-comparison guarantee is `Shelf.#comparing` in the front end.
    // This decodes
    // two capped images and allocates a composite larger than both, so several
    // at once is gigabytes.
    let permit = crate::share::sizing_limit()
        .clone()
        .acquire_owned()
        .await
        .map_err(|err| err.to_string())?;

    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let before = imaging::load(&before_path)?;
        let after = imaging::load(&after_path)?;
        let changes = compare::changed_regions(&before, &after, compare::Sensitivity::default());
        let composite = compare::side_by_side(&before, &after, &changes).ok_or_else(|| {
            imaging::ImageError::Encode(
                "those two captures are too large to put side by side".to_owned(),
            )
        })?;
        imaging::to_png(&composite)
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(String::from)?;

    // On a blocking worker like the decode above it: `write_edit` does
    // `create_dir_all`, an `exists()` probe loop and a `write_all` of up to
    // 64 MiB, and this is the runtime that serves every other command.
    let app_for_write = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        write_edit(&app_for_write, &name_source, "compared", &bytes)
    })
    .await
    .map_err(|err| err.to_string())?
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
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    // The PNG arrives as the request body rather than as a JSON array of
    // integers. See `bridge.ts` for why; the short version is that the JSON
    // shape cost roughly four bytes of string per byte of image, and the size
    // ceiling below could not apply until all of it had already been built.
    // Either transport, deliberately.
    //
    // Tauri sends an `invoke` as a fetch to `ipc://localhost` (or
    // `http://ipc.localhost` on Windows) — a different origin from the page,
    // so the CSP has to grant it, and `tauri.conf.json` now does. When that
    // request is refused Tauri falls back to `postMessage`, which JSON-encodes
    // the envelope and turns a `Uint8Array` back into an array of numbers.
    //
    // Accepting only `Raw` made every save fail on that fallback — the app's
    // headline feature depending on a directive nothing in the repo could
    // check, on a build nobody has run. The raw path is the one that avoids
    // four bytes of JSON per byte of image; the JSON path is what keeps the
    // work saved if it is ever taken.
    let png: std::borrow::Cow<'_, [u8]> = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => std::borrow::Cow::Borrowed(bytes),
        tauri::ipc::InvokeBody::Json(value) => {
            let numbers = value
                .as_array()
                .ok_or_else(|| "the edited capture did not arrive as bytes".to_owned())?;
            let mut bytes = Vec::with_capacity(numbers.len());
            for number in numbers {
                let byte = number
                    .as_u64()
                    .and_then(|byte| u8::try_from(byte).ok())
                    .ok_or_else(|| "the edited capture is not image data".to_owned())?;
                bytes.push(byte);
            }
            std::borrow::Cow::Owned(bytes)
        }
    };
    let png = png.as_ref();

    let source = request
        .headers()
        .get("x-shotshelf-source")
        .and_then(|value| value.to_str().ok())
        .map(percent_decode)
        .ok_or_else(|| "the edit did not say which capture it came from".to_owned())?;

    // Absolute, but not required to still exist. The source is taken only for
    // its name and the pixels are already in hand; refusing to write because
    // the original has since gone would discard the annotation to protect a
    // file this function never opens.
    let source = absolute(&source)?;

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

    let owned = png.to_vec();
    tauri::async_runtime::spawn_blocking(move || write_edit(&app, &source, "edited", &owned))
        .await
        .map_err(|err| err.to_string())?
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

    // Created exclusively rather than probed-then-written. `unique` checking
    // `!exists()` and writing afterwards is a race the doc below says this
    // function exists to prevent: two comparisons started by a double click
    // both picked the same name and the second silently overwrote the first.
    let mut target = target_for(&dir, source, kind);
    loop {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(mut file) => {
                use std::io::Write;
                // A failed write leaves a truncated PNG that the shelf would
                // later read as a capture, so the half-written file goes.
                // `create_new` already reserved the name, so nothing else can
                // be holding it.
                if let Err(err) = file.write_all(bytes) {
                    drop(file);
                    let _ = std::fs::remove_file(&target);
                    return Err(err.to_string());
                }
                break;
            }
            // Someone else took this name between the probe and the create.
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                target = target_for(&dir, source, kind);
            }
            Err(err) => return Err(err.to_string()),
        }
    }

    Ok(target.to_string_lossy().into_owned())
}

/// Where an edit of `source` should be written, inside `dir`.
///
/// The whole naming decision in one place, so a test can assert the property
/// that matters — the result stays inside `dir` — against the code that ships
/// rather than a copy of it. Splitting the sanitiser out and testing *that*
/// was not enough: it left nothing checking that `write_edit` still called it.
fn target_for(dir: &Path, source: &Path, kind: &str) -> PathBuf {
    unique(dir, &safe_stem(source), kind)
}

/// The source's name, reduced to something that is only ever a name.
///
/// `PathBuf::join` truncates its base when the pushed component carries a
/// Windows prefix, so a source of `C:\dir\D:evil.png` has a `file_stem` of
/// `D:evil`, and joining that to the edits directory produced a drive-relative
/// path outside it. `create_new` meant it could only ever create, never
/// overwrite — but "cannot overwrite" is not the same as "cannot escape".
///
/// A named function rather than four lines inline, so the regression test can
/// call the code that ships instead of a copy of it. The previous test
/// re-implemented this `replace` in its own body and asserted against that,
/// which left it green when the real call was deleted.
fn safe_stem(source: &Path) -> String {
    let stem = source
        .file_stem()
        .map_or_else(
            || "capture".to_owned(),
            |stem| stem.to_string_lossy().into_owned(),
        )
        .replace([':', '/', '\\'], "_");

    // All-dots is a relative path in disguise, and an empty stem names nothing.
    if stem.trim().is_empty() || stem.chars().all(|c| c == '.') {
        "capture".to_owned()
    } else {
        stem
    }
}

/// Undo `encodeURIComponent` for a value that travelled as a header.
///
/// Headers must be ASCII, and a capture path is not — accented folder names
/// and non-Latin scripts are ordinary. Hand-written rather than taking a
/// dependency for fifteen lines: this decodes exactly what `bridge.ts`
/// encodes, and anything malformed is left as written rather than guessed at,
/// because the result is used only as a *name*.
fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
            if let Some(byte) = hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }

    String::from_utf8_lossy(&out).into_owned()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_edit_cannot_be_named_out_of_the_edits_directory() {
        // `PathBuf::join` truncates its base when the pushed component carries
        // a Windows prefix, so `C:\dir\D:evil.png` produced a `file_stem` of
        // `D:evil` and wrote to `D:evil (edited).png` — outside the edits
        // directory entirely. Separators go the same way for the same reason.
        //
        // Calls `safe_stem`, the function that ships. This test used to
        // re-implement the `replace` in its own body and assert against its own
        // copy, so deleting the real call left it green — a regression test
        // that could not fail, guarding a path escape.
        let dir = std::env::temp_dir().join("shotshelf-stem-test");
        for hostile in [
            "C:/dir/D:evil.png",
            "/dir/../../evil.png",
            "/dir/a/b.png",
            "/dir/..png",
        ] {
            let target = target_for(&dir, Path::new(hostile), "edited");
            assert!(
                target.starts_with(&dir),
                "{hostile} escaped to {}",
                target.display(),
            );
        }
    }

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
}
