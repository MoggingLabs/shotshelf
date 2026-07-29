# Shotshelf — install and use

Shotshelf catches every screenshot and screen recording you take and keeps it one drag away on
an always-on-top shelf. This guide takes you from download to first drag-out.

> **Your captures never leave your machine.** Shotshelf makes exactly one network request: on
> launch it asks the internal release feed whether a newer version exists. That request carries the
> running version, the operating system and the CPU architecture — they are part of the feed's URL —
> plus the updater's User-Agent. No capture, no filename, no metadata, no telemetry, no analytics,
> and nothing identifying you or the machine. Not now and not later. Everything else it does happens
> on local disk, and switching the check off — `checkForUpdates` in `settings.json`, a hand-edit rather than a
> control in the panel — sends nothing at all.

---

## Install

### Windows 11

1. Download `Shotshelf_<version>_x64_en-US.msi` (or `Shotshelf_<version>_x64-setup.exe`).
2. Run it. The installer comes in two shapes: the **`-setup.exe`** installs per-user and needs no administrator rights, and the **`.msi`** installs per-machine and will ask for them.
3. Launch **Shotshelf** from the Start menu.

If SmartScreen warns that the publisher is unknown, the build you have is **unsigned** — check
with whoever produced it before continuing. Signed builds install without a warning.

### macOS

1. Download `Shotshelf_<version>_aarch64.dmg`.

   **Apple Silicon only.** The release workflow has one macOS runner and builds for its own
   architecture with no `--target` and no universal binary, so no Intel `.dmg` is produced —
   and an `aarch64` app does not launch on an Intel Mac at all. This page used to offer an
   `..._x64.dmg` that has never existed. On an Intel Mac, build from source as under Linux
   below.
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
rather than shipping unverified. To try it, build from source: install `build-essential`,
`libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `libxdo-dev`,
`libssl-dev` and `patchelf`, then `npm ci && npm run tauri build`. (`libssl-dev` is not
optional: the updater pulls `reqwest` → `native-tls` → `openssl-sys`, which fails to link
without it. This list used to omit it and `build-essential`, so the one documented route a
Linux user has did not work when followed verbatim; `.github/workflows/ci.yml` installs the
same set.) The tray needs an AppIndicator host — GNOME needs the
AppIndicator extension; KDE, Xfce and Cinnamon have one already.

Three things work differently there. The first is imposed by the drag protocol: the URIs Shotshelf
advertises when you drag a capture out are built by the drag library, which does not
percent-encode them, and every Linux screenshot name contains spaces. Whether that matters
depends on the application you drop onto — most tolerate it, some may not — and nobody has yet
run Shotshelf on a Linux desktop to find out. Copy still works either way.

The second is scope. Linux has no single conventional screenshot folder — GNOME, KDE and
Flameshot each choose differently and several write straight into `~/Pictures` — so Shotshelf
watches `~/Pictures` and `~/Videos` themselves, not just a `Screenshots` subfolder. Two
consequences worth knowing: anything you drop into either folder is shelved as a capture, and
the shelf's own webview is granted read access to the images and videos sitting directly in
them. Windows watches four specific subfolders and macOS one, so this is broader than either.
Set `SHOTSHELF_WATCH_DIRS` to narrow it.

The third is imposed by the tray protocol rather than by choice: Linux
tray icons deliver no click events to the app, so **open the shelf from the icon's menu or the
hotkey** rather than by clicking the icon.

---

## First run

Shotshelf lives in the tray (Windows, Linux) / menu bar (macOS). It has no taskbar or Dock entry by
design — the shelf is a **popover that rests in the bottom-right corner of your screen**, just
clear of the taskbar, not a window that sits open all day.

- **Click the icon**, or press the hotkey, to open it. Esc closes it, as does the − button. It
  deliberately does *not* close when you click away: an opened shelf is sticky, because the whole
  point is dragging out of it and into something else.
- **When a capture lands** it peeks for about a minute and closes itself. It never takes
  focus, so it can't swallow what you're typing. Hover it and it stays open for as long as you
  want it.
- **Windows:** the icon's tooltip tells you how many captures are on the shelf.
- **macOS and Linux:** the count sits beside the icon. Linux tooltips are not shown at all — the
  AppIndicator protocol has no equivalent — so the label is where the count goes there.

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

A capture folder that does not exist yet is created, but only where its parent already does — so `Pictures\Screenshots` appears on a machine that has never taken a screenshot, and nothing is invented inside a OneDrive folder you do not have. The dot in the title strip turns green once it is watching, and its tooltip tells you how
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
- **Pick several** — click one, then ctrl-click (⌘-click) others, or shift-click for a range.
  Dragging any one of them carries them all, oldest first.
- **Quick look** — press space to open the picked capture at readable size, and
  space or Esc to close it. A 199px card in a 225px panel is enough to recognise a screenshot and
  not enough to read one, which is the whole reason this exists.
- **Edit** — pick one capture and a button appears in the title strip. Five tools,
  and only five: **crop**, **box**, **arrow**, **number** and **redact**. Saving
  produces a new capture on the shelf; the one you marked up is untouched.
- **Compare** — pick exactly two and a Compare button appears in the title strip. It puts them
  side by side with whatever changed outlined, as a single new capture you can drag out. The
  **older** capture is the "before", whichever order you picked them in — ctrl-clicking and
  shift-selecting produce different pick orders, so pick order is not one rule but two.

Pin, remove and copy appear on a tile when you hover it; edit and compare live in the title
strip, because they act on what you have picked rather than on the tile under the pointer.
- **Show/hide** — the tray icon, its right-click menu, or the global hotkey
  (`Ctrl+Shift+S` on Windows, `⌘⇧S` on macOS by default).

### From the keyboard

The shelf is summoned with a hotkey, so reaching for the mouse to act on what it
shows rather defeats the point.

| Key | What it does |
| :-- | :-- |
| `↑` `↓` | Move between captures, in the order they are shown |
| `Space` | Open the picked **image** at readable size, and close it again — recordings have no preview |
| `Enter` | Copy it to the clipboard |
| `Delete` or `Backspace` | Take it off the shelf — **the file stays on disk** |
| `e` | Mark the picked capture up |
| `Ctrl+Z` | Undo the last mark, while marking up |
| `Esc` | Close the editor, then the preview, then the shelf |

Escape backs out one level at a time on purpose: one key that closes two things
at once is one key that loses your place.

Recordings show a frame from themselves plus a badge with their length and size. If a recording
can't be decoded the tile keeps a film icon and still drags out fine.

Captures are grouped by day, so "the one from yesterday" stays findable once the shelf fills up.

### Marking a capture up

The tools exist for one job: telling someone else — or a model — *where to look*.

**Numbers** are the one worth calling out. A numbered marker makes the picture
referenceable from a sentence: "why is 2 misaligned but 3 fine?" An anonymous
box cannot be talked about that way.

**Redact destroys.** The pixels under a redaction are replaced before the file is
written, so what comes out has nothing underneath it and nothing to peel off.
That is different from drawing a black rectangle in most annotation tools, where
the original survives in the file. If you are removing a key or an address before
sending a screenshot, this is the tool to use.

`Ctrl+Z` undoes the last mark, including a crop. `Esc` leaves without saving.

### What a card is named after

A capture arrives named after the clock, which identifies it to a filesystem and to nobody
else. So Shotshelf notes **what was in front when you took it** and puts that on the card
instead — "Code — auth.ts" rather than `Screenshot 2026-07-27 133012.png`. The filename is
still there in the tooltip.

This is read on your machine and stays there, like everything else. It asks for no new
permission, and that constraint shapes what it can see:

| | What is read |
| :-- | :-- |
| **Windows** | The frontmost window's title, and the program that owns it |
| **macOS** | The frontmost **application** only. Reading a window title there needs Screen Recording permission, which Shotshelf does not ask for and does not want |
| **Linux** | Nothing — there is no portable way, and Wayland deliberately refuses |

Where nothing can be read, the card shows its filename, exactly as before.

### The credential warning

Screenshots of a working machine routinely contain an API key, a `.env`, or a customer's email
address — and a drag-out is very often into a chat window on someone else's server. Shotshelf
reads each screenshot **on your machine** and puts an amber marker on the card if it finds
something that looks like a credential, naming the kind without ever showing the value.

Three things worth knowing:

- **It never stops you.** Dragging, copying and pinning a flagged capture all work exactly as
  they always did. It is a second look, not a lock.
- **It runs on all three platforms, but not on every machine.** Windows and macOS each have a
  text recogniser built into the OS — `Windows.Media.Ocr` and Vision, the one Preview uses. On
  Linux it needs `tesseract` installed; without it there is nothing to read with. Where it is
  unavailable the shelf says so in the tooltip on the status dot, and any capture that could
  not be read carries a small **?** — so an unchecked capture is never mistaken for a checked
  one.
- **No marker does not mean "safe".** It means nothing matched. Text recognition on a
  screenshot is imperfect, and the patterns only cover credentials with recognisable shapes.
  A **?** is different again: that capture could not be read at all, so nothing was checked.

Nothing about this leaves your machine — the checking happens locally, and the recognised text
never leaves Rust.

---

## Settings

The gear in the title strip opens every control there is — four of them. One setting has no
control and is hand-edited only: `checkForUpdates`, covered further down.

| Setting | What it does |
| :-- | :-- |
| **Keep for** | How long unpinned captures stay. Removing them never touches the files |
| **Max items** | How many unpinned captures the shelf holds |
| **Send smaller copies** | Hand over a copy no larger than 1568px on its long edge, instead of the original |
| **Hotkey** | The global show/hide shortcut |

**About "Send smaller copies".** Off by default. Every vision model resizes what it is given
to roughly 1568px before it looks at it, so when you are feeding a chat those extra pixels are
uploaded and then discarded — turning this on costs nothing and saves time and tokens. It is
off by default because a drag-out is also how captures reach design tools and bug reports, and
quietly handing you a smaller file than the one you asked for is not a decision Shotshelf
should make for you. Your original is never modified either way; the smaller copy is a
separate file, and it keeps the original's name — with a `.png` extension, because the smaller
copy really is a PNG and a file whose contents contradict its name breaks whatever opens it. So a
downscaled `shot.jpg` arrives as `shot.png`.

Settings are two JSON files you can also edit by hand — preferences, and your pins:

| | Preferences | Pinned captures |
| :-- | :-- | :-- |
| **Windows** | `%APPDATA%\com.mogginglabs.shotshelf\settings.json` | `%LOCALAPPDATA%\com.mogginglabs.shotshelf\pinned.json` |
| **macOS** | `~/Library/Application Support/com.mogginglabs.shotshelf/settings.json` | `~/Library/Application Support/com.mogginglabs.shotshelf/pinned.json` |
| **Linux** | `~/.config/com.mogginglabs.shotshelf/settings.json` | `~/.local/share/com.mogginglabs.shotshelf/pinned.json` |

They are separate **on Windows and Linux** because the first location roams to a network share on
a managed machine and the second does not, and a pin is an absolute path to one of your captures.
**On macOS the two paths above are the same folder** — macOS has no roaming profile, so there is
nothing to separate them from and the split buys nothing there.

`pinned.json` also records how recent the newest capture Shotshelf has seen was, which is how a
relaunch knows not to bring back something you removed. The same local-data folder holds
`shotshelf.log` and a small `video-drag-preview.png` that Shotshelf writes for drag previews;
both are re-derivable and safe to delete.

If `pinned.json` is ever unreadable, Shotshelf sets it aside as `pinned.json.corrupt` (then
`.corrupt.1`, up to five) rather than overwriting it, and says so in the log — the file is
hand-repairable and losing it loses your pins. Those copies name captures, so delete them
along with `pinned.json` if you are removing Shotshelf's data.

**On Linux, a shortcut can look registered without being.** The library behind it grabs keys
through X11 only, and its register call returns success even when the grab never happened — so
under Wayland without XWayland the Settings panel shows a live combination that does nothing, and
the log says nothing either. The tray has the same shape: its constructor cannot fail, so a desktop
with no StatusNotifier host (stock GNOME, without the AppIndicator extension) gets no icon and no
error. If both are unavailable, there is no way to summon the shelf once it is hidden — so on such
a desktop, leave it showing.

**About the default hotkey:** a global shortcut takes that combination away from every other
app. On macOS `⌘⇧S` is Save As almost everywhere, so it's worth changing to something you don't
otherwise use. If the combination is already taken, Shotshelf still runs — it just can't be
summoned that way, and says so in its log. A shortcut that won't register is refused and the
previous one stays active.

### Where Shotshelf keeps things

| | Windows | macOS | Linux |
| :-- | :-- | :-- | :-- |
| Settings | `%APPDATA%\com.mogginglabs.shotshelf\` | `~/Library/Application Support/com.mogginglabs.shotshelf/` | `~/.config/com.mogginglabs.shotshelf/` |
| Clipboard captures | `%LOCALAPPDATA%\com.mogginglabs.shotshelf\clipboard\` | `~/Library/Application Support/com.mogginglabs.shotshelf/clipboard/` | `~/.local/share/com.mogginglabs.shotshelf/clipboard/` |
| Comparisons and edits | `%LOCALAPPDATA%\com.mogginglabs.shotshelf\edits\` | `~/Library/Application Support/com.mogginglabs.shotshelf/edits/` | `~/.local/share/com.mogginglabs.shotshelf/edits/` |
| Video poster frames | `%LOCALAPPDATA%\com.mogginglabs.shotshelf\posters\` | `~/Library/Caches/com.mogginglabs.shotshelf/posters/` | `~/.cache/com.mogginglabs.shotshelf/posters/` |
| Smaller copies for sending | `%LOCALAPPDATA%\com.mogginglabs.shotshelf\handoff\` | `~/Library/Caches/com.mogginglabs.shotshelf/handoff/` | `~/.cache/com.mogginglabs.shotshelf/handoff/` |

**Four of those hold picture data**, so they are worth knowing about if you care where copies of
your screen end up. `clipboard` holds captures caught off the clipboard, which have no file
anywhere else — those are originals, not copies. `edits` holds comparisons and marked-up copies you
made; they are captures in their own right, which is why they are kept rather than cached, and
nothing prunes them — a cap that deleted oldest-first would silently delete pinned work, so
clearing that folder is your call and not the app's. `posters` holds one frame per recording, and
`handoff` holds smaller copies made for sending, and only if you turned that setting on; it keeps
the 60 most recent. Both are caches and are safe to delete at any time.

Deleting these folders costs you pins, thumbnails, and any comparisons you have not dragged out
yet. Your captures live wherever the OS put them and Shotshelf never moves or deletes them.

---

## Updates

Set `checkForUpdates` to `false` in the settings file and Shotshelf makes no network request at
all — not even this one.


On launch Shotshelf asks the internal feed whether a newer version exists. If one does, it says
so once and does nothing else — nothing is downloaded and nothing is replaced. Installing is
your decision, taken by fetching the installer yourself. If the feed is unreachable — you're
offline, or off the VPN — it carries on silently.

It used to download and install the update in place, unattended, at every launch. That is not
something an app should do without asking, and it is not what "asks whether a newer version
exists" means, so it no longer happens.
A compromised feed cannot make Shotshelf run arbitrary code.

To go back a version, install the older build over the top.

---

## Uninstall

- **Windows** — Settings → Apps → Installed apps → Shotshelf → Uninstall.
- **macOS** — drag Shotshelf from Applications to the Bin.

Then, if you want its leftovers gone too:

- **Safe to delete, always** — `posters` and `handoff`. Both are caches of things Shotshelf can
  work out again from your captures. Deleting them costs a few seconds of re-reading.
- **Read this first on macOS.** Shotshelf has two roots on Windows and Linux — a preferences one
  and a local-data one — and on macOS they are **the same folder**:
  `~/Library/Application Support/com.mogginglabs.shotshelf/`. So on macOS "delete the settings
  folder" also deletes `clipboard/` and `edits/`, and the next bullet explains why that is not
  something to do casually. On Windows and Linux the two are genuinely separate and deleting the
  preferences one is safe.
- **Safe to delete, and you lose your preferences** — `settings.json`. Delete the *file*, not the
  folder, and nothing else goes with it. Your pins are in `pinned.json` in the local-data root,
  so they survive; delete that too for a genuinely clean start.
- **Read this before deleting** — `clipboard` and `edits`. `clipboard` holds captures taken with
  Win+Shift+S or ⌘⇧⌃4, which never touched your disk anywhere else — **these are originals, and
  Shotshelf is the only place they exist.** `edits` holds the annotated copies and comparisons you
  made. Neither is a cache and neither is pruned; drag out anything you still want first.

Your screenshots and recordings in Pictures, Desktop and Videos are untouched by any of this.
Shotshelf never writes a *file* into a watched folder and never deletes from one; the only thing
it creates there is an empty capture folder that was missing, and those are left behind.

---

## Something's wrong

| Symptom | Likely cause |
| :-- | :-- |
| Nothing appears when you take a screenshot | The folder isn't being watched — check the status line, which now reports the folders actually being watched rather than the ones Shotshelf meant to watch. On macOS, the folder permission prompt may have been declined. `shotshelf.log` says which folder failed and why |
| The hotkey does nothing | Another app already owns that combination; change it in settings |
| Nothing appeared after a reboot | Shotshelf does not start itself — add it to your startup items. A launch brings back **up to 20** captures from the previous 24 hours, newest first, so the recent ones are still there |
| A recording shows a film glyph, not a frame | ffmpeg couldn't decode that file. The tile still drags out |
| A tile shows ⚠ | The file has been moved or deleted since it was caught |
| The shelf is nowhere to be seen | It's a popover — click the tray/menu-bar icon, or press the hotkey |
| It closes while you're still using it | Hover it to hold it open; it only auto-closes a peek |

Shotshelf writes diagnostics to `shotshelf.log` in its local app data directory —
`%LOCALAPPDATA%\com.mogginglabs.shotshelf\` on Windows,
`~/Library/Application Support/com.mogginglabs.shotshelf/` on macOS,
`~/.local/share/com.mogginglabs.shotshelf/` on Linux. Attach it to a bug report.

It used to say "run the installed binary from a terminal", which on Windows produces nothing at
all: a release build sets `windows_subsystem = "windows"` so the app has no console, and every
diagnostic went nowhere. The log holds the folders Shotshelf was asked to watch and capture *file names*
— never a capture's folder, a window title, or any recognised text — and it restarts itself once
it passes 512 KB.
