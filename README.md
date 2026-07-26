<div align="center">

# 📸 Shotshelf

**The shelf that catches every capture.**
A cross-platform desktop shelf that automatically grabs every screenshot and screen recording you
take and keeps it one drag away — so you never dig through folders for the clip you just made.

![Windows](https://img.shields.io/badge/Windows-11-0078D6?style=for-the-badge&logo=windows&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-supported-000000?style=for-the-badge&logo=apple&logoColor=white)
![Tauri](https://img.shields.io/badge/Tauri-v2-24C8DB?style=for-the-badge&logo=tauri&logoColor=white)
[![License: MIT](https://img.shields.io/badge/License-MIT-6366f1?style=for-the-badge)](./LICENSE)

</div>

---

> **Status: early scaffold.** Cross-platform desktop app. **Stack decided: Tauri v2** — prior-art
> research settled fork-vs-build (nothing forkable does cross-platform auto-catch, so we build) and
> confirmed the scary part, native drag-out, is a solved plugin. See `prompts/RESEARCH.md`. Part of
> [MoggingLabs Internals](https://github.com/MoggingLabs/mogginglabs-internals), in a new category:
> an **internal desktop utility** (not a platform driver like the `-wire` tools).

## 🎯 The problem

We screen-record and screenshot our cloud/AI systems all day — for the editor, for client demos, and
now for the Closewire/Highwire build-validation loops. Right after a capture you can grab it; four
seconds later it's buried in a folder of a hundred near-identical files. Shotshelf fixes the workflow
instead of fixing our filing habits.

## ✨ What it does

- **Catches** every new screenshot and screen recording automatically (watches the OS capture
  locations + clipboard).
- **Holds** them on an always-on-top shelf pinned to a screen edge, newest first, as thumbnails.
- **Drags out** — grab an item off the shelf and drop it straight into an email, editor, or chat. No
  Finder/Explorer spelunking, no 4-second window.

One job, done well. No accounts, no cloud, no 15 settings.

## 🧱 How it works (target)

1. **Catch engine** — watches the OS screenshot/recording save folders (Windows + macOS) with the Rust
   [`notify`](https://github.com/notify-rs/notify) crate, plus a clipboard watch
   (`tauri-plugin-clipboard`) for clipboard-only captures (Win+Shift+S / ⌘⌃⇧4). Emits a "new capture" event.
2. **Shelf UI** — an always-on-top, frameless edge widget rendering recent captures as thumbnails
   (images directly; a bundled **ffmpeg** poster-frame for recordings).
3. **Drag-out** — native OS drag-and-drop of the underlying file into any other app via
   [`tauri-plugin-drag`](https://github.com/crabnebula-dev/drag-rs) (the crux — a solved, maintained
   plugin covering Windows + macOS), with copy-to-clipboard as a fallback.

## 🧭 Reuse first (settled by research)

Per our standing rule, we don't rewrite what exists. Research found **no forkable cross-platform shelf
that auto-catches screenshots** — every one that does (Dropover, FlowShelf) is closed-source macOS-only,
which is exactly our opening. So we **build the combination**, but **adopt** the hard parts:
`tauri-plugin-drag`/`drag-rs` (drag-out), `notify` + `tauri-plugin-clipboard` (capture detection), and
bundled ffmpeg (video thumbnails). We **interoperate** with ShareX rather than fork it (watch its output
folder). Full detail in `prompts/RESEARCH.md`.

## 🗺️ Roadmap

- [x] **v0.0** research → **build in Tauri v2**; adopt `drag-rs` + `notify` + `tauri-plugin-clipboard`
- [ ] **v0.1** Tauri shell + catch engine + shelf UI (screenshots)
- [ ] **v0.2** native drag-out (the crux) via `tauri-plugin-drag`
- [ ] **v0.3** screen recordings (ffmpeg thumbs), settings/persistence, cross-platform parity, packaging

## 🔐 Privacy — captures never leave your machine

Screenshots and recordings routinely contain sensitive material (client data, tokens on screen).
Shotshelf is **local-only**: no cloud, no telemetry, no upload. Thumbnails and any index stay on the
device. See [SECURITY.md](./SECURITY.md). This repo never contains real captures.

## ⚖️ Internal use

Shotshelf is an internal MoggingLabs utility (not a product). MIT, no warranty.

## 🤝 Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Reuse before rewriting; keep both platforms working; never
commit captures or user data.

## 📄 License

[MIT](./LICENSE) © MoggingLabs.

<div align="center"><sub>Part of <a href="https://github.com/MoggingLabs/mogginglabs-internals">MoggingLabs Internals</a> · catch every shot 📸</sub></div>
