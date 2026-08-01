/**
 * The warning on a card that is carrying a credential.
 *
 * A capture is on the shelf to be dragged somewhere, and "somewhere" is very
 * often a chat window on someone else's machine. This is the last point at
 * which a token in a screenshot is still only on yours.
 *
 * It warns and never blocks. The drag, the copy and the pin all behave exactly
 * as they did — a tool that refuses to hand over your own screenshot because a
 * regex fired is a tool that gets turned off, and a scanner nobody runs
 * protects nobody.
 *
 * The marker deliberately does not show the value. Its whole purpose is to
 * stop that value spreading, and a tooltip is somewhere it can spread to; the
 * masked preview from Rust is the most it ever says.
 */

import { icon } from "../../icons.ts";
import { describeCapture } from "../bridge.ts";
import type { Findings, SecretFinding } from "../types.ts";

/**
 * "a token", "an email address" — the label decides which.
 *
 * The sentence hard-coded "a", and three of the labels Rust sends begin with a
 * vowel. One of those, `email address`, carries the *lowest* severity, so it is
 * the label the ordinary case reaches for: the commonest wording of this
 * warning read "a email address".
 *
 * On the first letter, not a dictionary. Every label is a plain English noun
 * phrase written in `secrets.rs`, none of them a "European"-style exception,
 * and a rule with a list of exceptions attached would be a second thing to keep
 * in step with that file.
 */
function article(label: string): string {
  return `${/^[aeiou]/i.test(label) ? "an" : "a"} ${label}`;
}

/** How the warning describes what it found, worst first. */
function summarise(findings: readonly SecretFinding[]): string {
  const [worst] = findings;
  if (!worst) return "";

  const rest = findings.length - 1;
  const tail =
    rest === 0 ? "" : ` and ${rest} other${rest === 1 ? "" : "s"}`;

  return [
    `Looks like this capture contains ${article(worst.label)}${tail}.`,
    `Found: ${worst.preview}`,
    "Shotshelf will still drag and copy it — check before you send it.",
  ].join("\n");
}

function marker(findings: readonly SecretFinding[]): HTMLElement {
  const el = document.createElement("span");
  el.className = "tile__secret";
  el.dataset["kind"] = findings[0]?.kind ?? "";
  el.title = summarise(findings);
  el.append(icon("alert", 12));

  // The count only earns its space when there is more than one thing to say.
  if (findings.length > 1) {
    const count = document.createElement("span");
    count.className = "tile__secret-count";
    count.textContent = String(findings.length);
    el.append(count);
  }

  return el;
}

/**
 * Read a capture and mark it if it is carrying something.
 *
 * Failure is silent on purpose. Text recognition is unavailable on some
 * platforms and fails on some files, and neither is worth an alert strip: the
 * absence of a warning has never meant "this capture is safe", only "nothing
 * was found", and saying so on every tile would train people to ignore it.
 */
export async function markSecrets(tile: HTMLElement, path: string): Promise<void> {
  let result: Findings;
  try {
    result = await describeCapture(path);
  } catch {
    // The capture could not be read at all. Same meaning as `scanned: false`.
    markUnscanned(tile);
    return;
  }

  if (!result.scanned) {
    // "Could not look" is not "looked and found nothing", and showing them the
    // same way is how a safety feature becomes silently inert. The platform
    // probe cannot answer this: text recognition can be available and *this*
    // file still fail to decode.
    markUnscanned(tile);
    return;
  }

  // Sorted here rather than trusted from the wire. Rust sends a severity with
  // each finding precisely so the "worst first" rule is data both sides can
  // enforce, instead of an ordering that anything touching the list in
  // between could silently undo.
  const findings = [...result.secrets].sort((a, b) => b.severity - a.severity);
  if (findings.length === 0) return;

  tile.classList.add("tile--secret");
  tile.append(marker(findings));
}

/**
 * Mark a capture that could not be read.
 *
 * Quiet on purpose — this is not a warning about the capture, it is the
 * absence of one — but present, because a card with no marker at all is a card
 * that claims to have been checked.
 */
function markUnscanned(tile: HTMLElement): void {
  const el = document.createElement("span");
  el.className = "tile__unscanned";
  el.title = "This capture could not be read, so it was not checked for credentials.";
  el.textContent = "?";
  tile.append(el);
}
