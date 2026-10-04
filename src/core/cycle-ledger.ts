// Reader-side cycle ledger: tracks per-pane observed status + acknowledgement so
// the `cycle` command can rank panes by priority (oldest-first within a tier)
// and skip panes the user has already seen. Distinct from the agent state
// writers — this is derived from the *displayed* runtime status at read time and
// covers every agent, including ones with no state file (Kiro).
//
// "seen" means the pane was the active tmux pane at some point since it entered
// its current status. It resets whenever the status changes.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getPreferredStateDir, getStateDirCandidates } from "../naming.ts";
import type { RuntimeStatus } from "../types.ts";

const STATE_ENV = "CODING_AGENTS_TMUX_CYCLE_STATE_DIR";
const STATE_SUBDIR = "cycle-state";
const LEDGER_VERSION = 1;

export interface CycleLedgerEntry {
  observedStatus: RuntimeStatus;
  statusSince: number;
  seen: boolean;
  version?: number;
}

export type CycleLedger = Map<string, CycleLedgerEntry>;

function getCycleStateDir(): string {
  return getPreferredStateDir({ env: STATE_ENV, subdirectory: STATE_SUBDIR });
}

function toFileName(paneId: string): string {
  return `pane-${Buffer.from(paneId).toString("hex")}.json`;
}

function readEntry(filePath: string): CycleLedgerEntry | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<CycleLedgerEntry>;
    if (!parsed || typeof parsed.observedStatus !== "string") {
      return null;
    }

    return {
      observedStatus: parsed.observedStatus,
      statusSince: typeof parsed.statusSince === "number" ? parsed.statusSince : 0,
      seen: Boolean(parsed.seen),
      ...(typeof parsed.version === "number" ? { version: parsed.version } : {}),
    };
  } catch {
    return null;
  }
}

/** Load every pane's ledger entry, keyed by hex-encoded pane id filename. */
export function readCycleLedger(): CycleLedger {
  const ledger: CycleLedger = new Map();

  for (const stateDir of getStateDirCandidates({ env: STATE_ENV, subdirectory: STATE_SUBDIR })) {
    if (!existsSync(stateDir)) {
      continue;
    }

    for (const name of readdirSync(stateDir)) {
      if (!name.startsWith("pane-") || !name.endsWith(".json")) {
        continue;
      }

      const paneId = decodePaneIdFromFileName(name);
      if (!paneId) {
        continue;
      }

      const entry = readEntry(join(stateDir, name));
      if (entry) {
        ledger.set(paneId, entry);
      }
    }
  }

  return ledger;
}

function decodePaneIdFromFileName(name: string): string | null {
  const hex = name.slice("pane-".length, -".json".length);
  if (!hex || !/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
    return null;
  }

  try {
    return Buffer.from(hex, "hex").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Compute the next ledger entry for a pane given its currently displayed status.
 * Returns null when no write is needed (keeps the frequent status path cheap).
 */
export function computeObservation(
  previous: CycleLedgerEntry | null,
  status: RuntimeStatus,
  isCurrent: boolean,
  now: number,
): CycleLedgerEntry | null {
  if (!previous || previous.observedStatus !== status) {
    return { observedStatus: status, statusSince: now, seen: isCurrent, version: LEDGER_VERSION };
  }

  if (isCurrent && !previous.seen) {
    return { ...previous, seen: true, version: LEDGER_VERSION };
  }

  return null;
}

/** Record an observation for a pane, writing atomically only when something changed. */
export function observePane(
  paneId: string,
  status: RuntimeStatus,
  isCurrent: boolean,
  now: number = Date.now(),
): void {
  const stateDir = getCycleStateDir();
  const filePath = join(stateDir, toFileName(paneId));
  const next = computeObservation(readEntry(filePath), status, isCurrent, now);

  if (!next) {
    return;
  }

  mkdirSync(stateDir, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, JSON.stringify(next, null, 2), "utf8");
  renameSync(tempPath, filePath);
}
