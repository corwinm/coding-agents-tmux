import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";

import { notifyIntegration } from "./notifications.ts";
import { getPreferredStateDir } from "../naming.ts";
import type { DiscoveredPane, PaneRuntimeSummary, RuntimeStatus } from "../types.ts";

const STATE_TTL_MS = 60_000;
const CLOCK_SKEW_MS = 5_000;
const EVENTS = [
  "sessionStart",
  "userPromptSubmitted",
  "agentStop",
  "sessionEnd",
  "notification",
] as const;
type EventName = (typeof EVENTS)[number];
interface HookState {
  version: 1;
  paneId: string;
  sessionId: string;
  processPid: number;
  previousSessionId?: string;
  directory: string;
  status: RuntimeStatus;
  event: EventName;
  eventAt: number;
  updatedAt: number;
}
interface HookOptions {
  processPid?: number;
  paneId?: string | null;
  stateDir?: string;
  now?: number;
  notify?: () => Promise<void>;
  eventName?: string;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function paneFile(stateDir: string, paneId: string): string {
  return join(stateDir, `pane-${Buffer.from(paneId).toString("hex")}.json`);
}
export function getCopilotStateDir(): string {
  return getPreferredStateDir({
    env: "CODING_AGENTS_TMUX_COPILOT_STATE_DIR",
    subdirectory: "copilot-state",
  });
}
export function getCopilotHooksPath(
  home = process.env.COPILOT_HOME ?? join(homedir(), ".copilot"),
): string {
  return join(home, "hooks", "coding-agents-tmux.json");
}
function readState(file: string, paneId: string): HookState | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      value.paneId !== paneId ||
      typeof value.sessionId !== "string" ||
      !value.sessionId ||
      typeof value.processPid !== "number" ||
      !Number.isSafeInteger(value.processPid) ||
      value.processPid <= 0 ||
      typeof value.directory !== "string" ||
      !["running", "idle", "waiting-question", "waiting-input", "unknown"].includes(
        String(value.status),
      ) ||
      !EVENTS.includes(value.event as EventName) ||
      typeof value.eventAt !== "number" ||
      !Number.isFinite(value.eventAt) ||
      typeof value.updatedAt !== "number" ||
      !Number.isFinite(value.updatedAt)
    )
      return null;
    return value as unknown as HookState;
  } catch {
    return null;
  }
}

// A bounded lock serializes separate hook processes, including detached /clear
// sessionEnd callbacks. Atomic replacement protects concurrent CLI readers.
async function withPaneLock(file: string, action: () => boolean): Promise<boolean> {
  const lock = `${file}.lock`;
  for (let i = 0; i < 30; i++) {
    try {
      mkdirSync(lock);
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
      // A killed hook must not strand subsequent events indefinitely.
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000)
          rmSync(lock, { recursive: true, force: true });
      } catch {
        /* another writer released it */
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }
    try {
      return action();
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
  return false;
}
export async function persistCopilotHookState(
  raw: string,
  options: HookOptions = {},
): Promise<void> {
  const paneId = options.paneId === undefined ? process.env.TMUX_PANE : options.paneId;
  if (!paneId || !/^%\d+$/.test(paneId) || (!process.env.TMUX && options.paneId === undefined))
    return;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isRecord(value)) return;
  const event = options.eventName ?? value.event;
  const now = options.now ?? Date.now();
  if (
    !EVENTS.includes(event as EventName) ||
    typeof value.sessionId !== "string" ||
    !value.sessionId ||
    typeof value.cwd !== "string" ||
    !value.cwd ||
    typeof value.timestamp !== "number" ||
    !Number.isFinite(value.timestamp) ||
    value.timestamp > now + CLOCK_SKEW_MS
  )
    return;
  if (
    event === "notification" &&
    !["permission_prompt", "elicitation_dialog"].includes(String(value.notification_type))
  )
    return;
  if (event === "sessionStart" && !["startup", "resume", "new"].includes(String(value.source)))
    return;
  const sessionId = value.sessionId as string;
  const directory = value.cwd as string;
  const timestamp = value.timestamp as number;
  const processPid =
    options.processPid ?? (options.paneId === undefined ? process.ppid : process.pid);
  if (!Number.isSafeInteger(processPid) || processPid <= 0) return;
  const dir = options.stateDir ?? getCopilotStateDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = paneFile(dir, paneId);
  const changed = await withPaneLock(file, () => {
    const stored = readState(file, paneId);
    const old = stored?.processPid === processPid ? stored : null;
    if (
      old &&
      (sessionId === old.previousSessionId ||
        timestamp < old.eventAt ||
        (sessionId !== old.sessionId &&
          event !== "sessionStart" &&
          event !== "userPromptSubmitted"))
    )
      return false;
    // sessionStart can follow the first submitted prompt: don't reset the turn.
    const sameSession = old?.sessionId === sessionId;
    const status: RuntimeStatus =
      event === "sessionEnd"
        ? "unknown"
        : event === "agentStop"
          ? "idle"
          : event === "userPromptSubmitted"
            ? "running"
            : event === "notification"
              ? value.notification_type === "permission_prompt"
                ? "waiting-question"
                : "waiting-input"
              : (value.source === "resume" && old?.event !== "userPromptSubmitted") ||
                  !sameSession ||
                  !old
                ? "idle"
                : old.status;
    const state: HookState = {
      version: 1,
      paneId,
      processPid,
      sessionId,
      directory,
      status,
      event: event as EventName,
      eventAt: timestamp,
      updatedAt: now,
      ...(old && !sameSession
        ? { previousSessionId: old.sessionId }
        : old?.previousSessionId
          ? { previousSessionId: old.previousSessionId }
          : {}),
    };
    const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
      renameSync(temp, file);
    } finally {
      if (existsSync(temp)) rmSync(temp);
    }
    return true;
  });
  if (changed) await (options.notify ?? notifyIntegration)();
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === "EPERM";
  }
}

function isForegroundProcess(pid: number, tty: string): boolean {
  if (!tty.startsWith("/dev/")) return false;
  const result = spawnSync("ps", ["-p", String(pid), "-o", "pgid=,tpgid=,tty="], {
    encoding: "utf8",
    timeout: 500,
  });
  if (result.status !== 0) return false;
  const match = result.stdout.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/);
  return Boolean(
    match &&
    match[1] === match[2] &&
    match[2] !== "0" &&
    (match[3] === tty || `/dev/${match[3]}` === tty),
  );
}

export function attachRuntimeWithCopilot(
  panes: DiscoveredPane[],
  options: {
    stateDir?: string;
    now?: number;
    isForeground?: (pid: number, tty: string) => boolean;
  } = {},
): PaneRuntimeSummary[] {
  const now = options.now ?? Date.now();
  const dir = options.stateDir ?? getCopilotStateDir();
  return panes.map((entry) => {
    const state = readState(paneFile(dir, entry.pane.paneId), entry.pane.paneId);
    const matching =
      state?.directory === entry.pane.currentPath &&
      isProcessAlive(state.processPid) &&
      (options.isForeground ?? isForegroundProcess)(state.processPid, entry.pane.tty) &&
      state.updatedAt <= now + CLOCK_SKEW_MS
        ? state
        : null;
    const fresh = matching && now - matching.updatedAt < STATE_TTL_MS;
    return {
      ...entry,
      runtime: {
        activity: fresh
          ? matching.status === "idle"
            ? ("idle" as const)
            : matching.status === "unknown"
              ? ("unknown" as const)
              : ("busy" as const)
          : ("unknown" as const),
        status: fresh ? matching.status : "unknown",
        source: fresh ? "copilot-hook" : "copilot-command",
        match: { strategy: "exact", provider: "copilot", heuristic: false },
        session: {
          id: fresh ? matching.sessionId : `copilot:${entry.pane.target}`,
          directory: entry.pane.currentPath,
          title: basename(entry.pane.currentPath) || "Copilot CLI",
          timeUpdated: fresh ? matching.updatedAt : now,
        },
        detail: fresh
          ? `Copilot ${matching.event} hook (${Math.max(0, now - matching.updatedAt)}ms old); expires after ${STATE_TTL_MS}ms`
          : matching
            ? `Copilot hook stale (${Math.max(0, now - matching.updatedAt)}ms old); command-only fallback`
            : "Copilot CLI process detected; hook state absent or disabled; command-only fallback",
      },
    };
  });
}

export function buildCopilotHooksTemplate(command: string): string {
  const hooks: Record<string, unknown[]> = {};
  for (const event of EVENTS) {
    hooks[event] = [
      {
        type: "command",
        exec: command,
        args: ["copilot-hook-state", event],
        timeoutSec: 5,
        ...(event === "notification" ? { matcher: "permission_prompt|elicitation_dialog" } : {}),
      },
    ];
  }
  return `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`;
}
export function installCopilotIntegration(command: string, home?: string): { hooksPath: string } {
  const path = getCopilotHooksPath(home);
  const dir = join(home ?? process.env.COPILOT_HOME ?? join(homedir(), ".copilot"), "hooks");
  const next = buildCopilotHooksTemplate(command);
  mkdirSync(dir, { recursive: true });
  let output = next;
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    if (existing === next) return { hooksPath: path };
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      throw new Error(`Refusing to replace unrecognized hook file: ${path}`);
    }
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.hooks))
      throw new Error(`Refusing to replace unrecognized hook file: ${path}`);
    const desired = JSON.parse(next) as { hooks: Record<EventName, unknown[]> };
    const hooks = { ...parsed.hooks };
    for (const event of EVENTS) {
      const entries = hooks[event];
      if (entries !== undefined && !Array.isArray(entries))
        throw new Error(`Refusing to replace malformed hook entries: ${path}`);
      hooks[event] = [
        ...(entries ?? []).filter(
          (entry: unknown) =>
            !isRecord(entry) ||
            !Array.isArray(entry.args) ||
            entry.args[0] !== "copilot-hook-state",
        ),
        ...desired.hooks[event],
      ];
    }
    output = `${JSON.stringify({ ...parsed, hooks }, null, 2)}\n`;
    if (output === existing) return { hooksPath: path };
  }
  writeFileSync(path, output, { mode: 0o600 });
  return { hooksPath: path };
}
