<div align="center">

# 📸 Shotshelf

**The shelf that catches every capture.**
A cross-platform desktop shelf that automatically grabs every screenshot and screen recording you
take and keeps it one drag away — so you never dig through folders for the clip you just made.

![Windows](https://img.shields.io/badge/Windows-11-0078D6?style=for-the-badge&logo=windows&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-supported-000000?style=for-the-badge&logo=apple&logoColor=white)
![Tauri](https://img.shields.io/badge/Tauri-v2-24C8DB?style=for-the-badge&logo=tauri&logoColor=white)
[![License: MIT](https://img.shields.io/badge/License-MIT-6366f1?style=for-the-badge)](./LICENSE)

[![CI](https://github.com/MoggingLabs/shotshelf/actions/workflows/ci.yml/badge.svg)](https://github.com/MoggingLabs/shotshelf/actions/workflows/ci.yml)

</div>

---

> **Status: the shell runs.** Cross-platform desktop app on **Tauri v2** — the frameless, always-on-top
> edge window and its tray icon are in; the catch engine, thumbnails and drag-out come next. Prior-art
> research settled fork-vs-build (nothing forkable does cross-platform auto-catch, so we build) and
> confirmed the scary part, native drag-out, is a solved plugin. See `prompts/RESEARCH.md`. Part of
> [MoggingLabs Internals](https://github.com/MoggingLabs/mogginglabs-internals), in a new category:
> an **internal desktop utility** (not a platform driver like the `-wire` tools).

## 🎯 The problem

We screen-record and screenshot our cloud/AI systems all day — for the editor, for client demos, and
now for the Closewire/Highwire build-validation loops. Right after a capture you can grab it; four
seconds later it's buried in a folder of a hundred near-identical files. Shotshelf fixes the workflow
instead of fixing our filing habits.

## ✨ What it does

- **Catches** every new screenshot and screen recording automatically (watches the OS capture
  locations + clipboard).
- **Holds** them on an always-on-top shelf pinned to a screen edge, newest first, as thumbnails.
- **Drags out** — grab an item off the shelf and drop it straight into an email, editor, or chat. No
  Finder/Explorer spelunking, no 4-second window.

One job, done well. No accounts, no cloud, no 15 settings.

## 🧱 How it works (target)

1. **Catch engine** — watches the OS screenshot/recording save folders (Windows + macOS) with the Rust
   [`notify`](https://github.com/notify-rs/notify) crate, plus a clipboard watch
   (`tauri-plugin-clipboard`) for clipboard-only captures (Win+Shift+S / ⌘⌃⇧4). Emits a "new capture" event.
2. **Shelf UI** — an always-on-top, frameless edge widget rendering recent captures as thumbnails
   (images directly; a bundled **ffmpeg** poster-frame for recordings).
3. **Drag-out** — native OS drag-and-drop of the underlying file into any other app via
   [`tauri-plugin-drag`](https://github.com/crabnebula-dev/drag-rs) (the crux — a solved, maintained
   plugin covering Windows + macOS), with copy-to-clipboard as a fallback.

## 🧭 Reuse first (settled by research)

Per our standing rule, we don't rewrite what exists. Research found **no forkable cross-platform shelf
that auto-catches screenshots** — every one that does (Dropover, FlowShelf) is closed-source macOS-only,
which is exactly our opening. So we **build the combination**, but **adopt** the hard parts:
`tauri-plugin-drag`/`drag-rs` (drag-out), `notify` + `tauri-plugin-clipboard` (capture detection), and
bundled ffmpeg (video thumbnails). We **interoperate** with ShareX rather than fork it (watch its output
folder). Full detail in `prompts/RESEARCH.md`.

## 🚀 Run it

**Prerequisites:** [Node](https://nodejs.org) 22+, [Rust](https://rustup.rs) (stable), plus the
platform toolchain Tauri v2 needs:

| | Windows 11 | macOS |
| :-- | :-- | :-- |
| Compiler | [VS Build Tools 2022](https://visualstudio.microsoft.com/downloads/) → *Desktop development with C++* | `xcode-select --install` |
| Webview | [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) (preinstalled on Windows 11) | WKWebView (built in) |

```bash
npm install            # also fetches the ffmpeg sidecar (~80 MB, one platform)
npm run tauri dev      # dev build, frontend hot-reloads
npm run tauri build    # release bundle (.msi/.exe on Windows, .dmg/.app on macOS)
```

Identical commands on both OSes. The shelf docks to the right edge of the active monitor and has **no
taskbar or Dock entry** by design — the tray icon (Windows) / menu-bar icon (macOS) shows, hides and
quits it, and so does its right-click menu. Building the Rust side on its own (`cargo build` in
`src-tauri/`) expects the frontend bundle to exist, so run `npm run build` first.

```
src/            frontend — vanilla TS + Vite, deliberately dependency-light
src-tauri/      Rust — window docking, tray icon, plugin registration
  catch/        the catch engine: folder watchers + clipboard watch
  capabilities/ Tauri v2 permissions (local filesystem, clipboard, drag — no network)
app-icon.png    icon source; regenerate the set with `npm run tauri icon app-icon.png`
.github/        CI — builds on Windows and macOS
```

Most of the per-OS code sits behind `cfg` gates that only the matching host compiles, so CI
builds both: every push and PR runs `tsc` → `vite build` → `cargo fmt --check` → `cargo clippy
-D warnings` → `cargo build` on **windows-latest and macos-latest**. Run the same gate locally
with `npm run build` then `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`.

### Where it watches

| | Capture folders | Clipboard-only captures |
| :-- | :-- | :-- |
| **Windows** | `%UserProfile%\Pictures\Screenshots`, `%UserProfile%\Videos\Captures` (Game Bar), `%UserProfile%\Videos\Screen Recordings` (Snipping Tool), `…\OneDrive\Pictures\Screenshots` | Win+Shift+S |
| **macOS** | whatever `defaults read com.apple.screencapture location` returns, else `~/Desktop` — ⌘⇧5 recordings land there too | ⌘⌃⇧4 |

Folders that don't exist are skipped, and the resolved list is logged at startup. macOS reads
the screenshot location once per launch, so `defaults write com.apple.screencapture location …`
takes effect on the next start. Set `SHOTSHELF_WATCH_DIRS` (`;`-separated on Windows, `:`
elsewhere) to override the list until the settings file lands. Clipboard captures are written
into the app data dir — never the repo.

Win+PrtSc saves a file **and** copies to the clipboard, so both watchers see the same
screenshot. The file wins — it has a real name and a real path — and the clipboard copy is
dropped rather than shelved twice. A clipboard-only capture (Win+Shift+S) is held ~1.5 s to
tell the two apart.

### The shelf

Tiles are the full width of the strip (298 px in the default 320 px window) by 78 px tall,
cropped with `object-fit: cover` so any aspect ratio stays recognisable, newest at the top.
The shelf holds **50** captures and scrolls; the 51st pushes the oldest off the end. Hovering
a tile reveals a **×** that takes it off the shelf — the file itself is never touched, moved
or deleted. Recordings show a placeholder tile until poster frames land in v0.3.

### Recordings

A recording is just a file until you can see what's in it, so every video capture gets one
frame pulled out with a bundled **ffmpeg 6.1.1** sidecar — seeking ~1 s in, because the opening
frame of a screen recording is so often black. The tile then shows that frame plus the clip's
**duration and file size**, with a play badge so it still reads as a recording. If ffmpeg can't
decode the file, the tile keeps its film glyph and stays draggable.

Poster frames are cached by source path **and** mtime, so relaunching reuses them and a
re-recorded file gets a fresh one. They're deleted when the tile leaves the shelf. The source
recording is never touched.

| | Poster cache |
| :-- | :-- |
| **Windows** | `%LOCALAPPDATA%\com.mogginglabs.shotshelf\posters` |
| **macOS** | `~/Library/Caches/com.mogginglabs.shotshelf/posters` |

The sidecar is ~80 MB per platform, so it's fetched at install time by
`scripts/prepare-sidecar.mjs` (via `ffmpeg-static`) and git-ignored rather than committed — it
still ends up inside the installer, so nothing is downloaded at runtime. Binaries are named
`ffmpeg-<target-triple>`, with a `.exe` suffix on Windows. **Licensing:** those builds are
GPL-3.0. Shotshelf runs ffmpeg as a separate process and doesn't link it, so the MIT licence
here is unaffected, but any distributed build carries GPL obligations for that binary.

### Getting a capture out

Press a tile and move: the capture leaves the shelf as a **real file**, dropped into Explorer,
Finder, an email, a chat box or an editor — `tauri-plugin-drag` (`drag-rs`) hands it to the OS
in `copy` mode, so the original never moves. A press that doesn't travel stays a click, which
keeps the copy and remove controls usable.

Each tile also has a **copy** button for the apps that take a paste but refuse a file drop:
images go on the clipboard as pixels, recordings as a file reference. Shotshelf flags its own
clipboard writes so copying a capture doesn't shelve a second copy of it.

Thumbnails are rendered straight from disk over Tauri's asset protocol, never inlined as
base64. That protocol is scoped shut by default, and the scope is granted at **runtime** from
the same resolved watch list the engine uses — non-recursively, plus the clipboard folder.
A static scope in `tauri.conf.json` could not express the macOS location, which is only known
after `defaults read` has run, nor a `SHOTSHELF_WATCH_DIRS` override. The asset URL differs by
platform (`http://asset.localhost/…` on Windows, `asset://localhost/…` on macOS);
`convertFileSrc` picks the right one and the CSP allows both.

## 🗺️ Roadmap

- [x] **v0.0** research → **build in Tauri v2**; adopt `drag-rs` + `notify` + `tauri-plugin-clipboard`
- [ ] **v0.1** Tauri shell + catch engine + shelf UI (screenshots)
  - [x] scaffold — frameless always-on-top edge window, tray icon, plugins wired
  - [x] catch engine — `notify` folder watchers + clipboard images → `capture://new`
  - [x] shelf UI — recent-first thumbnail strip, auto-shows on every capture
- [x] **v0.2** native drag-out (the crux) via `tauri-plugin-drag`, with a clipboard-copy fallback
- [ ] **v0.3** screen recordings (ffmpeg thumbs), settings/persistence, cross-platform parity, packaging
  - [x] recordings — bundled ffmpeg poster frames, duration + size on the tile
  - [ ] settings + persistence
  - [ ] cross-platform parity pass
  - [ ] packaging

## 🔐 Privacy — captures never leave your machine

Screenshots and recordings routinely contain sensitive material (client data, tokens on screen).
Shotshelf is **local-only**: no cloud, no telemetry, no upload. Thumbnails and any index stay on the
device. See [SECURITY.md](./SECURITY.md). This repo never contains real captures.

## ⚖️ Internal use

Shotshelf is an internal MoggingLabs utility (not a product). MIT, no warranty.

## 🤝 Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Reuse before rewriting; keep both platforms working; never
commit captures or user data.

## 📄 License

[MIT](./LICENSE) © MoggingLabs.

<div align="center"><sub>Part of <a href="https://github.com/MoggingLabs/mogginglabs-internals">MoggingLabs Internals</a> · catch every shot 📸</sub></div>
