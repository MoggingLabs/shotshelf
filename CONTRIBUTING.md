# Contributing to Shotshelf

Thanks for taking the time to contribute!

## Ground rules

1. **Never commit captures or user data.** No screenshots, recordings, thumbnails, or capture-index
   files. See [SECURITY.md](./SECURITY.md).
2. **Reuse before rewriting.** Shotshelf deliberately forks/adopts existing OSS for the hard parts
   (native drag-out, capture-folder watching) where a good option exists.
   Don't hand-roll what a maintained library already does.
3. **Keep both platforms working.** Every change is verified on **Windows and macOS**, or clearly
   flagged as platform-specific. Catch + drag-out are the two features that must never regress on
   either OS.
4. **Local-only, always.** No telemetry, no cloud, and exactly one network call: the launch-time
   update *check*, which sends nothing but the running version number and installs nothing. If a
   change would send a capture anywhere off the device, it doesn't belong here.
5. **Be kind.** See the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Workflow

```bash
# 1. Fork and clone
git clone git@github.com:<you>/shotshelf.git
cd shotshelf

# 2. Branch from main
git checkout -b feat/<short-description>

# 3. Make your change, test on BOTH platforms where possible

# 4. Commit with a clear message
git commit -m "add clipboard-image capture on Windows"

# 5. Push and open a PR against main
```

### Pull requests

- Keep PRs focused — one concern per PR.
- Describe **what** changed and **why**, and **which OS** you tested on.
- Confirm you have not committed any captures or user data.

## Reporting bugs & requesting features

Open a [GitHub Issue](https://github.com/MoggingLabs/shotshelf/issues). Include repro steps, your OS
+ version, and — since this is a capture tool — describe the capture type (screenshot vs recording)
without attaching anything sensitive.
