# 07 · Cross-platform parity pass (Shotshelf)

## Goal
A verification-heavy pass to prove catch → thumbnail → drag-out behave **identically on Windows 11 and macOS**, document any per-OS shims, and fix divergences. No new features — this phase hardens what 02–06 built.

## Context + reuse
Everything the product needs exists by now: catch engine (02), shelf UI (03), drag-out crux (04), recordings (05), settings (06). RESEARCH.md flags the known per-OS seams: capture folder locations differ (Windows fixed set + OneDrive variant vs macOS `defaults read com.apple.screencapture location`), clipboard capture paths (Win+Shift+S vs ⌘⌃⇧4), minor drag-out timing differences, and ffmpeg sidecar binary naming. Reuse the already-adopted plugins/crates; this is glue-and-verify, not re-architecture.

## Deliverables
1. A written **parity matrix** in `docs/PARITY.md`: rows = capabilities (folder catch, clipboard catch, image thumb, video poster-frame, drag-out to file manager, drag-out to mail/editor, hotkey, edge/monitor persistence, retention/pin); columns = Windows / macOS; each cell = Pass/Fail + notes. Fill it by actually testing on both OSes.
2. Fix any divergence surfaced by the matrix so both columns pass (or the gap is explicitly, defensibly flagged).
3. Consolidate per-OS branches behind small, clearly-named platform shims (e.g. `capture_paths()`, `ffmpeg_bin()`, `default_hotkey()`), each with a comment citing the RESEARCH.md reason — no scattered `cfg!(windows)` checks throughout the UI.
4. A short **smoke checklist** (in `docs/PARITY.md`) a human can run in ~5 minutes per OS covering the full loop: capture → appears on shelf → drag into another app.
5. Note any capability that is intentionally OS-specific (e.g. an extra Windows OneDrive path) as a documented, deliberate difference — not a silent one.
6. `README.md` roadmap: check off cross-platform parity.

## Constraints
- **Local-only:** all verification uses local captures; nothing leaves the device; no telemetry added while instrumenting.
- **Both OSes required:** a capability isn't "done" until both columns are Pass or the gap is explicitly flagged with a reason.
- Reuse existing plugins/shims — fixing divergence must not fork the app into two codebases; prefer one path with thin platform shims.
- **Never commit captures;** the checklist uses the tester's own live captures + synthetic fixtures, none checked in.
- No new user-facing features in this phase — parity and hardening only.

## Done when (manual)
- `docs/PARITY.md` exists with every capability marked Pass on both Windows and macOS, or a Fail explicitly justified.
- Running the 5-minute smoke checklist on Windows and on macOS both complete the full capture→shelf→drag-out loop with no divergence in behavior.
- Any remaining OS-specific behavior is listed as deliberate, with the RESEARCH.md rationale.
Report the completed parity matrix and any shims added or divergences fixed.
