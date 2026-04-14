import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { capturePanePreview } from "./tmux.ts";
import type {
  DiscoveredPane,
  PaneRuntimeSummary,
  RuntimeInfo,
  RuntimeStatus,
  SessionMatch,
  TmuxPane,
} from "../types.ts";

interface PiStateFile {
  activity?: RuntimeInfo["activity"];
  detail?: string;
  directory?: string;
  paneId?: string | null;
  sessionFile?: string | null;
  sourceEventType?: string;
  status?: RuntimeStatus;
  target?: string | null;
  title?: string;
  updatedAt?: number;
  version?: number;
}

interface PiStateIndex {
  exactPaneIdMatches: Map<string, PiStateFile>;
  exactTargetMatches: Map<string, PiStateFile>;
  statesByDirectory: Map<string, PiStateFile[]>;
}

function createPiRuntimeInfo(input: {
  activity: RuntimeInfo["activity"];
  status: RuntimeStatus;
  source: RuntimeInfo["source"];
  strategy: RuntimeInfo["match"]["strategy"];
  provider: RuntimeInfo["match"]["provider"];
  heuristic: boolean;
  session: SessionMatch | null;
  detail: string;
}): RuntimeInfo {
  return {
    activity: input.activity,
    status: input.status,
    source: input.source,
    match: {
      strategy: input.strategy,
      provider: input.provider,
      heuristic: input.heuristic,
    },
    session: input.session,
    detail: input.detail,
  };
}

function getPiStateUpdatedAt(state: PiStateFile): number {
  return state.updatedAt ?? 0;
}

function pickNewerPiState(current: PiStateFile | undefined, candidate: PiStateFile): PiStateFile {
  if (!current || getPiStateUpdatedAt(candidate) > getPiStateUpdatedAt(current)) {
    return candidate;
  }

  return current;
}

export function getPiStateDir(): string {
  const stateHome =
    process.env.OPENCODE_TMUX_PI_STATE_DIR ??
    process.env.XDG_STATE_HOME ??
    join(homedir(), ".local", "state");

  return process.env.OPENCODE_TMUX_PI_STATE_DIR
    ? stateHome
    : join(stateHome, "opencode-tmux", "pi-state");
}

function readPiStates(): PiStateFile[] {
  const stateDir = getPiStateDir();

  if (!existsSync(stateDir)) {
    return [];
  }

  return readdirSync(stateDir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => join(stateDir, entry))
    .map((filePath) => {
      try {
        return JSON.parse(readFileSync(filePath, "utf8")) as PiStateFile;
      } catch {
        return null;
      }
    })
    .filter((state): state is PiStateFile => Boolean(state?.directory));
}

function buildPiStateIndex(states = readPiStates()): PiStateIndex {
  const exactPaneIdMatches = new Map<string, PiStateFile>();
  const exactTargetMatches = new Map<string, PiStateFile>();
  const statesByDirectory = new Map<string, PiStateFile[]>();

  for (const state of states) {
    const directory = state.directory;

    if (!directory) {
      continue;
    }

    const directoryStates = statesByDirectory.get(directory) ?? [];
    directoryStates.push(state);
    statesByDirectory.set(directory, directoryStates);

    if (state.paneId) {
      exactPaneIdMatches.set(
        state.paneId,
        pickNewerPiState(exactPaneIdMatches.get(state.paneId), state),
      );
    }

    if (state.target) {
      exactTargetMatches.set(
        state.target,
        pickNewerPiState(exactTargetMatches.get(state.target), state),
      );
    }
  }

  return {
    exactPaneIdMatches,
    exactTargetMatches,
    statesByDirectory,
  };
}

function toPiSessionMatch(state: PiStateFile): SessionMatch | null {
  if (!state.directory || !state.title) {
    return null;
  }

  return {
    id: state.sessionFile ?? `pi:${state.directory}`,
    directory: state.directory,
    title: state.title,
    timeUpdated: state.updatedAt ?? Date.now(),
  };
}

function classifyPiState(
  state: PiStateFile | null,
  input: {
    detail: string;
    heuristic: boolean;
    strategy: RuntimeInfo["match"]["strategy"];
  },
): RuntimeInfo {
  if (!state?.directory) {
    return createPiRuntimeInfo({
      activity: "unknown",
      status: "unknown",
      source: "unmapped",
      strategy: "unmapped",
      provider: "none",
      heuristic: false,
      session: null,
      detail: input.detail,
    });
  }

  const status = state.status ?? "unknown";
  const activity =
    state.activity ??
    (status === "idle" || status === "new" ? "idle" : status === "unknown" ? "unknown" : "busy");

  return createPiRuntimeInfo({
    activity,
    status,
    source: "pi-extension",
    strategy: input.strategy,
    provider: "pi",
    heuristic: input.heuristic,
    session: toPiSessionMatch(state),
    detail: state.detail ?? input.detail,
  });
}

function getExactPiState(index: PiStateIndex, pane: TmuxPane): PiStateFile | null {
  const targetState = index.exactTargetMatches.get(pane.target);

  if (targetState) {
    return targetState;
  }

  const paneIdState = index.exactPaneIdMatches.get(pane.paneId);

  if (paneIdState) {
    return paneIdState;
  }

  return null;
}

function getDirectoryFallbackPiState(index: PiStateIndex, pane: TmuxPane): PiStateFile | null {
  const states = index.statesByDirectory.get(pane.currentPath) ?? [];

  if (states.length !== 1) {
    return null;
  }

  return states[0] ?? null;
}

function classifyPiPreview(
  lines: string[],
): Pick<RuntimeInfo, "activity" | "detail" | "status"> | null {
  const nonEmptyLines = lines.map((line) => line.trim()).filter(Boolean);
  const recentLines = nonEmptyLines.slice(-6);
  const recentText = recentLines.join("\n");
  const recentLower = recentText.toLowerCase();
  const lastLine = recentLines.at(-1) ?? "";

  if (
    /\?\s*$/.test(lastLine) ||
    ["would you like", "do you want", "should i", "please confirm", "can you", "could you"].some(
      (fragment) => recentLower.includes(fragment),
    )
  ) {
    return {
      activity: "busy",
      detail: "Pi appears to be waiting for user input",
      status: "waiting-input",
    };
  }

  return null;
}

function createPiPreviewRuntime(
  preview: Pick<RuntimeInfo, "activity" | "detail" | "status">,
): RuntimeInfo {
  return createPiRuntimeInfo({
    activity: preview.activity,
    status: preview.status,
    source: "pi-preview",
    strategy: "exact",
    provider: "pi",
    heuristic: true,
    session: null,
    detail: preview.detail,
  });
}

async function loadPiPreviewRuntime(target: TmuxPane["target"]): Promise<RuntimeInfo | null> {
  try {
    const lines = await capturePanePreview(target, 24);
    const preview = classifyPiPreview(lines);
    return preview ? createPiPreviewRuntime(preview) : null;
  } catch {
    return null;
  }
}

export async function attachRuntimeWithPi(
  panes: DiscoveredPane[],
  index = buildPiStateIndex(),
): Promise<PaneRuntimeSummary[]> {
  return Promise.all(
    panes.map(async (entry) => {
      const exactState = getExactPiState(index, entry.pane);

      if (exactState) {
        return {
          ...entry,
          runtime: classifyPiState(exactState, {
            detail: "matched Pi extension state by target or pane id",
            heuristic: false,
            strategy: "exact",
          }),
        };
      }

      const directoryState = getDirectoryFallbackPiState(index, entry.pane);

      if (directoryState) {
        return {
          ...entry,
          runtime: classifyPiState(directoryState, {
            detail: "matched unique Pi extension state by pane cwd",
            heuristic: true,
            strategy: "exact",
          }),
        };
      }

      const previewRuntime = await loadPiPreviewRuntime(entry.pane.target);

      if (previewRuntime) {
        return {
          ...entry,
          runtime: previewRuntime,
        };
      }

      return {
        ...entry,
        runtime: createPiRuntimeInfo({
          activity: "busy",
          status: "running",
          source: "pi-command",
          strategy: "exact",
          provider: "pi",
          heuristic: false,
          session: null,
          detail: `detected ${entry.pane.currentCommand} process in tmux pane`,
        }),
      };
    }),
  );
}
