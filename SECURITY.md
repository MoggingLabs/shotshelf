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
  a newer version exists, sending nothing but its own version number. It does not download or
  install anything — it says an update is available and stops there.
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

Every claim above is established by reading and testing the code: 80-odd Rust unit tests, a
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
