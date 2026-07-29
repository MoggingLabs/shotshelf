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

> **Status: built and gated, not yet run end-to-end.** Every gate below is green on Windows,
> macOS and Linux, and the front-end suite drives the real UI in a browser — but the packaged
> app has not been launched on a desktop, because the unsigned development build is refused by
> Windows Smart App Control on the machine it was written on. What that leaves unverified is
> named in [SECURITY.md](./SECURITY.md#what-has-not-been-verified). Cross-platform desktop app
> on **Tauri v2**. The catch engine, the corner
> popover, native drag-out, recordings, settings and packaging are all in — and on top of them:
> on-device text recognition, a credential warning, a five-tool annotation editor with real
> redaction, before/after comparison, quick look, multi-select and a keyboard map. Prior-art
> research settled fork-vs-build (nothing forkable does cross-platform auto-catch, so we build)
> and confirmed the scary part, native drag-out, is a solved plugin. The research notes behind those choices are kept locally and are not in the repo. Part of
> [MoggingLabs Internals](https://github.com/MoggingLabs/mogginglabs-internals), in a new category:
> an **internal desktop utility** (not a platform driver like the `-wire` tools).

## 🎯 The problem

We screen-record and screenshot our cloud/AI systems all day — for the editor, for client demos, and
now for the Closewire/Highwire build-validation loops. Right after a capture you can grab it; four
seconds later it's buried in a folder of a hundred near-identical files. Shotshelf fixes the workflow
instead of fixing our filing habits.

## ✨ What it does

- **Catches** every new screenshot and screen recording while it is running (watches the OS
  capture locations + clipboard), and brings back anything from the last 24 hours it was not
  running to see. Shotshelf does **not** add itself to startup — see
  [Run it](#-run-it) — so after a reboot you launch it yourself, and the backfill is what stops
  that costing you the morning's captures.
- **Holds** them in a popover in the corner of your screen, newest first, as thumbnails.
- **Drags out** — grab an item off the shelf and drop it straight into an email, editor, or chat. No
  Finder/Explorer spelunking, no 4-second window. Pick several and they go together, in order.
- **Reads them locally** — recognises the text in a screenshot on your machine, and warns you on
  the card if it looks like you are about to send a credential. Windows and macOS use the
  recogniser built into the OS; Linux uses tesseract if the machine has it. Where none is
  available the shelf says so rather than letting an unchecked capture look checked.
- **Compares two** — pick a before and an after and get one image with what changed outlined,
  which is the unit that actually carries meaning when you are iterating with a model.

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
folder).

## 🚀 Run it

**Prerequisites:** [Node](https://nodejs.org) 22+, [Rust](https://rustup.rs) (stable), plus the
platform toolchain Tauri v2 needs:

| | Windows 11 | macOS | Linux |
| :-- | :-- | :-- | :-- |
| Compiler | [VS Build Tools 2022](https://visualstudio.microsoft.com/downloads/) → *Desktop development with C++* | `xcode-select --install` | `build-essential` |
| Webview | [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) (preinstalled on Windows 11) | WKWebView (built in) | `libwebkit2gtk-4.1-dev` |
| Tray | built in | built in | `libayatana-appindicator3-dev` |

Linux also needs `librsvg2-dev`, `libxdo-dev`, `libssl-dev` and `patchelf` — see the CI workflow
for the exact list. **Linux is compile-verified only:** it builds and its tests pass in CI, but
nobody has run Shotshelf on a Linux desktop, so the tray, the capture paths and GTK drag-out are
all unproven there.

```bash
npm install                     # also fetches the ffmpeg sidecar (~80 MB, one platform)
npx playwright install chromium # once per clone; the browser gates need it
npm run tauri dev               # dev build, frontend hot-reloads
npm run tauri build             # release bundle (.msi/.exe on Windows, .dmg/.app on macOS)
```

**Starting it automatically is a manual step, and deliberately not automated here.** Shotshelf
registers no login item and writes nothing to a startup folder — an app that adds itself to
startup without being asked is a bad neighbour, and doing it properly needs a platform plugin
this build cannot currently add (`Cargo.toml` cannot be edited on the development machine; see
[SECURITY.md](./SECURITY.md#what-has-not-been-verified)). Until then: on Windows put a shortcut
in `shell:startup`, on macOS add it under System Settings → General → Login Items, on Linux drop
a `.desktop` file in `~/.config/autostart`. A launch picks up anything from the previous 24
hours, so a late start is not a lost morning.

Identical commands on every OS. The shelf is a popover that rests in the bottom-right corner of
the screen and has **no taskbar or Dock entry** by design — the tray icon (Windows, Linux) /
menu-bar icon (macOS), its right-click menu, and the global hotkey are how you summon it. On
Linux the tray protocol sends no click events to the app, so there the menu and the hotkey are
the only ways in. Building the Rust side on its own
(`cargo build` in `src-tauri/`) expects the frontend bundle to exist, so run `npm run build` first.

```
src/            frontend — vanilla TS + Vite, deliberately dependency-light
src-tauri/
  src/          Rust — window docking, tray icon, plugin registration
    catch/      the catch engine: folder watchers + clipboard watch
  capabilities/ what the webview itself may do (see below)
app-icon.png    icon source; regenerate the set with `npm run tauri icon app-icon.png`
.github/        CI — lints, tests and builds on Windows, macOS and Linux
```

Most of the per-OS code sits behind `cfg` gates that only the matching host compiles, so CI
builds all three. Every push and PR runs, on **windows-latest, macos-latest and ubuntu-latest**:

| Gate | What it catches |
| :-- | :-- |
| `npm run lint` | ESLint with type-aware rules — floating promises, unchecked IPC |
| `npm run deadcode` | knip, plus a check that every registered Tauri command has a caller *and* every invoked command is registered |
| `npm run test:unit` | the pure rules, in Node with no browser |
| `npm run build` | `tsc --noEmit` over `src` **and** `tests`, then the bundle |
| `npm run test:e2e` | the real front-end in a browser with the Tauri runtime stubbed |
| `npm run test:visual` | geometry and computed style everywhere; pixel goldens on Linux |
| `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, `cargo build` | the Rust half |

`npm run gate` runs the lot locally — including the Rust row, which it did not until it was
noticed that this sentence had been false since the table gained that row. One prerequisite,
once per clone: `npx playwright install chromium`, which `npm install` does not do for you.

The three-OS matrix is not ceremony: it has caught an unused parameter, two platform-only
dead-code errors and an `unsafe` block that guarded nothing, none of which the other two hosts
could see.

Pixel goldens are taken on Linux and compared on Linux — font rasterisation differs between
operating systems, so the appearance specs skip themselves elsewhere. Regenerate them with the
**Appearance goldens** workflow, then look at the images before committing them.

### Where it watches

| | Capture folders | Clipboard-only captures |
| :-- | :-- | :-- |
| **Windows** | `%UserProfile%\Pictures\Screenshots`, `%UserProfile%\Videos\Captures` (Game Bar), `%UserProfile%\Videos\Screen Recordings` (Snipping Tool), `…\OneDrive\Pictures\Screenshots` | Win+Shift+S |
| **macOS** | whatever `defaults read com.apple.screencapture location` returns, else `~/Desktop` — ⌘⇧5 recordings land there too | ⌘⌃⇧4 |
| **Linux** | `~/Pictures/Screenshots` (GNOME, XDG portal), `~/Pictures` (Spectacle, Flameshot), `~/Videos/Screencasts`, `~/Videos` | same clipboard watch |

A capture folder that does not exist yet is created, but only beside a parent that already does —
so `Pictures\Screenshots` appears on a machine that has never taken a screenshot, and nothing is
invented inside a OneDrive folder you do not have. The resolved list is logged at startup. macOS reads
the screenshot location once per launch, so `defaults write com.apple.screencapture location …`
takes effect on the next start. Set `SHOTSHELF_WATCH_DIRS` (`;`-separated on Windows, `:`
elsewhere) to override the list until the settings file lands. Clipboard captures are written
into the app data dir — never the repo.

Win+PrtSc saves a file **and** copies to the clipboard, so both watchers see the same
screenshot. The file wins — it has a real name and a real path — and the clipboard copy is
dropped rather than shelved twice. A clipboard-only capture (Win+Shift+S) is held ~1.5 s to
tell the two apart.

### The shelf

The shelf is a **popover resting in the bottom-right corner of the screen**, 225×420, not a window that sits on your
screen. It opens on a tray click or the hotkey — focused, so Esc dismisses it, and it stays put
while you work in other windows rather than vanishing on focus loss — and when a capture lands
it **peeks** for about a minute without
ever taking focus, then closes itself. Hovering it holds it open; dragging out of it will not
dismiss it. A shelf that appears on every screenshot and *stays* is the thing people end up
turning off, and a shelf that steals focus mid-sentence is the complaint Dropover's users made.

Captures sit in a **single column of 16:9 cards**, grouped by day, newest first. At 225 wide
there is only room for one: two columns would leave a card too small to recognise anything in,
which is the only job a thumbnail has. 16:9 is a screen's own shape, so a full-screen capture
fills a card exactly — nothing cropped, nothing letterboxed — and anything of another shape is
fitted whole rather than cut down to its middle.

The aspect ratio is the whole point: a screenshot keeps its meaning at the *top* — title bars,
headers, the first line of a terminal — and the shelf's original 3.8:1 tiles cropped a 1080p
capture to the middle 46%, throwing that away and rendering dark captures as empty holes.

The shelf holds **50** captures and scrolls; the 51st pushes the oldest off the end. Hovering
a tile reveals pin, copy and remove controls — removing takes it off the shelf, and the file
itself is never touched, moved or deleted. Recordings keep a permanent badge with their length
and size, because that is identity rather than chrome.

### Settings

The gear in the title strip opens the whole surface: how long captures **stay**, how many the
shelf **holds**, whether to **send smaller copies**, and the **hotkey**. That's the entire list,
and it's meant to stay short.

Everything lives in one hand-editable JSON file, on device, never synced:

| | Settings file |
| :-- | :-- |
| **Windows** | `%APPDATA%\com.mogginglabs.shotshelf\settings.json` |
| **macOS** | `~/Library/Application Support/com.mogginglabs.shotshelf/settings.json` |

The default hotkey is **`CommandOrControl+Shift+S`** — Ctrl+Shift+S on Windows, ⌘⇧S on macOS.
Worth knowing: a global shortcut takes that combination away from *every* app, and on macOS
⌘⇧S is Save As almost everywhere, so it's the first thing to change if it gets in the way. If
the combination is already taken the shelf still runs and says so in the log rather than failing
to start; a shortcut that won't register is refused and the previous one stays active.

**Retention** takes captures off the shelf, never off the disk — nothing here deletes, moves or
modifies a capture. **Pinned** captures (the ★ on a tile) ignore retention and the item limit,
and are the only shelf state that survives a restart; only their paths and a timestamp are
stored, never capture contents. Retention is in hours and accepts fractions, which is the only
practical way to watch expiry work without waiting an hour.

The popover places itself in the corner each time it opens, measured against the monitor's work
area rather than its full size — so it clears the taskbar wherever that sits, and rearranging
displays needs no setting at all. The column is pinned by that same corner, so as it grows it
moves upward and the newest card stays where your eye already is.

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

The webview holds four permissions and no more: listen and unlisten for events, window
drag-start for the title strip, and the drag plugin. Notably **not** `core:default`, which is
what this granted until it was audited — nine permission sets including `core:image`, whose
`from-path` and `rgba` together are a file-read primitive that bypasses both the asset-protocol
scope and `webview_path`, and `core:tray`/`core:menu`, which let the page rewrite the tray icon
and the app menu. No filesystem, no clipboard, no shell, no network.

Thumbnails are rendered straight from disk over Tauri's asset protocol, never inlined as
base64. That protocol is scoped shut by default, and the scope is granted at **runtime** from
the same resolved watch list the engine uses, non-recursively, plus the clipboard folder, the
edits directory and the poster cache. Three call sites, one of them a loop over the resolved
watch list, so the number of directories granted depends on how many the OS turns out to have —
this said "four grants", which was a count of neither. `webview_path::existing_file` consults
exactly this scope before Rust reads any capture.
A static scope in `tauri.conf.json` could not express the macOS location, which is only known
after `defaults read` has run, nor a `SHOTSHELF_WATCH_DIRS` override. The asset URL differs by
platform (`http://asset.localhost/…` on Windows, `asset://localhost/…` on macOS);
`convertFileSrc` picks the right one and the CSP allows both.

## 📦 Releasing

Installing and using Shotshelf is [docs/USAGE.md](./docs/USAGE.md). This is how the installers
get made.

```bash
npm run release              # signs if the environment can, otherwise unsigned
npm run release -- --unsigned  # never sign; for a local smoke test
```

Same command on both OSes. It produces an `.msi` and an NSIS `.exe` on Windows, a `.dmg` and
`.app` on macOS, plus the updater artifacts — with the ffmpeg sidecar inside each. **No signing
material lives in the repo**; it all comes from the environment, and a build with none of it set
still succeeds and emits unsigned artifacts.

| Variable | Needed for |
| :-- | :-- |
| `WINDOWS_CERT_THUMBPRINT` | Authenticode signing on Windows (cert must be in the Windows cert store) |
| `APPLE_SIGNING_IDENTITY` | Developer ID signing on macOS |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | macOS notarization (or `APPLE_API_KEY` + `APPLE_API_ISSUER` + `APPLE_API_KEY_PATH`) |
| `TAURI_SIGNING_PRIVATE_KEY` | Signing the update payload — without it, installed apps reject the update |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | If that key has a password |

Windows and macOS differ in kind here, not just in variable names: Windows signing is one
Authenticode timestamped signature, while macOS needs a Developer ID signature **and** a
round-trip to Apple's notary service before Gatekeeper will open it.

### The update feed

Update artifacts (and their `.sig` files) are produced **only when `TAURI_SIGNING_PRIVATE_KEY` is
set** — an unsigned one is rejected by every installed app, and Tauri refuses to build one
without the key. A build without it still produces perfectly good installers.

The app asks the endpoint in `tauri.conf.json`, with `{{target}}`, `{{arch}}` and
`{{current_version}}` substituted:

```
https://releases.mogginglabs.internal/shotshelf/{{target}}/{{arch}}/{{current_version}}
```

Serve either a static manifest or a dynamic endpoint that answers `204 No Content` when the
caller is current. The manifest shape:

```json
{
  "version": "0.2.0",
  "notes": "What changed",
  "pub_date": "2026-07-27T12:00:00Z",
  "platforms": {
    "windows-x86_64": { "signature": "<contents of the .sig>", "url": "https://…/Shotshelf_0.2.0_x64-setup.nsis.zip" },
    "darwin-aarch64": { "signature": "<contents of the .sig>", "url": "https://…/Shotshelf_0.2.0_aarch64.app.tar.gz" }
  }
}
```

The **public** half of the updater key is in `tauri.conf.json`; the private half must never be
committed — `*.key` is git-ignored. Regenerate the pair with
`npm run tauri signer generate -- -w <path outside the repo>` and paste the new public key into
`plugins.updater.pubkey`. Losing the private key means no further updates can be signed for
already-installed apps.

## 🗺️ Roadmap

- [x] **v0.0** research → **build in Tauri v2**; adopt `drag-rs` + `notify` + `tauri-plugin-clipboard`
- [ ] **v0.1** Tauri shell + catch engine + shelf UI (screenshots)
  - [x] scaffold — frameless always-on-top edge window, tray icon, plugins wired
  - [x] catch engine — `notify` folder watchers + clipboard images → `capture://new`
  - [x] shelf UI — recent-first thumbnail strip, auto-shows on every capture
- [x] **v0.2** native drag-out (the crux) via `tauri-plugin-drag`, with a clipboard-copy fallback
- [ ] **v0.3** screen recordings (ffmpeg thumbs), settings/persistence, cross-platform parity, packaging
  - [x] recordings — bundled ffmpeg poster frames, duration + size on the tile
  - [x] settings + persistence — retention, item cap, pinning, export sizing, global hotkey
  - [ ] cross-platform parity pass
  - [x] packaging — signed installers, bundled ffmpeg, internal updater, [USAGE](./docs/USAGE.md)

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
