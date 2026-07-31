# 08 · Package & distribute (Shotshelf)

## Goal
Ship installable, signed builds for internal use: a Windows `.msi`/`.exe` and a macOS `.dmg`, with ffmpeg bundled, a built-in updater wired for internal distribution, and a `docs/USAGE.md` install/use guide.

## Context + reuse
The app is feature-complete and parity-verified (01–07). Use Tauri v2's built-in bundler (`tauri build`) and `tauri-plugin-updater` — small signed installers with an updater are a stated Tauri advantage (RESEARCH.md). The ffmpeg sidecar from 05 must be declared so it's included in both bundles. This is internal MoggingLabs tooling (MIT, no warranty) — the updater points at an internal release location, not a public store.

## Deliverables
1. `tauri.conf.json` bundle config for both targets: Windows (`msi` + optional `nsis`/exe) and macOS (`dmg`), with app name, identifier, icons, and version. Confirm the ffmpeg `externalBin` sidecar is bundled on both.
2. **Code signing:** Windows Authenticode signing hook and macOS signing + notarization steps wired via env-provided certs/identities (never hard-code or commit secrets). Document exactly which env vars/secrets a signer must provide.
3. **Built-in updater:** `tauri-plugin-updater` configured against an internal update endpoint/manifest (e.g. a private release feed), with the update public key in config and the signing key kept out of the repo. App checks for updates on launch and can update in place.
4. `docs/USAGE.md`: install steps per OS, first-run notes (granting macOS screen-recording/accessibility permissions if needed; where captures are watched), how to change edge/hotkey/retention, and how updates are delivered.
5. A build script or documented commands producing the signed artifacts on each OS. `README.md` roadmap: check off packaging → v0.3.

## Constraints
- **Local-only app:** the only network use is the **update check** against the internal feed — no telemetry, no capture data ever transmitted; say so explicitly in `docs/USAGE.md`.
- **Both OSes:** produce and document a working installer for Windows AND macOS; flag per-OS signing/notarization differences.
- Reuse Tauri's bundler + `tauri-plugin-updater` — do not hand-roll installers or an update mechanism.
- **Never commit signing keys, certs, notarization creds, or captures.** Secrets come from env/CI only; keep `prompts/` and any keys git-ignored.
- Bundle the ffmpeg binary that matches each target; no runtime downloads.

## Done when (manual)
- `tauri build` on Windows yields a signed `.msi`/`.exe` that installs and launches; SmartScreen doesn't flag it as unsigned.
- `tauri build` on macOS yields a signed, notarized `.dmg` that installs and launches without Gatekeeper blocking it.
- Both installed builds catch a capture and drag it out (ffmpeg poster-frames work → sidecar bundled correctly).
- Publishing a higher version to the internal feed makes an installed app detect and apply the update on next launch.
- `docs/USAGE.md` walks a teammate from download to first drag-out on their OS.
Report the artifact paths, the signing env vars required, and the updater endpoint shape.
