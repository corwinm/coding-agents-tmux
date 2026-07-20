import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { capturePanePreview } from "./tmux.ts";
import { getPreferredStateDir, getStateDirCandidates } from "../naming.ts";
import { runCommand } from "../runtime.ts";
import type {
  DiscoveredPane,
  PaneRuntimeSummary,
  RuntimeInfo,
  RuntimeStatus,
  SessionMatch,
  TmuxPane,
} from "../types.ts";

export interface ClaudeStateFile {
  activity?: RuntimeInfo["activity"];
  detail?: string;
  directory?: string;
  paneId?: string | null;
  sessionId?: string;
  sourceEventType?: string;
  status?: RuntimeStatus;
  target?: string | null;
  title?: string;
  transcriptPath?: string | null;
  updatedAt?: number;
  version?: number;
}

interface ClaudeHookPayload {
  action?: string;
  content?: unknown;
  cwd?: string;
  hook_event_name?: string;
  last_assistant_message?: string | null;
  message?: string;
  mode?: string;
  requested_schema?: unknown;
  session_id?: string;
  tool_input?: unknown;
  tool_name?: string;
  transcript_path?: string;
}

interface ClaudeHookCommand {
  command: string;
  statusMessage?: string;
  type: "command";
}

interface ClaudeHookMatcherGroup {
  hooks: ClaudeHookCommand[];
  matcher?: string;
}

interface ClaudeHooksDocument {
  hooks?: Record<string, ClaudeHookMatcherGroup[]>;
}

interface ClaudeStateIndex {
  exactPaneIdMatches: Map<string, ClaudeStateFile>;
  exactTargetMatches: Map<string, ClaudeStateFile>;
  statesByDirectory: Map<string, ClaudeStateFile[]>;
}

export interface ClaudeInstallResult {
  settingsPath: string;
}

function normalizeEnvValue(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toFileName(input: { directory: string; paneId: string | null }): string {
  if (input.paneId) {
    return `pane-${Buffer.from(input.paneId).toString("hex")}.json`;
  }

  return `cwd-${Buffer.from(input.directory).toString("hex")}.json`;
}

async function resolveTmuxPaneTarget(paneId: string | null): Promise<string | null> {
  if (!paneId) {
    return null;
  }

  try {
    const { exitCode, stdoutText } = await runCommand([
      "tmux",
      "display-message",
      "-p",
      "-t",
      paneId,
      "#{session_name}:#{window_index}.#{pane_index}",
    ]);

    if (exitCode !== 0) {
      return null;
    }

    const target = stdoutText.trim();
    return target ? target : null;
  } catch {
    return null;
  }
}

function countChoiceLines(message: string): number {
  return message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:[›>]\s*)?\d+\.\s+\S/.test(line) || /^(?:[›>]\s*)?[-*]\s+\S/.test(line))
    .length;
}

function getClaudeHome(): string {
  return process.env.CLAUDE_HOME ?? join(homedir(), ".claude");
}

export function getClaudeSettingsPath(): string {
  return join(getClaudeHome(), "settings.json");
}

export function getClaudeStateDir(): string {
  return getPreferredStateDir({
    env: "CODING_AGENTS_TMUX_CLAUDE_STATE_DIR",
    subdirectory: "claude-state",
  });
}

function getClaudeStateUpdatedAt(state: ClaudeStateFile): number {
  return state.updatedAt ?? 0;
}

function pickNewerClaudeState(
  current: ClaudeStateFile | undefined,
  candidate: ClaudeStateFile,
): ClaudeStateFile {
  if (!current || getClaudeStateUpdatedAt(candidate) > getClaudeStateUpdatedAt(current)) {
    return candidate;
  }

  return current;
}

function getClaudeSessionTitle(directory: string, existing: ClaudeStateFile | null): string {
  if (existing?.title) {
    return existing.title;
  }

  const name = basename(directory);
  return name ? name : "Claude Code session";
}

function readStateFile(filePath: string): ClaudeStateFile | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as ClaudeStateFile;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function schemaContainsChoiceOptions(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => schemaContainsChoiceOptions(entry));
  }

  if (!isRecord(value)) {
    return false;
  }

  if (Array.isArray(value.enum) && value.enum.length > 0) {
    return true;
  }

  if (Array.isArray(value.oneOf) && value.oneOf.length > 0) {
    return true;
  }

  if (Array.isArray(value.anyOf) && value.anyOf.length > 0) {
    return true;
  }

  return Object.values(value).some((entry) => schemaContainsChoiceOptions(entry));
}

function classifyAskUserQuestion(toolInput: unknown): {
  detail: string;
  status: RuntimeStatus;
} {
  const questions =
    isRecord(toolInput) && Array.isArray(toolInput.questions) ? toolInput.questions : [];
  const hasOptions = questions.some(
    (question) =>
      isRecord(question) && Array.isArray(question.options) && question.options.length > 0,
  );

  if (hasOptions) {
    return {
      detail: "Claude Code is waiting for a multiple-choice response",
      status: "waiting-question",
    };
  }

  return {
    detail: "Claude Code is waiting for user input",
    status: "waiting-input",
  };
}

function classifyElicitation(payload: ClaudeHookPayload): {
  detail: string;
  status: RuntimeStatus;
} {
  const message = payload.message?.trim();
  const mode = payload.mode?.trim().toLowerCase();
  const status =
    mode === "form" && !schemaContainsChoiceOptions(payload.requested_schema)
      ? ("waiting-input" as const)
      : ("waiting-question" as const);

  return {
    detail:
      status === "waiting-question"
        ? `Claude Code is waiting for an MCP response${message ? `: ${message}` : ""}`
        : `Claude Code is waiting for MCP input${message ? `: ${message}` : ""}`,
    status,
  };
}

function classifyHookPayload(payload: ClaudeHookPayload): {
  activity: RuntimeInfo["activity"];
  detail: string;
  sourceEventType: string;
  status: RuntimeStatus;
} {
  const eventName = payload.hook_event_name ?? "unknown";

  switch (eventName) {
    case "SessionStart":
      return {
        activity: "idle",
        detail: "Claude Code session started",
        sourceEventType: eventName,
        status: "new",
      };
    case "UserPromptSubmit":
      return {
        activity: "busy",
        detail: "Claude Code is handling a user prompt",
        sourceEventType: eventName,
        status: "running",
      };
    case "PreToolUse":
      if (payload.tool_name === "AskUserQuestion") {
        const questionState = classifyAskUserQuestion(payload.tool_input);

        return {
          activity: "busy",
          detail: questionState.detail,
          sourceEventType: eventName,
          status: questionState.status,
        };
      }

      return {
        activity: "busy",
        detail: `Claude Code is running ${payload.tool_name ?? "a tool"}`,
        sourceEventType: eventName,
        status: "running",
      };
    case "PermissionRequest":
      return {
        activity: "busy",
        detail: "Claude Code is waiting for permission approval",
        sourceEventType: eventName,
        status: "waiting-question",
      };
    case "PermissionDenied":
      return {
        activity: "busy",
        detail: "Claude Code is handling a denied permission request",
        sourceEventType: eventName,
        status: "running",
      };
    case "Elicitation": {
      const elicitation = classifyElicitation(payload);

      return {
        activity: "busy",
        detail: elicitation.detail,
        sourceEventType: eventName,
        status: elicitation.status,
      };
    }
    case "ElicitationResult":
      return {
        activity: "busy",
        detail: "Claude Code is processing an MCP elicitation response",
        sourceEventType: eventName,
        status: "running",
      };
    case "PostToolUse":
      return {
        activity: "busy",
        detail: `Claude Code is processing ${payload.tool_name ?? "tool"} output`,
        sourceEventType: eventName,
        status: "running",
      };
    case "PostToolUseFailure":
      return {
        activity: "busy",
        detail: `Claude Code is recovering from a ${payload.tool_name ?? "tool"} failure`,
        sourceEventType: eventName,
        status: "running",
      };
    case "PostToolBatch":
      return {
        activity: "busy",
        detail: "Claude Code is processing tool results",
        sourceEventType: eventName,
        status: "running",
      };
    case "Stop":
      // A Stop event means Claude finished its turn and handed control back to
      // the user. That is an idle state. Genuine blocking prompts arrive via
      // dedicated hooks (PreToolUse+AskUserQuestion, PermissionRequest,
      // Elicitation); a prose question at the end of a turn is not a blocking
      // wait, so we must not classify it as "waiting" here.
      return {
        activity: "idle",
        detail: "Claude Code is idle between turns",
        sourceEventType: eventName,
        status: "idle",
      };
    default:
      return {
        activity: "unknown",
        detail: `Unhandled Claude Code hook event: ${eventName}`,
        sourceEventType: eventName,
        status: "unknown",
      };
  }
}

export async function persistClaudeHookState(rawInput: string): Promise<void> {
  const payload = JSON.parse(rawInput) as ClaudeHookPayload;
  const directory = payload.cwd?.trim() || process.cwd();
  const paneId = normalizeEnvValue(process.env.TMUX_PANE);
  const stateDir = getClaudeStateDir();
  const filePath = join(stateDir, toFileName({ directory, paneId }));

  if (payload.hook_event_name === "SessionEnd") {
    if (!existsSync(filePath)) {
      return;
    }

    unlinkSync(filePath);
    return;
  }

  const existing = readStateFile(filePath);
  const classified = classifyHookPayload(payload);
  const sessionId = payload.session_id?.trim() || existing?.sessionId;
  const transcriptPath = payload.transcript_path?.trim() || existing?.transcriptPath;
  const nextState = {
    version: 1,
    paneId,
    target: (await resolveTmuxPaneTarget(paneId)) ?? existing?.target ?? null,
    directory,
    title: getClaudeSessionTitle(directory, existing),
    activity: classified.activity,
    status: classified.status,
    detail: classified.detail,
    updatedAt: Date.now(),
    sourceEventType: classified.sourceEventType,
    ...(sessionId ? { sessionId } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
  } satisfies ClaudeStateFile;

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(nextState, null, 2), "utf8");
}

export function readClaudeStates(): ClaudeStateFile[] {
  return getStateDirCandidates({
    env: "CODING_AGENTS_TMUX_CLAUDE_STATE_DIR",
    subdirectory: "claude-state",
  })
    .filter((stateDir) => existsSync(stateDir))
    .flatMap((stateDir) =>
      readdirSync(stateDir)
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => join(stateDir, entry))
        .map((filePath) => readStateFile(filePath))
        .filter((state): state is ClaudeStateFile => Boolean(state?.directory)),
    );
}

function buildClaudeStateIndex(states = readClaudeStates()): ClaudeStateIndex {
  const exactPaneIdMatches = new Map<string, ClaudeStateFile>();
  const exactTargetMatches = new Map<string, ClaudeStateFile>();
  const statesByDirectory = new Map<string, ClaudeStateFile[]>();

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
        pickNewerClaudeState(exactPaneIdMatches.get(state.paneId), state),
      );
    }

    if (state.target) {
      exactTargetMatches.set(
        state.target,
        pickNewerClaudeState(exactTargetMatches.get(state.target), state),
      );
    }
  }

  return {
    exactPaneIdMatches,
    exactTargetMatches,
    statesByDirectory,
  };
}

function createClaudeRuntimeInfo(input: {
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

function toClaudeSessionMatch(state: ClaudeStateFile): SessionMatch | null {
  if (!state.directory || !state.title) {
    return null;
  }

  return {
    id: state.sessionId ?? `claude:${state.directory}`,
    directory: state.directory,
    title: state.title,
    timeUpdated: state.updatedAt ?? Date.now(),
  };
}

function classifyClaudeState(
  state: ClaudeStateFile | null,
  input: {
    detail: string;
    heuristic: boolean;
    strategy: RuntimeInfo["match"]["strategy"];
  },
): RuntimeInfo {
  if (!state?.directory) {
    return createClaudeRuntimeInfo({
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

  return createClaudeRuntimeInfo({
    activity,
    status,
    source: "claude-hook",
    strategy: input.strategy,
    provider: "claude",
    heuristic: input.heuristic,
    session: toClaudeSessionMatch(state),
    detail: state.detail ?? input.detail,
  });
}

function matchesClaudeStateDirectory(
  state: ClaudeStateFile | undefined,
  pane: TmuxPane,
): state is ClaudeStateFile {
  return Boolean(state?.directory && state.directory === pane.currentPath);
}

function getExactClaudeState(index: ClaudeStateIndex, pane: TmuxPane): ClaudeStateFile | null {
  const targetState = index.exactTargetMatches.get(pane.target);

  if (matchesClaudeStateDirectory(targetState, pane)) {
    return targetState;
  }

  const paneIdState = index.exactPaneIdMatches.get(pane.paneId);

  if (matchesClaudeStateDirectory(paneIdState, pane)) {
    return paneIdState;
  }

  return null;
}

function getDirectoryFallbackClaudeState(
  index: ClaudeStateIndex,
  pane: TmuxPane,
): ClaudeStateFile | null {
  const states = index.statesByDirectory.get(pane.currentPath) ?? [];

  if (states.length !== 1) {
    return null;
  }

  return states[0] ?? null;
}

// Claude's interactive prompts (permission requests, AskUserQuestion) render a
// selectable list where the highlighted option is marked with an arrow glyph.
// Requiring the arrow avoids misreading ordinary numbered prose in an assistant
// message as a live prompt.
function hasInteractiveChoicePrompt(lines: string[]): boolean {
  const trimmed = lines.map((line) => line.trim());
  const hasSelectionArrow = trimmed.some(
    (line) => /^[❯›>]\s*\d+\.\s+\S/.test(line) || /^[❯›>]\s+\S/.test(line),
  );

  return hasSelectionArrow && countChoiceLines(lines.join("\n")) >= 2;
}

// The tmux pane is the authoritative real-time signal for whether Claude is
// actively working. While Claude is processing it renders "esc to interrupt" in
// the footer and a spinner status line (e.g. "✳ Forming… (1m 2s · ↓ 4.2k
// tokens)"); once the turn ends both disappear. Hook state, by contrast, can go
// stale because Claude does not always emit a Stop event after a tool batch.
function detectClaudeBusy(text: string, lower: string): boolean {
  return lower.includes("esc to interrupt") || /…\s*\(\s*\d+\s*[hms]/.test(text);
}

// When Claude delegates to background subagents (the Task tool) it can sit on a
// "Waiting for N background agents to finish" spinner. In that state the footer
// drops "esc to interrupt" and each agent row reports its own elapsed time
// instead of the main spinner's "… (1m 2s)" format, so detectClaudeBusy misses
// it and the pane would otherwise fall through to the idle default. The parent
// session is still actively blocked on that work, so treat it as busy.
function detectClaudeBackgroundAgents(lower: string): boolean {
  return (
    /waiting for \d+ background agents?/.test(lower) ||
    /\d+ background agents? (?:to finish|running)/.test(lower)
  );
}

// Claude's slash-command menus (/effort, /model, /config, …) open an
// interactive overlay whose footer offers confirm/cancel and navigation hints.
// These block on user interaction, so they count as "waiting" rather than idle.
function isInteractiveDialog(lower: string): boolean {
  return (
    lower.includes("enter to confirm") ||
    lower.includes("esc to cancel") ||
    (lower.includes("to select") && lower.includes("enter")) ||
    (lower.includes("to adjust") && lower.includes("confirm"))
  );
}

function classifyClaudePreview(
  lines: string[],
): Pick<RuntimeInfo, "activity" | "detail" | "status"> | null {
  const nonEmptyLines = lines.map((line) => line.trim()).filter(Boolean);

  if (nonEmptyLines.length === 0) {
    return null;
  }

  const text = nonEmptyLines.join("\n");
  const lower = text.toLowerCase();
  const recentLines = nonEmptyLines.slice(-12);
  const recentText = recentLines.join("\n");
  const recentLower = recentText.toLowerCase();

  // Waiting is checked first: a blocking prompt or interactive dialog can also
  // keep "esc to interrupt" on screen, but it is a genuine wait for user input.
  if (
    hasInteractiveChoicePrompt(recentLines) ||
    ["permission", "allow", "deny"].every((fragment) => recentLower.includes(fragment)) ||
    isInteractiveDialog(recentLower)
  ) {
    return {
      activity: "busy",
      detail: "Claude Code appears to be waiting for a response",
      status: "waiting-question",
    };
  }

  if (detectClaudeBackgroundAgents(lower)) {
    return {
      activity: "busy",
      detail: "Claude Code is waiting on background agents",
      status: "running",
    };
  }

  if (detectClaudeBusy(text, lower)) {
    return {
      activity: "busy",
      detail: "Claude Code is working",
      status: "running",
    };
  }

  // A live Claude session with no active spinner and no blocking prompt is idle
  // between turns, regardless of what a possibly-stale hook event recorded. The
  // absence of "esc to interrupt" is strong evidence Claude is not working, so a
  // readable-but-otherwise-unrecognized Claude screen is treated as idle rather
  // than defaulting to "running".
  return {
    activity: "idle",
    detail: "Claude Code is idle between turns",
    status: "idle",
  };
}

async function loadClaudePreviewClassification(
  target: TmuxPane["target"],
): Promise<Pick<RuntimeInfo, "activity" | "detail" | "status"> | null> {
  try {
    const lines = await capturePanePreview(target, 24);
    return classifyClaudePreview(lines);
  } catch {
    return null;
  }
}

function buildManagedHook(command: string): ClaudeHookCommand {
  return {
    type: "command",
    command,
    statusMessage: "Updating Claude tmux state",
  };
}

function buildManagedClaudeHooks(command: string): ClaudeHooksDocument {
  const hook = buildManagedHook(command);

  return {
    hooks: {
      SessionStart: [{ matcher: "startup|resume", hooks: [hook] }],
      UserPromptSubmit: [{ hooks: [hook] }],
      PreToolUse: [{ matcher: "AskUserQuestion", hooks: [hook] }],
      PermissionRequest: [{ hooks: [hook] }],
      Elicitation: [{ hooks: [hook] }],
      ElicitationResult: [{ hooks: [hook] }],
      PostToolUse: [{ hooks: [hook] }],
      PostToolUseFailure: [{ hooks: [hook] }],
      PostToolBatch: [{ hooks: [hook] }],
      Stop: [{ hooks: [hook] }],
      SessionEnd: [{ hooks: [hook] }],
    },
  };
}

function isManagedHookGroup(group: ClaudeHookMatcherGroup): boolean {
  return group.hooks.some(
    (hook) => hook.type === "command" && hook.statusMessage === "Updating Claude tmux state",
  );
}

export function updateClaudeSettings(existing: string, command: string): string {
  const parsed = existing.trim() ? (JSON.parse(existing) as Record<string, unknown>) : {};
  const parsedHooks = isRecord(parsed.hooks)
    ? (parsed.hooks as Record<string, ClaudeHookMatcherGroup[]>)
    : {};
  const nextHooks = { ...parsedHooks };
  const managedHooks = buildManagedClaudeHooks(command).hooks ?? {};

  for (const [eventName, managedGroups] of Object.entries(managedHooks)) {
    const groups = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : [];
    nextHooks[eventName] = [
      ...groups.filter((group) => !isManagedHookGroup(group)),
      ...managedGroups,
    ];
  }

  return `${JSON.stringify({ ...parsed, hooks: nextHooks }, null, 2)}\n`;
}

export function installClaudeIntegration(command: string): ClaudeInstallResult {
  const settingsPath = getClaudeSettingsPath();
  const claudeHome = getClaudeHome();
  const existingSettings = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "";

  mkdirSync(claudeHome, { recursive: true });
  writeFileSync(settingsPath, updateClaudeSettings(existingSettings, command), "utf8");

  return { settingsPath };
}

export function buildClaudeHooksTemplate(command: string): string {
  return `${JSON.stringify(buildManagedClaudeHooks(command), null, 2)}\n`;
}

// A hook state is only trusted to assert a blocking wait that the live preview
// cannot see (e.g. an MCP elicitation form) for a short window. Beyond this the
// pane preview is the sole source of truth, which prevents stale "waiting" or
// "running" events from lingering after Claude has gone idle.
const CLAUDE_HOOK_WAIT_FRESHNESS_MS = 60_000;

function isFreshClaudeWait(state: ClaudeStateFile | null): state is ClaudeStateFile {
  if (!state?.status?.startsWith("waiting")) {
    return false;
  }

  return Date.now() - (state.updatedAt ?? 0) < CLAUDE_HOOK_WAIT_FRESHNESS_MS;
}

export async function attachRuntimeWithClaude(
  panes: DiscoveredPane[],
  index = buildClaudeStateIndex(),
): Promise<PaneRuntimeSummary[]> {
  return Promise.all(
    panes.map(async (entry) => {
      const hookState =
        getExactClaudeState(index, entry.pane) ??
        getDirectoryFallbackClaudeState(index, entry.pane);
      const session = hookState ? toClaudeSessionMatch(hookState) : null;
      const preview = await loadClaudePreviewClassification(entry.pane.target);

      if (preview) {
        // The preview reliably tells busy/idle/waiting apart in real time. When
        // it reads idle but a fresh hook event says Claude is blocked on a
        // structured prompt the preview can't render, honor the hook.
        if (preview.status === "idle" && isFreshClaudeWait(hookState)) {
          return {
            ...entry,
            runtime: classifyClaudeState(hookState, {
              detail: "matched fresh Claude hook wait state",
              heuristic: false,
              strategy: "exact",
            }),
          };
        }

        const detail =
          preview.status === "waiting-question" && hookState?.detail?.includes("waiting")
            ? hookState.detail
            : preview.detail;

        return {
          ...entry,
          runtime: createClaudeRuntimeInfo({
            activity: preview.activity,
            status: preview.status,
            source: "claude-preview",
            strategy: hookState ? "exact" : "unmapped",
            provider: "claude",
            heuristic: true,
            session,
            detail,
          }),
        };
      }

      // Preview unreadable (capture failed): fall back to hook state, then to
      // process detection.
      if (hookState) {
        return {
          ...entry,
          runtime: classifyClaudeState(hookState, {
            detail: "matched Claude hook state (preview unavailable)",
            heuristic: true,
            strategy: "exact",
          }),
        };
      }

      return {
        ...entry,
        runtime: createClaudeRuntimeInfo({
          activity: "busy",
          status: "running",
          source: "claude-command",
          strategy: "exact",
          provider: "claude",
          heuristic: false,
          session: null,
          detail: `detected ${entry.pane.currentCommand} process in tmux pane`,
        }),
      };
    }),
  );
}
