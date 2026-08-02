# Cross-platform parity

What has actually been observed working, on which operating system, and how to check it yourself
in about five minutes.

> **This matrix is incomplete on purpose.** Filling a cell means someone ran the app on that
> OS and watched the thing happen — not that the code compiles for it, and not that a test
> covering the same rule passes. Since 2026-08-02 the macOS and Linux columns hold their first
> real observations, from the **Runner smoke** workflow: it installs the shipped release
> artifacts on GitHub runners, drives them with synthetic captures, and uploads screencaptures
> that a person reads before any cell moves.
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
| Ever launched | **Yes** — 2026-07-31, dev build | **Yes** — 2026-08-02, the shipped v0.2.0 dmg on a macos-14 runner (quarantine strip required: unsigned) | **Yes** — 2026-08-02, the shipped v0.2.0 deb under Xvfb + openbox on ubuntu-latest |
| Ever packaged | **Yes** — `.msi` + NSIS `.exe`, unsigned | **Yes** — `.dmg` (aarch64), unsigned | Smoke bundles only — built in CI, not published; the runner smoke now supplies the evidence the publish flip was waiting on (owner call) |
| Packaged build ever run | **Yes** — from the MSI's contents | **Yes** — runner smoke 2026-08-02, screenshots reviewed | **Yes** — runner smoke 2026-08-02, screenshots reviewed |

## Capabilities

`Pass` means observed. `—` means nobody has looked, because the app has never run there.

| Capability | Windows 11 | macOS | Linux | Notes |
| :-- | :-- | :-- | :-- | :-- |
| Watch folders resolve | Pass | Pass — `~/Desktop` fallback used on the runner | Pass — `~/Pictures` + `~/Pictures/Screenshots` watched; absent `~/Videos` skipped by name | Three watched; the absent OneDrive path was skipped by name, not invented |
| Folder catch — image | Pass | Pass — `caught Image smoke-live.png`, column peeked | Pass — same, column peeked | PNG written into `Pictures\Screenshots` appeared on the shelf |
| Folder catch — recording | Pass | — | — | MP4 written into `Videos\Captures` |
| Clipboard catch | Pass | — | — | Image on the clipboard written into `clipboard/` in local app data |
| Clipboard echo suppressed | Pass | — | — | Copying a capture did **not** shelve a second copy of it |
| Backfill on launch | Pass | Pass — "1 captures from before this launch"; the relaunch correctly backfilled nothing (lastCaptureMs guard) | Pass — "1 captures from before this launch" | Reported "1 captures from before this launch" |
| Image thumbnail | Pass | Pass — the capture's content visible on the card | Pass — same | Rendered from disk over the asset protocol, so the runtime scope grant works |
| Video poster frame | Pass | — | — | Bundled ffmpeg extracted a frame; tile showed it |
| Duration and size badge | Pass | — | — | `0:06 · 14 kB` on the recording tile |
| Native drag-out | Pass | — | — | Full round-trip 2026-08-01, packaged build: dragged a capture into a real Explorer window; it arrived byte-identical and the original never moved |
| Copy to clipboard | Pass | — | — | 1920×1080 image on the clipboard |
| Show in folder | Pass | — | — | Clicked live 2026-08-01: Explorer opened on the capture's folder; also gated by e2e and the IPC scope-refusal test; now also on `o` and as the tray's Open the screenshots folder (neither driven live yet) |
| Copy recognised text (`t`) | Pass | — | — | Driven live 2026-08-02: `t` on a text-bearing capture put its exact recognised text — three lines, credential included — on the clipboard, with the "Text copied to the clipboard." receipt in the strip |
| Audit sweep (selection lifecycle, receipts, shelf Ctrl+Z, state-CSS integrity) | Pass | — | — | Driven live 2026-08-02, screenshots reviewed for each: picked ring + pick count with hover chrome up; pinned star at the top-right corner at rest with dark ink; the green copy receipt visible after the pointer left; Delete's "2 captures taken off — Ctrl+Z brings them back" and the "2 captures back on the shelf" restore (pin state survived the round trip); the "Pick a capture first" guard for unpicked keys; Enter activating the *focused* tile control rather than copying; `p` unpinning and `o` opening a real Explorer window with its receipt; Escape ending the session; the classic thin scrollbar **visible at rest under real WebView2** plus the bottom fade over acrylic. The keyboard-cursor halo in a multi-pick is pictured by the `multi-pick-cursor` golden |
| Start at login | Pass | Pass — reconcile wrote `~/Library/LaunchAgents/Shotshelf.plist` with RunAtLoad and logged "registered on this machine" | — | Reconcile driven live 2026-08-01: `startAtLogin: true` in the roamed file put the `Run` entry in `HKCU` at the next launch, `false` removed it — the machine-follows-account path, not just the toggle |
| Corner / monitor choice | Pass | — | — | Corner hop driven live 2026-08-01: all four corners, window rect read back exactly at the work-area edge minus the 12px margin each time. The cursor-monitor choice is untestable on this one-display machine and stays gates-only |
| On-device text recognition | Pass | — | — | `Windows.Media.Ocr`; macOS uses Vision, Linux tesseract if present |
| Credential warning | Pass | — | — | A capture containing an `AKIA…` placeholder showed the marker on its card |
| Annotation editor | Pass | — | — | Five tools present; a box drawn and saved |
| Saved edit becomes a capture | Pass | — | — | `<name> (edited).png` in `edits/`, on the shelf, annotation burned in |
| Popover placement | Pass | Pass — bottom-right corner of the runner desktop | Pass — bottom-right under openbox | Bottom-right of the **work area** (1920×1032 of a 1920×1080 screen), clear of the taskbar |
| Corner anchoring | Pass | — | — | Column grew upward; bottom edge stayed fixed |
| Both window shapes | Pass | Pass — peeked column and the browse view | Pass — both | Peeked column and the 225×420 browse view |
| Window chrome | Pass | — | — | DWM rounding and the dark backdrop rendered |
| Global hotkey | Pass | Pass — osascript ⌘⇧S opened the browse view (the empty state showed the ⌘ spelling) | Pass — xdotool Ctrl+Shift+S toggled it both ways, the XGrabKey path | `CommandOrControl+Shift+S` registered and toggled |
| Tray icon | Partial | — | — | A tray-region click toggled the shelf open live 2026-08-02 — the left-click behaviour, observed. The right-click **menu** still has never been opened: it refused two synthetic-click attempts, and which taskbar-corner icon is Shotshelf's was not pinned down |
| Update check | Pass | Pass — quiet warn against the keyless GitHub feed | Pass — same | Failure path only, against the old placeholder host; the endpoint moved to GitHub Releases on 2026-08-01 and 404s identically until an updater key publishes a manifest |
| Quick look, compare, multi-select, pin, remove, retention | — | — | — | Covered by the browser suite against the stubbed runtime; never driven against the real binary |
| Single instance | — | — | — | |
| Installer built | Pass | Pass — `.dmg` from the v0.1.0 run | Bundles built in CI (`.deb`/`.rpm`/`.AppImage`), deliberately unpublished | Windows: ffmpeg + licence verified inside the MSI; Linux publishing waits on one desktop smoke run |
| Packaged build runs | Pass | Pass — runner smoke, from the shipped dmg | Pass — runner smoke, from the shipped deb | Launched from the MSI's contents; caught a screenshot and a recording, poster frame from the bundled ffmpeg |
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
