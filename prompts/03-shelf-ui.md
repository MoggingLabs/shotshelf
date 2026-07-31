# 03 · Shelf UI — recent-first thumbnail strip (Shotshelf)

## Goal
Turn the empty edge widget into a live shelf: a recent-first strip of thumbnails that auto-populates and auto-shows whenever a `capture://new` event fires. Images render directly; item hover reveals a remove control. (Video poster-frames arrive in 05 — for now show a placeholder tile for `kind:"video"`.)

## Context + reuse
Builds on 01 (window + tray) and 02 (`capture://new {path,kind,ts}` events). UX north star is Dropover / Tokri: a compact, newest-first shelf pinned to an edge (RESEARCH.md). Image thumbnails are cheap — render the real file with CSS `object-fit: cover` in the webview; no image-processing crate needed for stills. Use `tauri-plugin-fs` / `convertFileSrc` (asset protocol) to display local files in the webview.

## Deliverables
1. Frontend shelf state: an in-memory ordered list of items `{ id, path, kind, ts }`, newest first, capped at a sane visible count (e.g. 50).
2. Subscribe to `capture://new`; prepend each new item, then **auto-show** the window (bring to front) and briefly highlight the new tile.
3. Thumbnail tile: for `image`, an `<img>` via `convertFileSrc(path)` with `object-fit: cover`, fixed tile size, rounded corners; for `video`, a placeholder tile (film icon + filename) until 05.
4. Hover affordances per tile: a remove (×) button that removes the item **from the shelf only** (never deletes the source file), and a tooltip/label showing the filename.
5. Empty state and overflow: show an "empty shelf" message when no items; make the strip scroll when items exceed the visible area.
6. Expose the asset protocol / scope in `capabilities` so the webview can load files from the watched dirs and app temp dir.
7. `README.md` roadmap: check off the shelf UI.

## Constraints
- **Local-only:** display files from disk only; no network image loads, no telemetry.
- **Both OSes:** identical layout and behavior on Windows and macOS; flag any per-OS asset-URL differences.
- Remove = shelf-only. **Never delete, move, or modify the user's capture files** in this phase.
- Reuse the asset protocol / `convertFileSrc` — do not base64-inline large images into the DOM.
- Keep it light: this widget is always on top 24/7; avoid heavy re-renders on every event.

## Done when (manual)
- Take a screenshot on Windows and on macOS → the shelf **auto-shows** and the new thumbnail appears at the front within ~1s, rendered correctly.
- A screen recording produces a placeholder video tile (real poster-frame lands in 05).
- Hovering a tile shows the filename and an × that removes it from the strip while the source file remains on disk.
- Taking several captures keeps them newest-first and the strip scrolls without breaking the always-on-top edge layout.
Report tile sizing, the visible cap, and the asset-protocol scope you granted.
