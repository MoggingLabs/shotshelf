# Cross-platform parity

What has actually been observed working, on which operating system, and how to check it yourself
in about five minutes.

> **This matrix is incomplete on purpose.** Two of its three columns are empty. Filling a cell
> means someone ran the app on that OS and watched the thing happen — not that the code compiles
> for it, and not that a test covering the same rule passes.
>
> **CI is not green on all three.** The last run that actually executed — 2026-07-30 — had
> Windows and macOS passing every step and **Linux failing** on pixel goldens: `column-one.png`
> and `column-three.png` differ by 979 pixels against stale snapshots. Every run since is
> stopped by GitHub Actions billing before a job starts, so nothing has been checked on any
> platform since. Regenerating those goldens needs the **Appearance goldens** workflow, which is
> Linux-only and blocked by the same billing stop.

## Status

| | Windows 11 | macOS | Linux |
| :-- | :-- | :-- | :-- |
| Compiles, lints, tests | Pass (CI, 2026-07-30) | Pass (CI, 2026-07-30) | **Red** — stale pixel goldens |
| Ever launched | **Yes** — 2026-07-31, dev build | No | No |
| Ever packaged | **Yes** — `.msi` + NSIS `.exe`, unsigned | No | n/a — no installer is produced |
| Packaged build ever run | **Yes** — from the MSI's contents | No | n/a |

## Capabilities

`Pass` means observed. `—` means nobody has looked, because the app has never run there.

| Capability | Windows 11 | macOS | Linux | Notes |
| :-- | :-- | :-- | :-- | :-- |
| Watch folders resolve | Pass | — | — | Three watched; the absent OneDrive path was skipped by name, not invented |
| Folder catch — image | Pass | — | — | PNG written into `Pictures\Screenshots` appeared on the shelf |
| Folder catch — recording | Pass | — | — | MP4 written into `Videos\Captures` |
| Clipboard catch | Pass | — | — | Image on the clipboard written into `clipboard/` in local app data |
| Clipboard echo suppressed | Pass | — | — | Copying a capture did **not** shelve a second copy of it |
| Backfill on launch | Pass | — | — | Reported "1 captures from before this launch" |
| Image thumbnail | Pass | — | — | Rendered from disk over the asset protocol, so the runtime scope grant works |
| Video poster frame | Pass | — | — | Bundled ffmpeg extracted a frame; tile showed it |
| Duration and size badge | Pass | — | — | `0:06 · 14 kB` on the recording tile |
| Native drag-out | Partial | — | — | The OS drag started with its preview under the cursor; the drag was **cancelled, not dropped**, so what a receiving app gets is unverified |
| Copy to clipboard | Pass | — | — | 1920×1080 image on the clipboard |
| Show in folder | Pass | — | — | Clicked live 2026-08-01: Explorer opened on the capture's folder; also gated by e2e and the IPC scope-refusal test |
| On-device text recognition | Pass | — | — | `Windows.Media.Ocr`; macOS uses Vision, Linux tesseract if present |
| Credential warning | Pass | — | — | A capture containing an `AKIA…` placeholder showed the marker on its card |
| Annotation editor | Pass | — | — | Five tools present; a box drawn and saved |
| Saved edit becomes a capture | Pass | — | — | `<name> (edited).png` in `edits/`, on the shelf, annotation burned in |
| Popover placement | Pass | — | — | Bottom-right of the **work area** (1920×1032 of a 1920×1080 screen), clear of the taskbar |
| Corner anchoring | Pass | — | — | Column grew upward; bottom edge stayed fixed |
| Both window shapes | Pass | — | — | Peeked column and the 225×420 browse view |
| Window chrome | Pass | — | — | DWM rounding and the dark backdrop rendered |
| Global hotkey | Pass | — | — | `CommandOrControl+Shift+S` registered and toggled |
| Tray icon | Partial | — | — | Present, in Windows 11's overflow flyout as `USAGE.md` says; the menu was never opened |
| Update check | Pass | — | — | Failure path only: the internal feed does not resolve, so it logged one warning and carried on |
| Quick look, compare, multi-select, pin, remove, retention | — | — | — | Covered by the browser suite against the stubbed runtime; never driven against the real binary |
| Single instance | — | — | — | |
| Installer built | Pass | — | n/a | `.msi` and NSIS `.exe`, unsigned; ffmpeg + its licence verified inside the MSI |
| Packaged build runs | Pass | — | n/a | Launched from the MSI's contents; caught a screenshot and a recording, poster frame from the bundled ffmpeg |
| Signing / notarization | — | — | n/a | Needs a certificate; no signed artifact has ever been produced |

### Deliberate per-OS differences

Not divergences to fix — decisions, with the reason.

- **Watch locations differ by OS**, because the OSes save captures in different places. The table
  is in [USAGE](./USAGE.md#first-run). Windows has an extra OneDrive path; macOS resolves its
  location dynamically with `defaults read`; Linux watches `~/Pictures` and `~/Videos` broadly
  because there is no one convention.
- **Windows 11 hides new tray icons** in the overflow flyout. An app cannot promote its own icon,
  so this is documented rather than worked around. Confirmed on the run above.
- **The tray click does nothing on Linux** — the tray protocol delivers no click events — so the
  menu and the hotkey are the only ways in there.
- **Wayland ignores window positioning**, so the popover appears wherever the compositor puts it.
- **macOS has no roaming profile**, so the two-file settings split is a no-op there. It is a
  privacy measure on Windows and Linux only.
- **`skipTaskbar` is Windows and Linux only**; macOS uses the Accessory activation policy to stay
  out of the Dock.

## The five-minute smoke checklist

Run this on any OS after a change that could touch catching, rendering or the window. It needs no
fixtures — take real captures, or synthesise them as below.

1. **Start it.** `npm run tauri dev`. The log should name every folder it is watching and skip the
   ones that are absent by name. On Windows the log is
   `%LOCALAPPDATA%\com.mogginglabs.shotshelf\shotshelf.log`; the other paths are in
   [USAGE](./USAGE.md#where-shotshelf-keeps-things).
2. **Take a screenshot.** Within about a second the shelf peeks in the bottom-right corner with a
   recognisable thumbnail. It must **not** take focus.
3. **Take a clipboard-only capture** (Win+Shift+S / ⌘⌃⇧4). It appears too, and exactly once.
4. **Record something short.** The tile shows a frame from the clip — not a black one — with its
   duration and size.
5. **Summon it with the hotkey.** The peeked column becomes the full browse view, anchored by the
   same corner. Press it again; it closes.
6. **Drag a capture into another app** — an editor, a chat box, a file manager. The file arrives,
   and the original is still where it was. This is the one step nothing else can substitute for.
7. **Copy one** with the tile's copy control and paste it somewhere. Then check the shelf did
   **not** gain a second copy of it.
8. **Mark one up.** Select an image, press `e`, draw a box, Save. A new capture appears carrying
   the annotation, and the original is untouched.
9. **Check a credential is flagged.** Capture a terminal showing a token-shaped string — the
   documentation placeholder `AKIAIOSFODNN7EXAMPLE` works — and the card should show the warning
   marker.
10. **Close it and reopen it.** Pinned captures come back; unpinned ones from the last 24 hours are
    backfilled; nothing was deleted from disk anywhere in this list.

Anything that fails here is a blocker regardless of what the gates say, because every step is
something no gate in this repository can reach.
