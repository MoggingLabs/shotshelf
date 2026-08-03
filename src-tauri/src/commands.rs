//! The commands the webview may call, as one named list.
//!
//! This was inline in `lib.rs`'s builder, which was fine until something else
//! needed the same list. `tests/ipc.rs` does: it drives the real handler through
//! a real IPC request, and a test that re-declared the list would be asserting
//! against its own copy — passing happily while the app registered something
//! different. One list, two callers.
//!
//! `pub` for that reason and no other. Nothing outside this crate consumes
//! `shotshelf_lib`; `main.rs` is its only caller.
//!
//! Adding a command here is all that is needed for the gate to be able to reach
//! it — `check-commands.mjs` separately requires that every name registered has
//! a caller in the front end and vice versa, so this list cannot quietly grow
//! an entry nothing uses.

use tauri::ipc::Invoke;
use tauri::Runtime;

/// Every `#[tauri::command]` the app registers.
pub fn handler<R: Runtime>() -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        crate::catch::catch_watch_dirs,
        crate::catch::catch_backfill,
        crate::share::prepare_drag,
        crate::share::copy_capture,
        crate::share::copy_capture_text,
        crate::share::reveal_capture,
        crate::enrich::scan::describe_capture,
        crate::edit::compare_captures,
        crate::edit::save_edit,
        crate::enrich::ocr::text_recognition_available,
        crate::poster::video_details,
        crate::poster::forget_video,
        crate::settings::get_settings,
        crate::settings::set_settings,
        crate::settings::set_pinned,
        crate::tray::set_capture_count,
        crate::window::show_shelf,
        crate::window::preview_shelf,
        crate::window::hide_shelf,
        crate::window::open_settings,
        crate::window::open_editor,
        crate::window::edit_target,
        crate::window::hide_editor,
        crate::update::check_for_updates,
        crate::links::open_link,
        crate::pick::choose_watch_folder,
        crate::window::size_browse,
        crate::delete::delete_capture,
        crate::delete::undo_delete,
        crate::delete::commit_delete,
    ]
}
