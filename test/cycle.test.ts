import assert from "node:assert/strict";
import test from "node:test";

import type { CycleLedger, CycleLedgerEntry } from "../src/core/cycle-ledger.ts";
import { pickNextCyclePane, rankPanesForCycle } from "../src/core/cycle.ts";
import type { PaneRuntimeSummary, PaneTarget, RuntimeStatus, TmuxPane } from "../src/types.ts";

function createPane(target: PaneTarget, paneId: string): TmuxPane {
  const [sessionWindow, paneIndexRaw] = target.split(".");
  const [sessionName, windowIndexRaw] = (sessionWindow ?? "").split(":");

  return {
    sessionName: sessionName ?? "",
    windowIndex: Number(windowIndexRaw),
    paneIndex: Number(paneIndexRaw),
    paneId,
    paneTitle: "OpenCode",
    currentCommand: "opencode",
    currentPath: "/tmp/project",
    isActive: false,
    tty: "/dev/ttys001",
    target,
  };
}

function createSummary(
  target: PaneTarget,
  paneId: string,
  status: RuntimeStatus,
): PaneRuntimeSummary {
  return {
    pane: createPane(target, paneId),
    detection: { agent: "opencode", confidence: "high", reasons: [] },
    runtime: {
      activity: status === "idle" || status === "new" ? "idle" : "busy",
      status,
      source: "plugin-exact",
      match: { strategy: "exact", provider: "plugin", heuristic: false },
      session: null,
      detail: `runtime:${status}`,
    },
  };
}

function ledgerOf(entries: Record<string, Partial<CycleLedgerEntry>>): CycleLedger {
  const ledger: CycleLedger = new Map();
  for (const [paneId, entry] of Object.entries(entries)) {
    ledger.set(paneId, {
      observedStatus: entry.observedStatus ?? "idle",
      statusSince: entry.statusSince ?? 0,
      seen: entry.seen ?? false,
    });
  }
  return ledger;
}

test("rankPanesForCycle orders by tier: waiting > idle > new > running > unknown", () => {
  const panes = [
    createSummary("work:1.0", "%1", "running"),
    createSummary("work:1.1", "%2", "idle"),
    createSummary("work:1.2", "%3", "waiting-input"),
    createSummary("work:1.3", "%4", "unknown"),
    createSummary("work:1.4", "%5", "new"),
  ];

  const ranked = rankPanesForCycle(panes, ledgerOf({}));

  assert.deepEqual(
    ranked.map((entry) => entry.pane.paneId),
    ["%3", "%2", "%5", "%1", "%4"],
  );
});

test("rankPanesForCycle sorts oldest statusSince first within a tier (true FIFO)", () => {
  const panes = [
    createSummary("work:1.0", "%new", "waiting-question"),
    createSummary("work:1.1", "%old", "waiting-question"),
  ];
  const ledger = ledgerOf({
    "%new": { observedStatus: "waiting-question", statusSince: 500 },
    "%old": { observedStatus: "waiting-question", statusSince: 100 },
  });

  const ranked = rankPanesForCycle(panes, ledger);

  assert.deepEqual(
    ranked.map((entry) => entry.pane.paneId),
    ["%old", "%new"],
  );
});

test("rankPanesForCycle keeps a seen waiting pane ahead of an unseen lower tier", () => {
  const panes = [
    createSummary("work:1.0", "%seenWaiting", "waiting-input"),
    createSummary("work:1.1", "%unseenRunning", "running"),
  ];
  const ledger = ledgerOf({
    "%seenWaiting": { observedStatus: "waiting-input", seen: true },
    "%unseenRunning": { observedStatus: "running", seen: false },
  });

  const ranked = rankPanesForCycle(panes, ledger);

  assert.deepEqual(
    ranked.map((entry) => entry.pane.paneId),
    ["%seenWaiting", "%unseenRunning"],
  );
});

test("rankPanesForCycle keeps a seen waiting pane ahead of an unseen idle pane", () => {
  const panes = [
    createSummary("work:1.0", "%unseenIdle", "idle"),
    createSummary("work:1.1", "%seenWaiting", "waiting-question"),
  ];
  const ledger = ledgerOf({
    "%unseenIdle": { observedStatus: "idle", seen: false },
    "%seenWaiting": { observedStatus: "waiting-question", seen: true },
  });

  const ranked = rankPanesForCycle(panes, ledger);

  assert.deepEqual(
    ranked.map((entry) => entry.pane.paneId),
    ["%seenWaiting", "%unseenIdle"],
  );
});

test("rankPanesForCycle keeps seen-major order among non-waiting tiers", () => {
  const panes = [
    createSummary("work:1.0", "%seenIdle", "idle"),
    createSummary("work:1.1", "%seenWaiting", "waiting-input"),
    createSummary("work:1.2", "%unseenRunning", "running"),
    createSummary("work:1.3", "%unseenWaiting", "waiting-question"),
  ];
  const ledger = ledgerOf({
    "%seenIdle": { observedStatus: "idle", seen: true },
    "%seenWaiting": { observedStatus: "waiting-input", seen: true },
    "%unseenRunning": { observedStatus: "running", seen: false },
    "%unseenWaiting": { observedStatus: "waiting-question", seen: false },
  });

  const ranked = rankPanesForCycle(panes, ledger);

  assert.deepEqual(
    ranked.map((entry) => entry.pane.paneId),
    ["%seenWaiting", "%unseenWaiting", "%unseenRunning", "%seenIdle"],
  );
});

test("rankPanesForCycle plus pickNextCyclePane visits every pane once before repeating", () => {
  const panes = [
    createSummary("work:1.0", "%1", "waiting-input"),
    createSummary("work:1.1", "%2", "idle"),
    createSummary("work:1.2", "%3", "running"),
  ];
  const ledger = ledgerOf({
    "%1": { observedStatus: "waiting-input", seen: true },
    "%2": { observedStatus: "idle", seen: true },
    "%3": { observedStatus: "running", seen: true },
  });

  const ranked = rankPanesForCycle(panes, ledger);
  const order = ranked.map((entry) => entry.pane.target as PaneTarget);
  const visited: string[] = [];
  let current = order[0] ?? null;

  for (let step = 0; step < order.length; step += 1) {
    const next = pickNextCyclePane(ranked, current, ledger);
    assert.ok(next);
    visited.push(next.pane.paneId);
    current = next.pane.target as PaneTarget;
  }

  assert.deepEqual(new Set(visited).size, ranked.length);
});

test("pickNextCyclePane advances past the current pane and wraps around", () => {
  const ranked = [
    createSummary("work:1.0", "%1", "waiting-input"),
    createSummary("work:1.1", "%2", "idle"),
    createSummary("work:1.2", "%3", "new"),
  ];
  const ledger = ledgerOf({});

  assert.equal(pickNextCyclePane(ranked, "work:1.0", ledger)?.pane.paneId, "%2");
  assert.equal(pickNextCyclePane(ranked, "work:1.2", ledger)?.pane.paneId, "%1");
});

test("pickNextCyclePane returns the first pane when current is not in the queue", () => {
  const ranked = [
    createSummary("work:1.0", "%1", "waiting-input"),
    createSummary("work:1.1", "%2", "idle"),
  ];
  const ledger = ledgerOf({});

  assert.equal(pickNextCyclePane(ranked, "work:9.9", ledger)?.pane.paneId, "%1");
  assert.equal(pickNextCyclePane(ranked, null, ledger)?.pane.paneId, "%1");
});

test("pickNextCyclePane returns null for an empty queue or a single current pane", () => {
  assert.equal(pickNextCyclePane([], "work:1.0", ledgerOf({})), null);

  const single = [createSummary("work:1.0", "%1", "idle")];
  assert.equal(pickNextCyclePane(single, "work:1.0", ledgerOf({})), null);
});

test("pickNextCyclePane reaches an unseen pane first from a seen pane", () => {
  const panes = [
    createSummary("work:1.0", "%seenIdle", "idle"),
    createSummary("work:1.1", "%unseenIdle", "idle"),
  ];
  const ledger = ledgerOf({
    "%seenIdle": { observedStatus: "idle", seen: true },
    "%unseenIdle": { observedStatus: "idle", seen: false },
  });

  const ranked = rankPanesForCycle(panes, ledger);
  // From the seen pane, the ring is just [%unseenIdle]; jump straight to it
  // rather than walking the full list.
  assert.equal(pickNextCyclePane(ranked, "work:1.0", ledger)?.pane.paneId, "%unseenIdle");
});

test("pickNextCyclePane drains the unseen ring then falls through to the full ring", () => {
  const panes = [
    createSummary("work:1.0", "%seen", "idle"),
    createSummary("work:1.1", "%unseenA", "idle"),
    createSummary("work:1.2", "%unseenB", "idle"),
  ];
  const ledger = ledgerOf({
    "%seen": { observedStatus: "idle", statusSince: 1, seen: true },
    "%unseenA": { observedStatus: "idle", statusSince: 2, seen: false },
    "%unseenB": { observedStatus: "idle", statusSince: 3, seen: false },
  });

  // First two presses stay within the unseen ring (oldest-first: A then B).
  let ranked = rankPanesForCycle(panes, ledger);
  const first = pickNextCyclePane(ranked, "work:1.0", ledger);
  assert.equal(first?.pane.paneId, "%unseenA");

  ledger.set("%unseenA", { observedStatus: "idle", statusSince: 2, seen: true });
  ranked = rankPanesForCycle(panes, ledger);
  const second = pickNextCyclePane(ranked, first?.pane.target ?? null, ledger);
  assert.equal(second?.pane.paneId, "%unseenB");

  // Once the last unseen pane is visited, the ring falls through to the full
  // list so every pane stays reachable.
  ledger.set("%unseenB", { observedStatus: "idle", statusSince: 3, seen: true });
  ranked = rankPanesForCycle(panes, ledger);
  const visited = new Set<string>();
  let current: PaneTarget | null = (second?.pane.target as PaneTarget) ?? null;
  for (let step = 0; step < ranked.length; step += 1) {
    const next = pickNextCyclePane(ranked, current, ledger);
    assert.ok(next);
    visited.add(next.pane.paneId);
    current = next.pane.target as PaneTarget;
  }
  assert.deepEqual(visited.size, ranked.length);
});

test("pickNextCyclePane with one pending prompt still reaches every pane (no oscillation)", () => {
  // Regression guard: a lone waiting pane is tier-0 seen-exempt for ordering,
  // but ring membership uses raw `seen`, so a seen prompt does not trap cycling
  // in a two-pane oscillation. The current pane is marked seen before ranking
  // (mirrors runCycleCommand), so here every pane is seen.
  const panes = [
    createSummary("work:1.0", "%prompt", "waiting-input"),
    createSummary("work:1.1", "%idleA", "idle"),
    createSummary("work:1.2", "%idleB", "idle"),
  ];
  const ledger = ledgerOf({
    "%prompt": { observedStatus: "waiting-input", statusSince: 1, seen: true },
    "%idleA": { observedStatus: "idle", statusSince: 2, seen: true },
    "%idleB": { observedStatus: "idle", statusSince: 3, seen: true },
  });

  const ranked = rankPanesForCycle(panes, ledger);
  const visited = new Set<string>();
  let current: PaneTarget | null = "work:1.0";
  for (let step = 0; step < ranked.length; step += 1) {
    const next = pickNextCyclePane(ranked, current, ledger);
    assert.ok(next);
    visited.add(next.pane.paneId);
    current = next.pane.target as PaneTarget;
  }
  assert.deepEqual(visited.size, ranked.length);
});

test("pickNextCyclePane falls through when the only unseen pane is the current one", () => {
  // Sitting on the sole unacknowledged pane: the unseen ring collapses to just
  // the current pane, so cycle must fall through to the full ring rather than
  // returning null (going dead).
  const panes = [
    createSummary("work:1.0", "%unseenCurrent", "waiting-input"),
    createSummary("work:1.1", "%seenIdle", "idle"),
  ];
  const ledger = ledgerOf({
    "%unseenCurrent": { observedStatus: "waiting-input", seen: false },
    "%seenIdle": { observedStatus: "idle", seen: true },
  });

  const ranked = rankPanesForCycle(panes, ledger);
  const next = pickNextCyclePane(ranked, "work:1.0", ledger);
  assert.equal(next?.pane.paneId, "%seenIdle");
});
