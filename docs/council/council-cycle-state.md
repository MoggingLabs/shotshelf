---
name: council-cycle-state
description: "Where the Shotshelf council review cycle stands, and what a resumed session must do first"
metadata: 
  node_type: memory
  type: project
  originSessionId: 23456be3-e691-4590-a732-093ca9cbb716
  modified: 2026-07-31T17:15:09.903Z
---

The `/goal` for Shotshelf requires a council of Opus 5 seats (senior engineer,
architect, solutions architect) to reach **unanimous APPROVE with zero
blockers**. As of 2026-07-30 that has **not** been reached.

**Current tip:** `6293d58` on `feat/enrich-and-edit`. Use this as `<TIP>`. The
four commits on top of `20dd01a` are the 2026-07-31 provisioning session and are
themselves unreviewed.

(The last commit an *independent seat* saw was `795ee6f`; everything after it is
unreviewed — `3383676`, `f0d5491`, `e45e56c`, `faedd67`, plus `a65a4d9`,
`20dd01a` and the four below.)

**Status:** every blocker from rounds 26–38 is fixed at the source and
mutation-proven. **No seat has ever returned APPROVE** — rounds 35–38 each
returned CHANGES REQUIRED, and each found real defects in the previous round's
fixes.

**The gate is green — but it was not, and this file said it was.** From
`a65a4d9` (the handoff commit) until `2de96d8`, `npm run deadcode` had been
**failing**: four backticked references in `CLAUDE.md` and `docs/council/` did
not resolve. Three of them were the gate's fault — it could not resolve a glob,
so every pattern anyone wrote in backticks was reported as naming nothing — and
one was a genuinely stale reference. **A seat must run the gate rather than
believing this paragraph.**

**Why CI did not catch it, corrected.** The provisioning session first wrote
that CI "fired only on pushes to `main` and on pull requests, and this branch is
109 commits with neither", and put that claim in a workflow comment, the README
and a commit message before checking it. Pull request #14 has been open since
2026-07-28 and CI ran on it throughout. The real reason is a **GitHub Actions
billing stop**: every run since 2026-07-31 ends in seconds with "the job was not
started because recent account payments have failed or your spending limit needs
to be increased". Nothing in this repository can fix that.

**CI is also red on Linux, and was before any of this.** The 2026-07-30 run —
the last one that actually executed — had Windows and macOS green and Linux
failing on pixel goldens: `column-one.png` and `column-three.png` differ by 979
pixels. The goldens are stale against a UI change and can only be regenerated on
Linux, by the **Appearance goldens** workflow, which the same billing stop
prevents from running.

Counts as of `6293d58`: 140 Node unit, 171 Playwright, 170 Rust, plus lint,
knip, four scripts, tsc, clippy, fmt, build. The Node and Rust numbers moved
because two modules had no test at all — `src-tauri/src/imaging/mod.rs`, which
holds the decode caps `compare.rs` cites as the reason its arithmetic cannot
overflow, and `src/retry.ts`.

**2026-07-31, and it changes what round 41 is for:** the app has now been **run**,
on Windows 11, for the first time on any platform. Roughly half of
`SECURITY.md`'s "what has not been verified" list moved to verified, including
the OCR FFI, the credential warning, the asset-protocol scope permitting, canvas
CORS, the clipboard write and a native drag starting. `docs/PARITY.md` is the
new matrix. Seats should treat prose about "never been launched" as a defect
now, and prose upgrading one unpackaged run on one OS into "verified" as the
same defect facing the other way.

**Why it stopped:** the session's subagent budget was exhausted (200/200), so
rounds 39 and 40 were self-reviews rather than independent seats.

**Machine handoff (2026-07-31).** Work is moving to another PC. The repo was
made **private** and this state was committed to `docs/council/` so it travels
with the clone — these memory files live outside the repo and would otherwise
be lost. On the new machine, copy `docs/council/*.md` into that machine's
`~/.claude/projects/<slug>/memory/` to restore auto-loading; the repo's root
`CLAUDE.md` points at them meanwhile. Local caches were pruned the same day
(stale Playwright browsers, cargo `incremental/`, 6 worktrees, 28 orphan
branches); the warm 14 GB `target/debug/deps` was kept deliberately, but it does
**not** travel — the new machine pays one full Tauri build.

**A resumed session must, in order:**

1. Launch three independent Opus 5 seats against the current tip with the
   lenses that have been productive: *correctness / do the gates bite*,
   *architecture / duplication / dead code*, *claims vs code*.
2. Tell each seat to verify `git log --oneline -1` first — seats have twice
   silently reviewed a months-old tree.
3. Warn seats to keep tool outputs small and mutate one line at a time; several
   died on oversized streams.

**Do not trust a self-review here.** In round 40, 4 of 15 of my own probes were
invalid — one mutated a *comment* containing `mode: "copy"` and reported the
product's central copy-never-move constraint as unguarded. Independent seats
have repeatedly caught false claims that my own audits passed over.

**The recurring defect classes**, which every brief should name: tests that
cannot fail; prose outrunning code, *including corrections that introduce new
false claims*; rules written as lists of spellings rather than as resolved
values; and decisions left on the untestable side of the IPC boundary (no Rust
test can build an `AppHandle`, and no browser spec runs a real
`#[tauri::command]`).

**Probe by coverage census, not by recency.** Mutating what the last round
touched found nothing; censusing which modules have *no test at all* found
`dirs::under` joining a caller-supplied name to a data root with no containment
rule, in the module that owns the roaming-profile promise. Fixed in `faedd67`.

**One candidate finding left for a seat to judge, deliberately not acted on:**
`src/dom.ts` draws a distinction between `el` (throws) and `maybeEl` (returns
null) and spends a paragraph justifying it — but `maybeEl`'s only callers are
`status.ts`'s four lookups of `#shelf-alert` and `#shelf-mark`, and both ship in
`index.html`, so the null branch is unreachable. `el`'s own docstring argues
against exactly this: "failing at start-up with the selector in the message
beats every call site downstream guarding against a `null` that cannot happen."
Two readings — defensible defence-in-depth, or an abstraction whose
distinguishing behaviour no live path exercises. Changing it alters behaviour on
a path no test can reach, so it wants an independent judgement rather than mine.

See [[shotshelf-standing-constraints]] for the invariants seats must not
propose breaking.
