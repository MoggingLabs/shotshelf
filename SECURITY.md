# Security & Privacy Policy

## Reporting an issue

If you find a security or privacy issue — especially anything that could **leak captures or user
data off the device** — please report it privately first. Open a
[GitHub Security Advisory](https://github.com/MoggingLabs/shotshelf/security/advisories/new) or
contact the maintainers directly rather than filing a public issue.

We aim to acknowledge reports within a few business days.

## Shotshelf is local-only by design

Screenshots and screen recordings routinely contain sensitive material — client data, credentials or
tokens visible on screen, private messages. Shotshelf's core privacy guarantee:

- **No cloud, no telemetry, no uploads.** Nothing a capture touches leaves the machine. Shotshelf
  makes exactly one network request in its life: on launch it asks an internal release feed whether
  a newer version exists. It does not download or install anything — it says an update is available
  and stops there.

  Precisely what that request discloses, because "nothing but its own version number" was written
  here and is not true. The endpoint is
  `https://releases.mogginglabs.internal/shotshelf/{{target}}/{{arch}}/{{current_version}}`, and the
  updater plugin substitutes the **operating system** and **CPU architecture** into the path
  alongside the version. It also sends a `tauri-plugin-updater/<version>` User-Agent, and — as any
  request does — reveals the machine's IP address to whatever serves that host. No capture, no
  filename, no path, no identifier of the machine or the person: those really are absent, and that
  is the guarantee worth stating. The rest is what an HTTP request costs, and this document is the
  wrong place to round it down.

  Turning the check off sends nothing at all and opens no socket. It is `checkForUpdates` in
  `settings.json` — a hand-edit, not a control in the Settings panel, which has four and does not
  include this one. Saying "in Settings" implied a switch that does not exist.
- Nothing Shotshelf stores leaves the machine by any route Shotshelf controls, and no capture
  and no path to one is ever written somewhere that syncs.

  Stated that way because the blunter version — "settings live **only** on the local
  device" — was not true and the difference is the whole reason for the two-file split.
  `settings.json` is in the **roaming** profile: on Windows `app_config_dir()` and
  `app_data_dir()` are the same directory, and a managed profile copies it to a network share
  at logoff. That is deliberate for a hotkey and an item cap, which should follow you between
  machines. It is why `pinned.json` — the only *settings* file naming captures — lives in
  `%LOCALAPPDATA%` instead, why `settings::persist` blanks `pinned` before writing, and why
  `scripts/check-dirs.mjs` and `src-tauri/clippy.toml` both refuse to let another module
  resolve a root for itself.

  There is also no "capture index" and there are no thumbnail files **for images**: those cards
  render from the capture itself through `convertFileSrc`. A recording cannot be drawn that
  way, so one poster frame per recording is written to the cache and the card renders that —
  which the next paragraph lists, and which this sentence used to contradict.

  Shotshelf writes picture data of its own in five places. Three are derived from your captures:
  video poster frames (`posters`), the downscaled copies made for hand-off while "Send smaller
  copies" is on (`handoff`), and saved edits and comparisons (`edits`). One is not derived at
  all — `video-drag-preview.png` is the bundled app icon written out verbatim. And one is not a
  copy of anything: `clipboard` holds captures caught off the clipboard, which exist nowhere
  else, which is why `dirs.rs` singles it out and why the uninstall notes flag it.

  All are on the local device and none roam. The first two are caches Shotshelf prunes; `edits`
  is your own work and is never pruned; `clipboard` is never pruned either, deliberately.

  This sentence has been wrong twice — first claiming poster frames were the only one, then
  claiming four after `README.md` had been corrected to five in the same commit. `docs/USAGE.md`
  holds the table both of these defer to.
- Any change that would introduce a network call touching captures is a privacy regression and will
  be rejected.

## Never belongs in this repo

This is a MoggingLabs repository. The following must **never** be committed:

- Real screenshots, screen recordings, or thumbnails
- Capture-index/database files or settings containing local file paths tied to a real machine
- Any signing keys or notarization credentials used to package builds

Fixtures for tests must be synthetic (a generated solid-color PNG, a 1-second black clip) — never a
real capture.

## What has not been verified

Stated plainly, because a security document that overstates its evidence is worse than one that
admits a gap.

Every claim above is established by reading and testing the code: 170 Rust unit tests, 133 Node
tests, a front-end suite of 171 specs that drives the real UI in a real browser, and static
analysis.

**On 2026-07-31 the application was run, for the first time, on Windows 11.** Every version of
this section before that date opened with "the packaged application has never been launched" and
closed with "no platform has run this", and both were true when written: the first development
machine had Windows Smart App Control **enforced**, which refuses an unsigned freshly linked
binary, and disabling it is irreversible without reinstalling the OS. Work moved to a second PC
whose Smart App Control is in **evaluation** mode, which observes rather than blocks. That is the
whole reason this list has shrunk — nothing about the code changed.

### Exercised at runtime — Windows 11, development build

Each of these was previously on the list below. They were driven against the real Rust binary,
the real webview and the real OS, with synthetic captures:

- **The catch engine.** Folder watchers resolved four candidate locations, skipped the absent
  OneDrive one by name, and watched the other three; a PNG written into `Pictures\Screenshots`
  and an MP4 written into `Videos\Captures` were both caught. The **clipboard watcher** caught an
  image placed on the clipboard and wrote it into `clipboard/` in local app data.
- **The asset-protocol scope**, in the affirmative direction: thumbnails rendered from disk, which
  is the runtime grant working. It still has never been observed *refusing* a path.
- **Native drag-out.** A press-and-move on a tile started a real OS drag with the drag preview
  under the cursor outside the window. The drag was cancelled rather than dropped, so the drop
  half — what the receiving application gets — remains unexercised.
- **On-device text recognition and the credential warning.** A capture containing
  `AKIAIOSFODNN7EXAMPLE` (Amazon's own documentation placeholder) was read by `Windows.Media.Ocr`
  and the card showed the warning marker. This is the FFI path and the feature that depends on it.
- **The Content Security Policy and the IPC transport it governs.** Not by a dedicated test, but
  by the app working at all. Nine of the seventeen registered commands were exercised — settings,
  the two catch commands, `describe_capture`, `video_details`, `copy_capture`, `prepare_drag`,
  `save_edit` and a window command — so the boundary carried real traffic under the real CSP, and
  `save_edit` carried PNG bytes across it. Not *every* command: `compare_captures`, the pinning
  and forget paths and the rest were not touched, and an earlier draft of this line said "every",
  which is the failure this document is most prone to.
- **Canvas CORS on the asset protocol.** An annotation was drawn and saved, producing
  `<name> (edited).png` in `edits/` and a new capture on the shelf carrying the annotation. A
  tainted canvas would have thrown in `toBlob`; a missing `Access-Control-Allow-Origin` would have
  failed the load outright. Neither happened.
- **The clipboard *write* path.** The copy control put a 1920×1080 image on the clipboard, and the
  watcher did **not** re-shelve it — the echo suppression working in the one place it matters.
- **Window placement and sizing**, and window chrome. The popover placed itself against the
  monitor's *work area* (1920×1032 of a 1920×1080 screen), took both documented shapes — a peeked
  column and the 225×420 browse view — and kept its bottom edge fixed as it grew, which is the
  corner anchoring. DWM corner rounding and the dark backdrop rendered.
- **The global hotkey.** `CommandOrControl+Shift+S` registered and toggled the shelf open and shut.
- **The bundled ffmpeg sidecar**, though not *as packaged*: the sidecar ran, extracted a poster
  frame, and the tile showed the frame with `0:06` and `14 kB`.
- **The update check against a real feed.** `releases.mogginglabs.internal` does not resolve, so
  what was verified is the failure path: it logged one warning and the app carried on.

### Still not verified

- **No installer has ever been built, on any machine.** The release workflow triggered on `v*`
  tags, of which there are none, and on manual dispatch, which had never been run; CI runs
  `cargo build`, never `tauri build`. A weekly schedule has since been added to `release.yml` so
  the bundling path stops being unexecuted code, but at the time of writing it has not yet fired.
  Everything above is the **development** build: the packaged app, its signing and its
  notarization remain untested.
- **The asset-protocol scope refusing a path.** Verified permitting, not denying — and denying is
  the half that confines what Rust will read.
- The **drop** half of drag-out, and what a receiving application actually gets.
- **Reading the foreground window**, which is a Win32 `unsafe` block.
- The **tray icon and menu**, and **single-instance** behaviour. Windows 11 puts a new tray icon
  in the overflow flyout, which `docs/USAGE.md` documents and which this run confirmed; the icon
  was never clicked, so the menu is unexercised.
- **Compare, quick look, multi-select, pinning, removal and the retention sweep.** All are covered
  by the browser suite against the stubbed runtime; none was driven against the real Rust binary.
- The `postMessage` IPC fallback path, which encodes the source path in a request header. The
  primary path carried bytes; this one is a different branch and has still never run.
- **macOS and Linux, entirely.** `defaults read`, the Accessory activation policy and the private
  transparency API are unverified, and Linux remains compile-checked only. One OS running is not
  three, and the per-OS code is behind `cfg` gates that only the matching host even compiles.

And plainly, because the section above is easy to read as more than it is: **one platform has run
this, once, unpackaged.** That is the difference between "no evidence" and "some evidence", not
between "some" and "enough".

One local-environment limit worth recording, because it shapes what can be checked and it differs
per machine. **Smart App Control refuses freshly linked executables** (`os error 4551`) — the same
policy that refuses the packaged app. It is not, as an earlier version of this paragraph claimed,
"any edit to `Cargo.toml`": a manifest edit that adds a dependency builds and tests fine. What
triggers it is a *newly linked binary* the policy has not seen before, and what gets relinked
varies — a build script after a manifest change, the bin target's test harness, `rustdoc`. Once a
given binary has been accepted it keeps working until something relinks it.

That is the **first** development machine, where the policy is enforced. The second has it in
evaluation mode, where it observes and does not block, which is why the app could be run there at
all. Evaluation is not a setting anyone chose and Windows may move it in either direction, so this
paragraph describes a property of a machine, not of the project — and the consequences below were
measured on the enforcing one.

That claim was wrong and it was load-bearing: it was given as the reason `tauri-plugin-log` could
not be adopted and the reason no autostart plugin could be added. Both were re-tested. Adding a
dependency works. The measured consequences are narrower and specific:

- `cargo test` cannot run doctests here (`rustdoc` is blocked) and cannot run the bin target's
  test harness after a relink — reproducibly, not intermittently: it stays refused across
  retries until something outside this repository changes. Neither matters for coverage, since
  this crate has no doctests and `main.rs` is a four-line shim, so `npm run gate:rust` runs
  `cargo test --lib` — every test there is. **CI runs `--all-targets` instead**, deliberately
  wider, so that an integration test under `src-tauri/tests/` would be run rather than silently
  skipped. That is the only place the local gate and CI differ, and it is stated in README and
  CONTRIBUTING as well as here.
- `tauri`'s `test` feature, which would let Rust tests construct an `App` and reach the command
  tier, could not be landed: three wirings all compiled and all died at load with
  `STATUS_ENTRYPOINT_NOT_FOUND`. **The cause is unidentified.** An earlier version of this bullet
  blamed the crate building as a `cdylib` and prescribed an integration test under
  `src-tauri/tests/` as the fix. Both were wrong and both were disproved by experiment: a `--lib`
  test binary is a standalone executable that never links the `cdylib`, and an integration test
  that merely names `shotshelf_lib::run` fails identically while one containing `2 + 2` passes.
  What distinguishes them is whether the linked object graph reaches the Tauri runtime — nothing
  about that is crate-shaped, so it is most likely local to this machine, the same policy estate
  that refuses the packaged app. `webview_path.rs` carries the full account. This bullet is what a
  reader of a security document sees first, and it repeated the retracted version for a round
  after the retraction.

None of these can leak a capture off the machine — the network surface is one URL, and the CSP
that seals the webview is written to allow nothing else *that it directs*. That qualifier is
load-bearing: the policy sets `default-src`, and `form-action` and `base-uri` do not fall back
to it, so a page that could inject markup could still aim a form somewhere. Nothing in the app
renders untrusted HTML, which is why this is a hardening gap rather than a hole. The policy has now
been enforced by a real webview rather than only inspected — the app ran under it — but "enforced
and nothing broke" is weaker evidence than "observed refusing something", and no gate in this
repository exercises it. "It starts and works" is a thing this repository can now demonstrate on
one OS, unpackaged; it is not yet a thing it can demonstrate on three, or from an installer.

## Known advisories in dependencies

**Zero vulnerabilities. Eighteen advisories**, all carried knowingly: one unsoundness and
seventeen unmaintained crates.

This section said "one open advisory" and named only the first of those, which was the
interesting one but not the whole answer — `cargo audit` reported eighteen the first time anyone
ran it here. The list now lives in `tests/fixtures/known-advisories.json` and
`scripts/check-advisories.mjs` holds `cargo audit` to it in both directions, so a new advisory
fails and a *cleared* one fails too. That second half matters: the glib entry below is documented
as "it will clear when Tauri updates", and until now nothing was watching for the day it did.
`.github/workflows/audit.yml` runs it weekly and whenever a lockfile moves.

- **`glib` 0.18.5 — RUSTSEC-2024-0429, unsoundness in the `Iterator` and `DoubleEndedIterator`
  impls for `VariantStrIter`** (moderate). Linux only: `glib` reaches this tree through GTK and
  WebKitGTK, which Tauri depends on for the Linux webview. It is not resolvable from here —
  `cargo update -p glib` reports 0.18.5 as the newest compatible release, and the fix is in 0.20,
  which arrives only when Tauri's GTK stack moves. Shotshelf does not use `VariantStrIter`,
  directly or transitively through any call it makes; the exposure is that the code is linked in,
  not that it is reached.
- **Seventeen unmaintained crates.** Ten are the gtk-rs GTK3 bindings (`gtk`, `gdk`, `atk` and
  their `-sys` companions), which are unmaintained upstream and arrive the same way `glib` does:
  Tauri's Linux webview, on the one platform of the three that has never been run. Two are
  build-time proc-macro helpers (`paste`, `proc-macro-error`) that are not in the shipped binary
  at all. Five are `unic-*` Unicode tables pulled in transitively. "Unmaintained" is a statement
  about a crate's future, not a defect in it — none has a known vulnerability, and none is
  removable from here.

Every one of these reaches the tree through Tauri and clears when Tauri's dependencies move, which
is what the weekly Dependabot run on the `cargo` ecosystem exists to notice.

`npm audit` reports no vulnerabilities in the front-end tree, production or development, so the
npm half of that workflow has no accepted list at all and fails on anything above `low`.
