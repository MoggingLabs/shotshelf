# 04 · Drag-out — the crux (Shotshelf)

## Goal
Make shelf tiles draggable **out of the app and into any other app** as a real file — drop a screenshot straight into Explorer/Finder, an email compose window, a chat box, or an editor, on both Windows and macOS. Add copy-to-clipboard as a fallback.

## Context + reuse
This is THE de-risked crux (RESEARCH.md): native OS drag-out of existing files is solved on Win + mac by **`tauri-plugin-drag` / `crabnebula-dev/drag-rs`** — https://github.com/crabnebula-dev/drag-rs. JS API: `startDrag({ item: [absolutePath], icon })`. It drags files that already exist on disk — exactly our case, since captures land on disk (clipboard captures were already written to a temp file in 02). Do NOT build a custom OLE/`NSDraggingSource` layer; the plugin covers it.

## Deliverables
1. Wire `@crabnebula/tauri-plugin-drag` in the frontend (Rust plugin already registered in 01).
2. On a tile, start a native drag via `startDrag({ item:[item.path], icon })` on drag-begin (pointer/mouse down + move threshold). Use the tile's own thumbnail (or a generated small image) as the drag `icon`.
3. Ensure the dragged path is an **absolute, existing** file; if the item is a clipboard capture, confirm the temp file exists (write it if not) before starting the drag.
4. Clipboard fallback: a per-tile "Copy" action (and/or right-click menu) that copies the image to the clipboard (`tauri-plugin-clipboard`) so the user can paste when an app doesn't accept file drops.
5. Visual feedback: cursor/drag image during drag; no crash if the drag is cancelled.
6. `README.md` roadmap: check off drag-out (the crux) → v0.2.

## Constraints
- **Local-only:** drag/copy move a local file reference or image bytes only; nothing is uploaded. No telemetry.
- **Both OSes:** drag-out must work on Windows 11 and macOS via the one plugin; flag any per-OS timing quirks (RESEARCH.md notes minor Win/mac differences) rather than forking logic.
- Reuse `tauri-plugin-drag` and `tauri-plugin-clipboard` — do not hand-roll native drag sources.
- **Never delete or move** the source file as part of a drag; a drag is a copy-out, not a move.
- Don't let a drag gesture conflict with the remove (×)/scroll interactions from 03.

## Done when (manual)
- On **Windows**: drag a shelf thumbnail into a File Explorer folder → a real file lands there; drag one into a Gmail/Outlook compose window → it attaches/embeds; drag into an image editor → it opens.
- On **macOS**: drag a tile into a Finder window, into Mail, and into an editor → the file drops in each.
- The "Copy" fallback puts the image on the clipboard so ⌘V / Ctrl+V pastes it into an app that rejects file drops.
- Cancelling a drag (drop on nothing / Esc) leaves the shelf and the source file intact.
Report which target apps you verified drops into on each OS.
