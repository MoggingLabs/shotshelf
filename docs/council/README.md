# Council review state

These files are the working state of Shotshelf's review cycle. They normally
live in Claude Code's per-machine memory directory, **outside** the repo — which
means they do not survive a move to another machine. They are committed here so
they travel with the clone.

Committed 2026-07-31, when work moved to a second PC.

## The files

| File | What it holds |
| :-- | :-- |
| `council-cycle-state.md` | Where the cycle stands, why it stopped, what a resumed session must do first |
| `shotshelf-standing-constraints.md` | Invariants a seat must not propose breaking, and the limits already known and accepted |
| `round-41-briefs.md` | Ready-to-send briefs for the three round-41 seats |
| `MEMORY.md` | The index that lists the three above |

## Restoring them on a new machine

The repo's root `CLAUDE.md` points at this directory, so a session in this repo
will find them without any setup. To get them auto-loading as memory again,
copy them into that machine's memory directory:

```sh
# The slug is derived from the checkout path, so it differs per machine.
# Let a session create one memory first, then copy alongside it.
cp docs/council/*.md ~/.claude/projects/<slug>/memory/
```

Keep the copies in sync if the cycle advances — the repo copy is the one that
travels, but only the memory copy is loaded automatically.

## What does not travel

- **`src-tauri/target/`** — the warm 14 GB build cache is git-ignored and
  machine-local. The new machine pays one full Tauri build.
- **`src-tauri/binaries/`** — the ffmpeg sidecar (~80 MB/platform) is fetched by
  `scripts/prepare-sidecar.mjs`, which `npm install` runs via `postinstall`.
- **Playwright browsers** — `npx playwright install` fetches revision 1234.
