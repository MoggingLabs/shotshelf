# Cross-platform parity

What has actually been observed working, on which operating system, and how to check it yourself
in about five minutes.

> **This matrix is incomplete on purpose.** Two of its three columns are empty. Filling a cell
> means someone ran the app on that OS and watched the thing happen — not that the code compiles
> for it, and not that a test covering the same rule passes.
>
> **CI is green on all three** as of 2026-08-01, run 30675649873 — the first fully green
> three-OS run in this repository's history. That run includes the design-scale gate, the
> nine-test IPC suite with per-OS local origins, and the Linux Appearance step against goldens
> regenerated for the design system (closing a red that predated it). The Actions billing stop
> that blocked everything for a day cleared on the account side the same day.

## Status

| | Windows 11 | macOS | Linux |
| :-- | :-- | :-- | :-- |
| Compiles, lints, tests | Pass (CI, 2026-08-01) | Pass (CI, 2026-08-01) | Pass (CI, 2026-08-01, goldens included) |
| Ever launched | **Yes** — 2026-07-31, dev build | No | No |
| Ever packaged | **Yes** — `.msi` + NSIS `.exe`, unsigned | **Yes** — `.dmg` (aarch64), built by the v0.1.0 release run, unsigned, never launched by a human | Smoke bundles only — built in CI, not published |
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
| Native drag-out | Pass | — | — | Full round-trip 2026-08-01, packaged build: dragged a capture into a real Explorer window; it arrived byte-identical and the original never moved |
| Copy to clipboard | Pass | — | — | 1920×1080 image on the clipboard |
| Show in folder | Pass | — | — | Clicked live 2026-08-01: Explorer opened on the capture's folder; also gated by e2e and the IPC scope-refusal test; now also on `o` and as the tray's Open the screenshots folder (neither driven live yet) |
| Copy recognised text (`t`) | — | — | — | Added 2026-08-01; e2e + IPC scope-refusal gated. A live keypress was attempted and could not be delivered: catch-shows open the shelf without focus or z-order, and the machine was in active use — needs a deliberate open (hotkey) first |
| Audit sweep (selection lifecycle, receipts, shelf Ctrl+Z, state-CSS integrity) | — | — | — | Landed 2026-08-02; e2e-gated in the real frontend with three guards mutation-proven, and every golden inspected. The parts only a live run can show — classic-scrollbar rendering, acrylic behind the fade, input-driven keys — wait on an idle machine, same as the `t` row above |
| Start at login | Pass | — | — | Reconcile driven live 2026-08-01: `startAtLogin: true` in the roamed file put the `Run` entry in `HKCU` at the next launch, `false` removed it — the machine-follows-account path, not just the toggle |
| Corner / monitor choice | Pass | — | — | Corner hop driven live 2026-08-01: all four corners, window rect read back exactly at the work-area edge minus the 12px margin each time. The cursor-monitor choice is untestable on this one-display machine and stays gates-only |
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
| Update check | Pass | — | — | Failure path only, against the old placeholder host; the endpoint moved to GitHub Releases on 2026-08-01 and 404s identically until an updater key publishes a manifest |
| Quick look, compare, multi-select, pin, remove, retention | — | — | — | Covered by the browser suite against the stubbed runtime; never driven against the real binary |
| Single instance | — | — | — | |
| Installer built | Pass | Pass — `.dmg` from the v0.1.0 run | Bundles built in CI (`.deb`/`.rpm`/`.AppImage`), deliberately unpublished | Windows: ffmpeg + licence verified inside the MSI; Linux publishing waits on one desktop smoke run |
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
