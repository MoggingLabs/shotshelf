//! The shelf popover: where it appears, and when it goes away.
//!
//! Shotshelf rests in the bottom-right corner of the screen, clear of the
//! taskbar, and is summoned from the tray rather than hanging off it. Two
//! ways in, and they behave differently on purpose:
//!
//! * **Opened** — a tray click or the global shortcut. Takes focus, so Esc and
//!   clicking outside can dismiss it the way every other popover does.
//! * **Peeked** — a capture just landed. Never takes focus, because the shelf
//!   appearing mid-sentence and swallowing your keystrokes is the single
//!   complaint people have about shelves that do this. It closes itself.

use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};

/// Label of the shelf window — must match `tauri.conf.json`.
pub const SHELF: &str = "main";

/// Whether what is on screen is the browse view you asked for, as opposed to
/// the column that popped up on its own. The tray needs the difference: asking
/// for the shelf while a column happens to be showing should give you the
/// shelf, not hide the column.
static OPENED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn set_opened(opened: bool) {
    OPENED.store(opened, std::sync::atomic::Ordering::Relaxed);
}

fn is_opened() -> bool {
    OPENED.load(std::sync::atomic::Ordering::Relaxed)
}

/// Mark the shelf as up because you asked for it, and tell the front-end.
///
/// One function because these are one fact kept in two places, and the two
/// must move together. They did not: `open` set the flag and emitted, while
/// `preview` set the same flag and emitted nothing — so the webview went on
/// rendering its column shape around a full-size editor. That shape hides the
/// alert strip, which is where a failed save is reported, and it keeps the
/// column's expiry timer running, which dismissed the window and took the
/// user's unsaved marks with it.
///
/// `peek` deliberately does not use this: it sets the flag *false*, and the
/// window is still on screen, so there is nothing for the front-end to adopt
/// beyond what it already knows.
fn mark_opened<R: Runtime>(shelf: &WebviewWindow<R>) {
    set_opened(true);
    // The front-end owns the shape: tell it this was deliberate, so it swaps
    // out of the auto-popup column and stops running its timers.
    let _ = shelf.emit("shelf://opened", ());
}

/// How far the popover sits from the corner it rests in.
const SCREEN_MARGIN: f64 = 12.0;

/// Park the popover in the bottom-right corner of the screen.
///
/// Measured against the monitor's **work area**, not its full size: the taskbar
/// lives in the difference between the two, and a window placed against the
/// real bottom edge disappears behind it. This is also why the placement is
/// done here rather than with `tauri-plugin-positioner` — its `BottomRight`
/// works off `monitor.size()`, so it would tuck the shelf under the taskbar.
///
/// `size` is the logical size the caller has just asked for, rather than
/// anything read back off the window. A resize has not necessarily reached the
/// OS by the time this runs, so querying `outer_size()` here would place the
/// window using its previous shape.
fn place<R: Runtime>(shelf: &WebviewWindow<R>, size: (f64, f64)) {
    // The primary monitor is where the taskbar and the tray icon live, so it is
    // the screen "the bottom-right corner" means, whatever monitor the window
    // happened to be on last.
    let Some(monitor) = monitor_for(shelf) else {
        return;
    };

    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let to_physical = |value: f64| (value * scale).round() as i32;

    let x = area.position.x + area.size.width as i32 - to_physical(size.0 + SCREEN_MARGIN);
    let y = area.position.y + area.size.height as i32 - to_physical(size.1 + SCREEN_MARGIN);

    if let Err(err) = shelf.set_position(tauri::PhysicalPosition::new(x, y)) {
        crate::diag::warn(&format!("could not place the shelf: {err}"));
    }
}

/// The monitor to place against: the primary one, or whatever the window is on.
///
/// `Result::or_else` only fires on `Err`, and "there is no primary monitor" is
/// `Ok(None)` — so the fallback that reads `current_monitor` was unreachable in
/// exactly the case it was written for, and the caller fell straight through to
/// its early return. That is the documented answer from `gdk`'s
/// `primary_monitor()` under Wayland, which is what `tao`'s Linux backend
/// calls. `preview` returns *before* `set_size`, `center`, `show` and
/// `mark_opened`, so on Wayland the quick look did nothing at all, silently;
/// `place` returned before positioning, so the shelf never reached its corner.
fn monitor_for<R: Runtime>(shelf: &WebviewWindow<R>) -> Option<tauri::Monitor> {
    match shelf.primary_monitor() {
        Ok(Some(monitor)) => return Some(monitor),
        Ok(None) => {}
        Err(err) => crate::diag::warn(&format!("could not read the monitor layout: {err}")),
    }
    match shelf.current_monitor() {
        Ok(monitor) => monitor,
        Err(err) => {
            crate::diag::warn(&format!("could not read the current monitor: {err}"));
            None
        }
    }
}

/// The two shapes the popover takes.
///
/// Browsing your history and glancing at what just landed are different jobs,
/// but they are the same width: one column of cards, sized so a screenshot in
/// one is actually recognisable. Only the height and the chrome differ — browse
/// is a fixed, scrollable box with a title strip, the column is sized to
/// exactly the cards it holds and carries no furniture at all.
pub const BROWSE_SIZE: (f64, f64) = (225.0, 420.0);
/// The tallest the popped column may be asked to grow. Generous — a tall
/// screen holds a lot of cards — and it exists so the number cannot be absurd.
const MAX_COLUMN_HEIGHT: f64 = 4000.0;
pub const COLUMN_WIDTH: f64 = BROWSE_SIZE.0;

/// Open the popover deliberately: full grid, in its corner, on top, and focused.
pub fn open<R: Runtime>(app: &AppHandle<R>) {
    let Some(shelf) = app.get_webview_window(SHELF) else {
        return;
    };

    let _ = shelf.set_size(tauri::LogicalSize::new(BROWSE_SIZE.0, BROWSE_SIZE.1));
    place(&shelf, BROWSE_SIZE);
    let _ = shelf.show();
    let _ = shelf.set_focus();
    mark_opened(&shelf);
}

/// Show the narrow column without taking focus, sized to just the cards it
/// holds. The front-end decides how tall that is and when it goes away.
pub fn peek<R: Runtime>(app: &AppHandle<R>, height: f64) {
    let Some(shelf) = app.get_webview_window(SHELF) else {
        return;
    };

    set_opened(false);
    // Clamped at both ends, and NaN is rejected rather than left to fall
    // through. `preview_shelf` validates its float and says why — "it arrives
    // from the front-end" — and this takes the same kind of value from the
    // same place, so it gets the same treatment. `clamp` panics on a NaN
    // bound and returns NaN for a NaN input, so the finiteness check is the
    // thing standing between the front-end and a window sized to NaN.
    let height = if height.is_finite() {
        height.clamp(80.0, MAX_COLUMN_HEIGHT)
    } else {
        80.0
    };
    let _ = shelf.set_size(tauri::LogicalSize::new(COLUMN_WIDTH, height));
    // Re-place on every peek: the column grows a card at a time, and it is
    // pinned by its bottom-right corner, so a taller one has to move up to keep
    // that corner where it was.
    place(&shelf, (COLUMN_WIDTH, height));
    let _ = shelf.show();
}

/// The largest a preview may be, as a fraction of the screen's work area.
///
/// Not the whole screen: a preview that fills the display is a window you have
/// to dismiss before you can see what you were comparing it against, and the
/// point of a quick look is that it is quick.
const PREVIEW_FRACTION: f64 = 0.72;

/// Show a capture large enough to read.
///
/// The shelf is 225 wide, which is enough to recognise a screenshot and not
/// enough to read one — so a preview is the only way to check *which* of two
/// similar captures you are about to send without opening it in another app.
///
/// Sized to the capture's own shape, capped to the work area so it always
/// fits, and centred rather than cornered: this one is meant to be looked at.
/// The caller passes the capture's aspect because only the front-end, which
/// has the image loaded, knows it.
///
/// Reports nothing back. It used to return the size it chose, on the reasoning
/// that the front-end needed it to lay the picture out — but neither caller
/// ever read it, and both were right not to: the toolbar takes a share of the
/// window, and the webview has not necessarily laid out at the new size by the
/// time this returns. Both fit their content to the box they actually get.
pub fn preview<R: Runtime>(app: &AppHandle<R>, aspect: f64) {
    let Some(shelf) = app.get_webview_window(SHELF) else {
        return;
    };

    // Through `monitor_for`, like `place`. This kept its own
    // `primary_monitor().or_else(…)` — which never fires the fallback, because
    // "no primary monitor" is `Ok(None)` and `or_else` only takes `Err` — so on
    // Wayland it fell into the catch-all arm and returned before `set_size`,
    // `center`, `show`, `set_focus` and `mark_opened`. The quick look did
    // nothing at all, silently. `monitor_for` was extracted to fix exactly
    // that and its docstring names *this* function as a casualty; only `place`
    // was converted.
    let Some(monitor) = monitor_for(&shelf) else {
        // Nothing to measure against, so nothing sensible to resize to.
        return;
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let (max_width, max_height) = (
        f64::from(area.size.width) / scale * PREVIEW_FRACTION,
        f64::from(area.size.height) / scale * PREVIEW_FRACTION,
    );

    // A sane aspect or nothing: a zero or negative one would divide by zero,
    // and it arrives from the front-end.
    let aspect = if aspect.is_finite() && aspect > 0.0 {
        aspect
    } else {
        16.0 / 9.0
    };

    // Fit inside the box without distorting: whichever edge hits first wins.
    let width = max_width.min(max_height * aspect).max(BROWSE_SIZE.0);
    let height = (width / aspect).min(max_height).max(200.0);

    let _ = shelf.set_size(tauri::LogicalSize::new(width, height));
    let _ = shelf.center();
    let _ = shelf.show();
    let _ = shelf.set_focus();
    // Safe when already browsing: `adoptBrowse` is front-end state only and
    // never calls back into Rust, so this cannot re-enter.
    mark_opened(&shelf);
}

pub fn hide<R: Runtime>(app: &AppHandle<R>) {
    let Some(shelf) = app.get_webview_window(SHELF) else {
        return;
    };
    set_opened(false);
    let _ = shelf.hide();

    // The front-end keeps its own "did you ask for this?" flag, and a close
    // from the tray icon, the tray menu or the hotkey never passes through it.
    // Without this it goes on believing the shelf is open and files every later
    // capture away silently instead of popping the column.
    let _ = shelf.emit("shelf://hidden", ());

    // Hiding the window alone leaves macOS treating Shotshelf as the active
    // app, so the app you were actually using does not get its focus back.
    #[cfg(target_os = "macos")]
    let _ = app.hide();
}

/// Tray click, tray menu, or the global shortcut.
pub fn toggle<R: Runtime>(app: &AppHandle<R>) {
    let Some(shelf) = app.get_webview_window(SHELF) else {
        return;
    };

    // Only the browse view toggles shut. Asking for the shelf while a column
    // is popped up should hand you the shelf, not take the column away.
    match shelf.is_visible() {
        Ok(true) if is_opened() => hide(app),
        Ok(_) => open(app),
        Err(err) => crate::diag::warn(&format!("could not read shelf visibility: {err}")),
    }
}

/// Frosted glass behind the popover — acrylic on Windows, vibrancy on macOS.
/// Cosmetic only: a failure here leaves a solid panel, which still works.
pub fn apply_material<R: Runtime>(shelf: &WebviewWindow<R>) {
    // Linux has no equivalent backdrop, so neither branch below compiles there
    // and the window is left to the CSS panel alone.
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let _ = shelf;

    #[cfg(target_os = "windows")]
    if let Err(err) = window_vibrancy::apply_acrylic(shelf, Some((16, 18, 26, 190))) {
        crate::diag::warn(&format!(
            "no acrylic backdrop ({err}) — falling back to a solid panel"
        ));
    }

    // Must follow the acrylic: it is the backdrop that needs clipping.
    #[cfg(target_os = "windows")]
    round_corners(shelf);

    #[cfg(target_os = "macos")]
    if let Err(err) = window_vibrancy::apply_vibrancy(
        shelf,
        window_vibrancy::NSVisualEffectMaterial::HudWindow,
        None,
        Some(14.0),
    ) {
        crate::diag::warn(&format!(
            "no vibrancy backdrop ({err}) — falling back to a solid panel"
        ));
    }
}

/// Round the popover's corners at the window level, not in CSS.
///
/// `border-radius` cannot round this window. Acrylic is painted by the
/// compositor across the whole window rectangle, *behind* the page, so the
/// corners the page leaves transparent are filled in by the backdrop rather
/// than by the desktop: measured, a 227,227,227 square wedge outside a 14px
/// curve, which is precisely what "the corners look square" means.
///
/// DWM clips the window itself — backdrop included — so the rounding has to
/// come from there. Its radius is fixed at 8px, matching every other Windows 11
/// flyout, so the CSS panel is told to use 8px too (`[data-os="windows"]`);
/// mismatched radii would leave a thinner version of the same wedge.
///
/// Windows 10 has no rounded windows and fails this call with E_INVALIDARG.
/// That is expected rather than worth reporting: the CSS radius is the fallback
/// and acrylic there is a dark tint, so the artefact is far less visible.
#[cfg(target_os = "windows")]
fn round_corners<R: Runtime>(shelf: &WebviewWindow<R>) {
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    };

    let Ok(hwnd) = shelf.hwnd() else {
        return;
    };

    let preference = DWMWCP_ROUND;
    // SAFETY: `hwnd` is a live top-level window owned by this process, and the
    // pointer and size describe the DWORD the attribute is documented to take.
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            std::ptr::from_ref(&preference).cast(),
            std::mem::size_of_val(&preference) as u32,
        );
    }
}

/// Commands the front-end uses to drive the popover.
///
/// `height` is only meaningful for the column: the front-end knows how many
/// cards are showing, so it decides how tall the window needs to be.
#[tauri::command]
pub fn show_shelf<R: Runtime>(app: AppHandle<R>, focus: bool, height: Option<f64>) {
    if focus {
        open(&app);
    } else {
        // No default. Every `focus: false` caller supplies a height —
        // `popover.ts` is the only one — and the `focus: true` branch above
        // ignores the argument entirely, so `unwrap_or(120.0)` was
        // unreachable. It was also wrong: one card needs 136, so had it
        // ever been reached it would have clipped the single capture the
        // peeked column exists to show, and it was a fourth copy of card
        // metrics that `geometry.ts` owns and `layout.spec.ts` joins to the
        // stylesheet. A missing height is a caller bug; say so.
        match height {
            Some(height) => peek(&app, height),
            None => crate::diag::warn("show_shelf asked for the column with no height"),
        }
    }
}

#[tauri::command]
pub fn hide_shelf<R: Runtime>(app: AppHandle<R>) {
    hide(&app);
}

/// Grow the popover to show one capture large.
///
/// Only Rust knows the work area, so only Rust can choose the size.
#[tauri::command]
pub fn preview_shelf<R: Runtime>(app: AppHandle<R>, aspect: f64) {
    preview(&app, aspect);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_browse_size_matches_the_window_the_app_actually_opens() {
        // `BROWSE_SIZE` is what every `set_size` here uses; `tauri.conf.json`
        // is what the window is created at. They were two hand-maintained
        // copies of one number, along with the Playwright viewport — which now
        // reads the config directly, leaving this as the only join left to
        // check. A disagreement means the shelf changes shape the first time
        // anything calls `open`, which no test at either end would notice.
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let window = &config["app"]["windows"][0];

        assert_eq!(window["label"].as_str(), Some(SHELF));
        assert_eq!(window["width"].as_f64(), Some(BROWSE_SIZE.0));
        assert_eq!(window["height"].as_f64(), Some(BROWSE_SIZE.1));
    }
}
