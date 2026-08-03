/**
 * Every call the shelf makes into Rust, in one place.
 *
 * One reason, and it is enough: command names and argument shapes are a
 * contract with the Rust side, and scattering them through the view means a
 * renamed command fails at runtime in whichever corner happens to call it.
 * Having the call sites in one file is what makes that reviewable.
 *
 * `scripts/check-commands.mjs` checks the **names**, in both directions —
 * every registered command has a caller, every invoked command is registered.
 * It does **not** check argument shapes, and this header used to say it checked
 * "both directions of that contract", which reads as though it did: renaming
 * `path` to `sourcePath` in a call to `video_details` passes the gate, eslint,
 * `tsc` and the whole browser suite, and fails at runtime with a serde
 * missing-field error on every recording tile.
 *
 * Nothing here can close that: the argument names live in Rust's function
 * signatures, and matching them would mean parsing those signatures and the
 * object literals below. What keeps it honest instead is that the literals are
 * all in this one file, next to the command they belong to — so a signature
 * change has one place to look rather than several.
 *
 * **Not a test seam.** This used to claim to be the module a harness replaces;
 * it is not, and never was — `tests/harness/tauri-mock.ts` stubs
 * `window.__TAURI_INTERNALS__` and says in its own header that it chose that
 * over abstracting Tauri behind an interface the app would otherwise not need.
 * Believing the seam was here is how a reader would conclude the tests exercise
 * less of the app than they do.
 *
 * **Where the boundary runs**, as a list rather than a description.
 * `scripts/check-commands.mjs` holds `invoke` to five files: this one, and the
 * four that each own a piece of Rust the shelf does not — the window
 * (`popover.ts`), the settings panel (`settings.ts`), start-up (`main.ts`) and
 * the editor's own window (`editor-window/bridge.ts`). Anything else calling
 * Rust fails that gate.
 *
 * The last of those is the newest and the clearest case for the rule: the
 * editor is a second page in a second window, so it cannot reach this file's
 * shelf-shaped helpers, and giving it its own bridge keeps its whole IPC
 * surface — three commands and a save — readable in one screen.
 *
 * It was a description, and two files described it differently: this header
 * said "the shelf's calls, not the app's — `main.ts` … invoke[s] directly,
 * because [it is] outside the shelf", while the editor said "the window itself
 * goes through `bridge.ts` like every other view module". `main.ts` both
 * imports from here and invokes directly, so it satisfied neither, and nothing
 * decided which applied. A rule stated twice in prose is a rule that decides
 * nothing. (The editor's half of that disagreement is now moot in the most
 * literal way: it is not in this window.)
 *
 * Within the shelf, view modules reach Rust through here and call back to
 * `Shelf` only for what the shelf owns — what is on it, and what the user is
 * told. Copy was on both sides of that line for a while and grew two failure
 * reports as a result.
 *
 * Calls that are advisory rather than load-bearing swallow their errors here —
 * the tray count failing to update is not worth breaking a render over — and
 * say so individually. Calls whose failure the user must hear about reject.
 */

import { invoke } from "@tauri-apps/api/core";

import type { CaptureKind, DragSource, Findings, VideoDetails } from "./types.ts";

/** What ffmpeg could tell us about a recording. Rejects if it could not be read. */
/**
 * Take the capture's file out of its folder, staged behind the undo toast.
 * Returns the token the toast settles with, one way or the other.
 */
export function deleteCapture(path: string): Promise<string> {
  return invoke<string>("delete_capture", { path });
}

/** Put a staged delete back exactly where it came from. */
export function undoDeleteStaged(token: string): Promise<void> {
  return invoke("undo_delete", { token });
}

/** The toast ran out; the staged file goes to the OS recycle bin. */
export function commitDelete(token: string): Promise<void> {
  return invoke("commit_delete", { token });
}

export function videoDetails(path: string): Promise<VideoDetails> {
  return invoke<VideoDetails>("video_details", { path });
}

/**
 * Drop a recording's cached poster frame. Advisory: a frame left behind is
 * wasted disk, not a broken shelf, and the cache is swept on a timer anyway.
 */
export async function forgetVideo(path: string): Promise<void> {
  try {
    await invoke("forget_video", { path });
  } catch {
    // Advisory by design; see above.
  }
}

/** Put a capture on the clipboard. Rejects — the button reports this one. */
export async function copyCapture(path: string, kind: CaptureKind): Promise<void> {
  await invoke("copy_capture", { path, kind });
}

/** Show the capture's file in the OS file manager, selected where the OS can. */
export async function revealCapture(path: string): Promise<void> {
  await invoke("reveal_capture", { path });
}

/**
 * Recognise the text in a capture and put it on the clipboard, all in Rust.
 *
 * `false` means "read it, and there was no text" — a different sentence from a
 * failure, which rejects. The text itself never crosses this boundary.
 */
export function copyCaptureText(path: string): Promise<boolean> {
  return invoke<boolean>("copy_capture_text", { path });
}

/** Stage a capture for a native drag. Rejects — a failed drag must be visible. */
export function prepareDrag(path: string, kind: CaptureKind): Promise<DragSource> {
  return invoke<DragSource>("prepare_drag", { path, kind });
}

/**
 * The popover is hidden most of the time, so the tray icon carries the count.
 * Advisory: a stale tooltip is not worth failing a render for.
 */
export async function setCaptureCount(count: number): Promise<void> {
  try {
    await invoke("set_capture_count", { count });
  } catch {
    // Advisory by design; see above.
  }
}

/**
 * What Shotshelf worked out about a capture by reading it.
 *
 * Slow — text recognition on a dense screenshot is the longest thing this app
 * does — so it is fetched per tile rather than waited for. A capture is on the
 * shelf and draggable long before this returns, and on platforms with no text
 * recogniser it returns nothing at all, which is ordinary.
 */
export function describeCapture(path: string): Promise<Findings> {
  return invoke<Findings>("describe_capture", { path });
}

/**
 * Whether this build can read text out of a capture at all.
 *
 * Asked once at start-up. Windows and macOS use the OS recogniser; Linux uses
 * tesseract if the machine has it, and has none if it does not. A user with no
 * recogniser needs telling — otherwise every capture looks exactly like one
 * that was checked and came back clean.
 */
export function textRecognitionAvailable(): Promise<boolean> {
  return invoke<boolean>("text_recognition_available");
}

/**
 * Put two captures side by side, with what changed outlined on the second.
 *
 * Returns the path of a new file. The originals are untouched — comparison is
 * a third capture, not an edit of either.
 */
export function compareCaptures(before: string, after: string): Promise<string> {
  return invoke<string>("compare_captures", { before, after });
}

/**
 * Grow the popover to show one capture at readable size.
 *
 * Rust chooses the size: only it knows the work area, and a preview that
 * spills off the screen is not a preview. It reports nothing back — both
 * callers fit their content to the box they actually get, because the webview
 * has not necessarily laid out at the new size by the time this resolves.
 */
export async function previewShelf(aspect: number): Promise<void> {
  await invoke("preview_shelf", { aspect });
}

/**
 * Put the popover back to the browse shape.
 *
 * Owed by everything that grew the window — the quick look and the editor both
 * ask for a bigger one, and both have to give it back. It was named for the
 * preview when only the preview called it, and the editor then had no obvious
 * thing to call and silently skipped the restore altogether.
 *
 * The same command that opens the shelf deliberately: "show the browse view,
 * focused" is one behaviour, and a second command doing exactly that was two
 * names for one thing and two pieces of reachable surface.
 */
export async function browseShelf(): Promise<void> {
  await invoke("show_shelf", { focus: true });
}

/**
 * Open the editor's window on a capture.
 *
 * Rejects rather than opening an empty window when the capture's file has
 * gone: Rust checks the path before anything appears, so the shelf can say so
 * on its own alert strip instead of flashing a window up to carry the message.
 *
 * `saveEdit` used to live beside this. It moved to
 * `src/editor-window/bridge.ts` with the editor itself — the shelf does not
 * save anything, and learns that an edit was written from Rust's
 * `capture://edited` rather than from a value handed back through here.
 */
export async function openEditorWindow(path: string): Promise<void> {
  await invoke("open_editor", { path });
}
