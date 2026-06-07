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

function isNoCurrentClientMessage(message: string): boolean {
  return /no current client/i.test(message);
}

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
  return (
    command === binaryName ||
    command === `${binaryName}.exe` ||
    command.startsWith(`${binaryName}-`)
  );
}

function isLikelyPiProcess(command: string): boolean {
  return (
    matchesCommand(command, "pi") ||
    matchesCommand(command, "node") ||
    matchesCommand(command, "bun") ||
    matchesCommand(command, "deno")
  );
}

function isLikelyCodexWrapperProcess(command: string): boolean {
  return ["node", "bun", "deno", "npm", "npx", "pnpm", "yarn", "corepack"].some((name) =>
    matchesCommand(command, name),
  );
}

function isCodexProcessToken(token: string): boolean {
  const normalized = token.toLowerCase().replace(/^['"]+|['",;:]+$/g, "");

  if (normalized.includes("@openai/codex")) {
    return true;
  }

  const basename = normalized.split(/[\\/]/).pop() ?? "";
  return /^codex(?:$|\.(?:exe|[cm]?js)$|-(?:aarch64|x86_64|arm64|x64|darwin|linux|windows|win32|unknown|apple|pc|msvc|musl|gnu)[a-z0-9._-]*$)/.test(
    basename,
  );
}

function processArgsContainCodex(stdoutText: string): boolean {
  return stdoutText
    .split("\n")
    .some((line) => line.split(/\s+/).some((token) => isCodexProcessToken(token)));
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
  const normalizedLowerTitle = lowerTitle.replace(/^[^a-z0-9]+/, "");
  const path = pane.currentPath.toLowerCase();
  const command = pane.currentCommand.toLowerCase();
  const opencodeReasons: string[] = [];
  const codexReasons: string[] = [];
  const piReasons: string[] = [];
  const claudeReasons: string[] = [];
  const kiroReasons: string[] = [];
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

  const hasPiTitleHint =
    lowerTitle === "pi" || lowerTitle.startsWith("pi - ") || title.startsWith("π - ");
  const hasClaudeTitleHint =
    normalizedLowerTitle === "claude" || normalizedLowerTitle.startsWith("claude code");
  const hasKiroTitleHint =
    normalizedLowerTitle === "kiro" || normalizedLowerTitle.startsWith("kiro cli");

  if (hasPiTitleHint) {
    piReasons.push("title:Pi");
  }

  if (matchesCommand(command, "pi")) {
    piReasons.push("command:pi");
  } else if (hasPiTitleHint && isLikelyPiProcess(command)) {
    piReasons.push("command:pi-wrapper");
  }

  if (hasClaudeTitleHint) {
    claudeReasons.push("title:Claude");
  }

  if (matchesCommand(command, "claude")) {
    claudeReasons.push("command:claude");
  }

  if (hasKiroTitleHint) {
    kiroReasons.push("title:Kiro");
  }

  if (matchesCommand(command, "kiro")) {
    kiroReasons.push("command:kiro");
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

  if (piReasons.some((reason) => reason.startsWith("command:"))) {
    candidates.push({
      agent: "pi",
      reasons: piReasons,
      score: hasPiTitleHint ? 5 : 4,
    });
  }

  if (claudeReasons.length > 0) {
    candidates.push({
      agent: "claude",
      reasons: claudeReasons,
      score: claudeReasons.some((reason) => reason.startsWith("command:"))
        ? hasClaudeTitleHint
          ? 5
          : 4
        : 4,
    });
  }

  if (kiroReasons.length > 0) {
    candidates.push({
      agent: "kiro",
      reasons: kiroReasons,
      score: kiroReasons.some((reason) => reason.startsWith("command:"))
        ? hasKiroTitleHint
          ? 5
          : 4
        : 4,
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

async function detectAgentPaneFromProcessArgs(pane: TmuxPane): Promise<PaneDetection | null> {
  if (!isLikelyCodexWrapperProcess(pane.currentCommand.toLowerCase())) {
    return null;
  }

  const { stdoutText, exitCode } = await runCommand(["ps", "-t", pane.tty, "-o", "args="]);

  if (exitCode !== 0 || !processArgsContainCodex(stdoutText)) {
    return null;
  }

  return {
    agent: "codex",
    confidence: "medium",
    reasons: ["process:codex"],
  };
}

export async function discoverAgentPanes(): Promise<DiscoveredPane[]> {
  const panes = await listAllPanes();
  const discovered = await Promise.all(
    panes.map(async (pane) => {
      const detection = detectAgentPane(pane);

      if (detection.agent !== null) {
        return { pane, detection };
      }

      const processDetection = await detectAgentPaneFromProcessArgs(pane);
      return {
        pane,
        detection: processDetection ?? detection,
      };
    }),
  );

  return discovered
    .filter((entry) => entry.detection.agent !== null)
    .sort((left, right) => left.pane.target.localeCompare(right.pane.target));
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
  const insideTmux = Boolean(process.env.TMUX);
  let result = await runCommand(buildSwitchToPaneCommand(pane, insideTmux));

  if (result.exitCode === 0) {
    return;
  }

  if (insideTmux && isNoCurrentClientMessage(result.stderrText)) {
    result = await runCommand(buildSwitchToPaneCommand(pane, false));

    if (result.exitCode === 0) {
      return;
    }
  }

  const message = result.stderrText.trim() || `failed to switch to ${pane.target}`;
  throw new Error(message);
}
