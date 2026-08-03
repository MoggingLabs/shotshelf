/**
 * The editor window's calls into Rust, in one file.
 *
 * The exact analogue of `src/settings.ts` for the settings window: a page that
 * is not the shelf needs somewhere to talk to Rust from, and
 * `scripts/check-commands.mjs` holds `invoke` to a named list of files. This
 * file is on that list; nothing else under `src/editor-window/` or
 * `src/editor/` may call Rust, which is what keeps the editor's whole IPC
 * surface — three commands and a save — readable in one screen.
 *
 * `saveEdit` lives here rather than in `src/shelf/bridge.ts` because the shelf
 * no longer saves anything: the editor is its own window now, and the shelf
 * learns that an edit was written from the `capture://edited` event Rust emits,
 * not from a value it passed along.
 */

import { invoke } from "@tauri-apps/api/core";

/**
 * Which capture this window is meant to be showing.
 *
 * Asked once at boot. Rust holds the answer rather than only announcing it,
 * because this window is declared-and-hidden: it has been alive since launch,
 * and an `editor://open` emitted before this page's listener attached would
 * simply be lost. Every open *after* the first arrives as that event.
 *
 * `null` when the window is up with nothing to show, which a user cannot
 * normally produce but a reloaded webview can.
 */
export function editTarget(): Promise<string | null> {
  return invoke<string | null>("edit_target");
}

/**
 * Take this window off screen.
 *
 * A command rather than the `core:window` permission that would let the page
 * hide itself: `core:window|hide` takes a label, so granting it would let this
 * webview hide *any* window, and the capability file's rule is that an entry
 * grants exactly what has a caller. Rust also has bookkeeping to do here —
 * forgetting the target, standing the close confirmation down, and putting the
 * macOS activation policy back — none of which the page knows about.
 */
export async function hideEditor(): Promise<void> {
  await invoke("hide_editor");
}

/**
 * Save an annotated copy of a capture.
 *
 * The bytes are a PNG this window composited on a canvas — which is what makes
 * a redaction real rather than decorative: the marks are drawn *into* the
 * pixels before encoding, so what Rust receives has no layer to peel off.
 * Returns the new capture's path.
 */
export function saveEdit(source: string, png: Uint8Array): Promise<string> {
  // Sent as a raw body, not as JSON.
  //
  // `{ png: [...png] }` turned a 5 MB PNG into a five-million-element JS array
  // and roughly 20 MB of JSON text for serde to parse back — on the one path
  // holding work the user cannot afford to lose, and scaling with exactly the
  // captures most worth annotating. At the 64 MiB ceiling the command
  // documents, that shape builds a quarter-gigabyte of string in the webview
  // before Rust sees a byte, which is also why the ceiling could not protect
  // the memory it named.
  //
  // Tauri takes a `Uint8Array` as the whole payload and transfers it as bytes.
  // Everything else then has to travel as a header, and a header must be
  // ASCII — hence the encoding, undone by `percent_decode` in `edit.rs`.
  return invoke<string>("save_edit", png, {
    headers: { "x-shotshelf-source": encodeURIComponent(source) },
  });
}
