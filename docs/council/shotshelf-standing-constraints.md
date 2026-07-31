---
name: shotshelf-standing-constraints
description: "Shotshelf invariants that must never be broken, and the limits already known and accepted"
metadata: 
  node_type: memory
  type: project
  originSessionId: 23456be3-e691-4590-a732-093ca9cbb716
  modified: 2026-07-31T17:13:28.283Z
---

Invariants for Shotshelf. A change that breaks one of these is a blocker, and a
council seat must not propose one as a fix.

- **Local-only.** No network, telemetry or cloud. The *only* network call is the
  update check, and switching it off opens no socket at all.
- Never commit captures, user data, signing keys, certs or notarization creds.
  Secrets come from env/CI only.
- **`prompts/` is now tracked, deliberately** (2026-07-31). It was git-ignored
  under a "never shipped" rule; the owner chose to commit it so the build
  prompts and `RESEARCH.md` survive a move to another machine. This was safe
  only because the repo was made **private** in the same change — it is no
  longer public. A seat must not report tracked `prompts/` as a violation, and
  must not propose making the repo public again.
- **Drag-out is a copy, never a move.**
- Remove / retention / expiry are **shelf-only** and must never delete, move or
  modify a capture file.
- No capture path may reach the roaming profile (`%APPDATA%`).
- All three OSes must work; a per-OS branch wrong on one of them is a blocker.
- Reuse adopted crates/plugins rather than hand-rolling.
- macOS Screen Recording permission is documented as NOT required and must
  stay that way.

**Known and accepted — a seat reporting these is wasting a round:** Windows
Smart App Control blocks the unsigned dev binary; Linux drag `text/uri-list` is
not percent-encoded (upstream `drag` crate); Linux global shortcuts can report
success without the OS taking them, and `tray-icon`'s GTK constructor cannot
fail; Wayland ignores window positioning; Linux watches `~/Pictures` and
`~/Videos` broadly; the macOS clipboard URI is `file://` + raw path; the release
workflow uploads artifacts rather than creating a Release; Windows Authenticode
needs a cert already in the machine store; no browser spec executes a real
`#[tauri::command]`; the IPC tier has no executable gate.

**A disclosed limit is not a finding — but a *false* disclosure is a blocker.**
Two disclosures have already been proved false and closed: `show_shelf`'s
claim about which mutation survives, and `showProblem`'s claim that its
`#showing` term could not be gated. Check the remaining ones rather than
accepting them.

See [[council-cycle-state]] for where the review cycle stands.
