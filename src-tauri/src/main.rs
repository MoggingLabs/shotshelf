// Shotshelf runs in the tray, so never pop a console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    shotshelf_lib::run()
}
