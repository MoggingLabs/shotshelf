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
   that does *not* mean: the packaged app has never been launched on any platform — see
   [SECURITY.md](./SECURITY.md#what-has-not-been-verified).
4. **Local-only, always.** No telemetry, no cloud, and exactly one network call: the launch-time
   update *check*, which installs nothing. The feed URL is built from the running version, the OS
   and the CPU architecture; the request also carries the updater's own `User-Agent` and, as any
   HTTPS request does, your IP. "And nothing else" used to end that sentence, which `SECURITY.md`
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
browser suites, then `cargo fmt --check`, `clippy -D warnings`, `cargo test --lib` and
`cargo build`. It needs a Rust toolchain and the Playwright browser above; without them it stops
rather than skipping quietly.

One difference, deliberate: CI runs `cargo test --all-targets`, which also covers anything under
`src-tauri/tests/`. There is nothing there yet, and `webview_path.rs` explains why an integration test could not be
landed (its prescription was retracted after being disproved) — and the local gate stays on `--lib` because Windows Smart App Control
refuses the bin target's freshly linked test harness on the machine this was written on. If you
add an integration test, CI will run it and your local gate will not; that is the one gap, and it
fails loudly in CI rather than silently anywhere.

### Pull requests

- Keep PRs focused — one concern per PR.
- Describe **what** changed and **why**, and **which OS** you tested on.
- Confirm you have not committed any captures or user data.

## Reporting bugs & requesting features

Open a [GitHub Issue](https://github.com/MoggingLabs/shotshelf/issues). Include repro steps, your OS
+ version, and — since this is a capture tool — describe the capture type (screenshot vs recording)
without attaching anything sensitive.
