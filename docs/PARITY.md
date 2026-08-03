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
| Native drag-out | Pass | — | — | Full round-trip 2026-08-01, packaged build: dragged a capture into a real Explorer window; it arrived byte-identical and the original never moved. Owner dogfooding 2026-08-02 found the drag **ghost** rendered at the capture's full dimensions — the icon was the original file under a comment claiming the plugin thumbnails it. Fixed to a bounded, cached, card-sized ghost (a recording shows its poster); observed 2026-08-02: a live drag wrote a 256×144 ghost for a 1280×720 capture, aspect kept |
| Copy to clipboard | Pass | — | — | 1920×1080 image on the clipboard |
| Show in folder | Pass | — | — | Clicked live 2026-08-01: Explorer opened on the capture's folder; also gated by e2e and the IPC scope-refusal test; now also on `o` and as the tray's Open the screenshots folder (neither driven live yet) |
| Copy recognised text (`t`) | Pass | — | — | Driven live 2026-08-02: `t` on a text-bearing capture put its exact recognised text — three lines, credential included — on the clipboard, with the "Text copied to the clipboard." receipt in the strip |
| Audit sweep (selection lifecycle, receipts, shelf Ctrl+Z, state-CSS integrity) | Pass | — | — | Driven live 2026-08-02, screenshots reviewed for each: picked ring + pick count with hover chrome up; pinned star at the top-right corner at rest with dark ink; the green copy receipt visible after the pointer left; Delete's "2 captures taken off — Ctrl+Z brings them back" and the "2 captures back on the shelf" restore (pin state survived the round trip); the "Pick a capture first" guard for unpicked keys; Enter activating the *focused* tile control rather than copying; `p` unpinning and `o` opening a real Explorer window with its receipt; Escape ending the session; the classic thin scrollbar **visible at rest under real WebView2** plus the bottom fade over acrylic. The keyboard-cursor halo in a multi-pick is pictured by the `multi-pick-cursor` golden |
| Start at login | Pass | Pass — reconcile wrote `~/Library/LaunchAgents/Shotshelf.plist` with RunAtLoad and logged "registered on this machine" | — | Reconcile driven live 2026-08-01: `startAtLogin: true` in the roamed file put the `Run` entry in `HKCU` at the next launch, `false` removed it — the machine-follows-account path, not just the toggle |
| Corner / monitor choice | Pass | — | — | Corner hop driven live 2026-08-01: all four corners, window rect read back exactly at the work-area edge minus the 12px margin each time. The cursor-monitor choice is untestable on this one-display machine and stays gates-only |
| On-device text recognition | Pass | — | — | `Windows.Media.Ocr`; macOS uses Vision, Linux tesseract if present |
| Credential warning | Pass | — | — | A capture containing an `AKIA…` placeholder showed the marker on its card |
| Annotation editor (in the shelf's window) | ~~Pass~~ | — | — | Struck rather than dropped: this read Pass on Windows for a surface that no longer exists. The editor was an overlay inside the shelf's popover until 2026-08-03; five tools present and a box drawn and saved was observed of *that*, and says nothing about the window below |
| Annotation editor (its own window) | Pass | — | — | Driven live 2026-08-03 against the dev build, by mouse rather than by hand (injected *keys* do not reach this app's webview from an automation process — a `p` on a picked capture left `pinned.json` empty, which is the decisive check — so every step below is a click at a coordinate read off a screenshot of the window). Clicking Edit opened a second window titled `<name> — Shotshelf`, **decorated, resizable, maximizable and in the taskbar, and not always-on-top**, with the shelf taken off screen. Sized from the capture: `wide.png` opened 1575×916 landscape, `tall.png` 496×916 portrait, both centred and capped to 85% of the work area. A `SetWindowPos` to 900×700 at 300,150 — what a hand on the border looks like from inside — reached `settings.json` as `editorWidth=884 editorHeight=661 editorX=300 editorY=150` after the debounce (inner size, outer position, by design), the X closed it, and re-opening brought it back at **exactly 900×700 at 300,150**. A box drawn at 100% landed under the pointer; the X over that unsaved mark showed the **Save / Discard / Cancel** bar instead of discarding; Save wrote `<name> (edited).png` into `edits/`, closed the window, and the shelf came back holding **two** captures — the edit with the box burned in, and the original untouched. That last step is `capture://edited` crossing windows, which no spec can prove. Two bugs were found by this run and fixed before it was repeated: Rust's own opening size was being persisted as though the user had chosen it (so "automatic" was overwritten on the very first open), and Fit *enlarged* a small capture to 464% instead of capping at actual size. **Not** covered: the macOS activation-policy swap that gives the window a ⌘-Tab entry, wheel zoom and Space-drag pan (both need real input this route cannot send), and Reset to automatic end to end |
| Saved edit becomes a capture | Pass | — | — | `<name> (edited).png` in `edits/`, on the shelf, annotation burned in |
| Popover placement | Pass | Pass — bottom-right corner of the runner desktop | Pass — bottom-right under openbox | Bottom-right of the **work area** (1920×1032 of a 1920×1080 screen), clear of the taskbar |
| Corner anchoring | Pass | — | — | Column grew upward; bottom edge stayed fixed |
| Both window shapes | Pass | Pass — peeked column and the browse view | Pass — both | Peeked column and the 225×420 browse view |
| Window chrome | Pass | — | — | DWM rounding and the dark backdrop rendered |
| Global hotkey | Pass | Pass — osascript ⌘⇧S opened the browse view (the empty state showed the ⌘ spelling) | Pass — xdotool Ctrl+Shift+S toggled it both ways, the XGrabKey path | `CommandOrControl+Shift+S` registered and toggled |
| Tray icon | Pass | — | — | Left-click toggle observed 2026-08-02. The right-click menu — which refused two synthetic-click attempts — opened the same day via the keyboard route (Win+B, arrows, Shift+F10): all four items present, and Settings… drove the settings window up focused. The keyboard route is the reproducible one; coordinate-hunting the Win11 overflow flyout was not |
| Update check | Pass | Pass — quiet warn against the keyless GitHub feed | Pass — same | Failure path only, against the old placeholder host; the endpoint moved to GitHub Releases on 2026-08-01 and 404s identically until an updater key publishes a manifest |
| Settings window | Pass | — | — | Driven live 2026-08-02, screenshots reviewed for each: the gear and the tray's Settings… both open it focused; all five sections walked; a cross-window save trimmed the shelf from 3 to 1 the moment Max items became 1; the corner picker moved the parked window bottom-left → bottom-right without a restart; the hotkey recorder took Ctrl+Shift+K, the new combo toggled the shelf globally while the old one went dead, and re-recording S restored it; X hides the window with the process alive and the gear brings it back |
| User watch folders (add / stop / restore) | Pass | — | — | The whole loop driven live 2026-08-02: the native picker (titled, in-process) took a typed path; the inline "Watch …?" row asked before anything was saved; the log re-emitted its watching block with the new folder and a PNG dropped there **landed on the shelf with no restart**; Stop asked in the row, the next PNG was correctly ignored, and what was already shelved stayed; removing a stock folder lit Restore defaults, whose confirm brought the stock folder back. The store ended byte-identical to defaults, every mutation reverted through the app's own controls. macOS/Linux unobserved; on Linux the picker is the XDG portal, absent on a bare runner |
| Delete with Undo toast, clipboard keep | — | — | — | Landed 2026-08-03, gates-only: five e2e walk the delete-stage-undo-commit loop against the mock and the keep sweep is unit-gated from both sides of its cutoff; the real file round trip (origin → stage → back, and stage → recycle bin) has been watched by no human on any OS |
| Resizable browse shelf | Pass | — | — | Driven live 2026-08-03 against the dev build, by Win32 rather than by hand: the summoned window really carries `WS_THICKFRAME` (the invisible border `set_resizable(true)` asks for), a `SetWindowPos` the app never made — which is what a hand on that border looks like from inside — was recognised as the user's and reached `settings.json` as `browseWidth=300 browseHeight=500` after the debounce, and a hide plus re-summon came back **300 wide by 227 tall**: the width applied, the height stayed the *ceiling* and the fit chose 227 for what the shelf was holding. Sizing the window below the floor from outside also stored 225×160, so sanitise holds even where the OS clamp does not apply. No warning from any of it in `shotshelf.log`. **Not** covered: the OS refusing a *hand* below the floor (`WM_GETMINMAXINFO` governs user sizing only, and `SetWindowPos` bypasses it), the grip's hover reveal on a real webview, and the Reset button end to end |
| Themes (System / Light / Dark) | Pass | — | — | Observed 2026-08-02 on real WebView2: the app booted light on a light OS with theme "system"; Dark and Light clicks repainted **both** windows at once; and with System selected, flipping the OS apps theme repainted both live — provided the flip is announced (`WM_SETTINGCHANGE`/ImmersiveColorSet, which the Windows Settings app sends and a raw registry write does not). WKWebView/WebKitGTK still unobserved |
| Themed tooltips and dropdowns | Pass | — | — | Observed 2026-08-02: the gear's themed bubble appeared after the hover delay on the real always-on-top popover, inside the window; the Keep-for dropdown opened as the themed listbox — no OS-white dropdown anywhere |
| Quick look, compare, multi-select, pin, remove, retention | Pass | — | — | Pin, remove and retention were the 2026-08-02 audit sweep; quick look and compare joined the same day against the real binary: Space grew the window to a readable 1321×743 and Space closed it back to the popover; a two-pick showed the cursor halo and the Compare control, and Compare produced the side-by-side composite as a new capture with its receipt in the strip |
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
5b. **Drag the summoned shelf's own edges.** It resizes from any edge or corner (the border is
   invisible — the six dots in the bottom-right corner appear when the pointer is over the
   window and mark where it is), and it refuses to go narrower than one card or shorter than
   about a card and a half. Let go, wait a second, summon it again: the width is still yours.
   Settings → Appearance → **Reset to automatic** — now enabled — puts it back. The capture
   popup is not resizable at all, and stays its own width whatever you did here.
6. **Drag a capture into another app** — an editor, a chat box, a file manager. The file arrives,
   and the original is still where it was. This is the one step nothing else can substitute for.
7. **Copy one** with the tile's copy control and paste it somewhere. Then check the shelf did
   **not** gain a second copy of it.
8. **Mark one up.** Select an image, press `e`. A **separate window** opens on the capture and
   the shelf goes away. Confirm it is a real one: drag its edges, maximize it, find it in
   Alt-Tab (⌘-Tab on macOS, where the app takes a Dock icon for as long as the window is up).
   Draw a box, Save. The window closes and a new capture appears on the shelf carrying the
   annotation, with the original untouched.
8a. **Zoom.** Reopen the editor on the largest screenshot you have. `Fit` shows all of it;
   `100%` should make small text *readable* — that is the whole point of this feature. Scroll
   to zoom about the cursor, hold Space and drag to pan, then redact a word at 100% and check
   the saved copy has nothing underneath it and is still the capture's full resolution.
   Then close the window with its X while a mark is unsaved: it must ask (Save / Discard /
   Cancel) rather than either discarding or refusing to close. Reopen it — it comes back where
   and how big you left it — then use **Reset to automatic** in Settings → Appearance.
8b. **Open the settings window** with the gear. Walk the five sections; change Max items and
   watch the shelf obey without a restart; switch the theme to Light and both windows should
   repaint; click the hotkey control, press a new combination, and summon the shelf with it.
   Close the window — the gear must bring it back.
9. **Check a credential is flagged.** Capture a terminal showing a token-shaped string — the
   documentation placeholder `AKIAIOSFODNN7EXAMPLE` works — and the card should show the warning
   marker.
10. **Close it and reopen it.** Pinned captures come back; unpinned ones from the last 24 hours are
    backfilled; nothing was deleted from disk anywhere in this list.

Anything that fails here is a blocker regardless of what the gates say, because every step is
something no gate in this repository can reach.
