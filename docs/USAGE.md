# Shotshelf — install and use

Shotshelf catches every screenshot and screen recording you take and keeps it one drag away on
an always-on-top shelf. This guide takes you from download to first drag-out.

> **Your captures never leave your machine.** Shotshelf makes exactly one network request: on
> launch it asks the internal release feed whether a newer version exists, sending nothing but
> its own version number. No capture, no filename, no metadata, no telemetry, no analytics —
> not now and not later. Everything else it does happens on local disk.

---

## Install

### Windows 11

1. Download `Shotshelf_<version>_x64_en-US.msi` (or `Shotshelf_<version>_x64-setup.exe`).
2. Run it. The installer is per-user, so it needs no administrator rights.
3. Launch **Shotshelf** from the Start menu.

If SmartScreen warns that the publisher is unknown, the build you have is **unsigned** — check
with whoever produced it before continuing. Signed builds install without a warning.

### macOS

1. Download `Shotshelf_<version>_aarch64.dmg` (Apple Silicon) or `..._x64.dmg` (Intel).
2. Open it and drag **Shotshelf** into Applications.
3. Launch it from Applications.

A signed and notarized build opens straight away. If macOS says the app "cannot be opened
because the developer cannot be verified", the build is **unsigned or un-notarized** — again,
check its provenance rather than working around the warning.

**First-run permission prompt.** Shotshelf reads screenshots from wherever macOS saves them,
which is `~/Desktop` unless you have changed it. macOS will ask for access to that folder the
first time — allow it, or Shotshelf will see nothing. It does **not** need Screen Recording
permission: Shotshelf never captures anything itself, it only watches for files the OS has
already written.

### Linux

There is no Linux download. Shotshelf compiles, lints and links on Linux — CI builds it on
every change — but nobody has yet run it on a Linux desktop, so it ships without an installer
rather than shipping unverified. To try it, build from source: install `libwebkit2gtk-4.1-dev`,
`libayatana-appindicator3-dev`, `librsvg2-dev`, `libxdo-dev` and `patchelf`, then
`npm ci && npm run tauri build`. The tray needs an AppIndicator host — GNOME needs the
AppIndicator extension; KDE, Xfce and Cinnamon have one already.

Two things work differently there, both imposed by the tray protocol rather than by choice:
Linux tray icons deliver no click events to the app, so **open the shelf from the icon's menu
or the hotkey** rather than by clicking the icon; and because the icon's position can't be
read either, the popover anchors to the top-right of the screen instead of to the icon.

---

## First run

Shotshelf lives in the tray (Windows, Linux) / menu bar (macOS). It has no taskbar or Dock entry by
design — the shelf is a **popover that hangs off that icon**, not a window that sits on your
screen.

- **Click the icon**, or press the hotkey, to open it. It closes when you click away or press Esc.
- **When a capture lands** it peeks for about four seconds and closes itself. It never takes
  focus, so it can't swallow what you're typing. Hover it and it stays open for as long as you
  want it.
- The icon's tooltip tells you how many captures are on the shelf. On macOS the count also sits
  beside the icon.

**Windows 11 hides new tray icons.** The first time you run Shotshelf its icon goes into the
overflow flyout behind the **^** chevron, not onto the taskbar itself. That is a deliberate
Windows restriction — an app cannot promote its own icon — so drag it out of the flyout onto
the taskbar once and it stays there. Until you do, the popover still works; you just have to
open the flyout to click it, or use the hotkey.

**Where it watches:**

| | Capture folders | Clipboard-only captures |
| :-- | :-- | :-- |
| **Windows** | `%UserProfile%\Pictures\Screenshots`, `%UserProfile%\Videos\Captures` (Game Bar), `%UserProfile%\Videos\Screen Recordings` (Snipping Tool), and the OneDrive copy of Screenshots | Win+Shift+S |
| **macOS** | wherever `defaults read com.apple.screencapture location` points, otherwise `~/Desktop` — ⌘⇧5 recordings land there too | ⌘⌃⇧4 |
| **Linux** | `~/Pictures/Screenshots` (GNOME, XDG portal) and `~/Pictures` (Spectacle, Flameshot), plus `~/Videos` and `~/Videos/Screencasts` | the clipboard watch applies here too |

Folders that don't exist are skipped. The status line at the bottom of the shelf tells you how
many it's watching.

Take a screenshot. Within about a second the shelf appears with a thumbnail of it.

---

## Using the shelf

- **Drag out** — press a tile and move. The capture leaves as a real file you can drop into
  Explorer, Finder, an email, a chat box or an editor. It's a copy: the original stays put.
- **Copy** — for apps that take a paste but refuse a file drop. Images go on the clipboard as
  pixels, recordings as a file reference.
- **Pin** (the star) — pinned captures ignore the retention window and the item limit, and are
  the only ones still on the shelf after a restart. A pinned tile keeps its star showing.
- **Remove** (the cross) — takes it off the shelf. **It never deletes the file.**

Those three appear on a tile when you hover it.
- **Show/hide** — the tray icon, its right-click menu, or the global hotkey
  (`Ctrl+Shift+S` on Windows, `⌘⇧S` on macOS by default).

Recordings show a frame from themselves plus a badge with their length and size. If a recording
can't be decoded the tile keeps a film icon and still drags out fine.

Captures are grouped by day, so "the one from yesterday" stays findable once the shelf fills up.

---

## Settings

The gear in the title strip opens everything there is:

| Setting | What it does |
| :-- | :-- |
| **Keep for** | How long unpinned captures stay. Removing them never touches the files |
| **Max items** | How many unpinned captures the shelf holds |
| **Hotkey** | The global show/hide shortcut |

Settings are one JSON file you can also edit by hand:

| | |
| :-- | :-- |
| **Windows** | `%APPDATA%\com.mogginglabs.shotshelf\settings.json` |
| **macOS** | `~/Library/Application Support/com.mogginglabs.shotshelf/settings.json` |
| **Linux** | `~/.config/com.mogginglabs.shotshelf/settings.json` |

**About the default hotkey:** a global shortcut takes that combination away from every other
app. On macOS `⌘⇧S` is Save As almost everywhere, so it's worth changing to something you don't
otherwise use. If the combination is already taken, Shotshelf still runs — it just can't be
summoned that way, and says so in its log. A shortcut that won't register is refused and the
previous one stays active.

### Where Shotshelf keeps things

| | Windows | macOS | Linux |
| :-- | :-- | :-- | :-- |
| Settings | `%APPDATA%\com.mogginglabs.shotshelf\` | `~/Library/Application Support/com.mogginglabs.shotshelf/` | `~/.config/com.mogginglabs.shotshelf/` |
| Clipboard captures | `%APPDATA%\com.mogginglabs.shotshelf\clipboard\` | `~/Library/Application Support/com.mogginglabs.shotshelf/clipboard/` | `~/.local/share/com.mogginglabs.shotshelf/clipboard/` |
| Video poster frames | `%LOCALAPPDATA%\com.mogginglabs.shotshelf\posters\` | `~/Library/Caches/com.mogginglabs.shotshelf/posters/` | `~/.cache/com.mogginglabs.shotshelf/posters/` |

Deleting those folders costs you pins and thumbnails, nothing else. Your captures live wherever
the OS put them and Shotshelf never moves or deletes them.

---

## Updates

On launch Shotshelf asks the internal feed whether a newer version exists. If one does, it
downloads and installs it in place; restart to run it. If the feed is unreachable — you're
offline, or off the VPN — it carries on silently.

An update is only installed if it carries a valid signature from the MoggingLabs updater key.
A compromised feed cannot make Shotshelf run arbitrary code.

To go back a version, install the older build over the top.

---

## Uninstall

- **Windows** — Settings → Apps → Installed apps → Shotshelf → Uninstall.
- **macOS** — drag Shotshelf from Applications to the Bin.

Then delete the folders in the table above if you want its settings and caches gone too. Your
screenshots and recordings are untouched by any of this.

---

## Something's wrong

| Symptom | Likely cause |
| :-- | :-- |
| Nothing appears when you take a screenshot | The folder isn't being watched — check the status line. On macOS, the folder permission prompt may have been declined |
| The hotkey does nothing | Another app already owns that combination; change it in settings |
| A recording shows a film glyph, not a frame | ffmpeg couldn't decode that file. The tile still drags out |
| A tile shows ⚠ | The file has been moved or deleted since it was caught |
| The shelf is nowhere to be seen | It's a popover — click the tray/menu-bar icon, or press the hotkey |
| It closes while you're still using it | Hover it to hold it open; it only auto-closes a peek |

Shotshelf logs to standard output. To see it, run the installed binary from a terminal.
