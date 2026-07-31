# 06 · Settings & persistence (Shotshelf)

## Goal
Give the shelf memory and controls: persist its edge/position, a retention policy, a global show/hide hotkey, pin-vs-auto-expire per item, and per-monitor placement — all in a local settings file that survives restarts.

## Context + reuse
Builds on the window (01), shelf state (03), and drag-out (04). Reuse `tauri-plugin-positioner` for edge/monitor placement, `tauri-plugin-global-shortcut` for the hotkey, and `tauri-plugin-store` (or a plain JSON file via `tauri-plugin-fs`) for persistence in the app config dir. Keep it to a handful of settings — Shotshelf is "no accounts, no cloud, no 15 settings" (README).

## Deliverables
1. A settings store (JSON in the OS app-config dir) with typed defaults, loaded on startup and written on change. Never store capture bytes — only paths + small metadata.
2. **Edge/position + per-monitor:** persist which screen edge the shelf docks to and which monitor; restore on launch. A settings action (or tray submenu) to change edge/monitor. Handle a monitor that's no longer present (fall back to primary).
3. **Retention policy:** configurable "items stay for N hours" and/or "max N items"; expired items drop off the shelf automatically. Expiry removes items **from the shelf only**, never deleting source files.
4. **Pin vs auto-expire:** per-item pin toggle; pinned items are exempt from retention and reload on restart (persist pinned item paths). Unpinned items may be forgotten per policy.
5. **Global show/hide hotkey:** a configurable shortcut (sensible default, e.g. Ctrl/⌘+Shift+S if free) that toggles the shelf; persisted and re-registered on launch. Warn if the combo fails to register (already taken).
6. A lightweight settings surface (small window or tray menu) to edit edge, monitor, retention, and hotkey.
7. `README.md` roadmap: check off settings/persistence.

## Constraints
- **Local-only:** settings file stays on device; no sync, no network, no telemetry.
- **Both OSes:** placement, hotkey, and persistence work on Windows and macOS; flag per-OS hotkey defaults or reserved combos.
- Reuse positioner / global-shortcut / store plugins — do not hand-roll monitor math or a hotkey listener.
- **Never persist or commit capture contents;** store paths/metadata only. Settings file is git-ignored / in app dir, not the repo.
- Retention/expiry/unpin must not touch files on disk — shelf state only.

## Done when (manual)
- Move the shelf to a different edge/monitor, quit, relaunch → it returns to that edge/monitor (and falls back sanely if the monitor is gone).
- Set retention to a short window → unpinned items disappear on schedule while their files remain on disk; a **pinned** item survives retention and a restart.
- The global hotkey toggles the shelf from any app on both OSes; changing it re-registers correctly.
Report the settings-file location on each OS and the default hotkey chosen.
