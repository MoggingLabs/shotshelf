# Shotshelf

Local-only Tauri v2 capture shelf — Rust + vanilla TypeScript/Vite. It watches
the OS screenshot/recording folders, shelves what lands there, and drags the
real file back out into other apps.

## Read this first

`docs/council/` holds the live state of the review cycle:

- **`council-cycle-state.md`** — where the cycle stands and what a resumed
  session must do first. Read before proposing any work.
- **`shotshelf-standing-constraints.md`** — invariants that must not be broken,
  plus the limits already known and accepted. A finding that reports one of the
  accepted limits wastes a round.
- **`round-41-briefs.md`** — ready-to-send briefs for the next three seats.

The cycle's goal is a council of three independent seats returning unanimous
APPROVE with zero blockers. That has not been reached.

## Gates

`npm run gate` runs everything. Individually:

| Command | Covers |
| :-- | :-- |
| `npm run lint` | eslint |
| `npm run deadcode` | knip + `check-commands`, `check-references`, `check-dirs`, `check-wire` |
| `npm run build` | `tsc --noEmit` + vite build |
| `npm run test:unit` | `node --test` over `src/**/*.test.ts` and `scripts/**/*.test.mjs` |
| `npm run test:e2e` | Playwright, `tests/e2e` |
| `npm run gate:rust` | `cargo fmt --check`, `clippy -D warnings`, `cargo test --lib`, `cargo build` |

## Setup on a fresh machine

```sh
npm install            # postinstall fetches the ffmpeg sidecar
npx playwright install # browser revision 1234
```

`src-tauri/target/` and `src-tauri/binaries/` are git-ignored and machine-local;
the first Rust gate on a new machine is a full build.

## Repo

Private. It was public until 2026-07-31 and was made private so the council
state and `prompts/` could be committed — see the note in `.gitignore`. Do not
make it public again without revisiting what is now tracked.
