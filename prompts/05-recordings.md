# 05 · Screen-recording support (Shotshelf)

## Goal
Make video captures first-class: detect recordings, generate a poster-frame thumbnail with bundled **ffmpeg**, show duration + file size on the tile, and drag the video file out like any other item.

## Context + reuse
Catch engine (02) already classifies `kind:"video"` (mp4/mov/mkv/webm) from Game Bar / Snipping Tool / ⌘⇧5. The one fiddly bit (RESEARCH.md) is video thumbnails: extract a poster frame via **ffmpeg** — same on both OSes — `ffmpeg -i clip -frames:v 1 thumb.jpg` (seek a second in, e.g. `-ss 00:00:01`, to avoid black first frames). Drag-out (04) already handles any existing file path, so a video drags with the same `startDrag` call.

## Deliverables
1. Bundle an `ffmpeg` binary as a Tauri sidecar (declare in `tauri.conf.json` `externalBin`, per-OS binaries with the target-triple suffix). Resolve its path at runtime via the shell/sidecar API — never assume a system ffmpeg.
2. On a `video` capture, run ffmpeg to write a poster frame (`-ss ~1s -frames:v 1`) into the app cache dir; render that image as the tile thumbnail (replacing the 03 placeholder). Handle failures gracefully (fallback film-icon tile).
3. Probe and display metadata on/under the video tile: **duration** and **file size** (use `ffprobe` or `ffmpeg` for duration; fs for size). A small "video" badge + play glyph distinguishes it from stills.
4. Drag-out: the video tile drags the **original video file** (not the thumbnail) via the 04 `startDrag`.
5. Cache poster frames by source path+mtime so they aren't regenerated every launch; clean them when the item leaves the shelf.
6. `README.md` roadmap: check off recordings.

## Constraints
- **Local-only:** ffmpeg runs on the local file only; no network. Bundled binary, no download-at-runtime, no telemetry.
- **Both OSes:** ship a Windows `ffmpeg.exe` and a macOS `ffmpeg` sidecar; the poster-frame + probe logic must be identical. Flag the per-OS binary names.
- Reuse the bundled ffmpeg sidecar — do not add a Rust video-decoding crate or call a system-installed ffmpeg.
- **Never modify the source recording;** poster frames/caches live in app cache, never the repo. Test with a synthetic sample clip (checked in only if tiny + license-clean, else generated).
- Generating a thumbnail must not block the UI — run ffmpeg off the UI thread and update the tile when ready.

## Done when (manual)
- On **Windows** and **macOS**, make a screen recording → within a couple seconds its tile shows a real poster frame (not black), plus duration and file size.
- If ffmpeg fails on a file, the tile falls back to the film-icon placeholder without crashing the shelf.
- Dragging the video tile drops the actual `.mp4`/`.mov` into Explorer/Finder and into a video player/editor.
- Restarting the app reuses cached poster frames instead of regenerating them.
Report the bundled ffmpeg version and where poster frames are cached on each OS.
