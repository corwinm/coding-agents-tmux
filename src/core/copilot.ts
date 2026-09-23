import { basename } from "node:path";

import type { DiscoveredPane, PaneRuntimeSummary } from "../types.ts";

export function attachRuntimeWithCopilot(panes: DiscoveredPane[]): PaneRuntimeSummary[] {
  return panes.map((entry) => ({
    ...entry,
    runtime: {
      activity: "unknown",
      status: "unknown",
      source: "copilot-command",
      match: { strategy: "exact", provider: "copilot", heuristic: false },
      session: {
        id: `copilot:${entry.pane.target}`,
        directory: entry.pane.currentPath,
        title: basename(entry.pane.currentPath) || "Copilot CLI",
        timeUpdated: Date.now(),
      },
      detail: "Copilot CLI process detected; turn and attention state unavailable without hooks",
    },
  }));
}
