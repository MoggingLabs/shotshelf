/**
 * Re-asking Rust for something start-up has not finished setting up yet.
 *
 * Tauri creates the window *before* `setup` runs, so the webview asks for
 * settings and for the catch engine while both are still being managed. Two
 * modules learned that independently and each grew its own loop — same shape,
 * different budgets, and they drifted: one retried only a specific transient
 * message and one retried permanent failures too; one slept after its final
 * attempt and one did not. A comment in the second even documented the
 * divergence rather than closing it.
 *
 * One loop, then, with the *budget* named at each call site — because that is
 * the part that genuinely differs, and stating it there is what makes the
 * difference reviewable instead of accidental.
 */

/** What a caller is willing to wait, and what counts as "not yet". */
export interface Wait {
  /** How many attempts, including the first. */
  attempts: number;
  /** How long between them, in milliseconds. */
  everyMs: number;
  /**
   * Whether an error means "ask again".
   *
   * Required, and deliberately not defaulted to "retry anything": a loop that
   * re-asks a *permanent* failure turns a clear error into a long wait and
   * then the same error. `readStored` did that for twenty attempts.
   */
  transient(error: unknown): boolean;
}

/**
 * Run `ask` until it succeeds, the budget runs out, or the error is permanent.
 *
 * Rethrows the last error rather than a wrapper, so the caller reports what
 * actually went wrong. Never sleeps after the final attempt.
 */
export async function until<T>(ask: () => Promise<T>, wait: Wait): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < wait.attempts; attempt += 1) {
    try {
      return await ask();
    } catch (error) {
      last = error;
      if (!wait.transient(error)) break;
      if (attempt === wait.attempts - 1) break;
      await new Promise((resume) => setTimeout(resume, wait.everyMs));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}
