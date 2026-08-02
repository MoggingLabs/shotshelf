/**
 * A stand-in for the Tauri runtime, so the real front-end can be driven in a
 * real browser.
 *
 * This is the seam the whole front-end gate rests on. Shotshelf's UI is not
 * reachable by unit tests — the interesting behaviour is windows resizing,
 * cards expiring, drags arming, pictures loading — and none of it can be
 * exercised without something answering `invoke`. Rather than abstract Tauri
 * behind an interface the app would otherwise not need, this reproduces the
 * four functions `@tauri-apps/api` actually reaches for:
 *
 *   invoke, transformCallback, unregisterCallback, convertFileSrc
 *
 * plus the `metadata` that `getCurrentWindow()` reads. Anything the app calls
 * that is not stubbed here fails loudly rather than resolving to undefined —
 * a silent stub is how a test passes against a command that no longer exists.
 *
 * Injected with `page.addInitScript`, so it is in place before any app module
 * runs. It is authored as a string-serialisable function for that reason: it
 * is evaluated in the page, not in the test process.
 */

/** A command name and what it was called with. */
interface RecordedCall {
  cmd: string;
  args: Record<string, unknown>;
  /**
   * The raw payload, for commands that send bytes rather than JSON.
   *
   * `save_edit` ships a PNG as the request body — a JSON array of integers
   * cost about four bytes of string per byte of image — so its arguments
   * travel as headers instead.
   */
  body?: Uint8Array;
  headers?: Record<string, string>;
}

/** The controls a test gets, exposed on `window.__shotshelf__`. */
interface TestHooks {
  /** Every `invoke` the app has made, oldest first, plugin calls included. */
  calls(): RecordedCall[];
  /** Calls for one command only. */
  callsTo(cmd: string): RecordedCall[];
  /** Forget the record, so a test can assert on what happens next. */
  clearCalls(): void;
  /** Answer a command with a value, or with a rejection. */
  respond(cmd: string, value: unknown): void;
  /**
   * Answer a command from its own arguments.
   *
   * A single fixed response makes every call look identical, which is how a
   * test asserting on *which* captures were handed over, and in what order,
   * silently asserted nothing.
   */
  respondWith(cmd: string, answer: (args: Record<string, unknown>) => unknown): void;
  reject(cmd: string, message: string): void;
  /**
   * Leave a command in flight, never settling.
   *
   * Some of the app's states only exist while a call is outstanding — a native
   * drag is the important one, since the shelf must not vanish out from under
   * it — and a stub that resolves immediately skips straight past them.
   */
  hang(cmd: string): void;
  /** Deliver a Tauri event to whatever the app has listening. */
  emit(event: string, payload: unknown): void;
}

/**
 * The surface `@tauri-apps/api` reaches for. Declared rather than imported:
 * the real one is installed by the Tauri runtime at page load, so as far as
 * TypeScript is concerned it does not exist until we put it there.
 */
interface TauriInternals {
  invoke(
    cmd: string,
    args?: Record<string, unknown> | Uint8Array | ArrayBuffer,
    options?: { headers?: Record<string, string> },
  ): Promise<unknown>;
  transformCallback(callback: (payload: unknown) => void, once?: boolean): number;
  unregisterCallback(id: number): void;
  convertFileSrc(path: string, protocol?: string): string;
  metadata: {
    currentWindow: { label: string };
    currentWebview: { label: string };
  };
}

declare global {
  interface Window {
    __TAURI_INTERNALS__: TauriInternals;
    __shotshelf__: TestHooks;
    /**
     * Command responses seeded before the app boots, for the ones it reads
     * during start-up. Declaring them afterwards is too late — the shelf has
     * already read its limits by the time a test could call `respond`.
     *
     * "Too late" means the test cannot fail, not that it is merely weaker: one
     * of these guarded a regression that had actually shipped, and it passed
     * with the code under test deleted. Anything the app invokes during module
     * evaluation — the settings, the watch folders, the credential probe —
     * belongs here rather than in a `respond()` after `bootShelf`.
     *
     * A value of `{ __rejects__: "why" }` makes the command reject instead of
     * resolve, which is the whole reason a start-up failure is expressible at
     * all from out here. `{ __rejectsTimes__: n, then: value }` fails n times
     * and then succeeds — a transient race rather than a permanent one, which
     * is what the settings retry exists for. `because` sets the rejection
     * message, which the catch commands' retry matches on.
     */
    __shotshelfStubs__?: Record<string, unknown>;
  }
}

/**
 * Installed into the page. Kept as one self-contained function with no imports
 * so it can be serialised across to the browser.
 */
/** The half of `window-events.json` this mock needs, passed in by the caller. */
export interface WindowEvents {
  opened: string;
  hidden: string;
  deliberate: boolean;
}

/**
 * Taken as an argument rather than imported.
 *
 * This function is serialised into the page by `addInitScript`, so nothing it
 * closes over survives — which is why the event names and the "deliberate"
 * payload used to be written out here by hand. They drifted twice: `null` where
 * Rust sends a boolean, then a hard-coded `true` under a comment asserting what
 * Rust does, with nothing joining the two. The caller reads
 * `tests/fixtures/window-events.json`, which a Rust test also reads.
 */
export function installTauriMock(EVENTS: WindowEvents): void {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  const callbacks = new Map<number, (payload: unknown) => void>();
  const listeners = new Map<string, number[]>();
  type Response =
    | { kind: "value"; value: unknown }
    | { kind: "from-args"; answer: (args: Record<string, unknown>) => unknown }
    | { kind: "error"; message: string }
    | { kind: "pending" };
  const responses = new Map<string, Response>();
  let nextCallbackId = 1;

  /**
   * Defaults for the commands the shelf cannot start without. Everything else
   * must be declared by the test, so a command the app invents without a test
   * noticing shows up as a failure rather than as `undefined`.
   */
  const defaults: Record<string, unknown> = {
    // The shape Rust returns: the folders, and whether the clipboard
    // watcher is actually running. It used to be a bare list, and the
    // front end filled the clipboard half in from nothing.
    "catch_watch_dirs": { dirs: [], clipboard: true },
    // Captures from before this launch. Empty by default: a spec that wants
    // them says so, and every other spec asserts against a shelf it filled.
    "catch_backfill": [],
    // No `get_settings` here on purpose: `bootShelf` seeds it from
    // `tests/fixtures/default-settings.json`, the same file Rust and the
    // front-end assert their defaults against. A third hand-written copy in
    // this file is how the harness would go on booting the app with a settings
    // shape the app no longer has.
    "set_pinned": null,
    "text_recognition_available": true,
    "set_capture_count": null,
    "show_shelf": null,
    "hide_shelf": null,
    "forget_video": null,
    "copy_capture": null,
    "reveal_capture": null,
    // Read, and there was text — the ordinary case; a spec that wants the
    // no-text answer stubs `false`.
    "copy_capture_text": true,
    // The gear's whole job is this invoke; the window itself is Rust's.
    "open_settings": null,
    // About's button, answered the way Rust answers when nothing is newer.
    // A spec that wants the update-available sentence stubs its own.
    "check_for_updates": "You are on the newest version.",
    // Named link opened in the OS browser — nothing to return.
    "open_link": null,
    // The folder picker with the user closing it — the ordinary changed-my-
    // mind answer; a spec that wants a folder chosen stubs the path.
    "choose_watch_folder": null,
    // Read, and nothing found — the ordinary case.
    "describe_capture": { secrets: [], scanned: true },
    ...(window.__shotshelfStubs__ ?? {}),
  };

  /** Deliver an event to whatever the app has listening. */
  function emitTo(event: string, payload: unknown): void {
    for (const id of listeners.get(event) ?? []) {
      callbacks.get(id)?.({ event, id, payload });
    }
  }

  function invoke(
    cmd: string,
    args: Record<string, unknown> | Uint8Array | ArrayBuffer = {},
    options?: { headers?: Record<string, string> },
  ): Promise<unknown> {
    // A raw payload is the whole body; anything else it needs rides in headers.
    const raw =
      args instanceof Uint8Array
        ? args
        : args instanceof ArrayBuffer
          ? new Uint8Array(args)
          : undefined;
    const named = raw ? {} : (args as Record<string, unknown>);
    // Event plumbing is part of the runtime, not part of the app's contract,
    // so it is handled here rather than recorded as an app call.
    if (cmd === "plugin:event|listen") {
      const event = named["event"] as string;
      const id = named["handler"] as number;
      listeners.set(event, [...(listeners.get(event) ?? []), id]);
      return Promise.resolve(id);
    }
    // No `plugin:event|unlisten` branch: nothing in `src/` unlistens, which
    // `src-tauri/capabilities/default.json` records as the reason that permission was
    // removed. A stub for a command the app cannot send is a branch no test can
    // reach — and it read as evidence the harness covered a path that does not
    // exist.

    calls.push({
      cmd,
      args: named,
      ...(raw ? { body: raw } : {}),
      ...(options?.headers ? { headers: options.headers } : {}),
    });

    // What this call answers with, decided *before* anything is emitted.
    //
    // Runs exactly once: the flaky-stub branch below counts down as a side
    // effect, so this cannot be a predicate consulted twice.
    const answer = ((): { succeeded: boolean; result: Promise<unknown> } => {
      const declared = responses.get(cmd);
      if (declared) {
        if (declared.kind === "value") {
          return { succeeded: true, result: Promise.resolve(declared.value) };
        }
        if (declared.kind === "from-args") {
          return { succeeded: true, result: Promise.resolve(declared.answer(named)) };
        }
        if (declared.kind === "error") {
          return { succeeded: false, result: Promise.reject(new Error(declared.message)) };
        }
        return { succeeded: false, result: new Promise(() => {}) };
      }

      if (cmd in defaults) {
        const seeded = defaults[cmd];
        // A seeded stub may ask to reject — see `__shotshelfStubs__`. Without
        // this, a start-up command could only ever be made to *succeed* before
        // the app ran, and a test wanting a start-up failure had to call
        // `reject()` after `bootShelf`, by which time the call it meant to
        // affect had already been answered from the defaults above.
        if (typeof seeded === "object" && seeded !== null && "__rejects__" in seeded) {
          return { succeeded: false, result: Promise.reject(new Error(String(seeded.__rejects__))) };
        }
        // Fails the first N times and then succeeds, which is what a start-up
        // race actually looks like: `get_settings` losing to Rust's setup hook
        // and winning on the retry. Without this the retry could only be tested
        // by its absence, so shortening it to a single attempt changed nothing.
        if (typeof seeded === "object" && seeded !== null && "__rejectsTimes__" in seeded) {
          const flaky = seeded as { __rejectsTimes__: number; then: unknown; because?: string };
          if (flaky.__rejectsTimes__ > 0) {
            flaky.__rejectsTimes__ -= 1;
            // The message is the stub's to choose. It was hard-coded to
            // "state not managed", which is `get_settings`'s failure — so this
            // affordance could not drive the catch commands' retry, which
            // matches on "still starting". A retry that no test can reach is a
            // retry that can be deleted with every gate green.
            const because =
              typeof flaky.because === "string" ? flaky.because : "state not managed";
            return { succeeded: false, result: Promise.reject(new Error(because)) };
          }
          return { succeeded: true, result: Promise.resolve(flaky.then) };
        }
        return { succeeded: true, result: Promise.resolve(seeded) };
      }

      return {
        succeeded: false,
        result: Promise.reject(
          new Error(`[harness] no stub for "${cmd}" — declare one with respond() or reject()`),
        ),
      };
    })();

    // Two commands emit `shelf://opened` from Rust, and the front-end depends
    // on it: `window::open` and `window::preview` both set the "opened" flag,
    // and this event is the only thing that tells the webview so.
    //
    // Modelled here because a stub that answers but does not emit is a lie
    // about the contract. `preview_shelf` not emitting was a real defect — the
    // shelf kept rendering its column shape around a full-size editor, which
    // hid the alert strip and left the column's expiry timer running — and no
    // browser test could see it while the harness had the same gap.
    //
    // Only on success, and that half was missing. Rust emits from *inside* the
    // command, after the window has actually been resized, so a call that
    // fails or never returns emits nothing. Emitting before the answer was
    // even looked up meant `reject()` and `hang()` could not suppress it: a
    // spec hanging `preview_shelf` still saw the window report itself opened
    // and tested a state the real app cannot reach.
    if (answer.succeeded) {
      // `true`, not `null`, and the payload is the contract.
      //
      // Rust's `mark_opened` carries a `deliberate` flag, and both of these
      // routes pass `true`: `show_shelf { focus: true }` is the tray, the
      // hotkey or the editor restoring its window, and `preview_shelf` is a
      // quick look. Only the launch appearance sends `false`.
      //
      // Emitting `null` made every browser test model a deliberate open as the
      // launch — so the front end left its four-second dismissal timer armed,
      // and a window the user had just opened put itself away. A probe driving
      // `browseShelf()` and advancing the clock five seconds saw `hide_shelf`,
      // and nothing in the suite pinned the payload in either direction.
      if ((cmd === "show_shelf" && named["focus"] === true) || cmd === "preview_shelf") {
        queueMicrotask(() => {
          emitTo(EVENTS.opened, EVENTS.deliberate);
        });
      }
      if (cmd === "hide_shelf") {
        queueMicrotask(() => {
          emitTo(EVENTS.hidden, null);
        });
      }
    }

    return answer.result;
  }

  window.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback(callback: (payload: unknown) => void) {
      const id = nextCallbackId;
      nextCallbackId += 1;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback(id: number) {
      callbacks.delete(id);
    },
    /**
     * The real protocol differs per OS. The shape does not matter to a test —
     * what matters is that it is a URL the harness can serve a real picture
     * from, so `object-fit`, the blurred wash and load failures all behave as
     * they do in the app.
     */
    convertFileSrc(path: string) {
      return `/fixtures/${path.split(/[\\/]/).pop() ?? ""}`;
    },
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  };

  window.__shotshelf__ = {
    calls: () => [...calls],
    callsTo: (cmd) => calls.filter((call) => call.cmd === cmd),
    clearCalls: () => {
      calls.length = 0;
    },
    respond: (cmd, value) => responses.set(cmd, { kind: "value", value }),
    respondWith: (cmd, answer) => responses.set(cmd, { kind: "from-args", answer }),
    reject: (cmd, message) => responses.set(cmd, { kind: "error", message }),
    hang: (cmd) => responses.set(cmd, { kind: "pending" }),
    emit: emitTo,
  };
}
