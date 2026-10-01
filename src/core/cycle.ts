// Priority ranking for the `cycle` command. Pure (no tmux/fs) so it is unit
// testable in isolation.
//
// Ordering is seen-major: unseen panes come first, then already-seen panes. The
// `cycle` command then rings over the unseen panes first (highest-priority
// first) and, once none remain unacknowledged, falls back to traversing the full
// ranked list so every agent pane is still reachable. Within each seen group,
// panes are ordered by attention tier (highest first), then oldest `statusSince`
// first (true FIFO — a long-waiting pane is never starved by newer arrivals):
//   0 waiting-question / waiting-input · 1 idle · 2 new · 3 running · 4 unknown
//
// "seen" means the pane was the active pane at some point since it entered its
// current status; it resets when the status changes (see cycle-ledger).
//
// Waiting panes are exempt from the seen demotion: they always sort as unseen.
// Glancing at an idle/new/running pane acknowledges it (review done), but
// glancing at a pane blocked on a prompt discharges nothing — only replying
// does — so a still-waiting pane must never sink below an unseen lower tier.

import type { CycleLedger } from "./cycle-ledger.ts";
import type { PaneRuntimeSummary, PaneTarget, RuntimeStatus } from "../types.ts";

function getCycleTier(status: RuntimeStatus): number {
  switch (status) {
    case "waiting-question":
    case "waiting-input":
      return 0;
    case "idle":
      return 1;
    case "new":
      return 2;
    case "running":
      return 3;
    default:
      return 4;
  }
}

// Effective "seen" rank for ordering: 0 sorts ahead of 1. A waiting pane is
// never demoted for having been looked at, since a glance does not discharge a
// pending prompt.
function getSeenRank(summary: PaneRuntimeSummary, ledger: CycleLedger): number {
  if (getCycleTier(summary.runtime.status) === 0) {
    return 0;
  }
  return ledger.get(summary.pane.paneId)?.seen ? 1 : 0;
}

/**
 * Rank panes into the cycle queue. Unseen panes first, then seen panes; within
 * each group, highest-attention tier first, then oldest `statusSince` first.
 * Waiting panes always sort as unseen (a glance does not acknowledge a prompt).
 */
export function rankPanesForCycle(
  summaries: PaneRuntimeSummary[],
  ledger: CycleLedger,
): PaneRuntimeSummary[] {
  return [...summaries].sort((left, right) => {
    const leftSeen = getSeenRank(left, ledger);
    const rightSeen = getSeenRank(right, ledger);
    if (leftSeen !== rightSeen) {
      return leftSeen - rightSeen;
    }

    const leftTier = getCycleTier(left.runtime.status);
    const rightTier = getCycleTier(right.runtime.status);
    if (leftTier !== rightTier) {
      return leftTier - rightTier;
    }

    const leftSince = ledger.get(left.pane.paneId)?.statusSince ?? 0;
    const rightSince = ledger.get(right.pane.paneId)?.statusSince ?? 0;
    if (leftSince !== rightSince) {
      return leftSince - rightSince;
    }

    return left.pane.target.localeCompare(right.pane.target);
  });
}

/**
 * Pick the next pane to jump to from a ranked queue, given the current pane.
 * Skips the current pane so a press always moves; returns the first ranked pane
 * when the current pane is not in the queue (e.g. focus is on a non-agent pane).
 *
 * Membership of the "unseen ring" uses the raw `ledger.seen` flag, NOT
 * `getSeenRank`. They are deliberately different: `getSeenRank` exempts tier 0
 * (waiting panes) from the seen demotion so a prompt always *sorts* above an
 * unseen lower tier. Reusing that for ring membership would keep a waiting pane
 * in the ring forever, so with a single pending prompt cycling would oscillate
 * between it and one partner pane and never reach the rest. Using raw `seen`
 * lets the ring drain: unseen panes are visited first (in ranked order), then
 * once none remain the ring falls back to the full list. A waiting pane still
 * gets priority once while unseen, then releases after a glance.
 */
export function pickNextCyclePane(
  ranked: PaneRuntimeSummary[],
  currentTarget: PaneTarget | null,
  ledger: CycleLedger,
): PaneRuntimeSummary | null {
  if (ranked.length === 0) {
    return null;
  }

  // Prefer the unseen ring, but fall through to the full ranked list when it
  // holds no pane other than the current one (otherwise cycle would go dead
  // when you are sitting on the only unacknowledged pane).
  const unseen = ranked.filter((entry) => !ledger.get(entry.pane.paneId)?.seen);
  const hasOtherUnseen = unseen.some((entry) => entry.pane.target !== currentTarget);
  const ring = hasOtherUnseen ? unseen : ranked;

  if (currentTarget === null) {
    return ring[0] ?? null;
  }

  const currentIndex = ring.findIndex((entry) => entry.pane.target === currentTarget);
  if (currentIndex === -1) {
    return ring[0] ?? null;
  }

  if (ring.length === 1) {
    return null;
  }

  return ring[(currentIndex + 1) % ring.length] ?? null;
}
