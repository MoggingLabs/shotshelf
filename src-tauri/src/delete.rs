//! A capture's true delete: staged for its undo window, then the OS bin.
//!
//! Remove — the tile's ×, and Delete on the keyboard — never touches files,
//! and still does not; that constraint stands. This is the *other* action the
//! owner added beside it (2026-08-03): deliberately named delete, it takes
//! the file out of its origin folder too, with a full-toast Undo. The shape
//! is stage-then-commit: the file first moves into the app's own `deleted/`
//! staging area, so Undo can put it back byte-identical at the exact path it
//! left; only when the toast has run out does the staged copy go on — to the
//! OS recycle bin, not oblivion, so even a missed toast stays recoverable
//! the way every other deletion on the machine is.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, PoisonError},
};

use tauri::{AppHandle, Manager, Runtime};

/// A staged delete the toast can still take back.
struct Pending {
    staged: PathBuf,
    origin: PathBuf,
}

/// The stage's registry, managed in `lib.rs` before the window shows.
///
/// Tokens are in-memory on purpose: a toast dies with its window, so a
/// pending entry that survives a restart has no owner — [`settle_leftovers`]
/// commits those at the next sweep, and skipping entries this registry still
/// holds is what keeps that sweep from settling a *live* toast's file.
#[derive(Default)]
pub struct DeleteStage {
    next: Mutex<u64>,
    pending: Mutex<HashMap<u64, Pending>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Take a capture's file out of its folder, reversibly for now.
///
/// The path arrives from the webview and goes through the same door every
/// other capture command uses — absolute, existing, inside the asset scope —
/// so delete can act on exactly what the shelf can show, nothing else.
#[tauri::command]
pub fn delete_capture<R: Runtime>(app: AppHandle<R>, path: String) -> Result<String, String> {
    let origin = crate::webview_path::existing_file(&app, &path)?;
    let dir = crate::dirs::local(&app, "deleted")?;
    let stage = app.state::<DeleteStage>();
    let token = {
        let mut next = lock(&stage.next);
        *next += 1;
        *next
    };
    // The token prefixes the name so two deletes of same-named files from
    // different folders cannot collide in the stage.
    let name = origin
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("capture");
    let staged = dir.join(format!("{token}-{name}"));
    move_file(&origin, &staged)?;
    lock(&stage.pending).insert(token, Pending { staged, origin });
    Ok(token.to_string())
}

/// Put a staged delete back exactly where it came from.
#[tauri::command]
pub fn undo_delete<R: Runtime>(app: AppHandle<R>, token: String) -> Result<(), String> {
    let token: u64 = token.parse().map_err(|_| "not a delete token".to_owned())?;
    let stage = app.state::<DeleteStage>();
    let Some(entry) = lock(&stage.pending).remove(&token) else {
        return Err("that delete has already been settled".to_owned());
    };
    if entry.origin.exists() {
        // A new file took the name in the meantime. Refuse rather than
        // overwrite — and put the entry back, so the toast's expiry can
        // still settle the staged copy into the bin instead of leaking it.
        let said = format!(
            "{} could not come back — a new file has its name",
            entry.origin.display()
        );
        lock(&stage.pending).insert(token, entry);
        return Err(said);
    }
    move_file(&entry.staged, &entry.origin)
}

/// The toast ran out; the staged file goes to the OS bin.
#[tauri::command]
pub fn commit_delete<R: Runtime>(app: AppHandle<R>, token: String) {
    let Ok(token) = token.parse::<u64>() else {
        return;
    };
    let stage = app.state::<DeleteStage>();
    let Some(entry) = lock(&stage.pending).remove(&token) else {
        return;
    };
    commit(&entry.staged);
}

/// Recycle bin first, plain removal as the fallback: the stage must never
/// become a second forever-folder, and by the time this runs the user has
/// been shown the toast and let it go.
fn commit(staged: &Path) {
    if let Err(err) = trash::delete(staged) {
        crate::diag::warn(&format!("the recycle bin refused a staged delete: {err}"));
        let _ = std::fs::remove_file(staged);
    }
}

/// Settle staging the previous session left behind.
///
/// A staged file with no live token is a toast that died with its window —
/// the undo it offered is gone, so the commit it promised happens now. Runs
/// from the sweep loop; entries the registry still holds belong to a toast
/// that is on screen and are left strictly alone.
pub fn settle_leftovers<R: Runtime>(app: &AppHandle<R>) {
    let Ok(dir) = crate::dirs::local(app, "deleted") else {
        return;
    };
    let live: Vec<PathBuf> = app
        .try_state::<DeleteStage>()
        .map(|stage| {
            lock(&stage.pending)
                .values()
                .map(|entry| entry.staged.clone())
                .collect()
        })
        .unwrap_or_default();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && !live.contains(&path) {
            commit(&path);
        }
    }
}

/// Rename where possible, copy-then-remove where not.
///
/// A watched folder can live on a different volume from the app data dir —
/// exactly the case a user-added `D:\Work` creates — and `rename` cannot
/// cross volumes. The original is removed only after the copy succeeded, so
/// a failure part-way leaves the capture where it was.
fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    std::fs::copy(from, to).map_err(|err| format!("could not stage {}: {err}", from.display()))?;
    std::fs::remove_file(from)
        .map_err(|err| format!("could not finish moving {}: {err}", from.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A temp workspace of this test's own.
    fn workspace(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("shotshelf-del-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a temp dir");
        dir
    }

    #[test]
    fn a_move_survives_what_rename_cannot() {
        // The pure half of the stage: the round trip out and back, byte
        // identical, with the origin only ever removed after the copy took.
        let dir = workspace("move");
        let origin = dir.join("cap.png");
        let staged = dir.join("staged").join("1-cap.png");
        std::fs::create_dir_all(dir.join("staged")).expect("a stage dir");
        std::fs::write(&origin, b"the capture").expect("writable");

        move_file(&origin, &staged).expect("staging succeeds");
        assert!(!origin.exists(), "the origin is empty after staging");
        move_file(&staged, &origin).expect("undo succeeds");
        assert_eq!(
            std::fs::read(&origin).expect("readable"),
            b"the capture",
            "the capture came back byte-identical"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
