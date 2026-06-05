import { getClaudeStateDir, attachRuntimeWithClaude } from "./claude.ts";
import { getCodexStateDir } from "./codex.ts";
import { attachRuntimeWithKiro } from "./kiro.ts";
import {
  attachRuntimeWithCodex,
  attachRuntimeWithOpencodeProvider,
  getPluginStateDir,
} from "./opencode.ts";
import { attachRuntimeWithPi } from "./pi.ts";
import { PRIMARY_CLI_NAME } from "../naming.ts";
import type { DiscoveredPane, PaneRuntimeSummary, RuntimeProviderOptions } from "../types.ts";

export async function attachRuntimeToPanes(
  panes: DiscoveredPane[],
  options: RuntimeProviderOptions = {},
): Promise<PaneRuntimeSummary[]> {
  const opencodePanes = panes.filter((entry) => entry.detection.agent === "opencode");
  const codexPanes = panes.filter((entry) => entry.detection.agent === "codex");
  const piPanes = panes.filter((entry) => entry.detection.agent === "pi");
  const claudePanes = panes.filter((entry) => entry.detection.agent === "claude");
  const kiroPanes = panes.filter((entry) => entry.detection.agent === "kiro");

  const resultGroups = await Promise.all([
    opencodePanes.length > 0 ? attachRuntimeWithOpencodeProvider(opencodePanes, options) : [],
    codexPanes.length > 0 ? attachRuntimeWithCodex(codexPanes) : [],
    piPanes.length > 0 ? attachRuntimeWithPi(piPanes) : [],
    claudePanes.length > 0 ? attachRuntimeWithClaude(claudePanes) : [],
    kiroPanes.length > 0 ? attachRuntimeWithKiro(kiroPanes) : [],
  ]);
  const resultsByTarget = new Map(resultGroups.flat().map((entry) => [entry.pane.target, entry]));

  return panes.map((entry) => {
    const result = resultsByTarget.get(entry.pane.target);

    if (!result) {
      throw new Error(`missing runtime summary for pane ${entry.pane.target}`);
    }

    return result;
  });
}

export function getRuntimeProviderHelpText(): string {
  return [
    "Runtime providers:",
    "  auto    Use plugin state when available, then server endpoints, then sqlite",
    "  plugin  Use opencode plugin state files only",
    "  sqlite  Use local opencode sqlite state only",
    "  server  Use explicit server endpoints only",
    "",
    "Plugin state:",
    `  Default path: ${getPluginStateDir()}`,
    "  Override with CODING_AGENTS_TMUX_STATE_DIR.",
    "",
    "Codex hook state:",
    `  Default path: ${getCodexStateDir()}`,
    "  Override with CODING_AGENTS_TMUX_CODEX_STATE_DIR.",
    `  Generate hooks.json with: ${PRIMARY_CLI_NAME} codex-hooks-template`,
    "",
    "Claude hook state:",
    `  Default path: ${getClaudeStateDir()}`,
    "  Override with CODING_AGENTS_TMUX_CLAUDE_STATE_DIR.",
    `  Generate settings hooks with: ${PRIMARY_CLI_NAME} claude-hooks-template`,
    `  Install global Claude hooks with: ${PRIMARY_CLI_NAME} install-claude`,
    "",
    "Server map:",
    "  Pass --server-map with a JSON object or a path to a JSON file.",
    '  Example: {"work:1.2":"http://127.0.0.1:4096"}',
    "  You can also set CODING_AGENTS_TMUX_SERVER_MAP with the same value.",
  ].join("\n");
}
