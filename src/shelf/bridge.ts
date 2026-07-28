/**
 * Every call the shelf makes into Rust, in one place.
 *
 * Two reasons it is worth a module of its own. Command names and argument
 * shapes are a contract with the Rust side, and scattering them through the
 * view means a renamed command fails at runtime in whichever corner happens to
 * call it. And it gives the tests one seam to stand in front of: a browser has
 * no Tauri to talk to, so this is the module a harness replaces.
 *
 * Calls that are advisory rather than load-bearing swallow their errors here —
 * the tray count failing to update is not worth breaking a render over — and
 * say so individually. Calls whose failure the user must hear about reject.
 */

import { invoke } from "@tauri-apps/api/core";

import type { CaptureKind, DragSource, VideoDetails } from "./types.ts";

/** What ffmpeg could tell us about a recording. Rejects if it could not be read. */
export function videoDetails(path: string): Promise<VideoDetails> {
  return invoke<VideoDetails>("video_details", { path });
}

/**
 * Drop a recording's cached poster frame. Advisory: a frame left behind is
 * wasted disk, not a broken shelf, and the cache is pruned at startup anyway.
 */
export function forgetVideo(path: string): Promise<void> {
  return invoke<void>("forget_video", { path }).catch(() => undefined);
}

/** Put a capture on the clipboard. Rejects — the button reports this one. */
export function copyCapture(path: string, kind: CaptureKind): Promise<void> {
  return invoke<void>("copy_capture", { path, kind });
}

/** Stage a capture for a native drag. Rejects — a failed drag must be visible. */
export function prepareDrag(path: string, kind: CaptureKind): Promise<DragSource> {
  return invoke<DragSource>("prepare_drag", { path, kind });
}

/**
 * The popover is hidden most of the time, so the tray icon carries the count.
 * Advisory: a stale tooltip is not worth failing a render for.
 */
export function setCaptureCount(count: number): Promise<void> {
  return invoke<void>("set_capture_count", { count }).catch(() => undefined);
}
