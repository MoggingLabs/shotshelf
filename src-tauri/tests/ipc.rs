//! The IPC tier, executed.
//!
//! Every other gate in this repository stops at this boundary.
//! `check-commands.mjs` proves each registered command has a caller and each
//! invoked name is registered — a check on *spellings*. `check-wire.mjs` and the
//! fixtures join the field names. But no Rust unit test could construct an
//! `AppHandle`, and `tests/harness/tauri-mock.ts` replaces
//! `window.__TAURI_INTERNALS__` wholesale, so no browser spec has ever executed
//! a `#[tauri::command]`. The tier carrying every decision between the two
//! languages had no executable gate at all.
//!
//! It has one now. `tauri::test::mock_builder` builds a real `App` with a real
//! `invoke_handler`, and `get_ipc_response` sends a real IPC request through it.
//!
//! **Why this could not be landed before.** Any test binary that links the Tauri
//! runtime died at load with `STATUS_ENTRYPOINT_NOT_FOUND` (0xc0000139), and
//! `webview_path.rs` recorded that as unexplained and "most likely local to this
//! machine". It was neither. The runtime imports `TaskDialogIndirect`,
//! `RemoveWindowSubclass` and `DefSubclassProc`, which exist only in ComCtl32
//! **v6**; the copy in System32 is v5.82 and exports none of them. `tauri-build`
//! embeds a side-by-side manifest in the app binary, and nothing embedded one in
//! a test binary. `build.rs` now does, for test targets only.
//!
//! Under `tests/` rather than in the crate, because it has to be. Cargo's
//! `rustc-link-arg-tests` reaches integration-test targets and **not** the lib's
//! own unittest harness, and the flag cannot go on the binary instead —
//! `tauri-build` already embeds a manifest resource there and a second one is
//! `CVT1100: duplicate resource`. That is the whole reason `settings` is `pub`.

use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// An app with the real command handler, its state, and one webview to ask from.
///
/// The window is built once and handed back with the app. Building it per call
/// fails on the second — `WebviewLabelAlreadyExists` — which is the sort of
/// thing that turns a test into a flake that only appears when someone adds a
/// second assertion.
fn app() -> (
    tauri::App<tauri::test::MockRuntime>,
    tauri::WebviewWindow<tauri::test::MockRuntime>,
) {
    let app = mock_builder()
        // The app's own list, not a copy. A second `generate_handler!` here
        // would let this file pass while `lib.rs` registered something else —
        // the test asserting against its own idea of the app.
        .invoke_handler(shotshelf_lib::commands::handler())
        .build(tauri::generate_context!())
        .expect("the mock app builds");

    // `lib.rs` manages this in `setup`. Without it the command would be testing
    // the absence of its own state.
    //
    // Real paths, in a directory of this test's own. `load_from(None, None)`
    // was the first attempt and it made the whole thing vacuous: with nowhere
    // to write, `set_settings` failed at `persist` and returned `Err`, the
    // store kept its defaults, and an assertion that the item cap was under the
    // ceiling passed because the cap was still 50 and the command had never
    // run. Never the user's real settings file — that is what the process id
    // in the name is for.
    let scratch = std::env::temp_dir().join(format!("shotshelf-ipc-{}", std::process::id()));
    std::fs::create_dir_all(&scratch).expect("the scratch directory is created");
    app.manage(shotshelf_lib::settings::load_from(
        Some(scratch.join("settings.json")),
        Some(scratch.join("pinned.json")),
    ));

    let window = WebviewWindowBuilder::new(&app, "ipc-gate", WebviewUrl::default())
        .build()
        .expect("the mock webview builds");
    (app, window)
}

/// Send a real IPC request through the real handler.
fn invoke(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    get_ipc_response(
        window,
        InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "http://tauri.localhost".parse().expect("a valid url"),
            body: body.into(),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|value| {
        value
            .deserialize::<serde_json::Value>()
            .expect("the reply is json")
    })
    .map_err(|error| format!("{error:?}"))
}

#[test]
fn get_settings_answers_across_the_real_ipc_boundary() {
    // Not about the values — `settings.rs` covers those. About the things only
    // this path can show: that the command is reachable under its registered
    // name, that its `tauri::State` argument resolves, and that what comes back
    // carries the *wire* names the front end destructures.
    let (_app, window) = app();
    let settings = invoke(&window, "get_settings", serde_json::json!({}))
        .expect("get_settings answers rather than erroring");

    // The rename is the point. Rust writes `max_items`; `settings.ts` reads
    // `maxItems`. `check-wire.mjs` compares both against a fixture, which is a
    // join between two declarations — this is the first thing to observe the
    // serializer actually doing it.
    for wire_name in ["maxItems", "retentionHours", "hotkey", "checkForUpdates"] {
        assert!(
            settings.get(wire_name).is_some(),
            "the wire name the front end reads is missing: {wire_name} in {settings}",
        );
    }
}

#[test]
fn an_unregistered_command_is_refused() {
    // Without this the test above could pass against a harness that answered
    // anything at all, which is the shape of a test that cannot fail.
    let (_app, window) = app();
    assert!(
        invoke(&window, "no_such_command", serde_json::json!({})).is_err(),
        "an unregistered command was answered rather than refused",
    );
}

#[test]
fn the_item_cap_is_clamped_by_the_command_and_not_merely_by_the_helper() {
    // `sanitise` is unit-tested directly. What no test could reach is whether
    // the *command* applies it: a `set_settings` that stored its argument
    // verbatim would leave every existing test in this crate green, because
    // every one of them calls `sanitise` itself.
    //
    // Worth knowing what this does and does not prove. The clamp is applied
    // **twice** — `set_settings` sanitises so it can compare the *sanitised*
    // hotkey before rebinding, and `SettingsStore::replace` sanitises because
    // other callers reach it directly. So deleting either one alone leaves this
    // green; only removing both turns it red, which was verified by doing it.
    // That is the correct behaviour for a doubled guard rather than a hole in
    // the test: what is asserted is the invariant, not which line enforces it.
    let (_app, window) = app();

    let stored = invoke(
        &window,
        "set_settings",
        serde_json::json!({ "settings": {
            "maxItems": 100_000,
            "retentionHours": serde_json::Value::Null,
            "hotkey": shotshelf_lib::settings::DEFAULT_HOTKEY,
            "checkForUpdates": true,
            "downscaleExports": false,
            "pinned": [],
        }}),
    );

    // Asserted, not discarded. The first version of this test threw the result
    // away, and a `set_settings` that rejected the payload outright would have
    // left the store on its defaults — 50, comfortably under the ceiling — so
    // the assertion below passed without the command ever having run. A test
    // that cannot fail is the thing this repository hunts hardest.
    let stored = stored.expect("set_settings answered rather than erroring");
    assert_eq!(
        stored.get("maxItems").and_then(serde_json::Value::as_u64),
        Some(200),
        "the command did not clamp on the way in: {stored}",
    );

    let after = invoke(&window, "get_settings", serde_json::json!({}))
        .expect("settings are still readable");
    let max = after
        .get("maxItems")
        .and_then(serde_json::Value::as_u64)
        .expect("the cap is on the wire");
    assert!(
        max <= 200,
        "an unclamped item cap crossed the boundary: {max}"
    );
}

#[test]
fn a_test_binary_that_links_the_tauri_runtime_loads_at_all() {
    // The gate on the gate. If the ComCtl32 v6 manifest wiring in `build.rs`
    // regresses, this binary dies at load with STATUS_ENTRYPOINT_NOT_FOUND
    // before a single test runs — and the failure looks like a crash rather
    // than an assertion, so it is worth naming what it means.
    let reachable: fn() = shotshelf_lib::run;
    assert!(!std::ptr::eq(reachable as *const (), std::ptr::null()));
}

/// A file that really exists and is really outside the scope.
///
/// **Both halves matter.** `existing_file` refuses a path for two different
/// reasons — it is not in the scope, or it is not there at all — and a test
/// pointed at a name that was never created would pass on the second reason
/// while claiming the first. That is the same vacuity that made the item-cap
/// test meaningless on its first writing, so it is worth spelling out: this
/// writes a real PNG, and the only thing wrong with it is where it lives.
///
/// Nothing grants a scope in this harness, which is what makes any path outside
/// it. The real app grants one at runtime from the resolved watch list.
fn a_real_file_outside_the_scope() -> String {
    let dir = std::env::temp_dir().join(format!("shotshelf-unscoped-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("the scratch directory is created");
    let path = dir.join("outside.png");
    // A one-pixel PNG, so nothing downstream can refuse it for being unreadable
    // either.
    std::fs::write(
        &path,
        [
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ],
    )
    .expect("the fixture writes");

    assert!(path.exists(), "the fixture must exist to be a fair test");
    path.to_string_lossy().into_owned()
}

#[test]
fn the_scope_refuses_a_path_it_was_never_given() {
    // **This is the half of the confinement story that had never been
    // observed.** `SECURITY.md` says so outright: the scope "is checked against
    // Tauri's implementation; it has never actually refused anything at
    // runtime". Its logic was verified by reading, and by unit tests of the
    // *shape* rules in `webview_path.rs` — never by a command being told no.
    //
    // Every command that touches a capture's file is asked for the same
    // out-of-scope path. Each must refuse. If `existing_file` were deleted from
    // any one of them, that command would answer instead, and this goes red.
    //
    // For `reveal_capture` this is also the *only* test it can have in a
    // harness: its success path opens a real file-manager window on whatever
    // machine runs the suite, which is a side effect no test should have. The
    // refusal is the property that matters — reveal hands a path to the OS
    // shell, so it is the last command that may take one the scope never
    // admitted.
    let (_app, window) = app();
    let path = a_real_file_outside_the_scope();

    for (command, body) in [
        (
            "describe_capture",
            serde_json::json!({ "path": path.clone() }),
        ),
        (
            "prepare_drag",
            serde_json::json!({ "path": path.clone(), "kind": "image" }),
        ),
        (
            "copy_capture",
            serde_json::json!({ "path": path.clone(), "kind": "image" }),
        ),
        (
            "reveal_capture",
            serde_json::json!({ "path": path.clone() }),
        ),
    ] {
        assert!(
            invoke(&window, command, body).is_err(),
            "{command} read a path the scope never admitted",
        );
    }
}

#[test]
fn the_catch_engine_says_it_is_starting_in_the_words_the_front_end_matches() {
    // `main.ts` retries only on an error containing "still starting", and gives
    // up on anything else — so this sentence is a cross-language contract, and
    // the fixture is the join. Nothing had ever seen it cross the boundary: the
    // Rust side asserts the constant, the browser side asserts the stub, and
    // the two met nowhere.
    //
    // The engine is never started in this harness, which is exactly the state
    // the front end is retrying through at launch.
    let (_app, window) = app();
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../tests/fixtures/engine-starting.json"))
            .expect("the shared sentinel fixture parses");
    let starting = fixture["starting"]
        .as_str()
        .expect("the fixture names the sentinel");

    for command in ["catch_watch_dirs", "catch_backfill"] {
        let error = invoke(&window, command, serde_json::json!({}))
            .expect_err("the engine has not started, so this cannot succeed");
        assert!(
            error.contains(starting),
            "{command} did not answer with the sentinel the front end retries on: {error}",
        );
    }
}

#[test]
fn a_relative_pinned_path_does_not_survive_the_boundary() {
    // `allowed_pins` drops anything not absolute, because `pinned.json` is read
    // back at the next launch and an unchecked entry outlives the session that
    // wrote it. That rule is unit-tested; what was not is whether `set_pinned`
    // — the command the webview actually calls — applies it.
    let (_app, window) = app();

    invoke(
        &window,
        "set_pinned",
        serde_json::json!({ "pinned": [
            { "path": "relative/sneaky.png", "kind": "image", "ts": 1 },
            { "path": "also-relative.png", "kind": "image", "ts": 2 },
        ]}),
    )
    .expect("set_pinned answers");

    let settings = invoke(&window, "get_settings", serde_json::json!({}))
        .expect("settings are readable afterwards");
    let pinned = settings
        .get("pinned")
        .and_then(serde_json::Value::as_array)
        .expect("pinned is on the wire");
    assert!(
        pinned.is_empty(),
        "a relative pinned path crossed the boundary and was stored: {pinned:?}",
    );
}

#[test]
fn asking_whether_text_can_be_recognised_answers_rather_than_failing() {
    // Advisory, and the front end treats a failure as "do not mention it".
    // What must not happen is the command being unreachable — the shelf would
    // then never say that captures are going unchecked, which is the one
    // outcome `secrets.spec.ts` calls worse than no check at all.
    let (_app, window) = app();
    let answer = invoke(&window, "text_recognition_available", serde_json::json!({}))
        .expect("the command is reachable");
    assert!(
        answer.is_boolean(),
        "expected a bool on the wire, got {answer}",
    );
}
