<div align="center">

# 📸 Shotshelf

**The shelf that catches every capture.**
A cross-platform desktop shelf that automatically grabs every screenshot and screen recording you
take and keeps it one drag away — so you never dig through folders for the clip you just made.

![Windows](https://img.shields.io/badge/Windows-11-0078D6?style=for-the-badge&logo=windows&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-supported-000000?style=for-the-badge&logo=apple&logoColor=white)
[![License: MIT](https://img.shields.io/badge/License-MIT-6366f1?style=for-the-badge)](./LICENSE)

</div>

---

> **Status: early scaffold.** Cross-platform desktop app; the exact stack (Tauri vs Electron) and how
> much we fork vs build are being decided by prior-art research — see the Roadmap. Part of
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

1. **Catch engine** — watches the OS screenshot/recording save folders (Windows + macOS) and the
   clipboard, emits a "new capture" event.
2. **Shelf UI** — an always-on-top edge widget rendering recent captures as thumbnails (image + video
   frame).
3. **Drag-out** — native OS drag-and-drop of the underlying file into any other app (the crux; assessed
   per stack in research), with copy-to-clipboard as a fallback.

## 🧭 Reuse first (decided by research)

Per our standing rule, we don't rewrite what exists. The prior-art research (landing in
`prompts/RESEARCH.md`) is scoped to find a **forkable cross-platform "drop shelf"** and mature
libraries for the hard parts (native drag-out, capture-folder watching, clipboard image access) before
we write anything — and to pick **Tauri vs Electron** with reasoning.

## 🗺️ Roadmap

- [ ] **v0.0** research → adopt-vs-build + stack decision; scaffold the chosen shell
- [ ] **v0.1** catch engine + shelf UI (screenshots)
- [ ] **v0.2** native drag-out (the crux)
- [ ] **v0.3** screen recordings, settings/persistence, cross-platform parity, packaging

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
