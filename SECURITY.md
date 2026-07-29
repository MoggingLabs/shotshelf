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
- Thumbnails, the capture index, and settings live **only** on the local device.
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

Every claim above is established by reading and testing the code: over a hundred Rust unit tests, a
front-end suite that drives the real UI in a real browser, and static analysis. **The packaged
application has never been launched.** The development build is unsigned, and Windows Smart App
Control refuses to execute it on the machine Shotshelf was written on; disabling that setting is
irreversible without reinstalling the OS, so it was not done.

What that leaves unverified, specifically:

- The asset-protocol scope, which is what confines every file Rust will read, copy, scan or hand
  to a drag. Its logic is checked against Tauri's implementation; it has never actually refused
  anything at runtime.
- **The catch engine** — the folder watchers and the clipboard watcher. This is the app's one
  job, and on Windows the clipboard path is how Win+Shift+S captures arrive.
- **Native drag-out**, which is the feature the whole thing exists for.
- **On-device text recognition**, which is FFI into `Windows.Media.Ocr` and macOS Vision, and
  which the credential warning depends on.
- **Reading the foreground window**, which is a Win32 `unsafe` block.
- Window chrome — DWM corner rounding, acrylic and vibrancy backdrops.
- The tray icon and menu, the global hotkey, and single-instance behaviour.
- The bundled ffmpeg sidecar as packaged.
- The update check against a real feed.
- **The Content Security Policy, and the IPC transport it governs.** No gate in this repository
  can exercise either: the browser suite runs against a hand-written stub of the Tauri runtime,
  which has no CSP and no real IPC. This is not a theoretical gap — a CSP missing `connect-src`
  would have made every annotated save fail, and it was caught by reading Tauri's source rather
  than by anything that runs. The `postMessage` fallback path, which encodes the source path in a
  request header, has never carried a byte at runtime.

Four more, named because the list above reads as though only Windows chrome is untested:

- **No installer has ever been built, on any machine.** The release workflow triggers on `v*` tags
  and there are none; CI runs `cargo build`, never `tauri build`. So the whole bundling path —
  `scripts/build-release.mjs`, sidecar packaging, NSIS/MSI/DMG generation, updater artifacts — has
  never executed anywhere. "The bundled ffmpeg sidecar *as packaged*" above implies a package
  exists; none does.
- **Window placement and sizing.** `window::place` reads the work area and scale factor off the
  primary monitor, and every resize is measured against it. Chrome is on the list above; the
  geometry deciding whether the shelf lands on screen at all was not.
- **The clipboard *write* path.** The watcher is listed; `copy_capture` writing image bytes or a
  file URI — the documented fallback for apps that refuse a drop — is equally unexercised.
- **Canvas CORS on the asset protocol.** The editor sets `crossOrigin = "anonymous"` so `toBlob`
  does not throw on a tainted canvas, which depends on Tauri's asset protocol sending an
  `Access-Control-Allow-Origin` header. If that ever fails the image does not merely taint the
  canvas, it fails to load — and the user is told the capture's file is gone when it is not.

And plainly, because the list is otherwise easy to read as Windows-specific: **no platform has run
this**. macOS's `defaults read` subprocess, the Accessory activation policy and the private-API
transparency are unverified, and the entire Linux target is compile-checked only.

One local-environment limit worth recording, because it shapes what can be checked here at all.
**Smart App Control refuses freshly linked executables on the development machine** (`os error
4551`) — the same policy that refuses the packaged app. It is not, as an earlier version of this
paragraph claimed, "any edit to `Cargo.toml`": a manifest edit that adds a dependency builds and
tests fine. What triggers it is a *newly linked binary* that the policy has not seen before, and
what gets relinked varies — a build script after a manifest change, the bin target's test
harness, `rustdoc`. Once a given binary has been accepted it keeps working until something
relinks it.

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
that seals the webview is written to allow nothing else. But that policy is itself on the list
above: it is verified by inspection, not by having ever been enforced. "It starts and works" is
not among the things this repository can currently demonstrate.

## Known advisories in dependencies

One open advisory, carried knowingly:

- **`glib` 0.18.5 — RUSTSEC unsoundness in the `Iterator` and `DoubleEndedIterator` impls for
  `VariantStrIter`** (moderate). Linux only: `glib` reaches this tree through GTK and WebKitGTK,
  which Tauri depends on for the Linux webview. It is not resolvable from here — `cargo update -p
  glib` reports 0.18.5 as the newest compatible release, and the fix is in 0.20, which arrives
  only when Tauri's GTK stack moves. Shotshelf does not use `VariantStrIter`, directly or
  transitively through any call it makes; the exposure is that the code is linked in, not that it
  is reached. It will clear when Tauri updates, and it is listed here rather than dismissed
  because "a dependency we cannot patch" is exactly the kind of thing that goes unrecorded and
  then unnoticed.

`npm audit` reports no vulnerabilities in the front-end tree.
