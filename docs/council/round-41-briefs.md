---
name: round-41-briefs
description: Ready-to-send briefs for the three Shotshelf council seats; paste as Agent prompts on resume
metadata: 
  node_type: memory
  type: reference
  originSessionId: 23456be3-e691-4590-a732-093ca9cbb716
  modified: 2026-07-31T17:15:15.388Z
---

Launch all three in one message, `subagent_type: general-purpose`, `model: opus`,
`isolation: "worktree"`. Substitute the current tip for `<TIP>` — as of writing
`6293d58`. See [[council-cycle-state]] and [[shotshelf-standing-constraints]].

## Shared preamble — put this at the top of every brief

> You are on a review council for **Shotshelf**, a local-only Tauri v2 capture
> shelf (Rust + vanilla TypeScript/Vite). This is round 41. Forty previous
> rounds each found real, shipped defects.
>
> **FIRST:** run `git log --oneline -1`. If it is not `<TIP>`, run
> `git fetch origin feat/enrich-and-edit && git reset --hard <TIP>`. Seats have
> twice silently reviewed a months-old tree. State in your report which commit
> you reviewed.
>
> Work only in your own worktree. Do not commit, do not push, do not modify the
> main checkout. Keep scratch files in your worktree; delete before reporting.
>
> Environment — **the checkout path is per-machine, so re-derive it rather than
> copying the line below**. On the second PC (2026-07-31 onwards) it is:
> `export PATH="$HOME/.cargo/bin:$PATH"` and
> `export CARGO_TARGET_DIR="C:/Users/pveloso01/Documents/projects/shotshelf/src-tauri/target"`
> The first machine's path was `C:/Users/pedro/Documents/GitHub/shotshelf/…`, and
> a seat exporting it here points every build at a directory that does not exist.
> The "disk runs near full" warning was also the first machine's; the second has
> ~418 GB free. What it does **not** have is a Rust toolchain or MSVC — see
> [[shotshelf-machine-two-environment]]; a seat cannot run a Rust gate until
> those are installed.
>
> Gates: `npm run lint`, `npm run deadcode`, `npm run build`,
> `npm run test:unit`, `npx playwright test tests/e2e`,
> `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`,
> `cargo test --manifest-path src-tauri/Cargo.toml --lib`.
>
> **Keep tool outputs small** — pipe through `| tail -30` or
> `| grep -E "test result|error|failed"`. Seats have died on oversized streams.
> One mutation at a time: edit, run only the gate covering that line, restore,
> record.
>
> Then paste the standing constraints and the known-accepted list from
> [[shotshelf-standing-constraints]] verbatim. A **false disclosure is a
> blocker** — two have already been proved false and closed.

## Ten commits are unreviewed

`3383676`, `f0d5491`, `e45e56c`, `faedd67`, `a65a4d9`, `20dd01a`, and the four
from the 2026-07-31 provisioning session: `2de96d8`, `8c80ded`, `3859db5`,
`6293d58`. The last tree an independent seat saw was `795ee6f`. Tell every seat
this.

Those last four are worth a seat's particular attention, because they were
written in one sitting and self-reviewed: a new rule in `check-references.mjs`
(does the glob matcher *weaken* the gate anywhere?), tests for two previously
untested modules, four workflow changes nothing has executed, and a large
rewrite of `SECURITY.md`'s evidence claims. The last of those is the highest
risk in the whole diff — it is prose about what has been verified, written by
the party that did the verifying, in a repository whose most persistent defect
is exactly that.

## Seat 1 — correctness and whether the gates bite

Lens: mutation testing, not reading. Break a production line so it still
compiles and type-checks, run the gate, restore. Gate green = real hole.

Attack in particular: `Appearance::deliberate` and the `window-events.json`
mapping; `catch::Backfill`; `src-tauri/src/enrich/scan.rs`'s `remembered`/`remember` and the
disclosure that the command *calling* them is uncovered; `dirs::under` and
`contained`; `documented.rs`; `quotesNumber`; the `INVOKERS` rule; the four new
e2e specs added in rounds 38–39.

Hunt tests that cannot fail: trivially-true assertions, a term deleted from a
selector without the spec failing, `clearCalls()` erasing evidence before an
assert, `page.clock.install()` advancing with real time so `runFor(N)` lands at
N + elapsed wall-clock, an assertion on `.shelf[data-mode]` when the decision
writes `#shelf-items[data-view]`.

## Seat 2 — architecture, duplication, dead code, testability

Verify rounds 38–40's fixes are *right*, not merely present: `src-tauri/src/enrich/scan.rs`
moved out of `share.rs`; the `invoke` boundary as a gate rather than two
differing headers; `dirs::under`'s containment rule.

Then sweep for: duplicated logic in either language; logic in a module that
cannot test it; dead code knip and clippy cannot see (trait impls, config never
read, CSS nothing matches, fixture keys nothing reads); state modelled so a
wrong combination is representable; layering violations; abstractions with one
caller and no second consumer.

**Judge the open `dom.ts` question** recorded in [[council-cycle-state]].

Evidence standard: a finding needs a concrete consequence — a defect this shape
already caused, or a specific change that would be silently wrong.

## Seat 3 — claims vs code

The most persistent defect across forty rounds is **prose outrunning code,
including corrections that introduce new false claims**. Audit all prose written
in `3383676`, `f0d5491`, `e45e56c`, `faedd67` and their commit messages line by
line, then sweep wider: docstrings, user-facing strings (true *in the state that
produces them*?), `README.md`, `docs/USAGE.md`, `SECURITY.md`,
`CONTRIBUTING.md`, and cross-language contracts still unjoined.

Demonstrate, do not assert.

## Report format for every seat

```
REVIEWED: <commit>
VERDICT: APPROVE | CHANGES REQUIRED
BLOCKERS (numbered; empty if none) — where, the mutation/evidence, the result,
  and the ROOT CAUSE (the structural fact that allowed it)
NON-BLOCKING OBSERVATIONS
WHAT I CHECKED AND FOUND SOUND
```

Unanimous APPROVE with zero blockers ends the cycle. Anything else starts
another round of root-cause fixes.
