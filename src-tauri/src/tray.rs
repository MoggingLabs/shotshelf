//! System-tray (macOS menu-bar) icon — the only chrome Shotshelf has.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Runtime,
};

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

    let tray = TrayIconBuilder::with_id("shotshelf")
        .icon(icon)
        .tooltip("Shotshelf — the shelf that catches every capture")
        .menu(&menu)
        // Left click toggles the shelf; the menu belongs on right click.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => window::toggle(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Feeds the positioner the tray rectangle so later phases can use
            // `Position::Tray*` placements.
            tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);

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
