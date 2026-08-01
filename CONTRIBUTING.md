# Contributing to Shotshelf

Thanks for taking the time to contribute!

## Ground rules

1. **Never commit captures or user data.** No screenshots, recordings, thumbnails, or capture-index
   files. See [SECURITY.md](./SECURITY.md).
2. **Reuse before rewriting.** Shotshelf deliberately forks/adopts existing OSS for the hard parts
   (native drag-out, capture-folder watching) where a good option exists.
   Don't hand-roll what a maintained library already does.
3. **Keep all three platforms working.** Windows, macOS and Linux are built and gated in CI,
   and catch + drag-out are the two features that must never regress on any of them. Note what
   that does *not* mean: only Windows has ever run this, packaged or otherwise, and nothing is
   signed — see [SECURITY.md](./SECURITY.md#what-has-not-been-verified) and
   [PARITY](./docs/PARITY.md).
4. **Local-only, always.** No telemetry, no cloud, and exactly one network call: the launch-time
   update *check*, which installs nothing. It fetches a static `latest.json` from this repo's
   GitHub Releases — the version comparison is local, so the URL carries nothing about the
   machine; the request has the updater's own `User-Agent` and, as any HTTPS request does,
   your IP. "And nothing else" used to end that sentence, which `SECURITY.md`
   had already retracted in the same words. See `SECURITY.md` for the exact wording; if you change what that request contains, change that section in the same commit.
   If a change would send a capture anywhere off the device, it doesn't belong here.
5. **Be kind.** See the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Workflow

```bash
# 1. Fork and clone
git clone git@github.com:<you>/shotshelf.git
cd shotshelf

# 2. Branch from main
git checkout -b feat/<short-description>

# 3. Install dependencies, including the browser the gates drive
npm install
npx playwright install chromium

# 4. Make your change, test on every platform you can

# 5. Run every gate CI runs, before you push
npm run gate

# 6. Commit with a clear message
git commit -m "add clipboard-image capture on Windows"

# 7. Push and open a PR against main
```

`npm run gate` is the same set CI runs: lint, dead code, type-check and bundle, the unit and
browser suites, then `cargo fmt --check`, `clippy -D warnings`, `cargo test --lib --test ipc`
and `cargo build`. It needs a Rust toolchain and the Playwright browser above; without them it stops
rather than skipping quietly.

On Windows it also needs **`git` on the PATH** — `check-references.mjs` asks git which files the
repository has, so that it can skip anything git ignores. Installing Git for Windows without the
"add to PATH" option leaves `npm run deadcode` dying on a raw `spawnSync git ENOENT` rather than
saying so.

Two things are **not** in `npm run gate`, each for a reason worth knowing:

- **`npm run advisories`** compares the RUSTSEC set against `tests/fixtures/known-advisories.json`.
  It needs `cargo install cargo-audit --locked` and the network, and its answer changes with no
  commit at all, so it runs in `.github/workflows/audit.yml` weekly and on lockfile changes
  instead of blocking unrelated work.
- **The smoke checklist in [PARITY](./docs/PARITY.md)**, which is a human running the app for
  five minutes. Every step in it is something no gate here can reach — drag-out into another
  application most of all. Run it before anything that touches catching, rendering or the window.

One difference, deliberate: CI runs `cargo test --all-targets`, which also covers the bin
target's own test harness. The local gate names its targets instead — `--lib --test ipc` —
because Windows Smart App Control refuses a freshly linked bin test harness on one of the
development machines.

`src-tauri/tests/ipc.rs` is that integration test, and it is the only executable gate the IPC
tier has: it builds a real `App` with the real `invoke_handler` and sends real IPC requests
through it. Landing it needed the ComCtl32 v6 manifest `build.rs` embeds into test targets —
`webview_path.rs` carries the account, including two earlier explanations that were recorded as
fact and were both wrong. **If you add another integration test, add it to `gate:rust` too.** CI
will run it either way; your local gate will not.

### Pull requests

- Keep PRs focused — one concern per PR.
- Describe **what** changed and **why**, and **which OS** you tested on.
- Confirm you have not committed any captures or user data.

## Reporting bugs & requesting features

Open a [GitHub Issue](https://github.com/MoggingLabs/shotshelf/issues). Include repro steps, your OS
+ version, and — since this is a capture tool — describe the capture type (screenshot vs recording)
without attaching anything sensitive.
