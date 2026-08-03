# Shotshelf — install and use

Shotshelf catches every screenshot and screen recording you take and keeps it one drag away on
an always-on-top shelf. This guide takes you from download to first drag-out.

> **Your captures never leave your machine.** Shotshelf makes exactly one network request: on
> launch it fetches a small version manifest from the project's GitHub Releases to see whether a
> newer build exists. The request carries the updater's User-Agent and — as any HTTPS request
> does — your IP address to the host, which is GitHub; the version comparison happens locally,
> so not even your running version is in the URL. No capture, no filename, no metadata, no
> telemetry, no analytics. Everything else it does happens on local disk, and switching the
> check off — "Check at launch" in the settings window's About section — sends nothing at all.

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
every change, and since 2026-08-01 the release workflow also builds the Linux bundles
(`.deb`, `.rpm`, `.AppImage`) on every run so the packaging path stays exercised — but nobody
has yet run it on a Linux desktop, so those bundles are deliberately not attached to releases.
The day someone runs the smoke checklist in `PARITY.md` on a real Linux desktop, publishing
them is a one-line change the release workflow documents. To try it, build from source: install `build-essential`,
`libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `libxdo-dev`,
`libssl-dev` and `patchelf`, then `npm ci && npm run tauri build`. This list used to omit
`libssl-dev` and `build-essential`, so the one documented route a Linux user has did not work
when followed verbatim; `.github/workflows/ci.yml` installs exactly this set on every build,
which is the evidence it is the right one. (No reason is offered here for any individual
package. An earlier version of this sentence justified `libssl-dev` by saying the updater pulls
`reqwest` → `native-tls` → `openssl-sys`; the lockfile contains none of those last two, because
`reqwest` resolves to rustls. It is the webkit2gtk/libsoup side that wants OpenSSL headers, and
rather than replace one guess with another the list is now simply what CI proves builds.) The
tray needs an AppIndicator host — GNOME needs the AppIndicator extension; KDE, Xfce and
Cinnamon have one already.

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
design — the shelf is a **popover that rests in a corner of your screen** — bottom-right unless the Corner setting
says otherwise — just clear of the taskbar, not a window that sits open all day.

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
| **macOS** | wherever `defaults read com.apple.screencapture location` points **if that folder exists**, otherwise `~/Desktop` — ⌘⇧5 recordings land there too | ⌘⌃⇧4 |
| **Linux** | `~/Pictures/Screenshots` (GNOME, XDG portal) and `~/Pictures` (Spectacle, Flameshot), plus `~/Videos` and `~/Videos/Screencasts` | the clipboard watch applies here too |

A capture folder that does not exist yet is created, but only where its parent already does — so `Pictures\Screenshots` appears on a machine that has never taken a screenshot, and nothing is invented inside a OneDrive folder you do not have. Nothing is ever created *directly* in your home folder, so `~/Pictures` and `~/Videos` are watched only if they are already there — but `~/Pictures/Screenshots` and `~/Videos/Screencasts` are created when their parents exist, like the Windows entries. The macOS row is the exception to the whole paragraph: a configured screenshot location that is missing is not created, Shotshelf falls back to `~/Desktop` instead, and the dot's tooltip will name Desktop rather than the folder you set. The dot in the title strip turns green once it is watching, and its tooltip tells you how
many it's watching.

Take a screenshot. Within about a second the shelf appears with a thumbnail of it.

---

## Using the shelf

- **Drag out** — press a tile and move. The capture leaves as a real file you can drop into
  Explorer, Finder, an email, a chat box or an editor. It's a copy: the original stays put.
  The ghost under the cursor is card-sized — for a recording it shows the recording's own
  poster frame — never the capture at its full dimensions.
- **Copy** — for apps that take a paste but refuse a file drop. Images go on the clipboard as
  pixels, recordings as a file reference.
- **Show in folder** (the folder icon) — opens the capture's real file in Explorer / Finder /
  your file manager, selected where the OS supports it. The shelf holds a pointer to a real
  file, and this is the shortest path to that file when you need the thing itself — to attach
  it, rename a copy, or check what else landed beside it.
- **Pin** (the star) — pinned captures ignore the retention window and the item limit, and are
  the only ones kept **indefinitely** across a restart. A relaunch also brings back up to twenty
  *unpinned* captures from the previous 24 hours, which is a different thing — see
  Troubleshooting. A pinned tile keeps its star showing.
- **Remove** (the cross) — takes it off the shelf. **It never deletes the file.**
- **Pick several** — click one, then ctrl-click (⌘-click) others, or shift-click for a range.
  Dragging any one of them carries them all, oldest first.
- **Quick look** — press space to open the picked capture at readable size, and
  space or Esc to close it. A 199px card in a 225px panel is enough to recognise a screenshot and
  not enough to read one, which is the whole reason this exists.
- **Edit** — pick one *image* and a button appears (a recording has nothing to mark up, so it stays hidden, as it does while a preview or the editor is open) in the title strip. Five tools,
  and only five: **crop**, **box**, **arrow**, **number** and **redact**. Saving
  produces a new capture on the shelf; the one you marked up is untouched.
- **Compare** — pick exactly two *images* and a Compare button appears (two recordings show nothing: an `.mp4` cannot be decoded as a picture, and offering the button made it look broken) in the title strip. It puts them
  side by side with whatever changed outlined, as a single new capture you can drag out. The
  **older** capture is the "before", whichever order you picked them in — ctrl-clicking and
  shift-selecting produce different pick orders, so pick order is not one rule but two.

Pin, copy, show-in-folder and remove appear on a tile when you hover it; edit and compare live
in the title strip, because they act on what you have picked rather than on the tile under the
pointer.
- **Show/hide** — the tray icon, its right-click menu, or the global hotkey
  (`Ctrl+Shift+S` on Windows, `⌘⇧S` on macOS by default). The summoned view
  fits what it holds: one capture gets a one-capture window, two get two,
  and three at a time is the ceiling — past that the list scrolls. An empty
  shelf keeps the full window, because that is where it explains itself.

### From the keyboard

The shelf is summoned with a hotkey, so reaching for the mouse to act on what it
shows rather defeats the point.

| Key | What it does |
| :-- | :-- |
| `↑` `↓` | Move between captures, in the order they are shown — an open preview follows along |
| `Space` | Open the picked **image** at readable size, and close it again — a recording answers that it has no preview |
| `Enter` | Copy it to the clipboard, with a receipt in the strip |
| `Delete` or `Backspace` | Take the picked captures off the shelf — **the files stay on disk**, and `Ctrl+Z` brings the batch back |
| `e` | Mark the picked capture up |
| `t` | Copy the **text** in the picked image — recognised on your machine, straight onto the clipboard |
| `p` | Pin or unpin the picked captures |
| `o` | Show the picked capture's file in Explorer / Finder / your file manager |
| `Ctrl+Z` | Undo the last mark while marking up; bring back the last removal otherwise |
| `Esc` | Close the editor (twice if you have unsaved marks — the first press warns), then the preview, then the shelf |

Escape backs out one level at a time on purpose: one key that closes two things
at once is one key that loses your place. Every key that needs a pick says
"Pick a capture first" rather than doing nothing, clicking the space between
cards clears the pick, and a click on one card of a multi-pick collapses to
just that card. The title strip counts a live selection ("2 of 7 picked"), and
in a multi-pick the card the arrows move from carries an extra outer ring. The
same map is listed in the settings window's Shortcuts section, and each
control's tooltip names its key.

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
- **Recordings are never scanned**, and their cards say so with the same **?** — a screen
  recording of a terminal can carry exactly what the scanner looks for, and a card with no
  marker would be claiming a check that never ran.

Nothing about this leaves your machine — the checking happens locally, and the recognised text
never leaves Rust.

---

## Settings

The gear in the title strip — or **Settings…** in the tray icon's
right-click menu — opens the settings window: its own resizable
window, with a sidebar of five sections: **General**, **Capturing**,
**Appearance**, **Shortcuts** and **About**. There is no Save button because
there is nothing it would do: changes apply the moment you make them, in every
window at once, and the form says so when one is adjusted — pick a Max items
past 200 and the note reads "Max items was limited to 200" rather than
snapping back in silence. The hotkey is recorded rather than typed: click the
control, press the combination you want, Escape to cancel. Capturing shows
the folders *actually* being watched right now — the watch dot's diagnostic,
somewhere findable — and lets you edit the list: add any folder with the
OS's own picker, stop watching any folder (stock or added) with its ×, and
every change asks once, in the row, before anything is saved. Watching
starts the moment you confirm; stopping never touches files. **Restore
defaults** brings back the stock folders and keeps the ones you added —
it exists to recover a stock folder removed by mistake. About carries the
version, the update check, and links out (which open through a named
allowlist, never a raw URL).

| Setting | Where | What it does |
| :-- | :-- | :-- |
| **Start at login** | General | Registers Shotshelf as a login item so it is already watching at the day's first capture. Follows your account — turn it on once and each machine you log into registers itself at the next launch; turning it off unregisters the same way |
| **Keep for** | General | How long unpinned captures stay. Removing them never touches the files |
| **Max items** | General | How many unpinned captures the shelf holds |
| **Watched folders** | Capturing | Add any folder to the watch — it is watched with everything inside it, subfolders included, while the stock screenshot folders stay top-level. Stop watching any folder, stock or added. Additions apply live and roam with your account — a machine where the path doesn't exist just skips it, the way an absent OneDrive folder is skipped. One honest limit: the launch backfill looks only at each watched folder's top level, so a capture written *into a subfolder* while Shotshelf was not running is not brought back — anything written there while it runs is caught |
| **Keep clipboard captures** | Capturing | How long the app keeps its own copies of clipboard-only captures (Win+Shift+S / ⌘⌃⇧4) — the one place those exist. Forever by default; a limit lets old **unpinned** ones go, and pinned captures always stay. The only file deletion the app ever performs, and only on files it made itself |
| **Smaller copies** | Capturing | Hand over a copy no larger than 1568px on its long edge, instead of the original |
| **Theme** | Appearance | System, Light, Dark — or a named palette: Solarized (both halves), Nord, Dracula, Gruvbox Dark, Catppuccin Mocha. System follows the OS setting live; every palette holds the same contrast bars the stock two do |
| **Corner** | Appearance | Which screen corner the popover docks to — a 2×2 picker. A bottom corner grows the popped column upward; a top corner grows it downward |
| **Monitor** | Appearance | Which monitor carries that corner: the primary, or whichever one your cursor is on when the shelf appears |
| **Summon the shelf** | Shortcuts | The global show/hide shortcut, recorded from your keys |
| **Check at launch** | About | Whether Shotshelf asks GitHub Releases for a newer version once per launch |

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

If either settings file is ever unreadable, Shotshelf sets it aside as `<name>.corrupt` (then
`.corrupt.1`, up to 5) rather than overwriting it, and says so in the log. Both are
hand-repairable, and what losing one costs differs: `settings.json` holds your preferences,
while `pinned.json` holds the pins. A live `settings.json` never contains a capture path, by
construction — pins are blanked before it is written, which is the whole point of keeping the two
apart — but a `settings.json.corrupt` can, because it is a copy of the file *as it was*, and on an
install that predates the split that file still carried a `pinned` array. So delete the `.corrupt`
copies of both, in both locations, if you are removing Shotshelf's data: the preferences ones sit
in the roaming profile, which is the one place a capture path must never persist.

**On Linux, a shortcut can look registered without being.** The library behind it grabs keys
through X11 only, and its register call returns success even when the grab never happened — so
under Wayland without XWayland the settings window shows a live combination that does nothing, and
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

Deleting `edits`, `posters` and `handoff` costs you saved edits (comparisons are written there too), poster frames and sized copies you have not dragged out
yet. `clipboard` is the exception and the one to leave alone: Win+Shift+S and ⌘⌃⇧4 captures exist nowhere else, so deleting that folder destroys them. By default it grows forever; "Keep clipboard captures" in Settings → Capturing is the opt-in limit that lets old unpinned ones go. Everything else Shotshelf shows lives wherever the OS put it, and Shotshelf never moves or deletes it.

---

## Updates

Switch "Check at launch" off in the settings window's About section (it writes
`checkForUpdates` in the settings file) and Shotshelf makes no network request
at all — not even this one. "Check now", beside it, asks the same feed on
demand and answers in place.

On launch Shotshelf asks the project's GitHub Releases whether a newer version exists — one
fetch of a `latest.json` the release pipeline publishes. If one does, it says so once and does
nothing else — nothing is downloaded and nothing is replaced. Installing is your decision,
taken by fetching the installer yourself. If the feed is unreachable — you're offline, or no
release has published a manifest yet — it carries on silently.

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
- **Delete these as well, in both places** — any `*.corrupt` neighbours of those two files.
  Shotshelf keeps one whenever a settings file will not read, so it is repairable by hand rather
  than overwritten. A `pinned.json.corrupt` names captures by definition; a `settings.json.corrupt`
  can too, because it is the file *as it was*, and on an install predating the split it still
  carried a `pinned` array — and that one sits in the roaming profile.
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
| A message says a capture could not be saved | The capture was in the clipboard only — Win+Shift+S and ⌘⌃⇧4 write no file of their own — and Shotshelf could not write it. That copy is gone; the usual causes are a full disk or a profile it cannot write to. `shotshelf.log` records the underlying error. |
| The hotkey does nothing | Another app already owns that combination; change it in settings |
| Nothing appeared after a reboot | Shotshelf does not start itself — add it to your startup items. A launch brings back **up to 20** captures from the previous 24 hours, newest first, so the recent ones are still there |
| A recording shows a film glyph, not a frame | ffmpeg couldn't decode that file. The tile still drags out |
| A tile shows ⚠ | The capture could not be loaded. Usually it has been moved or deleted since it was caught — but the same mark appears for a file that will not decode, or one Shotshelf is no longer allowed to read, so check it is still where it was |
| The shelf is nowhere to be seen | It's a popover — click the tray/menu-bar icon, or press the hotkey |
| It closes while you're still using it | The appearance at launch, and a peek after a capture, both take themselves away. Start doing something — drag a capture, open one, open settings — and it stays; or press the hotkey to open it deliberately, which never self-closes |

Shotshelf writes diagnostics to `shotshelf.log` in its local app data directory —
`%LOCALAPPDATA%\com.mogginglabs.shotshelf\` on Windows,
`~/Library/Application Support/com.mogginglabs.shotshelf/` on macOS,
`~/.local/share/com.mogginglabs.shotshelf/` on Linux. Attach it to a bug report.

It used to say "run the installed binary from a terminal", which on Windows produces nothing at
all: a release build sets `windows_subsystem = "windows"` so the app has no console, and every
diagnostic went nowhere. The log holds the folders Shotshelf was asked to watch and capture *file names*
— never a capture's folder, a window title, or any recognised text — and it restarts itself once
it passes 512 KB.
