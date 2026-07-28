/**
 * Every call the shelf makes into Rust, in one place.
 *
 * One reason, and it is enough: command names and argument shapes are a
 * contract with the Rust side, and scattering them through the view means a
 * renamed command fails at runtime in whichever corner happens to call it.
 * `scripts/check-commands.mjs` checks both directions of that contract, and
 * having the call sites in one file is what makes its output readable.
 *
 * **Not a test seam.** This used to claim to be the module a harness replaces;
 * it is not, and never was — `tests/harness/tauri-mock.ts` stubs
 * `window.__TAURI_INTERNALS__` and says in its own header that it chose that
 * over abstracting Tauri behind an interface the app would otherwise not need.
 * Believing the seam was here is how a reader would conclude the tests exercise
 * less of the app than they do.
 *
 * **Where the boundary runs.** This is the shelf's calls, not the app's:
 * `main.ts`, `popover.ts` and `settings.ts` invoke directly, because they are
 * outside the shelf. Within the shelf the rule is that view modules reach Rust
 * through here, and call back to `Shelf` only for what the shelf owns — what
 * is on it, and what the user is told. Copy was on both sides of that line
 * for a while and grew two failure reports as a result.
 *
 * Calls that are advisory rather than load-bearing swallow their errors here —
 * the tray count failing to update is not worth breaking a render over — and
 * say so individually. Calls whose failure the user must hear about reject.
 */

import { invoke } from "@tauri-apps/api/core";

import type { CaptureKind, DragSource, Findings, VideoDetails } from "./types.ts";

/** What ffmpeg could tell us about a recording. Rejects if it could not be read. */
export function videoDetails(path: string): Promise<VideoDetails> {
  return invoke<VideoDetails>("video_details", { path });
}

/**
 * Drop a recording's cached poster frame. Advisory: a frame left behind is
 * wasted disk, not a broken shelf, and the cache is pruned at startup anyway.
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
 * Save an annotated copy of a capture.
 *
 * The bytes are a PNG the editor composited on a canvas — which is what makes
 * a redaction real rather than decorative: the marks are drawn *into* the
 * pixels before encoding, so what Rust receives has no layer to peel off.
 * Returns the new capture's path.
 */
export function saveEdit(source: string, png: Uint8Array): Promise<string> {
  return invoke<string>("save_edit", { source, png: [...png] });
}
