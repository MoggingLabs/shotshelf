# 01 · Scaffold the Tauri v2 shell (Shotshelf)

## Goal
Turn the docs-only `shotshelf` repo into a runnable Tauri v2 app: a frameless, always-on-top, `skipTaskbar` edge window plus a system-tray icon, with all the adopted plugins wired in as dependencies. Launch on both Windows 11 and macOS and show an empty shelf. No catch/drag logic yet — just the shell.

## Context + reuse
Stack is SETTLED as **Tauri v2** (Rust backend + web frontend) — see `RESEARCH.md`. Use a minimal frontend (vanilla TS + Vite is fine; no heavy framework). Wire these now so later phases only add code, not deps:
- Drag-out: `@crabnebula/tauri-plugin-drag` + Rust `tauri-plugin-drag` — https://github.com/crabnebula-dev/drag-rs
- Clipboard image: `tauri-plugin-clipboard`
- Window placement: `tauri-plugin-positioner` + Tauri v2 tray API
- Folder watch: Rust `notify` crate — https://github.com/notify-rs/notify (add to `Cargo.toml`; wire in 02)
- Filesystem: `tauri-plugin-fs`

## Deliverables
1. `npm create tauri-app`-style layout: `src/` (frontend), `src-tauri/` (Rust), `package.json`, `src-tauri/Cargo.toml`, `tauri.conf.json`.
2. `tauri.conf.json` main window: `decorations:false`, `alwaysOnTop:true`, `skipTaskbar:true`, `resizable:false`, transparent optional, a small default size (e.g. 320×640) docked to the right edge via `tauri-plugin-positioner`.
3. System tray: icon + menu (Show/Hide shelf, Quit). Clicking the tray toggles window visibility.
4. All plugins above registered in `src-tauri/src/lib.rs` (`Builder::default().plugin(...)`) and declared in `Cargo.toml` / `package.json`. Capabilities file (`src-tauri/capabilities/default.json`) grants the permissions each plugin needs.
5. Frontend renders a placeholder "empty shelf" (title bar strip + empty list) so we can see the widget.
6. `README.md` roadmap: check off the scaffold step.

## Constraints
- **Local-only:** no network, telemetry, cloud, or analytics — none now, none wired for later. Captures never leave the device.
- **Both OSes:** must build and run on Windows 11 and macOS. Flag any platform-specific config inline.
- Reuse the adopted crates/plugins above — do not hand-roll window docking, trays, or watchers.
- **Never commit captures or user data;** only synthetic fixtures. Keep `prompts/` git-ignored.
- Keep the frontend dependency-light; this is a 24/7 ambient tray app — footprint matters.

## Done when (manual)
- `npm install` then `npm run tauri dev` launches on Windows AND macOS.
- A frameless, always-on-top window appears docked to a screen edge, absent from the taskbar/dock-as-window, showing an empty shelf.
- A tray icon is present; its menu Show/Hide toggles the window and Quit exits.
- `cargo build` in `src-tauri/` succeeds with all five plugins compiled in.
Report the file tree and the exact commands to run on each OS.
