import { basename } from "node:path";

import { capturePanePreview } from "./tmux.ts";
import type {
  DiscoveredPane,
  PaneRuntimeSummary,
  RuntimeInfo,
  SessionMatch,
  TmuxPane,
} from "../types.ts";

function createKiroRuntimeInfo(input: {
  activity: RuntimeInfo["activity"];
  status: RuntimeInfo["status"];
  source: RuntimeInfo["source"];
  heuristic: boolean;
  detail: string;
  session: SessionMatch;
}): RuntimeInfo {
  return {
    activity: input.activity,
    status: input.status,
    source: input.source,
    match: {
      strategy: "exact",
      provider: "kiro",
      heuristic: input.heuristic,
    },
    session: input.session,
    detail: input.detail,
  };
}

function createKiroPaneSession(pane: TmuxPane): SessionMatch {
  const title = basename(pane.currentPath) || pane.paneTitle.trim() || "Kiro CLI";

  return {
    id: `kiro:${pane.target}`,
    directory: pane.currentPath,
    title,
    timeUpdated: Date.now(),
  };
}

function countChoiceLines(message: string): number {
  return message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:[›>]\s*)?\d+\.\s+\S/.test(line) || /^(?:[›>]\s*)?[-*]\s+\S/.test(line))
    .length;
}

function classifyKiroPreview(
  lines: string[],
): Pick<RuntimeInfo, "activity" | "detail" | "status"> | null {
  const nonEmptyLines = lines.map((line) => line.trim()).filter(Boolean);
  const recentLines = nonEmptyLines.slice(-10);
  const recentText = recentLines.join("\n");
  const recentLower = recentText.toLowerCase();
  const lastLine = recentLines.at(-1) ?? "";

  if (
    countChoiceLines(recentText) >= 2 ||
    ["permission", "allow", "deny"].every((fragment) => recentLower.includes(fragment)) ||
    ["approval", "trust this", "yes", "no"].every((fragment) => recentLower.includes(fragment))
  ) {
    return {
      activity: "busy",
      detail: "Kiro appears to be waiting for a multiple-choice response",
      status: "waiting-question",
    };
  }

  if (
    /\?\s*$/.test(lastLine) ||
    ["would you like", "do you want", "should i", "please confirm", "what would you like"].some(
      (fragment) => recentLower.includes(fragment),
    )
  ) {
    return {
      activity: "busy",
      detail: "Kiro appears to be waiting for user input",
      status: "waiting-input",
    };
  }

  return null;
}

function createKiroPreviewRuntime(
  preview: Pick<RuntimeInfo, "activity" | "detail" | "status">,
  pane: TmuxPane,
): RuntimeInfo {
  return createKiroRuntimeInfo({
    activity: preview.activity,
    status: preview.status,
    source: "kiro-preview",
    heuristic: true,
    detail: preview.detail,
    session: createKiroPaneSession(pane),
  });
}

async function loadKiroPreviewRuntime(pane: TmuxPane): Promise<RuntimeInfo | null> {
  try {
    const lines = await capturePanePreview(pane.target, 24);
    const preview = classifyKiroPreview(lines);
    return preview ? createKiroPreviewRuntime(preview, pane) : null;
  } catch {
    return null;
  }
}

export async function attachRuntimeWithKiro(
  panes: DiscoveredPane[],
): Promise<PaneRuntimeSummary[]> {
  return Promise.all(
    panes.map(async (entry) => {
      const previewRuntime = await loadKiroPreviewRuntime(entry.pane);

      if (previewRuntime) {
        return {
          ...entry,
          runtime: previewRuntime,
        };
      }

      return {
        ...entry,
        runtime: createKiroRuntimeInfo({
          activity: "idle",
          status: "idle",
          source: "kiro-command",
          heuristic: false,
          detail: `detected ${entry.pane.currentCommand} process in tmux pane; assuming idle without stronger Kiro state`,
          session: createKiroPaneSession(entry.pane),
        }),
      };
    }),
  );
}
