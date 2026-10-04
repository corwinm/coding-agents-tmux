import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { computeObservation, observePane, readCycleLedger } from "../src/core/cycle-ledger.ts";

function withCycleStateDir<T>(fn: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-cycle-ledger-"));
  const previous = process.env.CODING_AGENTS_TMUX_CYCLE_STATE_DIR;
  process.env.CODING_AGENTS_TMUX_CYCLE_STATE_DIR = dir;

  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.CODING_AGENTS_TMUX_CYCLE_STATE_DIR;
    } else {
      process.env.CODING_AGENTS_TMUX_CYCLE_STATE_DIR = previous;
    }
  }
}

test("computeObservation resets statusSince and seen on a status change", () => {
  const next = computeObservation(
    { observedStatus: "running", statusSince: 100, seen: true },
    "idle",
    false,
    500,
  );

  assert.deepEqual(next, {
    observedStatus: "idle",
    statusSince: 500,
    seen: false,
    version: 1,
  });
});

test("computeObservation marks seen when the current pane matches an unchanged status", () => {
  const next = computeObservation(
    { observedStatus: "idle", statusSince: 100, seen: false },
    "idle",
    true,
    500,
  );

  assert.equal(next?.seen, true);
  assert.equal(next?.statusSince, 100);
});

test("computeObservation returns null when nothing needs to change", () => {
  assert.equal(
    computeObservation({ observedStatus: "idle", statusSince: 100, seen: true }, "idle", true, 500),
    null,
  );
  assert.equal(
    computeObservation(
      { observedStatus: "idle", statusSince: 100, seen: false },
      "idle",
      false,
      500,
    ),
    null,
  );
});

test("observePane persists and readCycleLedger reads back by pane id", () => {
  withCycleStateDir(() => {
    observePane("%42", "waiting-question", false, 1000);
    const ledger = readCycleLedger();
    const entry = ledger.get("%42");

    assert.equal(entry?.observedStatus, "waiting-question");
    assert.equal(entry?.statusSince, 1000);
    assert.equal(entry?.seen, false);
  });
});

test("observePane no-ops leave the prior record intact", () => {
  withCycleStateDir(() => {
    observePane("%7", "idle", false, 1000);
    observePane("%7", "idle", false, 2000);
    const entry = readCycleLedger().get("%7");

    assert.equal(entry?.statusSince, 1000);
  });
});
