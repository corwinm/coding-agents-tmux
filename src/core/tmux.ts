import type {
  AgentKind,
  DiscoveredPane,
  DetectionConfidence,
  PaneTarget,
  PaneDetection,
  TmuxPane,
} from "../types.ts";
import { runCommand } from "../runtime.ts";

export interface WindowPreviewPane {
  active: boolean;
  height: number;
  left: number;
  lines: string[];
  target: PaneTarget;
  title: string;
  top: number;
  width: number;
}

export interface WindowPreviewSnapshot {
  height: number;
  panes: WindowPreviewPane[];
  sessionName: string;
  width: number;
}

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

const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\u001B\[[0-9;?]*[ -/]*[@-~]`, "g");

function formatConfidence(reasons: string[]): DetectionConfidence {
  if (
    reasons.some((reason) => reason.startsWith("title:")) ||
    reasons.some((reason) => reason.startsWith("command:"))
  ) {
    if (reasons.some((reason) => reason.startsWith("title:"))) {
      return "high";
    }

    return "medium";
  }

  if (reasons.length >= 2) {
    return "high";
  }

  return "low";
}

function matchesCommand(command: string, binaryName: string): boolean {
  return command === binaryName || command.startsWith(`${binaryName}-`);
}

function pickDetectedAgent(
  candidates: Array<{
    agent: AgentKind;
    reasons: string[];
    score: number;
  }>,
): { agent: AgentKind; reasons: string[] } | null {
  return candidates.reduce<{ agent: AgentKind; reasons: string[]; score: number } | null>(
    (best, candidate) => {
      if (!best || candidate.score > best.score) {
        return candidate;
      }

      return best;
    },
    null,
  );
}

export function detectAgentPane(pane: TmuxPane): PaneDetection {
  const title = pane.paneTitle.trim();
  const lowerTitle = title.toLowerCase();
  const path = pane.currentPath.toLowerCase();
  const command = pane.currentCommand.toLowerCase();
  const opencodeReasons: string[] = [];
  const codexReasons: string[] = [];
  const candidates: Array<{ agent: AgentKind; reasons: string[]; score: number }> = [];

  if (title === "OpenCode") {
    opencodeReasons.push("title:OpenCode");
  }

  if (title.startsWith("OC | ")) {
    opencodeReasons.push("title:OC prefix");
  }

  if (matchesCommand(command, "opencode")) {
    opencodeReasons.push("command:opencode");
  }

  if (path.includes("/opencode") || path.includes("opencode-")) {
    opencodeReasons.push("path:opencode-like");
  }

  if (lowerTitle === "codex" || lowerTitle.startsWith("openai codex")) {
    codexReasons.push("title:Codex");
  }

  if (matchesCommand(command, "codex")) {
    codexReasons.push("command:codex");
  }

  if (opencodeReasons.some((reason) => !reason.startsWith("path:"))) {
    candidates.push({
      agent: "opencode",
      reasons: opencodeReasons,
      score:
        opencodeReasons.includes("title:OpenCode") || opencodeReasons.includes("title:OC prefix")
          ? 5
          : 4,
    });
  }

  if (codexReasons.length > 0) {
    candidates.push({
      agent: "codex",
      reasons: codexReasons,
      score: codexReasons.includes("command:codex") ? 5 : 4,
    });
  }

  const detected = pickDetectedAgent(candidates);

  if (detected) {
    return {
      agent: detected.agent,
      confidence: formatConfidence(detected.reasons),
      reasons: detected.reasons,
    };
  }

  return {
    agent: null,
    confidence: formatConfidence(opencodeReasons),
    reasons: opencodeReasons,
  };
}

export async function listAllPanes(): Promise<TmuxPane[]> {
  const command = ["tmux", "list-panes", "-a", "-F", TMUX_FIELDS.join("\t")];
  const { stdoutText, stderrText, exitCode } = await runCommand(command);

  if (exitCode !== 0) {
    const message = stderrText.trim() || "tmux list-panes failed";
    throw new Error(message);
  }

  return parseListAllPanesOutput(stdoutText);
}

export function parseListAllPanesOutput(stdoutText: string): TmuxPane[] {
  return stdoutText
    .split("\n")
    .map((line: string) => line.trimEnd())
    .filter(Boolean)
    .map(parsePaneLine);
}

export function parsePaneLine(line: string): TmuxPane {
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

export function discoverAgentPanesFromList(panes: TmuxPane[]): DiscoveredPane[] {
  return panes
    .map((pane) => ({
      pane,
      detection: detectAgentPane(pane),
    }))
    .filter((entry) => entry.detection.agent !== null)
    .sort((left, right) => left.pane.target.localeCompare(right.pane.target));
}

export async function discoverAgentPanes(): Promise<DiscoveredPane[]> {
  return discoverAgentPanesFromList(await listAllPanes());
}

export function findDiscoveredPaneByTarget(
  panes: DiscoveredPane[],
  target: PaneTarget,
): DiscoveredPane | null {
  return panes.find((entry) => entry.pane.target === target) ?? null;
}

export async function getCurrentTmuxTarget(): Promise<PaneTarget> {
  const { stdoutText, stderrText, exitCode } = await runCommand([
    "tmux",
    "display-message",
    "-p",
    "#{session_name}:#{window_index}.#{pane_index}",
  ]);

  if (exitCode !== 0) {
    const message = stderrText.trim() || "tmux display-message failed";
    throw new Error(message);
  }

  return stdoutText.trim() as PaneTarget;
}

export async function capturePanePreview(target: PaneTarget, lineCount = 16): Promise<string[]> {
  const startLine = `-${Math.max(1, lineCount)}`;
  const { stdoutText, stderrText, exitCode } = await runCommand([
    "tmux",
    "capture-pane",
    "-p",
    "-J",
    "-t",
    target,
    "-S",
    startLine,
  ]);

  if (exitCode !== 0) {
    const message = stderrText.trim() || `failed to capture preview for ${target}`;
    throw new Error(message);
  }

  return normalizeCapturedPaneLines(stdoutText);
}

export function normalizeCapturedPaneLines(stdoutText: string): string[] {
  return stdoutText
    .split("\n")
    .map((line) => line.replace(/\t/g, "    ").replace(ANSI_ESCAPE_PATTERN, "").trimEnd())
    .filter((line, index, lines) => line.length > 0 || index < lines.length - 1);
}

export async function captureWindowPreview(target: PaneTarget): Promise<WindowPreviewSnapshot> {
  const windowTarget = target.replace(/\.\d+$/, "");
  const paneFormat = [
    "#{session_name}",
    "#{window_index}",
    "#{pane_index}",
    "#{pane_active}",
    "#{pane_left}",
    "#{pane_top}",
    "#{pane_width}",
    "#{pane_height}",
    "#{pane_title}",
  ].join("\t");
  const { stdoutText, stderrText, exitCode } = await runCommand([
    "tmux",
    "list-panes",
    "-t",
    windowTarget,
    "-F",
    paneFormat,
  ]);

  if (exitCode !== 0) {
    const message = stderrText.trim() || `failed to inspect window preview for ${target}`;
    throw new Error(message);
  }

  const panes = await Promise.all(
    stdoutText
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map(async (line) => {
        const [
          sessionName,
          windowIndex,
          paneIndex,
          paneActive,
          paneLeft,
          paneTop,
          paneWidth,
          paneHeight,
          paneTitle,
        ] = line.split("\t");

        if (
          sessionName === undefined ||
          windowIndex === undefined ||
          paneIndex === undefined ||
          paneActive === undefined ||
          paneLeft === undefined ||
          paneTop === undefined ||
          paneWidth === undefined ||
          paneHeight === undefined ||
          paneTitle === undefined
        ) {
          throw new Error(`Unexpected tmux pane preview output: ${line}`);
        }

        const paneTarget =
          `${sessionName}:${Number(windowIndex)}.${Number(paneIndex)}` as PaneTarget;

        return {
          active: paneActive === "1",
          height: Number(paneHeight),
          left: Number(paneLeft),
          lines: await capturePanePreview(paneTarget, Math.max(1, Number(paneHeight))),
          target: paneTarget,
          title: paneTitle,
          top: Number(paneTop),
          width: Number(paneWidth),
        } satisfies WindowPreviewPane;
      }),
  );

  const sessionName = panes[0]?.target.split(":")[0] ?? windowTarget.split(":")[0] ?? "session";
  const width = panes.reduce((maximum, pane) => Math.max(maximum, pane.left + pane.width), 0);
  const height = panes.reduce((maximum, pane) => Math.max(maximum, pane.top + pane.height), 0);

  return {
    height,
    panes,
    sessionName,
    width,
  };
}

export function buildSwitchToPaneCommand(pane: TmuxPane, insideTmux: boolean): string[] {
  const windowTarget = `${pane.sessionName}:${pane.windowIndex}`;
  return insideTmux
    ? [
        "tmux",
        "switch-client",
        "-t",
        pane.sessionName,
        ";",
        "select-window",
        "-t",
        windowTarget,
        ";",
        "select-pane",
        "-t",
        pane.target,
      ]
    : [
        "tmux",
        "attach-session",
        "-t",
        pane.sessionName,
        ";",
        "select-window",
        "-t",
        windowTarget,
        ";",
        "select-pane",
        "-t",
        pane.target,
      ];
}

export async function switchToPane(pane: TmuxPane): Promise<void> {
  const command = buildSwitchToPaneCommand(pane, Boolean(process.env.TMUX));

  const { stderrText, exitCode } = await runCommand(command);

  if (exitCode !== 0) {
    const message = stderrText.trim() || `failed to switch to ${pane.target}`;
    throw new Error(message);
  }
}
