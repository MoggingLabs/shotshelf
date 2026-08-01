# Shotshelf

Local-only Tauri v2 capture shelf — Rust + vanilla TypeScript/Vite. It watches
the OS screenshot/recording folders, shelves what lands there, and drags the
real file back out into other apps.

## Read this first

- **`docs/council/shotshelf-standing-constraints.md`** — invariants that must
  not be broken, plus the limits already known and accepted. Read before
  proposing any work.
- **`docs/DESIGN.md`** — the design system: type scale, spacing grid, palette,
  radii, motion, and the hierarchy rules the UI is built on. A visual change
  that invents a new value belongs on the scale or in that document first.
- **`docs/PARITY.md`** — what has actually been observed working, per OS, and
  the five-minute smoke checklist.

**The council review cycle is retired** (owner decision, 2026-08-01). The rest
of `docs/council/` — the cycle state and the round-41 briefs — is kept as
history, not as instructions; no session should launch seats or treat
"unanimous APPROVE" as a merge gate. What survives from it is the constraints
file above and the working habits the cycle proved out: run the gate rather
than trusting prose about it, mutate a guard before believing its test, and
treat a claim about the world that was inferred from a config file as unchecked.

## Gates

`npm run gate` runs everything. Individually:

| Command | Covers |
| :-- | :-- |
| `npm run lint` | eslint |
| `npm run deadcode` | knip + `check-commands`, `check-references`, `check-dirs`, `check-wire` |
| `npm run build` | `tsc --noEmit` + vite build |
| `npm run test:unit` | `node --test` over `src/**/*.test.ts` and `scripts/**/*.test.mjs` |
| `npm run test:e2e` | Playwright, `tests/e2e` |
| `npm run gate:rust` | `cargo fmt --check`, `clippy -D warnings`, `cargo test --lib --test ipc`, `cargo build` |

Out of the gate, deliberately: `npm run advisories` (needs cargo-audit and the
network; runs in `.github/workflows/audit.yml`) and the smoke checklist in
`docs/PARITY.md` (needs a human and a desktop).

## Setup on a fresh machine

```sh
npm install            # postinstall fetches the ffmpeg sidecar
npx playwright install # browser revision 1234
```

`src-tauri/target/` and `src-tauri/binaries/` are git-ignored and machine-local;
the first Rust gate on a new machine is a full build.

## Repo

Public again as of 2026-08-01 (owner decision, to restore free CI after an
Actions billing stop). It was private from 2026-07-31 so `prompts/` and
`docs/council/` could be committed; the owner chose to keep both tracked and
publish anyway — they are methodology, not secrets, and the tree was scanned
for credential-shaped strings before the flip (only documented placeholders and
the secret-detector's own fixtures). The `.gitignore` note records the history.
