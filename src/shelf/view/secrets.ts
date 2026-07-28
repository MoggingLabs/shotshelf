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
import type { SecretFinding } from "../types.ts";

/** How the warning describes what it found, worst first. */
function summarise(findings: readonly SecretFinding[]): string {
  const [worst] = findings;
  if (!worst) return "";

  const rest = findings.length - 1;
  const tail =
    rest === 0 ? "" : ` and ${rest} other${rest === 1 ? "" : "s"}`;

  return [
    `Looks like this capture contains a ${worst.label}${tail}.`,
    `Found: ${worst.preview}`,
    "Shotshelf will still drag and copy it — check before you send it.",
  ].join("\n");
}

function marker(findings: readonly SecretFinding[]): HTMLElement {
  const el = document.createElement("span");
  el.className = "tile__secret";
  el.dataset["kind"] = findings[0]?.kind ?? "";
  el.title = summarise(findings);
  el.append(icon("alert", 11));

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
  let findings: SecretFinding[];
  try {
    findings = (await describeCapture(path)).secrets;
  } catch {
    return;
  }

  if (findings.length === 0) return;

  tile.classList.add("tile--secret");
  tile.append(marker(findings));
}
