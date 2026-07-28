import assert from "node:assert/strict";
import { test } from "node:test";

import { OverlayTicket } from "./overlay-ticket.ts";

/**
 * The rules two overlays used to keep separate copies of, and drifted on.
 *
 * Each case below is a bug that shipped in one module while the other was
 * already fixed.
 */

test("an open in flight counts as open", () => {
  const lifetime = new OverlayTicket();
  assert.equal(lifetime.opening, false);
  lifetime.begin();
  assert.equal(lifetime.opening, true);
});

test("backing out clears the in-flight open, so the keyboard is not left dead", () => {
  // The editor learned this and the quick look did not: a close that bumped
  // the ticket but left `opening` true made "is the overlay up?" answer yes
  // for ever, and the keydown handler routes on that answer.
  const lifetime = new OverlayTicket();
  lifetime.begin();

  assert.equal(lifetime.close(), true, "it consumed a pending open");
  assert.equal(lifetime.opening, false);
});

test("discarding clears it too", () => {
  const lifetime = new OverlayTicket();
  lifetime.begin();

  lifetime.discard();
  assert.equal(lifetime.opening, false);
});

test("a close reports whether it consumed a gesture", () => {
  const lifetime = new OverlayTicket();
  assert.equal(lifetime.close(), false, "nothing was opening");
  lifetime.begin();
  assert.equal(lifetime.close(), true);
});

test("an open in flight goes stale when anything ends it", () => {
  const lifetime = new OverlayTicket();
  const mine = lifetime.begin();
  assert.equal(lifetime.stale(mine), false);

  lifetime.close();
  assert.equal(lifetime.stale(mine), true, "a close supersedes it");

  const next = lifetime.begin();
  assert.equal(lifetime.stale(next), false);
  lifetime.discard();
  assert.equal(lifetime.stale(next), true, "a discard supersedes it too");
});

test("backing out owes the window back; the window going away does not", () => {
  // One ticket said *that* an open was superseded and not by what, so a
  // cancelled open re-showed a window the user had just dismissed.
  const lifetime = new OverlayTicket();

  lifetime.begin();
  lifetime.close();
  assert.equal(lifetime.abandoned, false, "the user backed out");

  lifetime.begin();
  lifetime.discard();
  assert.equal(lifetime.abandoned, true, "the window was put away");

  // And a fresh open starts owing again.
  lifetime.begin();
  assert.equal(lifetime.abandoned, false);
});

test("work started after an open can tell which surface it belongs to", () => {
  // A save composites, encodes and writes across three awaits, then used to
  // close whatever happened to be live — tearing down a different editor
  // opened in the meantime.
  const lifetime = new OverlayTicket();
  lifetime.begin();
  const savingThis = lifetime.current;

  lifetime.close();
  lifetime.begin();

  assert.equal(lifetime.stale(savingThis), true, "the save is for the old one");
});
