# Shotshelf — prior-art research (local only)

> Git-ignored; never ships. Generated 2026-07-26 by an Opus research subagent. Reference for building
> the numbered `/goal` prompts. Contains no secrets.

---

**Bottom line up front:** The hardest technical piece — native drag-OUT of a real file into other
apps — is a **solved problem on both Windows and macOS, in both stacks**. Tauri: `crabnebula-dev/drag-rs`
/ `tauri-plugin-drag`. Electron: built-in `webContents.startDrag`. Both drag *existing* files, and OS
screenshots/recordings land on disk, so that's exactly what we need. There is **no existing OSS
cross-platform shelf that auto-catches screenshots** — that combination is our wedge. Recommendation:
**build in Tauri v2**, borrow UX patterns from `Tokri`/`ShakePin`, use `drag-rs` for the crux.

## Existing shelf apps

| App | Platform | OSS? / License | Auto-catches screenshots? | Reuse value |
|---|---|---|---|---|
| [Dropover](https://dropoverapp.com/) | macOS | Closed, commercial | **Yes** (v4.15+ auto-shelf on new screenshot + optional auto-copy) | Not forkable. **Closest existing product to Shotshelf's vision** — UX north star. |
| [Yoink](https://eternalstorms.at/yoink/mac/) | macOS/iOS | Closed, $8.99 | Partial (drags/clipboard) | Not forkable. Edge-shelf UX reference. |
| [Dropzone](https://aptonic.com/) | macOS | Closed | No (action grid) | Not forkable. |
| [Unclutter](https://unclutterapp.com/) | macOS | Closed | No | Not forkable. |
| [ShakePin](https://github.com/foamify/shakepin) | **macOS + Windows** | **OSS, MIT**, Flutter | No | Forkable & cross-platform but Flutter stack + no auto-catch. Feature/UX reference. |
| [FlowShelf](https://flowshelf.vercel.app/) | macOS | Closed | **Yes** (clipboard + screenshot + OCR) | Not forkable; proves the market thesis. |
| Windows shelves (Seer, etc.) | Windows | Mostly closed | No | Windows has **no strong shelf incumbent** — market gap. |

**Takeaway:** every app that auto-catches screenshots (Dropover, FlowShelf) is **closed-source
macOS-only**. Nobody does cross-platform auto-catch. That's the opening.

## Forkable OSS / cross-platform

| Project | Stack | License | Platforms | Notes |
|---|---|---|---|---|
| **[Tokri](https://github.com/jarusll/tokri)** | C++ | MIT | Mac/Win/Linux | 241★. Best-known OSS cross-platform "drop basket" (shake-to-open, holds files/text/images/URLs). **No screenshot auto-catch.** C++ = heavy fork. |
| **[ShakePin](https://github.com/foamify/shakepin)** | Flutter | MIT | Mac/Win | 2nd-best OSS cross-platform shelf (+compress/zip). No auto-catch. |
| Various `DropShelf`/`Perch`/`shelf` clones | Swift/AppKit | often unlicensed | macOS-only | Swarm of 2026 macOS-only clones; shake-detection/shelf-UI references, many unlicensed (not safely forkable). |
| `hj18985876834/DropShelfApp` | C# | **No license** | Windows | Rare Windows shelf, unlicensed — reference only. |

**Verdict:** no clean "fork this" exists — none combines cross-platform + web/Tauri stack + screenshot
auto-catch. Tokri (functionality) and ShakePin (feature set) are the best design references; neither is
worth adopting as a codebase given our preferred stack.

## Capture + history tools to build on

| Tool | License | Platform | Reuse value |
|---|---|---|---|
| **[ShareX](https://github.com/ShareX/ShareX)** | GPL-3.0, C#, 38.8k★ | Windows | Gold standard for capture + history + "After Capture" hooks + **Watch Folders**. Do NOT fork (GPL viral + C#/Win-only + huge), but it validates the model: *watch a folder → fire an action*. Users can even keep ShareX as capturer and let Shotshelf watch its output folder. |
| [Flameshot](https://github.com/flameshot-org/flameshot) | GPL-3.0, C++ | Linux/Win/mac | Capture tool, not a shelf. Reference only. |
| [Ksnip](https://github.com/ksnip/ksnip) | GPL-2.0, C++ | Cross-platform | Capture, not shelf. |

**Key insight:** we don't build a *capturer*. The OS already saves screenshots/recordings to known
folders. Shotshelf is a **watcher + shelf + drag-out**, not a capture tool. GPL on these tools means we
watch their *output*, we don't link their *code*.

## Hard parts + libraries (per stack)

### a. Native drag-OUT (the crux) — SOLVED on Win + mac in both stacks
- **Tauri:** [`crabnebula-dev/drag-rs`](https://github.com/crabnebula-dev/drag-rs) — Apache-2.0/MIT, 120★,
  active (pushed 2026-06), tested vs Tauri v2 / wry 0.46. Ships
  [`@crabnebula/tauri-plugin-drag`](https://www.npmjs.com/package/@crabnebula/tauri-plugin-drag): JS
  `startDrag({ item: [filePaths], icon })`. **Win + macOS + Linux(GTK) drag-out of existing files.**
  Single biggest de-risking find.
  - File-promise (create-on-drop) variant [`tauri-plugin-dragout`](https://github.com/alexqqqqqq777/tauri-plugin-dragout)
    exists (macOS `NSFilePromiseProvider`) but brand-new/low maturity. **Likely not needed:** screenshots
    already exist on disk; only clipboard-only images need a trivial temp-file write first.
- **Electron:** built-in [`webContents.startDrag({ file, icon })`](https://www.electronjs.org/docs/latest/tutorial/native-file-drag-drop).
  Win + macOS for existing files. Only drags files that already exist (fine for us); minor Win/mac timing
  differences but battle-tested.

### b. Detecting new captures
- **Windows save locations:** `%UserProfile%\Pictures\Screenshots` (Win+PrtSc / Snip & Sketch auto-save),
  `%UserProfile%\Videos\Screen Recordings` (Snipping Tool video), `%UserProfile%\Videos\Captures` (Xbox
  Game Bar), and `…\OneDrive\Pictures\Screenshots` when OneDrive backs up Pictures. **Win+Shift+S =
  clipboard only** → needs clipboard-image detection, not folder watch.
- **macOS save locations:** default `~/Desktop`; actual location via
  `defaults read com.apple.screencapture location`. ⌘⇧5 recordings save to the same configured location.
- **File-watch libs:** Tauri → Rust [`notify`](https://github.com/notify-rs/notify) crate (or
  `tauri-plugin-fs-watch`). Electron → [`chokidar`](https://github.com/paulmillr/chokidar). Both mature.
- **Clipboard-image detection:** Tauri → `tauri-plugin-clipboard` (image read) or Rust `arboard`.
  Electron → built-in `clipboard.readImage()`. Poll/hook clipboard to catch Win+Shift+S / ⌘⌃⇧4, write to
  temp file, add to shelf.

### c. Always-on-top edge widget + thumbnails
- **Always-on-top / tray / frameless docked window:** native both — Tauri `alwaysOnTop`, `skipTaskbar`,
  `decorations:false` + `tauri-plugin-positioner` + tray API; Electron `BrowserWindow({ alwaysOnTop,
  frame:false, skipTaskbar })` + `Tray`.
- **Image thumbnails:** cheap — CSS `object-fit` on the real file in the webview, or `image` crate / sharp.
- **Video-frame thumbnails (recordings):** the one fiddly bit. Extract a poster frame via bundled
  **ffmpeg** (`ffmpeg -i clip.mp4 -frames:v 1 thumb.jpg`) — same both stacks; adds a binary dependency.

## Adopt vs build + stack recommendation

**Adopt / reuse:** `drag-rs`/`tauri-plugin-drag` for the drag-out crux (biggest risk-killer); `notify` +
`tauri-plugin-clipboard` for capture detection; **interoperate** with ShareX (don't fork — its
Watch-Folder / After-Capture model is our blueprint); study Tokri/ShakePin UX (don't fork the codebases —
wrong stacks).

**Build from scratch (the actual product):** the *combination* — folder-watch + clipboard-watch → shelf
ingest → thumbnail (incl. video poster frames) → edge/tray always-on-top widget → drag-out. None of this
exists as a cross-platform OSS bundle; the individual pieces are all well-supported libraries.

**Stack pick: Tauri v2.**
- **Footprint:** an always-on tray app runs 24/7; Tauri's native-webview model uses a fraction of
  Electron's RAM (tens of MB vs 150MB+). Deciding factor for an ambient utility.
- **Drag-out quality:** `drag-rs` is purpose-built, actively maintained, covers Win+mac+Linux — parity
  with Electron's built-in, arguably better fit. Crux fully covered.
- **Capture/clipboard/watch:** `notify` + `tauri-plugin-clipboard` + `tauri-plugin-fs` cover it on both OSes.
- **Packaging:** Tauri produces small signed installers (.msi/.exe, .dmg) with a built-in updater.
- **Cost:** Rust backend learning curve; video-frame thumbnails need bundled ffmpeg either way.

**Choose Electron instead only if** the team wants everything in JS (`chokidar` +
`webContents.startDrag` + `clipboard.readImage()`) with maximum tutorial coverage — at ~5–10x idle
memory, a real cost for a background shelf.

**Suggested MVP path:** Tauri v2 shell → tray + edge always-on-top window → `notify` watchers on the OS
screenshot/recording folders (+ clipboard poll) → thumbnail grid (ffmpeg poster frame for video) →
`tauri-plugin-drag` drag-out. Front-loads the only two real risks (drag-out, video thumbs), both with
known working solutions.

Sources: Dropover, Yoink, ShakePin, Tokri, FlowShelf, drag-rs, tauri-plugin-drag, tauri-plugin-dragout,
Electron native drag-and-drop, ShareX, Windows/macOS screenshot-location docs (URLs inline above).
