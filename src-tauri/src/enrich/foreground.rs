//! What you were looking at when a capture landed.
//!
//! A screenshot arrives named after the clock. "VS Code — auth.ts" tells you
//! which one it is at a glance; `Screenshot 2026-07-27 133012.png` does not,
//! and no amount of scrolling a wall of thumbnails fixes that.
//!
//! **This never asks for a new permission.** That constraint decides the whole
//! design, because the obvious implementation on macOS would break a promise
//! the app makes in its own documentation:
//!
//! * **Windows** — the foreground window's title and the owning executable,
//!   both from ordinary Win32 calls available to any process.
//! * **macOS** — the frontmost *application* only. Reading a window's title
//!   there requires Screen Recording permission, and Shotshelf documents that
//!   it does not need it: it never captures anything itself, it only notices
//!   files the OS has already written. Asking for the most invasive permission
//!   on the platform to put a nicer label on a card is a bad trade, so the
//!   title is simply not collected there.
//! * **Linux** — nothing portable. X11 could be read via `_NET_ACTIVE_WINDOW`,
//!   Wayland deliberately refuses, and a per-compositor portal dance is a lot
//!   of surface for a label.
//!
//! Absence is ordinary everywhere. A capture with no context behaves exactly
//! as every capture did before this existed.

use serde::Serialize;

/// What was in front when a capture landed.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    /// The application and the window title, as one line, ready to show.
    ///
    /// Only the composed line. `app` and `title` were separate `pub` fields
    /// too, serialised onto every `capture://new` event — and read by nothing,
    /// in either language: the Rust tests assert on `label`, and the front end
    /// renders `item.context?.label`. Two `Option<String>`s of window titles
    /// crossing the IPC boundary per capture, for nobody. They are titles of
    /// whatever was on screen, which is the one category of string this app
    /// takes care not to move around without a reason.
    ///
    /// Composed here rather than in the front-end so there is one answer to
    /// "how does this read", instead of one in Rust for the log and another in
    /// TypeScript for the card that could drift apart.
    pub label: Option<String>,
}

impl Context {
    /// Build a context from whatever the platform could find.
    ///
    /// Takes raw strings and tidies them here rather than at each call site,
    /// so every platform — including the one that finds nothing — goes through
    /// the same construction. Splitting that out left the cleaning and the
    /// labelling with no caller at all on Linux, which the dead-code gate
    /// refused, and rightly: a helper only some platforms reach is a helper
    /// whose behaviour differs by platform for no stated reason.
    #[must_use]
    pub fn new(app: Option<&str>, title: Option<&str>) -> Self {
        let app = app.and_then(tidy);
        let title = title.and_then(tidy);

        let label = match (app.as_deref(), title.as_deref()) {
            (Some(app), Some(title)) if !title.eq_ignore_ascii_case(app) => {
                Some(format!("{app} — {title}"))
            }
            (Some(app), _) => Some(app.to_owned()),
            (None, Some(title)) => Some(title.to_owned()),
            (None, None) => None,
        };
        Self { label }
    }

    /// Whether there is anything here worth putting on a card.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.label.is_none()
    }
}

/// What was in front, right now.
#[must_use]
pub fn current() -> Context {
    platform::current()
}

/// Tidy a raw title or application name.
///
/// Trimmed, collapsed, and capped. The cap is not cosmetic: a window title is
/// arbitrary text chosen by another program, it goes into a tooltip and will
/// go into a shelf that is searched, and an unbounded string from outside the
/// app is worth bounding at the door rather than at every use.
fn tidy(raw: &str) -> Option<String> {
    const MAX: usize = 120;

    // Neutralised before collapsing, because none of these are whitespace and
    // `split_whitespace` therefore carried them straight through into a label
    // Shotshelf renders in its own UI. U+202E on its own is enough to display
    // a title as the reverse of what it says, and the zero-width characters
    // hide text inside a word — both in a string chosen by whatever program
    // happened to be in front, which is as untrusted as input gets here.
    //
    // Mapped to a space rather than dropped: a title with a newline in it is
    // two words, and deleting the separator would run them together.
    //
    // Deliberately not scanned for credentials. A title can certainly contain
    // one, but unlike the capture it is never handed to anything — it is shown
    // on the card and nowhere else — so a warning would be about a disclosure
    // that cannot happen. That changes the day the shelf becomes searchable
    // and titles are indexed.
    let cleaned: String = raw
        .chars()
        .map(|c| if is_display_noise(c) { ' ' } else { c })
        .collect();

    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }

    // Truncated on a character boundary; a title can be any script at all.
    Some(collapsed.chars().take(MAX).collect())
}

/// Control and formatting characters that have no business in a label.
///
/// Two threats, and the ranges are grouped by which one they answer.
///
/// **Reordering.** A right-to-left override makes the rest of the string
/// render backwards, so `Notes\u{202E}gnp.tnuocca` reads as `Notes account.png`
/// on screen. Every character that can do this is here: the marks, the
/// embeddings, the overrides and the isolates.
///
/// **Invisibility.** A zero-width space hides a join inside a word, so two
/// labels that render identically are different strings.
///
/// The earlier version listed four ranges chosen from memory and described
/// itself as "the bidirectional overrides and isolates" while omitting
/// U+061C — an Arabic letter mark, a bidi control of exactly the kind the
/// sentence claimed to cover — along with U+206A-U+206F and the tag block.
/// `char::is_control()` does not cover any of them: they are category `Cf`,
/// not `Cc`, so `is_control` returns false for every one.
///
/// The honest limit: this is a list, and Unicode adds format characters. It is
/// the complete set of `Cf` and invisible characters in the planes a window
/// title realistically carries, and the test below names individual hostile
/// characters rather than re-asking this predicate, so a range going missing
/// is a failure rather than a tautology.
fn is_display_noise(c: char) -> bool {
    c.is_control()
        || matches!(c,
            // Invisible on their own, in ascending order.
            '\u{00AD}'                  // soft hyphen
                | '\u{034F}'            // combining grapheme joiner
                | '\u{061C}'            // Arabic letter mark — a bidi control
                | '\u{115F}'..='\u{1160}' // Hangul choseong/jungseong fillers
                | '\u{17B4}'..='\u{17B5}' // Khmer inherent vowels
                | '\u{180B}'..='\u{180F}' // Mongolian selectors and separator
                | '\u{200B}'..='\u{200F}' // zero-width set, LRM, RLM
                | '\u{202A}'..='\u{202E}' // embeddings and overrides
                | '\u{2060}'..='\u{206F}' // joiners, isolates, deprecated formats
                | '\u{3164}'            // Hangul filler
                | '\u{FEFF}'            // byte-order mark
                | '\u{FFA0}'            // halfwidth Hangul filler
                | '\u{FFF9}'..='\u{FFFB}' // interlinear annotation
                | '\u{1BCA0}'..='\u{1BCA3}' // shorthand format controls
                | '\u{1D173}'..='\u{1D17A}' // musical beam/slur formats
                | '\u{E0000}'..='\u{E0FFF}') // tags and variation selectors
}

#[cfg(target_os = "windows")]
mod platform {
    use windows::Win32::{
        Foundation::{CloseHandle, HWND, MAX_PATH},
        System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
            PROCESS_QUERY_LIMITED_INFORMATION,
        },
        UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        },
    };

    use super::Context;

    pub fn current() -> Context {
        // SAFETY: the window handle is **foreign** — `GetForegroundWindow`
        // returns a window this process does not own, and its owner may close
        // it between that call and the next. This is sound because every Win32
        // call here fails closed on a stale `HWND`: they answer zero or an
        // error rather than reading freed memory, and each result is checked.
        // It is *not* sound because of any lifetime this function controls,
        // which is what an earlier version of this comment claimed — the
        // buffers are the only part this scope owns.
        unsafe {
            let window = GetForegroundWindow();
            if window.0.is_null() {
                // Nothing is focused — a lock screen, a moment between apps.
                return Context::default();
            }

            Context::new(app_name(window).as_deref(), title(window).as_deref())
        }
    }

    unsafe fn title(window: HWND) -> Option<String> {
        // The length excludes the terminator, so the buffer is one longer.
        let length = unsafe { GetWindowTextLengthW(window) };
        if length <= 0 {
            return None;
        }

        // `try_from`, not `as`: the guard above proves this is positive, but
        // proving it to the compiler costs one conversion and removes the need
        // to silence a lint that is now switched on.
        let mut buffer = vec![0_u16; usize::try_from(length).ok()? + 1];
        let written = unsafe { GetWindowTextW(window, &mut buffer) };
        if written <= 0 {
            return None;
        }

        #[allow(clippy::cast_sign_loss)] // Guarded positive above.
        Some(String::from_utf16_lossy(&buffer[..written as usize]))
    }

    /// The owning executable, as a person would name it: `Code.exe` → `Code`.
    unsafe fn app_name(window: HWND) -> Option<String> {
        let mut pid = 0_u32;
        unsafe { GetWindowThreadProcessId(window, Some(&raw mut pid)) };
        if pid == 0 {
            return None;
        }

        // `LIMITED_INFORMATION` is the least this can ask for and still read a
        // path, and it works for processes at the same integrity level without
        // any elevation.
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;

        let mut buffer = vec![0_u16; MAX_PATH as usize];
        // `try_from`, not `as`: the buffer is `MAX_PATH` long, so this cannot
        // truncate — but saying so through the conversion costs nothing and
        // needs no allowance.
        let mut length = u32::try_from(buffer.len()).unwrap_or(MAX_PATH);
        let read = unsafe {
            QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_FORMAT(0),
                windows::core::PWSTR(buffer.as_mut_ptr()),
                &raw mut length,
            )
        };
        let _ = unsafe { CloseHandle(process) };
        read.ok()?;

        let path = String::from_utf16_lossy(&buffer[..length as usize]);
        let stem = std::path::Path::new(&path).file_stem()?.to_string_lossy();
        Some(stem.into_owned())
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::Context;

    /// The frontmost application, and deliberately not its window title.
    ///
    /// `NSWorkspace` needs no permission at all. The title would need Screen
    /// Recording, which this app documents that it does not require — see the
    /// module header.
    pub fn current() -> Context {
        use objc2_app_kit::NSWorkspace;

        // No `unsafe` needed: objc2 exposes these as safe, because reading a
        // shared workspace singleton has no invariant for a caller to uphold.
        let app = NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .and_then(|app| app.localizedName())
            .map(|name| name.to_string());

        Context::new(app.as_deref(), None)
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod platform {
    use super::Context;

    /// Nothing portable here.
    ///
    /// X11 exposes `_NET_ACTIVE_WINDOW`, Wayland deliberately refuses, and a
    /// per-compositor portal dance is a great deal of surface to maintain for
    /// a label on a card. An empty context is ordinary rather than an error.
    pub fn current() -> Context {
        // Through the same constructor as everywhere else, so "found nothing"
        // is one shape of the same answer rather than a separate path.
        Context::new(None, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_context_with_nothing_in_it_says_so() {
        assert!(Context::default().is_empty());
        assert_eq!(Context::default().label, None);
    }

    #[test]
    fn the_label_leads_with_the_application() {
        // The application is what stays the same across a session, so it is
        // what the eye scans a list for.
        let context = Context::new(Some("Code"), Some("auth.ts"));
        assert_eq!(context.label.as_deref(), Some("Code — auth.ts"));
    }

    #[test]
    fn a_title_that_only_repeats_the_app_earns_no_space() {
        // Plenty of applications title their window after themselves.
        let context = Context::new(Some("Firefox"), Some("firefox"));
        assert_eq!(context.label.as_deref(), Some("Firefox"));
    }

    #[test]
    fn either_half_alone_is_still_a_label() {
        assert_eq!(
            Context::new(Some("Code"), None).label.as_deref(),
            Some("Code"),
        );
        assert_eq!(
            Context::new(None, Some("auth.ts")).label.as_deref(),
            Some("auth.ts"),
        );
    }

    #[test]
    fn whitespace_is_collapsed_and_emptiness_is_nothing() {
        assert_eq!(
            tidy("  Visual   Studio  Code \n").as_deref(),
            Some("Visual Studio Code")
        );
        assert_eq!(tidy("   "), None);
        assert_eq!(tidy(""), None);
    }

    /// Characters a hostile window title would actually use, each named.
    ///
    /// Not `is_display_noise` re-applied to its own output. That assertion —
    /// "no character in the result satisfies the predicate" — is true by
    /// construction for *any* predicate, because `tidy` maps exactly what the
    /// predicate matches. Deleting the whole `matches!` arm left it passing
    /// with U+202E and U+200B rendering in the card, since both are category
    /// `Cf` and `char::is_control()` is false for them.
    ///
    /// A literal list cannot do that: each entry fails on its own if the range
    /// covering it is dropped.
    const HOSTILE: &[(char, &str)] = &[
        ('\u{202E}', "right-to-left override"),
        ('\u{202D}', "left-to-right override"),
        ('\u{2066}', "left-to-right isolate"),
        ('\u{2069}', "pop directional isolate"),
        ('\u{200E}', "left-to-right mark"),
        ('\u{061C}', "Arabic letter mark"),
        ('\u{200B}', "zero-width space"),
        ('\u{200D}', "zero-width joiner"),
        ('\u{00AD}', "soft hyphen"),
        ('\u{180E}', "Mongolian vowel separator"),
        ('\u{2064}', "invisible plus"),
        ('\u{206A}', "inhibit symmetric swapping"),
        ('\u{3164}', "Hangul filler"),
        ('\u{FEFF}', "byte-order mark"),
        ('\u{E0041}', "tag latin capital A"),
    ];

    #[test]
    fn a_title_cannot_smuggle_bidi_or_zero_width_characters_into_the_ui() {
        // A window title is chosen by whatever program is in front, and this
        // one renders in Shotshelf's own card and tooltip. U+202E reverses
        // everything after it on screen; U+200B hides a join inside a word.
        for (hostile, name) in HOSTILE {
            let title = format!("Notes{hostile}gnp.tnuocca");
            let label = tidy(&title).unwrap_or_else(|| panic!("{name} ate the whole label"));
            assert!(
                !label.contains(*hostile),
                "{name} (U+{:04X}) survived into {label:?}",
                *hostile as u32,
            );
        }

        // And the words either side are still words.
        assert_eq!(
            tidy("Visual\u{0007}Studio").as_deref(),
            Some("Visual Studio")
        );
        assert_eq!(tidy("\u{202E}\u{200B}").as_deref(), None);
    }

    #[test]
    fn an_arbitrarily_long_title_is_bounded_at_the_door() {
        // A window title is text chosen by another program; it reaches a
        // tooltip and, later, a search index.
        let long = "x".repeat(5_000);
        assert_eq!(tidy(&long).map(|title| title.chars().count()), Some(120));
    }

    #[test]
    fn a_title_is_truncated_on_a_character_boundary() {
        // Titles are arbitrary script, and slicing bytes would panic.
        let long = "日本語".repeat(200);
        let tidied = tidy(&long).expect("some title");
        assert_eq!(tidied.chars().count(), 120);
    }

    #[test]
    fn reading_the_foreground_never_panics() {
        // Whatever is in front — including nothing, on a locked screen — this
        // has to come back with an answer rather than an unwind.
        let _ = current();
    }
}
