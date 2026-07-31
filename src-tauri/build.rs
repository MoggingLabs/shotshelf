fn main() {
    // Test binaries need the manifest the app binary gets for free.
    //
    // Anything here that links the Tauri runtime imports `TaskDialogIndirect`,
    // `RemoveWindowSubclass` and `DefSubclassProc` from ComCtl32. Those are
    // **v6** exports; `C:\Windows\System32\comctl32.dll` is v5.82 and has none
    // of them, and v6 is reachable only through a side-by-side manifest.
    // `tauri_build::build()` below embeds one in the app binary. Nothing
    // embeds one in a `cargo test` binary, so every test that reached the
    // runtime died at load with STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139).
    //
    // That failure was recorded in `webview_path.rs` as "most likely local to
    // this machine, the same policy estate that refuses the packaged app". It
    // is not: it reproduces on a second machine with different policy state,
    // and `dumpbin /imports` names the three missing exports outright.
    //
    // `rustc-link-arg-tests` applies to test targets only, so the app binary
    // keeps the manifest `tauri_build` gives it and nothing here can conflict
    // with that one.
    #[cfg(target_os = "windows")]
    {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("common-controls-v6.manifest");
        println!("cargo::rerun-if-changed={}", manifest.display());
        println!("cargo::rustc-link-arg-tests=/MANIFEST:EMBED");
        println!(
            "cargo::rustc-link-arg-tests=/MANIFESTINPUT:{}",
            manifest.display()
        );
    }

    tauri_build::build()
}
