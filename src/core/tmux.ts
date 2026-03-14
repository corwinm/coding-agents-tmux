import type { DiscoveredPane, DetectionConfidence, PaneTarget, PaneDetection, TmuxPane } from "../types.ts";
import { runCommand } from "../runtime.ts";

const TMUX_FIELDS = [
  "#{session_name}",
  "#{window_index}",
  "#{pane_index}",
  "#{pane_id}",
  "#{pane_title}",
  "#{pane_current_command}",
  "#{pane_current_path}",
  "#{pane_active}",
  "#{pane_tty}",
] as const;

function formatConfidence(reasons: string[]): DetectionConfidence {
  if (reasons.some((reason) => reason.startsWith("title:"))) {
    return "high";
  }

  if (reasons.length >= 2) {
    return "medium";
  }

  return "low";
}

export function detectOpencodePane(pane: TmuxPane): PaneDetection {
  const reasons: string[] = [];
  const title = pane.paneTitle.trim();
  const path = pane.currentPath.toLowerCase();
  const command = pane.currentCommand.toLowerCase();
  let strongMatch = false;

  if (title === "OpenCode") {
    reasons.push("title:OpenCode");
    strongMatch = true;
  }

  if (title.startsWith("OC | ")) {
    reasons.push("title:OC prefix");
    strongMatch = true;
  }

  if (command === "opencode") {
    reasons.push("command:opencode");
    strongMatch = true;
  }

  if (path.includes("/opencode") || path.includes("opencode-")) {
    reasons.push("path:opencode-like");
  }

  return {
    isOpencode: strongMatch,
    confidence: formatConfidence(reasons),
    reasons,
  };
}

export async function listAllPanes(): Promise<TmuxPane[]> {
  const command = ["tmux", "list-panes", "-a", "-F", TMUX_FIELDS.join("\t")];
  const { stdoutText, stderrText, exitCode } = await runCommand(command);

  if (exitCode !== 0) {
    const message = stderrText.trim() || "tmux list-panes failed";
    throw new Error(message);
  }

  return stdoutText
    .split("\n")
    .map((line: string) => line.trimEnd())
    .filter(Boolean)
    .map(parsePaneLine);
}

function parsePaneLine(line: string): TmuxPane {
  const parts = line.split("\t");

  if (parts.length !== TMUX_FIELDS.length) {
    throw new Error(`Unexpected tmux output: ${line}`);
  }

  const sessionName = parts[0];
  const windowIndex = parts[1];
  const paneIndex = parts[2];
  const paneId = parts[3];
  const paneTitle = parts[4];
  const currentCommand = parts[5];
  const currentPath = parts[6];
  const paneActive = parts[7];
  const tty = parts[8];

  if (
    sessionName === undefined ||
    windowIndex === undefined ||
    paneIndex === undefined ||
    paneId === undefined ||
    paneTitle === undefined ||
    currentCommand === undefined ||
    currentPath === undefined ||
    paneActive === undefined ||
    tty === undefined
  ) {
    throw new Error(`Incomplete tmux output: ${line}`);
  }

  return {
    sessionName,
    windowIndex: Number(windowIndex),
    paneIndex: Number(paneIndex),
    paneId,
    paneTitle,
    currentCommand,
    currentPath,
    isActive: paneActive === "1",
    tty,
    target: `${sessionName}:${Number(windowIndex)}.${Number(paneIndex)}`,
  };
}

export async function discoverOpencodePanes(): Promise<DiscoveredPane[]> {
  const panes = await listAllPanes();

  return panes
    .map((pane) => ({
      pane,
      detection: detectOpencodePane(pane),
    }))
    .filter((entry) => entry.detection.isOpencode)
    .sort((left, right) => left.pane.target.localeCompare(right.pane.target));
}

export function findDiscoveredPaneByTarget(panes: DiscoveredPane[], target: PaneTarget): DiscoveredPane | null {
  return panes.find((entry) => entry.pane.target === target) ?? null;
}

export async function getCurrentTmuxTarget(): Promise<PaneTarget> {
  const { stdoutText, stderrText, exitCode } = await runCommand(["tmux", "display-message", "-p", "#{session_name}:#{window_index}.#{pane_index}"]);

  if (exitCode !== 0) {
    const message = stderrText.trim() || "tmux display-message failed";
    throw new Error(message);
  }

  return stdoutText.trim() as PaneTarget;
}

export async function switchToPane(pane: TmuxPane): Promise<void> {
  const insideTmux = Boolean(process.env.TMUX);
  const windowTarget = `${pane.sessionName}:${pane.windowIndex}`;
  const command = insideTmux
    ? ["tmux", "switch-client", "-t", pane.sessionName, ";", "select-window", "-t", windowTarget, ";", "select-pane", "-t", pane.target]
    : ["tmux", "attach-session", "-t", pane.sessionName, ";", "select-window", "-t", windowTarget, ";", "select-pane", "-t", pane.target];

  const { stderrText, exitCode } = await runCommand(command);

  if (exitCode !== 0) {
    const message = stderrText.trim() || `failed to switch to ${pane.target}`;
    throw new Error(message);
  }
}
