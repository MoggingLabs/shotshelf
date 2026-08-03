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

/// The events the front end listens for, and what their payloads mean.
///
/// `tests/harness/tauri-mock.ts` has to emit what this module emits, and it
/// carried a hand-written copy: first `null` where this sends a boolean — so
/// every browser test modelled a deliberate open as the launch appearance —
/// and then a hard-coded `true` under a comment asserting what Rust does.
/// Nothing joined the two, so inverting the emit below passed clippy and every
/// Rust test while making each tray, hotkey and editor-restore open dismiss
/// itself after four seconds and the launch appearance stay up for good.
///
/// `tests/fixtures/window-events.json` is the join, the same shape as
/// `engine-starting.json` and `secret-kinds.json`, and a test on each side
/// reads it.
///
/// The honest limit: this pins the *names* and *which payload means what*.
/// Neither side can observe the other's emit, so an inverted expression at the
/// call site is still only caught by a person.
const OPENED_EVENT: &str = "shelf://opened";
/// …and the one for the window going down.
const HIDDEN_EVENT: &str = "shelf://hidden";

#[cfg(test)]
const WINDOW_EVENTS: &str = include_str!("../../tests/fixtures/window-events.json");

/// Mark the shelf as up because you asked for it, and tell the front-end.
///
/// One function because these are one fact kept in two places, and the two must
/// move together. They did not: `open` set the flag and emitted, while `preview`
/// set the same flag and emitted nothing — so the webview went on rendering its
/// column shape around a full-size editor. That shape hides the alert strip,
/// which is where a failed save is reported, and it keeps the column's expiry
/// timer running, which dismissed the window and took the user's unsaved marks
/// with it.
///
/// `peek` deliberately does not use this: it sets the flag *false*, and the
/// window is still on screen, so there is nothing for the front-end to adopt
/// beyond what it already knows.
///
/// `deliberate` is false for the one appearance nobody asked for: the launch.
/// The front end owns the shape and cannot tell the two apart on its own —
/// `open` is the same function for the tray, the hotkey and the launch. It used
/// `shelf://opened` and the focus that comes with it as proof that "the user
/// asked for this", and both of those are emitted *by the launch open itself*.
/// Each one stood the launch dismissal down, so the four-second appearance had
/// no way to put itself away and stayed on screen — an always-on-top window,
/// until dismissed by hand — contradicting its own contract.
fn mark_opened<R: Runtime>(shelf: &WebviewWindow<R>, appearance: Appearance) {
    set_opened(true);
    attempt(
        "announce that the shelf opened",
        shelf.emit(OPENED_EVENT, appearance.deliberate()),
    );
}

/// Which of the two ways the window came up.
///
/// A named pair rather than a `bool`, because the bool was the whole
/// distinction and it travelled as a literal through three call sites that no
/// test can execute. `open(app, false)` inside `open_deliberately` compiles,
/// passes clippy and passes all 160 tests, and makes every tray click and
/// hotkey press dismiss itself four seconds later. `Appearance::Launch` inside
/// `open_deliberately` is the same mistake spelled so it reads wrong.
///
/// It does not make the mistake impossible — nothing here can, for the reason
/// `show_shelf` sets out — but it is the difference between a typo and a
/// sentence that contradicts the function it is in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Appearance {
    /// Tray, hotkey, dock, or a restore after the editor closes.
    Deliberate,
    /// The launch appearance, which nobody asked for and which takes itself
    /// away again.
    Launch,
}

impl Appearance {
    /// What goes on the wire, which the front end reads as "the user asked".
    ///
    /// A named method rather than `appearance == Appearance::Deliberate` inline
    /// at the `emit`, because that expression was the last untested step of the
    /// whole distinction: inverting it made every tray click, hotkey press and
    /// editor-restore emit `false`, so `popover.ts` read each as the launch
    /// appearance and dismissed the shelf the user had just opened four seconds
    /// later — while the real launch appearance stayed up for good. Clippy and
    /// all 160 tests were green.
    ///
    /// The enum had moved the risk from three call sites into one function, and
    /// that function takes a `&WebviewWindow`, so nothing in the crate could
    /// execute it. Same shape as `wanted`, `note_folder_image` and `make_room`:
    /// the decision was on the untestable side of a boundary, and moving it one
    /// function out is the whole fix.
    pub(crate) const fn deliberate(self) -> bool {
        matches!(self, Self::Deliberate)
    }
}

/// Do a window operation, and say so in the log if it does not happen.
///
/// Every `set_size`, `show`, `set_focus`, `center`, `hide` and `emit` in this
/// module used to be `let _ = …`, discarding the one piece of evidence that
/// anything went wrong — in a file whose own `place`, `monitor_for` and
/// `toggle` report the identical class of failure four lines away, and beside
/// `catch::CaptureSink`, which handles the very same `emit` with a full `match`.
/// One module, two error policies, nothing saying which applied where.
///
/// The emit at the end of [`hide`] is the one that makes this matter: `lib.rs`
/// spells out what it costs when that event does not land — the front end goes
/// on believing the shelf is open, so every later capture is filed away
/// silently instead of popping the column. One keystroke, two features dead,
/// and `docs/USAGE.md` sends the user to `shotshelf.log` for exactly that
/// symptom, which said nothing.
///
/// Not a `Result`: a window that will not resize is worth recording, not worth
/// abandoning the rest of the sequence for. [`preview`] is the exception and
/// says why.
fn attempt<T>(what: &str, outcome: tauri::Result<T>) {
    if let Err(err) = outcome {
        crate::diag::warn(&format!("could not {what}: {err}"));
    }
}

/// How far the popover sits from the corner it rests in.
const SCREEN_MARGIN: f64 = 12.0;

/// The corner the popover docks to, parsed from the settings string.
///
/// The parse lives here rather than in `settings.rs` because the corner is a
/// *placement* concept: settings owns the storage and the sanitising (an
/// unknown spelling has already been put back to the default by the time this
/// runs), and this module owns what a corner means in pixels. Anything
/// unrecognised — which `sanitise` makes unreachable, but a hand-built
/// `Settings` in a test is not sanitised — falls back to bottom-right.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Corner {
    BottomRight,
    BottomLeft,
    TopRight,
    TopLeft,
}

impl Corner {
    fn from_setting(value: &str) -> Self {
        match value {
            "bottom-left" => Self::BottomLeft,
            "top-right" => Self::TopRight,
            "top-left" => Self::TopLeft,
            _ => Self::BottomRight,
        }
    }
}

/// The physical origin that parks a window of `size` in `corner` of `area`.
///
/// Pure, so the arithmetic that decides whether the shelf lands on screen at
/// all is finally testable — `place` had no test of any kind while carrying
/// exactly the saturating-cast subtleties the comments below describe.
///
/// Far corners are `far edge − (extent + margin)`; near corners are
/// `position + margin`. The growth direction falls out for free: a bottom
/// corner's `y` depends on the height, so a taller column moves *up* to keep
/// its bottom edge; a top corner's `y` does not, so it grows *down*. No caller
/// needs to know which — the front end only ever sends a height.
fn corner_origin(
    area_position: (i32, i32),
    area_size: (u32, u32),
    scale: f64,
    size: (f64, f64),
    corner: Corner,
) -> (i32, i32) {
    // Saturating, not wrapping, and the difference is where the window lands.
    //
    // These are the casts `Cargo.toml`'s lint block names as its motivating
    // case, and they were the ones it did not cover. `as` on a float that is
    // NaN gives 0 and on one past `i32::MAX` gives `i32::MAX` — but the u32
    // width and height came from the OS and `as i32` on those *wraps* above
    // 2^31, which is a window placed at a negative coordinate rather than a
    // clamped one. Nothing here is near that today; the point is that the next
    // person to change `work_area()` should not have to know it.
    let to_physical = |value: f64| {
        let scaled = (value * scale).round();
        if scaled.is_nan() {
            0
        } else {
            #[allow(clippy::cast_possible_truncation)]
            {
                scaled.clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32
            }
        }
    };
    let edge = |position: i32, extent: u32| {
        position.saturating_add(i32::try_from(extent).unwrap_or(i32::MAX))
    };

    // Saturating here too. `edge` and `to_physical` were made total and then
    // fed into a plain `-`, which panics on overflow in a debug build — and
    // `gate:rust` builds debug. A saturating pair consumed by an unchecked
    // subtraction does not deliver what the paragraph above promises.
    let far_x =
        edge(area_position.0, area_size.0).saturating_sub(to_physical(size.0 + SCREEN_MARGIN));
    let far_y =
        edge(area_position.1, area_size.1).saturating_sub(to_physical(size.1 + SCREEN_MARGIN));
    let near_x = area_position.0.saturating_add(to_physical(SCREEN_MARGIN));
    let near_y = area_position.1.saturating_add(to_physical(SCREEN_MARGIN));

    match corner {
        Corner::BottomRight => (far_x, far_y),
        Corner::BottomLeft => (near_x, far_y),
        Corner::TopRight => (far_x, near_y),
        Corner::TopLeft => (near_x, near_y),
    }
}

/// Park the popover in its corner of the screen — bottom-right unless the
/// `dockCorner` setting says otherwise.
///
/// Measured against the monitor's **work area**, not its full size: the taskbar
/// lives in the difference between the two, and a window placed against the
/// real bottom edge disappears behind it. This is also why the placement is
/// done here rather than with `tauri-plugin-positioner` — its corner positions
/// work off `monitor.size()`, so they would tuck the shelf under the taskbar.
///
/// `size` is the logical size the caller has just asked for, rather than
/// anything read back off the window. A resize has not necessarily reached the
/// OS by the time this runs, so querying `outer_size()` here would place the
/// window using its previous shape.
fn place<R: Runtime>(shelf: &WebviewWindow<R>, size: (f64, f64)) {
    let Some(monitor) = monitor_for(shelf) else {
        return;
    };

    // Absent state means a test's bare mock app, not a missing setting — the
    // real app manages the store before any window shows.
    let corner = shelf
        .app_handle()
        .try_state::<crate::settings::SettingsStore>()
        .map_or(Corner::BottomRight, |store| {
            Corner::from_setting(&store.get().dock_corner)
        });

    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let (x, y) = corner_origin(
        (area.position.x, area.position.y),
        (area.size.width, area.size.height),
        scale,
        size,
        corner,
    );

    // On Linux this cannot fail and may not happen. `tao`'s GTK
    // `set_outer_position` returns `()` and only posts a request, which
    // becomes `gtk_window_move` — ignored under Wayland, where a client does
    // not choose its own position. So the branch below is dead there and the
    // shelf appears wherever the compositor puts it, which is not the corner
    // `README.md` describes. Nothing here can change that; a Wayland client
    // has no positioning protocol to use.
    if let Err(err) = shelf.set_position(tauri::PhysicalPosition::new(x, y)) {
        crate::diag::warn(&format!("could not place the shelf: {err}"));
    }
}

/// Re-park a visible shelf at its current size.
///
/// The one caller is `set_settings`, after a corner or monitor change: the
/// window should move now, not on its next open. Reading the size back off the
/// window is safe *here* — nothing has asked for a resize, so `outer_size` is
/// not racing one — which is exactly the situation `place`'s docstring warns
/// its own callers away from.
pub fn reposition<R: Runtime>(app: &AppHandle<R>) {
    let Some(shelf) = app.get_webview_window(SHELF) else {
        return;
    };
    if !shelf.is_visible().unwrap_or(false) {
        return;
    }
    let scale = match shelf.scale_factor() {
        Ok(scale) if scale > 0.0 => scale,
        _ => 1.0,
    };
    let Ok(size) = shelf.outer_size() else {
        return;
    };
    place(
        &shelf,
        (
            f64::from(size.width) / scale,
            f64::from(size.height) / scale,
        ),
    );
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
    // "The monitor my cursor is on", when asked for. Every failure on this
    // path — no cursor position (Wayland has no global one), no monitor
    // containing it, no settings state — falls through to the primary chain
    // below, because a shelf on the wrong screen beats no shelf at all.
    let wants_cursor = shelf
        .app_handle()
        .try_state::<crate::settings::SettingsStore>()
        .is_some_and(|store| store.get().dock_monitor == "cursor");
    if wants_cursor {
        if let Some(monitor) = monitor_under_cursor(shelf) {
            return Some(monitor);
        }
    }

    match shelf.primary_monitor() {
        Ok(Some(monitor)) => return Some(monitor),
        Ok(None) => {}
        Err(err) => crate::diag::warn(&format!("could not read the monitor layout: {err}")),
    }
    match shelf.current_monitor() {
        Ok(Some(monitor)) => Some(monitor),
        // Said out loud, like the `Err` arms. Both "no monitor" answers used to
        // return `None` silently, and `preview` treats that as a reason to
        // abandon the whole operation — returning before `set_size`, `center`,
        // `show`, `set_focus` and `mark_opened`, while the front end's `await`
        // resolves and mounts a full-size picture into a 225px window. That is
        // the failure this function's own docstring says it was extracted to
        // fix, and `docs/USAGE.md` points the user at a log that said nothing.
        Ok(None) => {
            crate::diag::warn("no monitor could be identified; the shelf cannot size itself");
            None
        }
        Err(err) => {
            crate::diag::warn(&format!("could not read the current monitor: {err}"));
            None
        }
    }
}

/// The monitor the pointer is currently on, if that can be known.
///
/// Containment is tested against the monitor's full bounds rather than its
/// work area: a cursor hovering the taskbar is still on that monitor. Quiet on
/// failure — the caller has a stated fallback, and "could not read the cursor"
/// on every open would be noise about a setting working as documented.
fn monitor_under_cursor<R: Runtime>(shelf: &WebviewWindow<R>) -> Option<tauri::Monitor> {
    let cursor = shelf.cursor_position().ok()?;
    let monitors = shelf.available_monitors().ok()?;
    monitors.into_iter().find(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        let right = f64::from(position.x) + f64::from(size.width);
        let bottom = f64::from(position.y) + f64::from(size.height);
        cursor.x >= f64::from(position.x)
            && cursor.x < right
            && cursor.y >= f64::from(position.y)
            && cursor.y < bottom
    })
}

/// The two shapes the popover takes.
///
/// Browsing your history and glancing at what just landed are different jobs,
/// but they are the same width: one column of cards, sized so a screenshot in
/// one is actually recognisable. Only the height and the chrome differ — browse
/// is a fixed, scrollable box with a title strip, the column is sized to
/// exactly the cards it holds and carries no furniture at all.
pub const BROWSE_SIZE: (f64, f64) = (225.0, 420.0);

/// The shortest browse window: the title strip plus one card with its day
/// heading and the box's own padding. A report below this is a measurement
/// bug, not a wish — one card must always be recognisable.
pub(crate) const MIN_BROWSE_HEIGHT: f64 = 160.0;

/// The tallest a fitted browse may ask for: three cards with their strip,
/// headings and paddings, plus a wrapped alert line of slack. The *fit* is
/// the front end's — it cuts its measurement at the third card's bottom —
/// so this is the sanity guard on a value that crosses the IPC boundary,
/// not the rule itself.
const MAX_BROWSE_HEIGHT: f64 = 560.0;

/// The smallest the user may drag the browse window: its stock width, and
/// one recognisable card's worth of height. `settings::sanitise` clamps the
/// stored size to the same floors, so the two statements cannot disagree.
pub(crate) const MIN_BROWSE_WIDTH: f64 = BROWSE_SIZE.0;

/// The browse window's width and fit ceiling, honouring the user's dragged
/// size when one is stored: width applies always, height caps the adaptive
/// fit — one capture still gets a snug window however tall the ceiling.
/// Read from state like `paths::resolve_watch_dirs` reads the watch lists;
/// absent state (bare test apps) means stock.
fn browse_dims<R: Runtime>(app: &AppHandle<R>) -> (f64, f64) {
    let (width, ceiling) = app
        .try_state::<crate::settings::SettingsStore>()
        .map(|store| {
            let settings = store.get();
            (settings.browse_width, settings.browse_height)
        })
        .unwrap_or_default();
    (
        width.unwrap_or(BROWSE_SIZE.0),
        ceiling.unwrap_or(MAX_BROWSE_HEIGHT),
    )
}

/// The last size this module set, packed as rounded logical (w, h) — the
/// half of user-resize detection that filters our own work. Written by
/// [`set_size_noting`], which is the only thing that resizes the window and
/// says why that matters.
static LAST_SET: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Whether the quick look is up. `mark_opened` fires for previews too, so
/// `is_opened` alone cannot keep a preview's 72%-of-screen size out of the
/// remembered browse size; `preview` sets this, `open` clears it.
static PREVIEWING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// How many glide threads are mid-flight. A glide is ten sizes in 160ms and
/// the OS delivers their Resized events on its own schedule — an event can
/// trail [`LAST_SET`] by a whole frame, which is more than the tolerance —
/// so detection simply stands down while any glide runs. The final event
/// arrives after the counter drops and matches the recorded target.
static GLIDING: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

/// Decrements [`GLIDING`] however the glide thread leaves — the superseded
/// early return included.
struct GlideGuard;
impl Drop for GlideGuard {
    fn drop(&mut self) {
        GLIDING.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    }
}

// Exact by construction: rounded and clamped into [0, u32::MAX] before the
// cast, so neither truncation nor sign loss can occur — the allow states
// that rather than restructuring arithmetic three comparisons deep.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn pack_size(width: f64, height: f64) -> u64 {
    let w = width.round().clamp(0.0, f64::from(u32::MAX)) as u64;
    let h = height.round().clamp(0.0, f64::from(u32::MAX)) as u64;
    (w << 32) | h
}

/// Resize the window, and record that *we* were the ones who did.
///
/// One function rather than two statements at each site, because the two are
/// a single fact and a site that does only the first is silent: the landing
/// `Resized` event then matches nothing in [`LAST_SET`], `note_resized` reads
/// the app's own work as the user's hand, and the shelf remembers a size
/// nobody dragged it to. That is not hypothetical — the per-frame call was
/// dropped by a bad edit here and nothing in the crate could notice, since
/// every one of these sites takes a `WebviewWindow` and no test can run them.
///
/// Three callers, and they are all of them: `glide`'s instant branch, the
/// frames of a glide (a glide is ten sizes, and recording only the target
/// would leave nine of them looking like a hand), and the quick look.
fn set_size_noting<R: Runtime>(shelf: &WebviewWindow<R>, what: &'static str, size: (f64, f64)) {
    LAST_SET.store(
        pack_size(size.0, size.1),
        std::sync::atomic::Ordering::Relaxed,
    );
    attempt(
        what,
        shelf.set_size(tauri::LogicalSize::new(size.0, size.1)),
    );
}

/// Whether a reported size is the one this module just set, within the
/// couple of pixels DPI rounding moves a logical size by on its round trip
/// through physical coordinates.
fn was_programmatic(last: u64, got: (f64, f64)) -> bool {
    let (last_w, last_h) = unpack_size(last);
    (last_w - got.0).abs() <= 2.0 && (last_h - got.1).abs() <= 2.0
}

/// The inverse of [`pack_size`]. Each half fits a u32, which f64 holds
/// exactly — the allow states the impossibility rather than restructuring.
#[allow(clippy::cast_precision_loss)]
fn unpack_size(packed: u64) -> (f64, f64) {
    (
        ((packed >> 32) & 0xffff_ffff) as f64,
        (packed & 0xffff_ffff) as f64,
    )
}

/// The user's drag, pending its debounce — packed like [`LAST_SET`], with
/// zero meaning nothing pending.
static PENDING_RESIZE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static RESIZE_WRITER_ARMED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// A window resize arrived from the OS. Decide whose it was, and remember
/// the user's.
///
/// Called from `lib.rs`'s window-event hook for the main window only. Our
/// own resizes are filtered by [`LAST_SET`]; a preview's by [`PREVIEWING`];
/// anything with the window not deliberately open cannot be a user drag at
/// all, because the peek keeps `resizable(false)`. What survives is the
/// user's hand on the border — debounced 600ms before it is persisted,
/// because `SettingsStore::note_capture` documents exactly what per-event
/// writes cost, and a drag is a stream of events.
pub fn note_resized<R: Runtime>(app: &AppHandle<R>, width: f64, height: f64) {
    if !is_opened() || PREVIEWING.load(std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    if GLIDING.load(std::sync::atomic::Ordering::Relaxed) > 0 {
        return;
    }
    if was_programmatic(
        LAST_SET.load(std::sync::atomic::Ordering::Relaxed),
        (width, height),
    ) {
        return;
    }

    PENDING_RESIZE.store(
        pack_size(width, height),
        std::sync::atomic::Ordering::Relaxed,
    );
    if RESIZE_WRITER_ARMED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(600));
        RESIZE_WRITER_ARMED.store(false, std::sync::atomic::Ordering::Relaxed);
        let pending = PENDING_RESIZE.swap(0, std::sync::atomic::Ordering::Relaxed);
        if pending == 0 {
            return;
        }
        let (width, height) = unpack_size(pending);
        // Deliberately not written into the fit cache. That cache is what
        // the next open glides to before the front end has measured
        // anything, and the dragged height is a ceiling rather than a size:
        // caching it would open a shelf holding two cards at the full
        // dragged height and then shrink it the moment the measurement
        // arrived — the flash the cache exists to prevent.
        crate::settings::remember_browse_size(&app, width, height);
    });
}

/// The browse height the front end last measured, remembered between opens.
///
/// The browse window fits its content now — one card gets one card's height,
/// capped at [`BROWSE_SIZE`]'s — but a deliberate open originates here
/// (hotkey, tray), where no DOM can be measured. So the front end reports
/// after every browse render, this remembers bitwise (the same shape as
/// [`OPENED`]), the next open shows at the last known height, and the first
/// render's own report corrects it if captures moved while the window was
/// down.
static BROWSE_HEIGHT: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(f64::to_bits(BROWSE_SIZE.1));

fn set_browse_height(height: f64) {
    BROWSE_HEIGHT.store(height.to_bits(), std::sync::atomic::Ordering::Relaxed);
}

fn browse_height() -> f64 {
    f64::from_bits(BROWSE_HEIGHT.load(std::sync::atomic::Ordering::Relaxed))
}

/// Clamp a front-end browse measurement into the window's honest range.
///
/// `None` is the front end asking for the ceiling — the empty state keeps
/// the full window, because it is the app's teaching surface. Non-finite
/// numbers get the same answer for the same reason `peek` rejects them:
/// the value arrives from the front end, and a window sized to NaN is not
/// a state.
pub(crate) fn fitted_browse_height(content: Option<f64>, ceiling: f64) -> f64 {
    // The ceiling is the user's dragged height when one is stored — already
    // sanitised on its way into the settings file — or the stock maximum.
    // The floor still applies: no ceiling may argue with "one card must be
    // recognisable".
    let ceiling = if ceiling.is_finite() {
        ceiling.max(MIN_BROWSE_HEIGHT)
    } else {
        MAX_BROWSE_HEIGHT
    };
    match content {
        Some(content) if content.is_finite() => content.clamp(MIN_BROWSE_HEIGHT, ceiling),
        _ => BROWSE_SIZE.1.clamp(MIN_BROWSE_HEIGHT, ceiling),
    }
}
/// The tallest the popped column may be asked to grow. Generous — a tall
/// screen holds a lot of cards — and it exists so the number cannot be absurd.
const MAX_COLUMN_HEIGHT: f64 = 4000.0;
pub const COLUMN_WIDTH: f64 = BROWSE_SIZE.0;

/// How long a shape change takes to arrive, mirroring the stylesheet's
/// `--motion-state`. Deliberately one beat: the OS reduced-motion preference
/// cannot be read portably from here, and 160ms of ease-out is below the
/// threshold where motion becomes a journey — that limit is stated rather
/// than hidden.
const GLIDE_MS: u64 = 160;
const GLIDE_STEPS: u32 = 10;

/// Supersession: each glide claims an epoch, and a newer claim ends it —
/// cards landing faster than the animation would otherwise queue fights
/// over the same window.
static GLIDE_EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The eased fraction at `step` of `steps` — ease-out, exact at both ends.
fn glide_fraction(step: u32, steps: u32) -> f64 {
    let x = f64::from(step) / f64::from(steps);
    1.0 - (1.0 - x) * (1.0 - x)
}

/// Move the shelf to `size` smoothly when it is visible, instantly when not.
///
/// The `set_size`/`place` pair every shape change already makes, played over
/// ten corner-anchored frames: `place` runs per frame, so a bottom-anchored
/// window keeps its bottom edge still and growth reads as the top edge
/// travelling — the one-to-two-to-three of the fitted shelf, the column
/// taking a card, and the popup becoming the browse view all move instead of
/// snapping. Hidden windows jump: nothing should grow out of nowhere. A
/// newer resize supersedes mid-flight, and the last frame is the exact
/// target — the animation is presentation, never a different answer.
fn glide<R: Runtime>(shelf: &WebviewWindow<R>, what: &'static str, size: (f64, f64)) {
    let from = shelf
        .outer_size()
        .ok()
        .zip(shelf.scale_factor().ok())
        .map(|(current, scale)| {
            (
                f64::from(current.width) / scale,
                f64::from(current.height) / scale,
            )
        });
    let visible = shelf.is_visible().unwrap_or(false);
    // Anything not worth animating — hidden, unreadable, or already there —
    // takes the exact pair the call sites used to make.
    let close_enough =
        from.is_some_and(|from| (from.0 - size.0).abs() < 1.0 && (from.1 - size.1).abs() < 1.0);
    let (Some(from), true, false) = (from, visible, close_enough) else {
        set_size_noting(shelf, what, size);
        place(shelf, size);
        return;
    };

    let epoch = GLIDE_EPOCH.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    GLIDING.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let shelf = shelf.clone();
    std::thread::spawn(move || {
        let _down_when_done = GlideGuard;
        for step in 1..=GLIDE_STEPS {
            if GLIDE_EPOCH.load(std::sync::atomic::Ordering::Relaxed) != epoch {
                return;
            }
            let t = glide_fraction(step, GLIDE_STEPS);
            let frame = (
                from.0 + (size.0 - from.0) * t,
                from.1 + (size.1 - from.1) * t,
            );
            set_size_noting(&shelf, what, frame);
            place(&shelf, frame);
            std::thread::sleep(std::time::Duration::from_millis(
                GLIDE_MS / u64::from(GLIDE_STEPS),
            ));
        }
    });
}

/// Open the popover because the user asked: tray, hotkey, dock, or a restore
/// after the editor closes.
pub fn open_deliberately<R: Runtime>(app: &AppHandle<R>) {
    open(app, Appearance::Deliberate);
}

/// Open the popover at launch, which nobody asked for.
///
/// The one appearance that takes itself away again — `popover.ts` reads the
/// `false` and arms its own dismissal.
pub fn open_at_launch<R: Runtime>(app: &AppHandle<R>) {
    open(app, Appearance::Launch);
}

/// Open the popover: full grid, in its corner, on top, and focused.
///
/// Private, behind the two named wrappers above, because `deliberate` is a flag
/// argument on which the whole launch/deliberate distinction turns and every
/// caller passed a literal. Inverting one of those literals inside
/// `show_shelf` — which no test in this crate can execute and which the browser
/// harness *supplies* rather than observes — made every tray click, hotkey and
/// editor-restore emit `shelf://opened` with `deliberate = false`. `popover.ts`
/// reads that as the launch appearance, so the shelf the user just opened
/// dismisses itself four seconds later. Clippy, all 160 tests and the whole
/// gate stayed green. That is the failure `mark_opened` spends eight lines on,
/// inverted, and a bool at a call site is not the place for it.
fn open<R: Runtime>(app: &AppHandle<R>, appearance: Appearance) {
    let Some(shelf) = app.get_webview_window(SHELF) else {
        return;
    };

    // The cached fitted height, not the ceiling: the browse window takes the
    // height its content needed last time it was measured, so an open with
    // one card on the shelf does not flash the full grid first. Gliding when
    // it was already up is the popup-becomes-shelf morph. Width — and the
    // cap on that cached height — honour the size the user dragged.
    let (user_width, user_ceiling) = browse_dims(app);
    let size = (user_width, browse_height().min(user_ceiling));
    // Before the glide, not after: this is the one shape a hand may resize,
    // and the minimums are a rule about the window rather than about this
    // appearance of it — applying them first leaves the glide's own frames
    // the last word on where it lands. Both come off again in `peek` and
    // `preview`, whose shapes are Rust's to decide.
    PREVIEWING.store(false, std::sync::atomic::Ordering::Relaxed);
    attempt(
        "allow resizing the browse window",
        shelf.set_resizable(true),
    );
    attempt(
        "floor the browse window's size",
        shelf.set_min_size(Some(tauri::LogicalSize::new(
            MIN_BROWSE_WIDTH,
            MIN_BROWSE_HEIGHT,
        ))),
    );
    glide(&shelf, "resize the shelf to the browse grid", size);
    attempt("show the shelf", shelf.show());
    attempt("focus the shelf", shelf.set_focus());
    mark_opened(&shelf, appearance);
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
    // Transient, and never the user's to resize. The minimums matter as much
    // as the handle: they are the *browse* floor, and a column asked for at
    // 80 is a column the OS would refuse to shrink below 160 while they are
    // still on — so once the shelf had been opened, every later popup would
    // have come up too tall.
    attempt("fix the column's size", shelf.set_resizable(false));
    attempt(
        "lift the browse minimums off the column",
        shelf.set_min_size(None::<tauri::LogicalSize<f64>>),
    );
    // Glide rather than jump: the column grows a card at a time, and it is
    // pinned by its corner, so each frame re-places to keep that corner still
    // while the far edge travels.
    glide(
        &shelf,
        "resize the shelf to the column",
        (COLUMN_WIDTH, height),
    );
    attempt("show the column", shelf.show());
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
pub fn preview<R: Runtime>(app: &AppHandle<R>, aspect: f64) -> Result<(), String> {
    let Some(shelf) = app.get_webview_window(SHELF) else {
        return Err("the shelf window is not there".to_owned());
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
        // Nothing to measure against, so nothing sensible to resize to — and
        // unlike every other operation in this module, stopping here is not a
        // cosmetic loss. This returns before `set_size`, `center`, `show`,
        // `set_focus` *and* `mark_opened`, so the window keeps its 225px column
        // shape while the front end's `await` resolves and mounts a full-size
        // picture or an editor into it. Worse, `mark_opened` never firing
        // leaves the front end's `#opened` false, so the next capture resizes
        // the window to column height underneath the open overlay.
        //
        // So this one reports. `showPreview` already has a `.catch` that puts a
        // sentence on the alert strip; the caller can decide not to open rather
        // than open into a window that never grew.
        return Err("no monitor could be identified, so the shelf cannot be resized".to_owned());
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

    // A quick look is sized by Rust, not the hand: mark it so the resize
    // events it fires are never remembered as the user's browse size.
    PREVIEWING.store(true, std::sync::atomic::Ordering::Relaxed);
    attempt("fix the preview's size", shelf.set_resizable(false));
    attempt(
        "lift the browse minimums off the preview",
        shelf.set_min_size(None::<tauri::LogicalSize<f64>>),
    );
    set_size_noting(&shelf, "resize the shelf for a preview", (width, height));
    attempt("centre the shelf", shelf.center());
    attempt("show the preview", shelf.show());
    attempt("focus the preview", shelf.set_focus());
    // Safe when already browsing: `adoptBrowse` is front-end state only and
    // never calls back into Rust, so this cannot re-enter.
    // A quick look is the user asking, so the launch appearance stands down.
    mark_opened(&shelf, Appearance::Deliberate);
    Ok(())
}

pub fn hide<R: Runtime>(app: &AppHandle<R>) {
    let Some(shelf) = app.get_webview_window(SHELF) else {
        return;
    };
    set_opened(false);
    attempt("hide the shelf", shelf.hide());

    // The front-end keeps its own "did you ask for this?" flag, and a close
    // from the tray icon, the tray menu or the hotkey never passes through it.
    // Without this it goes on believing the shelf is open and files every later
    // capture away silently instead of popping the column.
    attempt(
        "announce that the shelf closed",
        shelf.emit(HIDDEN_EVENT, ()),
    );

    // No `app.hide()` here, on any platform.
    //
    // It was here on macOS, to hand focus back to whatever the user was
    // actually working in. `AppHandle::hide` is not "deactivate" — it is ⌘H,
    // `NSApplication::hide`, which hides the *whole application*. Its pair,
    // `AppHandle::show` → `NSApplication::unhide`, was called nowhere.
    //
    // Neither thing `open` does afterwards recovers it. `window.show()` reaches
    // `makeKeyAndOrderFront:`, which orders a window front and does not unhide
    // an application; `set_focus` is the only call in the graph that reaches
    // `activateIgnoringOtherApps:`, and `tao` gates it behind
    // `ns_window.isVisible()`, which is false for every window of a hidden app.
    // `peek` never calls `set_focus` at all, so a newly landed capture cannot
    // bring it back either. And `ActivationPolicy::Accessory` means there is no
    // Dock icon and no ⌘-Tab entry to unhide it by hand.
    //
    // Every dismissal reached it — the tray, the tray menu, the hotkey, ⌘W,
    // `hide_shelf` — including the two nobody triggers: the column's
    // sixty-second expiry, and the four-second launch dismissal. So a first
    // macOS launch showed the shelf and then hid its own application, four
    // seconds in, with no user action at all and no way back.
    //
    // Losing the focus-return nicety is the right trade for that. Tauri exposes
    // no "deactivate without hiding", so the alternative would be hand-rolled
    // AppKit in a project that adopts crates rather than doing that.
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
        Ok(_) => open_deliberately(app),
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
            // A `u32` DWORD, and `preference` is a `u32`: this is 4.
            #[allow(clippy::cast_possible_truncation)]
            {
                std::mem::size_of_val(&preference) as u32
            },
        );
    }
}

/// What `show_shelf`'s two arguments actually ask for.
///
/// Three answers from four representable combinations, which is the point:
/// `focus` and `height` are two booleans-worth of wire and only two of the
/// four pairs mean anything. Naming the three makes the fourth a value the
/// caller can be told about rather than a branch that quietly does nothing.
///
/// `Debug` and `PartialEq` because the test compares these; no `Clone` or
/// `Copy`, which it was written with and nothing needed — `wanted` returns by
/// value and the one `match` moves out of it. `cache::Version` records what an
/// unjustified derive costs: a sentence explaining a property no caller uses,
/// which the next reader takes for a requirement.
#[derive(Debug, PartialEq)]
pub(crate) enum Wanted {
    /// The user asked for the shelf — hotkey, tray, dock. Takes focus.
    Deliberate,
    /// A capture landed. Peek at the column, at the height the front end says
    /// its cards need.
    Column(f64),
    /// A column with no height, which is a caller bug and not a state.
    Unsaid,
}

/// Read the request out of the pair, so the decision has a test.
///
/// Separated from the command because `show_shelf` takes an `AppHandle` and
/// therefore nothing in this crate can call it, and no browser spec executes a
/// real `#[tauri::command]` either. Inverting the `focus` branch inside the
/// command left *every* gate green — clippy, 158 Rust tests, `cargo fmt`, the
/// whole `deadcode` chain, and all 166 Playwright tests — while shipping a
/// hotkey that opens nothing and a landed capture that steals focus mid-typing.
///
/// The same shape as `catch::settled` and `CaptureSink::note_folder_image`: the
/// decision was on the untestable side of the IPC boundary, and moving it one
/// function out is the whole fix.
pub(crate) fn wanted(focus: bool, height: Option<f64>) -> Wanted {
    if focus {
        // `height` is ignored here, deliberately: a deliberate open shows the
        // browse shape, whose size the window owns.
        return Wanted::Deliberate;
    }
    // No default. Every `focus: false` caller supplies a height — `popover.ts`
    // is the only one — so `unwrap_or(120.0)` was unreachable. It was also
    // wrong: one card needs 136, so had it ever been reached it would have
    // clipped the single capture the peeked column exists to show, and it was a
    // fourth copy of card metrics that `geometry.ts` owns and `layout.spec.ts`
    // joins to the stylesheet.
    height.map_or(Wanted::Unsaid, Wanted::Column)
}

/// Commands the front-end uses to drive the popover.
///
/// `height` is only meaningful for the column: the front-end knows how many
/// cards are showing, so it decides how tall the window needs to be.
///
/// Where the cover ends, stated rather than implied — and stated as a mutation
/// that really does survive, because the first two attempts at this sentence
/// named ones that do not.
///
/// [`wanted`] decides, and a test pins all four argument combinations. What is
/// left here is the dispatch, and nothing in the repo can execute it: this takes
/// an `AppHandle`, which no Rust test can build, and no browser spec runs a real
/// `#[tauri::command]` — `webview_path.rs` records that limit for the tier.
///
/// Swapping the three arms below is **not** the example: with a payload on
/// `Column`, the literal swap does not compile, and the nearest one that does
/// leaves `height` unused and `peek` uncalled, which `-D warnings` refuses. Nor
/// is `open(&app, true)`, which no longer exists.
///
/// What does survive is calling the wrong *named* function — `open_at_launch`
/// where `open_deliberately` belongs, here or in `lib.rs`, or the equivalent
/// inside either wrapper. Every tray click and hotkey press would then dismiss
/// itself four seconds later, with clippy and every test green. [`Appearance`]
/// is what makes that read wrong rather than look ordinary; it does not make it
/// impossible, and nothing at this boundary can.
///
/// Not the `Appearance → bool` translation, though, which this used to leave
/// implied. That was the last untested step of the distinction — inverting it
/// had the same effect and the same silence — and it has a name and a test
/// against the shared fixture now: [`Appearance::deliberate`]. The enum alone
/// had moved the risk from three call sites into one function rather than
/// removing it.
#[tauri::command]
pub fn show_shelf<R: Runtime>(app: AppHandle<R>, focus: bool, height: Option<f64>) {
    match wanted(focus, height) {
        Wanted::Deliberate => open_deliberately(&app),
        Wanted::Column(height) => peek(&app, height),
        Wanted::Unsaid => crate::diag::warn("show_shelf asked for the column with no height"),
    }
}

#[tauri::command]
pub fn hide_shelf<R: Runtime>(app: AppHandle<R>) {
    hide(&app);
}

/// Fit the browse window to the content the front end just measured.
///
/// Always a cache write — the next deliberate open shows at this height —
/// and a live resize only while the browse shape is actually up: a report
/// arriving with the window down (or mid-column, which `popover.ts` already
/// refuses to send) must not put anything on screen. The same
/// re-place-on-resize rule as `peek`: the window is pinned by its corner, so
/// a shorter one moves to keep that corner where it was.
#[tauri::command]
pub fn size_browse<R: Runtime>(app: AppHandle<R>, content: Option<f64>) {
    let (user_width, user_ceiling) = browse_dims(&app);
    let height = fitted_browse_height(content, user_ceiling);
    set_browse_height(height);

    if !is_opened() {
        return;
    }
    let Some(shelf) = app.get_webview_window(SHELF) else {
        return;
    };
    if !shelf.is_visible().unwrap_or(false) {
        return;
    }
    glide(
        &shelf,
        "fit the browse window to its cards",
        (user_width, height),
    );
}

/// Grow the popover to show one capture large.
///
/// Only Rust knows the work area, so only Rust can choose the size.
#[tauri::command]
pub fn preview_shelf<R: Runtime>(app: AppHandle<R>, aspect: f64) -> Result<(), String> {
    preview(&app, aspect)
}

/// The settings window's label — declared in `tauri.conf.json`, like [`SHELF`].
pub const SETTINGS_WINDOW: &str = "settings";

/// Show and focus the settings window.
///
/// The window is declared in the config (hidden at start, centered) rather
/// than created on demand: create-on-demand needs a builder call that can
/// fail in six ways, and a second click racing the first can build two. A
/// declared window exists exactly once for the life of the app, so this is
/// show-and-focus and nothing else — the same reason the shelf itself is
/// declared. Closing it hides it (see the on-close handler in `lib.rs`), so
/// every open after the first is instant and keeps whatever section was
/// showing.
#[tauri::command]
pub fn open_settings<R: Runtime>(app: AppHandle<R>) {
    let Some(window) = app.get_webview_window(SETTINGS_WINDOW) else {
        crate::diag::warn("the settings window is not declared");
        return;
    };
    attempt("show the settings window", window.show());
    attempt("focus the settings window", window.set_focus());
}

#[cfg(test)]
mod tests {
    use super::{fitted_browse_height, wanted, Wanted, BROWSE_SIZE};

    #[test]
    fn our_own_sizes_are_recognised_and_the_hand_is_not() {
        // The tolerance is the couple of pixels DPI rounding moves a logical
        // size by on its round trip through physical coordinates — a real
        // drag moves further than that or it is not a drag.
        let last = super::pack_size(300.0, 480.0);
        assert!(super::was_programmatic(last, (300.0, 480.0)));
        assert!(
            super::was_programmatic(last, (301.5, 478.5)),
            "DPI rounding is ours"
        );
        assert!(
            !super::was_programmatic(last, (330.0, 480.0)),
            "a widened window is a drag"
        );
        assert!(
            !super::was_programmatic(last, (300.0, 520.0)),
            "a taller one too"
        );
    }

    #[test]
    fn a_glide_lands_exactly_and_only_moves_forward() {
        // The last frame must be the target itself — the animation is
        // presentation, never a different answer — and the fraction must
        // never back up, or a growing window would visibly stutter.
        assert!(
            (super::glide_fraction(super::GLIDE_STEPS, super::GLIDE_STEPS) - 1.0).abs()
                < f64::EPSILON,
            "the final frame is the target, not near it"
        );
        let mut last = 0.0;
        for step in 1..=super::GLIDE_STEPS {
            let f = super::glide_fraction(step, super::GLIDE_STEPS);
            assert!(f > last, "the glide never backs up");
            last = f;
        }
    }

    #[test]
    fn a_browse_measurement_is_clamped_into_the_honest_range() {
        // A mid-range measurement passes through untouched — that is the
        // whole feature: one card's height for one card.
        let stock = super::MAX_BROWSE_HEIGHT;
        assert_eq!(fitted_browse_height(Some(300.0), stock), 300.0);
        assert_eq!(
            fitted_browse_height(Some(10.0), stock),
            160.0,
            "one card must stay recognisable, whatever was measured"
        );
        assert_eq!(
            fitted_browse_height(Some(9000.0), stock),
            560.0,
            "past the three-card fit the list scrolls; the window stops growing"
        );
        // The user's dragged height replaces the stock ceiling in both
        // directions: taller lets more content stand, shorter caps sooner —
        // and the floor still outranks any ceiling.
        assert_eq!(fitted_browse_height(Some(900.0), 800.0), 800.0);
        assert_eq!(fitted_browse_height(Some(300.0), 800.0), 300.0);
        assert_eq!(fitted_browse_height(Some(500.0), 240.0), 240.0);
        assert_eq!(
            fitted_browse_height(Some(500.0), 40.0),
            160.0,
            "no ceiling argues with one recognisable card"
        );
        // `None` is the empty state asking for the ceiling on purpose; a NaN
        // is the front end having a bug, not a wish. Same answer, different
        // reasons, both stated — and the empty state honours a low ceiling.
        assert_eq!(fitted_browse_height(None, stock), BROWSE_SIZE.1);
        assert_eq!(fitted_browse_height(Some(f64::NAN), stock), BROWSE_SIZE.1);
        assert_eq!(fitted_browse_height(None, 300.0), 300.0);
    }

    #[test]
    fn the_two_things_show_shelf_can_be_asked_for_are_told_apart() {
        // `show_shelf` takes an `AppHandle`, so no test in this crate can call
        // it, and no browser spec executes a real `#[tauri::command]` either.
        // Inverting its `focus` branch left *every* gate green — clippy, 158
        // Rust tests, `cargo fmt`, the whole `deadcode` chain, and 166
        // Playwright tests — while shipping a hotkey that opens nothing and a
        // landed capture that steals focus out from under whatever the user is
        // typing into.
        assert_eq!(wanted(true, None), Wanted::Deliberate);
        // A deliberate open ignores the height rather than peeking at it: the
        // browse shape's size is the window's to decide.
        assert_eq!(wanted(true, Some(400.0)), Wanted::Deliberate);

        assert_eq!(wanted(false, Some(400.0)), Wanted::Column(400.0));

        // The fourth combination is a caller bug, and is said out loud rather
        // than defaulted. A default here was unreachable *and* wrong: it was
        // 120, and one card needs 136, so it would have clipped the single
        // capture the peeked column exists to show.
        assert_eq!(wanted(false, None), Wanted::Unsaid);
    }

    #[test]
    fn the_window_events_match_what_the_browser_harness_expects() {
        // Both halves of the open event: the name, and which payload means
        // "the user asked for this".
        let shared: serde_json::Value =
            serde_json::from_str(WINDOW_EVENTS).expect("the shared fixture parses");

        assert_eq!(shared["opened"].as_str(), Some(OPENED_EVENT));
        assert_eq!(shared["hidden"].as_str(), Some(HIDDEN_EVENT));

        // Both values, and *which appearance sends which* — the fixture pinned
        // the two booleans and neither side pinned the mapping onto them, so
        // the one expression that turns an `Appearance` into the wire boolean
        // could be inverted with clippy and every test green. `mark_opened`
        // takes a `&WebviewWindow`, so nothing here can execute it; the mapping
        // is `Appearance::deliberate` for exactly that reason.
        assert_eq!(shared["deliberate"].as_bool(), Some(true));
        assert_eq!(shared["launch"].as_bool(), Some(false));
        assert_eq!(
            shared["deliberate"].as_bool(),
            Some(Appearance::Deliberate.deliberate()),
            "a deliberate open no longer tells the front end the user asked",
        );
        assert_eq!(
            shared["launch"].as_bool(),
            Some(Appearance::Launch.deliberate()),
            "the launch appearance now claims the user asked for it",
        );

        // The other two events cross the same boundary and had the same gap:
        // a constant on the Rust side that only its own file reads, and a
        // hard-coded string in `main.ts`. Renaming `capture://new` leaves the
        // front end's `listen` *succeeding* — so `subscribe` reports nothing —
        // and no capture ever reaches the shelf. Silent, total, every gate
        // green, since no browser test can reach Rust.
        assert_eq!(
            shared["capture"].as_str(),
            Some(crate::catch::CAPTURE_EVENT)
        );
        assert_eq!(
            shared["problem"].as_str(),
            Some(crate::catch::PROBLEM_EVENT)
        );
        assert_eq!(shared["update"].as_str(), Some(crate::update::UPDATE_EVENT));
    }

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

    /// A 1920×1032 work area at scale 1 — the shape the app was actually
    /// measured against on the machine that first ran it.
    const AREA: ((i32, i32), (u32, u32)) = ((0, 0), (1920, 1032));

    #[test]
    fn each_corner_parks_the_window_where_the_corner_says() {
        // The geometry that decides whether the shelf lands on screen at all
        // had no test while it was one hard-coded corner; four corners is four
        // ways for a sign error to put it off screen. 225×420 browse window,
        // 12px margin: far edges are area minus (extent + 12), near edges are
        // 12 in from the origin.
        let size = (225.0, 420.0);

        let cases = [
            (Corner::BottomRight, (1920 - 237, 1032 - 432)),
            (Corner::BottomLeft, (12, 1032 - 432)),
            (Corner::TopRight, (1920 - 237, 12)),
            (Corner::TopLeft, (12, 12)),
        ];
        for (corner, expected) in cases {
            assert_eq!(
                corner_origin(AREA.0, AREA.1, 1.0, size, corner),
                expected,
                "{corner:?} parked the window somewhere else",
            );
        }
    }

    #[test]
    fn growth_direction_follows_the_corner() {
        // The column growing a card at a time is the one behaviour that
        // depends on which coordinate tracks the height: a bottom corner must
        // move *up* as the column grows (fixed bottom edge), a top corner must
        // not move at all (fixed top edge, growing down). This is the property
        // the peek comment promises, generalised.
        let short = corner_origin(AREA.0, AREA.1, 1.0, (225.0, 138.0), Corner::BottomRight);
        let tall = corner_origin(AREA.0, AREA.1, 1.0, (225.0, 378.0), Corner::BottomRight);
        assert!(
            tall.1 < short.1,
            "a taller bottom-docked column must move up"
        );
        assert_eq!(short.1 + 138, tall.1 + 378, "the bottom edge must not move");

        let short = corner_origin(AREA.0, AREA.1, 1.0, (225.0, 138.0), Corner::TopLeft);
        let tall = corner_origin(AREA.0, AREA.1, 1.0, (225.0, 378.0), Corner::TopLeft);
        assert_eq!(
            short, tall,
            "a top-docked column grows down from a fixed origin"
        );
    }

    #[test]
    fn scale_factor_reaches_both_margin_and_extent() {
        // At 200% DPI the 12px logical margin is 24 physical pixels, and the
        // 225-wide window is 450. A corner that scaled one and not the other
        // would drift by exactly the unscaled half — visible on every high-DPI
        // laptop, caught by no other test.
        let (x, y) = corner_origin(AREA.0, AREA.1, 2.0, (225.0, 420.0), Corner::BottomRight);
        assert_eq!((x, y), (1920 - 2 * 237, 1032 - 2 * 432));

        let (x, y) = corner_origin(AREA.0, AREA.1, 2.0, (225.0, 420.0), Corner::TopLeft);
        assert_eq!((x, y), (24, 24));
    }

    #[test]
    fn an_unhinged_monitor_layout_saturates_rather_than_wrapping() {
        // The saturating arithmetic predates the corners and its promise must
        // survive them: a NaN size places at the near edge rather than
        // panicking, and an extent past i32::MAX clamps rather than wrapping
        // into a negative coordinate.
        let (x, _) = corner_origin(
            (0, 0),
            (u32::MAX, 1032),
            1.0,
            (f64::NAN, 420.0),
            Corner::BottomRight,
        );
        assert_eq!(x, i32::MAX);

        let (x, y) = corner_origin(
            (i32::MAX, i32::MAX),
            (u32::MAX, u32::MAX),
            1.0,
            (225.0, 420.0),
            Corner::TopLeft,
        );
        assert_eq!((x, y), (i32::MAX, i32::MAX));
    }

    #[test]
    fn every_stored_corner_spelling_parses_to_its_own_corner() {
        // The join between `settings::DOCK_CORNERS` — what `sanitise` lets
        // through and what the panel's options say — and this module's parse.
        // Four spellings, four distinct corners; a fifth spelling is the
        // documented fallback. Distinctness matters as much as coverage: a
        // copy-paste error mapping two spellings to one corner passes a
        // per-value check.
        let parsed: Vec<Corner> = crate::settings::DOCK_CORNERS
            .iter()
            .map(|value| Corner::from_setting(value))
            .collect();
        assert_eq!(parsed.len(), 4);
        for (index, corner) in parsed.iter().enumerate() {
            assert_eq!(
                parsed.iter().position(|other| other == corner),
                Some(index),
                "two corner spellings parse to {corner:?}",
            );
        }
        assert_eq!(Corner::from_setting("under-the-desk"), Corner::BottomRight);
    }
}
