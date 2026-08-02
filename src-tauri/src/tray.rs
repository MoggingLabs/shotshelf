//! System-tray (macOS menu-bar) icon — the only chrome Shotshelf has.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Runtime,
};

/// Identifies the tray icon so the count can be written back onto it.
const TRAY_ID: &str = "shotshelf";

use crate::window;

pub fn init<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "Show / Hide shelf", true, None::<&str>)?;
    // "The screenshots folder", not "captures folder": the tile control
    // "Show … in its folder" opens the folder of ONE capture, and two menu
    // entries whose names differ only in an article read as the same feature.
    // This one opens the first watched directory wholesale.
    let folder = MenuItem::with_id(
        app,
        "open-folder",
        "Open the screenshots folder",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit Shotshelf", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&toggle, &folder, &separator, &quit])?;

    // Windows/Linux show the full-colour app icon; macOS gets a monochrome
    // glyph so it can be drawn as a template image (see below).
    #[cfg(target_os = "macos")]
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-macos.png"))?;
    #[cfg(not(target_os = "macos"))]
    let icon = app
        .default_window_icon()
        .cloned()
        .expect("shotshelf: no bundle icon configured in tauri.conf.json");

    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Shotshelf — the shelf that catches every capture")
        .menu(&menu)
        // Windows and macOS: left click toggles the shelf, so the menu belongs
        // on right click. Ignored on Linux, where the tray is an AppIndicator
        // and the host decides — which is the reason the menu carries a
        // "Show / Hide shelf" item at all. Without it Linux would have no way
        // to open the shelf but the hotkey.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => window::toggle(app),
            "open-folder" => open_captures_folder(app),
            "quit" => app.exit(0),
            _ => {}
        })
        // Never fires on Linux — `tray-icon` documents the event as unemitted
        // there even though the icon shows. Everything below is Windows/macOS
        // in practice; Linux drives the shelf from the menu above.
        .on_tray_icon_event(|tray, event| {
            // Nothing here needs the icon's rectangle: the shelf parks in the
            // corner the `dockCorner` setting names (bottom-right by default)
            // rather than hanging off the icon, so the click is all this
            // handler wants.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                window::toggle(tray.app_handle());
            }
        });

    // macOS only: template images are drawn from their alpha channel, so the
    // glyph follows a light or dark menu bar automatically.
    #[cfg(target_os = "macos")]
    let tray = tray.icon_as_template(true);

    tray.build(app)?;

    Ok(())
}

/// Open the first watched capture folder in the OS file manager.
///
/// The shelf shows the last fifty; the folder holds everything, and "where do
/// my screenshots actually live" should not require reading a log. The *first*
/// resolved watch directory is the platform's primary screenshots location on
/// every OS — the resolvers put it first on purpose.
///
/// Through `catch_watch_dirs` rather than a private accessor: it is already
/// `pub`, already answers from an `AppHandle`, and already has the one honest
/// failure — clicked before the engine has resolved anything, it says
/// "still starting", which lands in the log rather than the void. A plain
/// function, not a command: nothing in the webview calls this, and
/// `check-commands.mjs` would rightly refuse a registered command no one
/// invokes.
fn open_captures_folder<R: Runtime>(app: &AppHandle<R>) {
    let dirs = match crate::catch::catch_watch_dirs(app.clone()) {
        Ok(watching) => watching.dirs,
        Err(err) => {
            crate::diag::warn(&format!("could not open the captures folder: {err}"));
            return;
        }
    };
    let Some(first) = dirs.into_iter().next() else {
        crate::diag::warn("no capture folder is being watched; nothing to open");
        return;
    };

    // Off the event loop: `opener` spawns and, on some platforms, waits on a
    // process — same reasoning as `share::reveal_capture`.
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(err) = opener::open(&first) {
            crate::diag::warn(&format!("could not open {first}: {err}"));
        }
    });
}

/// The shelf is hidden most of the time, so the tray icon is where the count
/// has to live.
#[tauri::command]
pub fn set_capture_count<R: Runtime>(app: AppHandle<R>, count: usize) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };

    let label = match count {
        0 => "Shotshelf — the shelf is empty".to_owned(),
        1 => "Shotshelf — 1 capture".to_owned(),
        many => format!("Shotshelf — {many} captures"),
    };
    let _ = tray.set_tooltip(Some(label));

    // macOS puts text beside the menu bar icon; Linux puts it on the
    // AppIndicator label. Windows is the one platform with no equivalent, so
    // there the tooltip above really is the only place the count can appear.
    //
    // This was macOS-only, under a comment that named Windows and did not
    // consider Linux — where it is the *tooltip* that has no equivalent:
    // `tray-icon`'s GTK backend implements `set_tooltip` as a no-op that
    // discards its argument and returns `Ok`, and `set_title` as a real
    // `set_label`. So the one call that works was compiled out, on the
    // platform where `docs/USAGE.md` tells the user the tray is their primary
    // way in because clicks do not reach the app there.
    //
    // A previous attempt at this widened the wrong `cfg` — the icon selection
    // in `init` — which on Linux left two `let icon` bindings, the first
    // shadowed and unread, and `-D warnings` refuses that. The Linux CI leg
    // could not compile, and the local gate could not see it.
    // "Not Windows" — deliberately *wider* than the crate's usual
    // `not(any(windows, macos))`, which names the GTK platform.
    //
    // Both macOS and every GTK platform have a real `set_title`; only Windows
    // does not. The sites that spell it the narrower way are each choosing a
    // GTK-specific *implementation*, which is a different question from "does
    // this API exist here". No list of those sites is given: the first attempt
    // at one was wrong on its count, and the attempt to correct that was wrong
    // about `share.rs`, which uses the narrow form and always has. Two wrong
    // enumerations of one set is the argument for stating the criterion
    // instead.
    //
    // What was wrong before was `any(macos, linux)`: an enumeration, so the
    // capture count silently never reached the tray on any other Unix
    // `tray-icon` builds for. Widening fixed that; matching the other five would
    // have re-broken macOS.
    #[cfg(not(target_os = "windows"))]
    let _ = tray.set_title(if count == 0 {
        None
    } else {
        Some(count.to_string())
    });
}
