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

- **No cloud, no telemetry, no uploads.** Nothing a capture touches leaves the machine.
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
