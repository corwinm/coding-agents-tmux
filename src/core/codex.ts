import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { getPreferredStateDir, getStateDirCandidates } from "../naming.ts";
import { runCommand } from "../runtime.ts";
import type { RuntimeInfo, RuntimeStatus } from "../types.ts";

export interface CodexStateFile {
  activity?: RuntimeInfo["activity"];
  detail?: string;
  directory?: string;
  paneId?: string | null;
  sessionId?: string;
  sourceEventType?: string;
  status?: RuntimeStatus;
  target?: string | null;
  title?: string;
  updatedAt?: number;
  version?: number;
}

interface CodexHookPayload {
  cwd?: string;
  hook_event_name?: string;
  last_assistant_message?: string | null;
  session_id?: string;
  tool_name?: string;
}

interface CodexHookCommand {
  command: string;
  statusMessage?: string;
  type: "command";
}

interface CodexHookMatcherGroup {
  hooks: CodexHookCommand[];
  matcher?: string;
}

interface CodexHooksDocument {
  hooks?: Record<string, CodexHookMatcherGroup[]>;
}

export interface CodexInstallResult {
  configPath: string;
  hooksPath: string;
}

export interface CodexStateEntry {
  filePath: string;
  state: CodexStateFile;
}

function normalizeEnvValue(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function getCodexStateDir(): string {
  return getPreferredStateDir({
    preferredEnv: "CODING_AGENTS_TMUX_CODEX_STATE_DIR",
    legacyEnv: "OPENCODE_TMUX_CODEX_STATE_DIR",
    subdirectory: "codex-state",
  });
}

export function getCodexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

export function getCodexConfigPath(): string {
  return join(getCodexHome(), "config.toml");
}

export function getCodexHooksPath(): string {
  return join(getCodexHome(), "hooks.json");
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

function getCodexSessionTitle(directory: string, existing: CodexStateFile | null): string {
  if (existing?.title) {
    return existing.title;
  }

  const name = basename(directory);
  return name ? name : "Codex session";
}

function readStateFile(filePath: string): CodexStateFile | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as CodexStateFile;
  } catch {
    return null;
  }
}

function countChoiceLines(message: string): number {
  return message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s+\S/.test(line) || /^[-*]\s+\S/.test(line)).length;
}

function classifyWaitingMessage(message: string | null | undefined): RuntimeStatus | null {
  if (!message) {
    return null;
  }

  const trimmed = message.trim();

  if (!trimmed) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  const choiceLineCount = countChoiceLines(trimmed);

  if (
    choiceLineCount >= 2 &&
    ["would you like", "do you want", "should i", "choose", "select", "option"].some((fragment) =>
      lower.includes(fragment),
    )
  ) {
    return "waiting-question";
  }

  if (/\?\s*$/.test(trimmed)) {
    return "waiting-input";
  }

  if (
    [
      "would you like",
      "do you want",
      "should i",
      "can you",
      "could you",
      "please provide",
      "please confirm",
      "choose",
      "select",
      "confirm",
    ].some((fragment) => lower.includes(fragment))
  ) {
    return "waiting-input";
  }

  return null;
}

function classifyHookPayload(payload: CodexHookPayload): {
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
        detail: "Codex session started",
        sourceEventType: eventName,
        status: "new",
      };
    case "UserPromptSubmit":
      return {
        activity: "busy",
        detail: "Codex is handling a user prompt",
        sourceEventType: eventName,
        status: "running",
      };
    case "PreToolUse":
      return {
        activity: "busy",
        detail: `Codex is running ${payload.tool_name ?? "a tool"}`,
        sourceEventType: eventName,
        status: "running",
      };
    case "PostToolUse":
      return {
        activity: "busy",
        detail: `Codex is processing ${payload.tool_name ?? "tool"} output`,
        sourceEventType: eventName,
        status: "running",
      };
    case "Stop":
      return classifyWaitingMessage(payload.last_assistant_message)
        ? {
            activity: "busy",
            detail:
              classifyWaitingMessage(payload.last_assistant_message) === "waiting-question"
                ? "Codex is waiting for a multiple-choice response"
                : "Codex is waiting for user input",
            sourceEventType: eventName,
            status: classifyWaitingMessage(payload.last_assistant_message) ?? "waiting-input",
          }
        : {
            activity: "idle",
            detail: "Codex is idle between turns",
            sourceEventType: eventName,
            status: "idle",
          };
    default:
      return {
        activity: "unknown",
        detail: `Unhandled Codex hook event: ${eventName}`,
        sourceEventType: eventName,
        status: "unknown",
      };
  }
}

export async function persistCodexHookState(rawInput: string): Promise<void> {
  const payload = JSON.parse(rawInput) as CodexHookPayload;
  const directory = payload.cwd?.trim() || process.cwd();
  const paneId = normalizeEnvValue(process.env.TMUX_PANE);
  const stateDir = getCodexStateDir();
  const filePath = join(stateDir, toFileName({ directory, paneId }));
  const existing = readStateFile(filePath);
  const classified = classifyHookPayload(payload);
  const sessionId = payload.session_id?.trim() || existing?.sessionId;
  const nextState = {
    version: 1,
    paneId,
    target: (await resolveTmuxPaneTarget(paneId)) ?? existing?.target ?? null,
    directory,
    title: getCodexSessionTitle(directory, existing),
    activity: classified.activity,
    status: classified.status,
    detail: classified.detail,
    updatedAt: Date.now(),
    sourceEventType: classified.sourceEventType,
    ...(sessionId ? { sessionId } : {}),
  } satisfies CodexStateFile;

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(nextState, null, 2), "utf8");
}

export function readCodexStateEntries(): CodexStateEntry[] {
  return getStateDirCandidates({
    preferredEnv: "CODING_AGENTS_TMUX_CODEX_STATE_DIR",
    legacyEnv: "OPENCODE_TMUX_CODEX_STATE_DIR",
    subdirectory: "codex-state",
  })
    .filter((stateDir) => existsSync(stateDir))
    .flatMap((stateDir) =>
      readdirSync(stateDir)
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => join(stateDir, entry))
        .map((filePath) => ({ filePath, state: readStateFile(filePath) }))
        .filter((entry): entry is CodexStateEntry => Boolean(entry.state?.directory)),
    );
}

export function readCodexStates(): CodexStateFile[] {
  return readCodexStateEntries().map((entry) => entry.state);
}

function buildManagedHook(command: string): CodexHookCommand {
  return {
    type: "command",
    command,
    statusMessage: "Updating Codex tmux state",
  };
}

function buildManagedCodexHooks(command: string): CodexHooksDocument {
  const hook = buildManagedHook(command);

  return {
    hooks: {
      SessionStart: [{ matcher: "startup|resume", hooks: [hook] }],
      UserPromptSubmit: [{ hooks: [hook] }],
      PreToolUse: [{ matcher: "Bash", hooks: [hook] }],
      PostToolUse: [{ matcher: "Bash", hooks: [hook] }],
      Stop: [{ hooks: [hook] }],
    },
  };
}

function isManagedHookGroup(group: CodexHookMatcherGroup): boolean {
  return group.hooks.some(
    (hook) => hook.type === "command" && hook.statusMessage === "Updating Codex tmux state",
  );
}

export function updateCodexConfig(existing: string): string {
  const lines = existing.split(/\r?\n/);
  const dottedKeyIndex = lines.findIndex((line) => /^\s*features\.codex_hooks\s*=/.test(line));

  if (dottedKeyIndex >= 0) {
    lines[dottedKeyIndex] = "features.codex_hooks = true";
    return `${lines.join("\n").trimEnd()}\n`;
  }

  let featuresIndex = -1;
  let nextSectionIndex = lines.length;

  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*\[features\]\s*$/.test(lines[index] ?? "")) {
      featuresIndex = index;
      continue;
    }

    if (
      featuresIndex >= 0 &&
      index > featuresIndex &&
      /^\s*\[[^\]]+\]\s*$/.test(lines[index] ?? "")
    ) {
      nextSectionIndex = index;
      break;
    }
  }

  if (featuresIndex >= 0) {
    for (let index = featuresIndex + 1; index < nextSectionIndex; index += 1) {
      if (/^\s*codex_hooks\s*=/.test(lines[index] ?? "")) {
        lines[index] = "codex_hooks = true";
        return `${lines.join("\n").trimEnd()}\n`;
      }
    }

    lines.splice(nextSectionIndex, 0, "codex_hooks = true");
    return `${lines.join("\n").trimEnd()}\n`;
  }

  const trimmed = existing.trimEnd();
  return trimmed
    ? `${trimmed}\n\n[features]\ncodex_hooks = true\n`
    : "[features]\ncodex_hooks = true\n";
}

export function updateCodexHooks(existing: string, command: string): string {
  const parsed = existing.trim() ? (JSON.parse(existing) as CodexHooksDocument) : {};
  const nextHooks = { ...parsed.hooks };
  const managedHooks = buildManagedCodexHooks(command).hooks ?? {};

  for (const [eventName, managedGroups] of Object.entries(managedHooks)) {
    const groups = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : [];
    nextHooks[eventName] = [
      ...groups.filter((group) => !isManagedHookGroup(group)),
      ...managedGroups,
    ];
  }

  return `${JSON.stringify({ ...parsed, hooks: nextHooks }, null, 2)}\n`;
}

export function installCodexIntegration(command: string): CodexInstallResult {
  const configPath = getCodexConfigPath();
  const hooksPath = getCodexHooksPath();
  const codexHome = getCodexHome();
  const existingConfig = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const existingHooks = existsSync(hooksPath) ? readFileSync(hooksPath, "utf8") : "";

  mkdirSync(codexHome, { recursive: true });
  writeFileSync(configPath, updateCodexConfig(existingConfig), "utf8");
  writeFileSync(hooksPath, updateCodexHooks(existingHooks, command), "utf8");

  return { configPath, hooksPath };
}

export function buildCodexHooksTemplate(command: string): string {
  return `${JSON.stringify(buildManagedCodexHooks(command), null, 2)}\n`;
}
