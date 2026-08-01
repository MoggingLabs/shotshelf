# 02 · Catch engine — watch folders + clipboard (Shotshelf)

## Goal
Build the detection layer: Rust `notify` watchers on the per-OS screenshot/recording folders plus a clipboard-image watch, emitting one typed "new capture" event to the frontend for every new capture — debounced, ignoring temp/partial writes.

## Context + reuse
Shotshelf is a **watcher, not a capturer** (RESEARCH.md): the OS already saves captures to known folders; Win+Shift+S / ⌘⌃⇧4 land on the clipboard only.
- Folder watch: Rust `notify` — https://github.com/notify-rs/notify (recommended-watcher + debouncer).
- Clipboard image: `tauri-plugin-clipboard` (poll/subscribe for image data).
- **Windows folders:** `%UserProfile%\Pictures\Screenshots`, `%UserProfile%\Videos\Captures` (Game Bar), `%UserProfile%\Videos\Screen Recordings` (Snipping Tool), and the OneDrive variant `…\OneDrive\Pictures\Screenshots`.
- **macOS folder:** resolve dynamically via `defaults read com.apple.screencapture location` (default `~/Desktop`); ⌘⇧5 recordings save there too.

## Deliverables
1. `src-tauri/src/catch/` module: a watcher manager that starts `notify` watchers on a resolved list of folders.
2. Path resolution: Windows expands the folders above (skip any that don't exist); macOS shells out to `defaults read com.apple.screencapture location` and falls back to `~/Desktop`. Make the watched paths **configurable** (accept an override list; defaults per OS).
3. Debounce (e.g. 300–500ms) and **ignore partial writes**: skip temp/incomplete files (`.tmp`, `.crdownload`, `~`-prefixed, zero-byte, or files still growing) so half-written recordings aren't caught.
4. Classify by extension: `image` (png/jpg/jpeg/gif/webp/bmp) vs `video` (mp4/mov/mkv/webm).
5. Clipboard watch: on new clipboard image, write it to a temp file under an app data dir and treat it as an `image` capture.
6. Emit a typed Tauri event `capture://new` with payload `{ path: string, kind: "image" | "video", ts: number }`. Frontend logs each event (real UI comes in 03).
7. `README.md` roadmap: check off the catch engine.

## Constraints
- **Local-only:** watchers read local folders only; nothing leaves the device. No network/telemetry.
- **Both OSes:** Windows path set + macOS dynamic resolution both implemented; flag per-OS branches clearly.
- Reuse `notify` and `tauri-plugin-clipboard` — do not hand-roll polling loops for folders.
- **Never commit captures;** temp clipboard files go to app data / OS temp, never the repo. Tests use synthetic fixture files.
- No duplicate events for a single capture (debounce + dedupe by path within a short window).

## Done when (manual)
- On **Windows**: Win+PrtSc (or Snipping Tool) produces exactly one `capture://new {kind:"image"}`; a Game Bar / Snipping Tool recording produces one `{kind:"video"}` only after the file finishes writing; Win+Shift+S produces one image event via clipboard.
- On **macOS**: ⌘⇧3 / ⌘⇧4 to the configured location fires one image event; ⌘⌃⇧4 (clipboard) fires one image event; a ⌘⇧5 recording fires one video event when finalized.
- Changing the screenshot location on macOS (`defaults write …`) is picked up after restart.
Report the resolved watch paths on each OS and the event payloads observed.
