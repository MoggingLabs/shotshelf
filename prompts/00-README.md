# Shotshelf build prompts (local only)

This folder is **git-ignored** — it never ships. It holds the ordered, goal-oriented prompts we paste
into Claude Code's `/goal` command to build Shotshelf, one phase at a time.

## Reuse first — decisions SETTLED (see `RESEARCH.md`)

- **Build, don't fork:** no OSS cross-platform shelf auto-catches screenshots — that's our wedge.
- **Stack: Tauri v2** (footprint of a 24/7 tray app is the deciding factor).
- **Adopt the hard parts:** [`tauri-plugin-drag`/`drag-rs`](https://github.com/crabnebula-dev/drag-rs)
  for native drag-out (the crux, solved on Win+mac), `notify` + `tauri-plugin-clipboard` for capture
  detection, bundled **ffmpeg** for video poster-frames. **Interoperate** with ShareX (watch its output),
  don't fork it. UX references: Dropover (north star), Tokri/ShakePin.

## How to use

1. Open Claude Code in the `shotshelf` repo.
2. Copy the **entire contents** of the next numbered file (each is < 4000 chars, the `/goal` limit)
   and paste it after `/goal`.
3. Let Claude complete the phase. Run/verify it yourself on the target OS.
4. Move to the next file.

## Order

| # | File | Phase |
| :-- | :-- | :-- |
| 01 | `01-scaffold.md` | scaffold the **Tauri v2** shell — tray + frameless always-on-top `skipTaskbar` edge window; wire the adopted plugins (drag, clipboard, positioner, fs/notify); empty shelf runs on both OSes |
| 02 | `02-catch-engine.md` | Rust `notify` watchers on the per-OS screenshot/recording folders (configurable; macOS location resolved dynamically) + clipboard-image watch; debounce, ignore partials, emit typed `{path,kind,ts}` capture events |
| 03 | `03-shelf-ui.md` | always-on-top edge widget: recent-first image thumbnail strip, hover/remove, auto-show on new capture (video placeholder tiles until 05) |
| 04 | `04-drag-out.md` | **the crux** — native OS drag-out of the underlying file into other apps via `tauri-plugin-drag`; clipboard-copy fallback |
| 05 | `05-recordings.md` | screen-recording support: bundled **ffmpeg** poster-frame thumbnails, duration/size, drag-out the video file |
| 06 | `06-settings-persistence.md` | persist edge/position + per-monitor placement, retention policy, global show/hide hotkey, pin vs auto-expire; local settings file |
| 07 | `07-cross-platform-parity.md` | verification-heavy pass: catch + thumbnail + drag-out behave identically on Windows AND macOS; document shims, fix divergences |
| 08 | `08-package-and-distribute.md` | Tauri bundling — signed `.msi`/`.exe` + `.dmg`, bundled ffmpeg, built-in internal updater, `docs/USAGE.md` |

## Standing rules (baked into every prompt)

- **Local-only.** No network, no telemetry, no cloud. Captures never leave the device.
- **Reuse before rewriting.** Fork/adopt the OSS and libraries `RESEARCH.md` identifies for drag-out,
  folder-watching, and clipboard access; keep original code to the glue.
- **Both platforms.** Catch + drag-out must work on Windows and macOS, or be explicitly flagged.
- **Never commit captures/user data.** Test fixtures are synthetic only.
- **Manual verification first** — no automated test suites unless a prompt asks.
