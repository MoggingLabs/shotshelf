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
    let quit = MenuItem::with_id(app, "quit", "Quit Shotshelf", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&toggle, &separator, &quit])?;

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
            "quit" => app.exit(0),
            _ => {}
        })
        // Never fires on Linux — `tray-icon` documents the event as unemitted
        // there even though the icon shows. Everything below is Windows/macOS
        // in practice; Linux drives the shelf from the menu above.
        .on_tray_icon_event(|tray, event| {
            // Nothing here needs the icon's rectangle: the shelf rests in the
            // bottom-right corner of the screen rather than hanging off the
            // icon, so the click is all this handler wants.
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

    // macOS can put text beside a menu bar icon; Windows has no equivalent, so
    // there the tooltip is the only place the count can appear.
    #[cfg(target_os = "macos")]
    let _ = tray.set_title(if count == 0 {
        None
    } else {
        Some(count.to_string())
    });
}
