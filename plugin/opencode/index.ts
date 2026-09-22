import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const stateDirOverride = process.env.CODING_AGENTS_TMUX_STATE_DIR?.trim();
const stateHome = process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
const STATE_DIR = stateDirOverride || join(stateHome, "coding-agents-tmux", "plugin-state");

let tmuxRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function dispatchNotification(command: string) {
  const child = spawn(process.env.SHELL ?? "/bin/sh", ["-c", command], { stdio: "ignore" });
  const timeout = setTimeout(() => child.kill(), 5_000);
  const clear = () => clearTimeout(timeout);
  timeout.unref();
  child.once("error", clear);
  child.once("exit", clear);
  child.unref();
}

interface PluginLogClient {
  app: {
    log(input: {
      body: {
        service: string;
        level: string;
        message: string;
        extra: Record<string, unknown>;
      };
    }): Promise<unknown>;
  };
}

interface PluginProject {
  name?: string;
}

interface PluginInitContext {
  directory: string;
  project?: PluginProject;
  client: PluginLogClient;
}

interface PluginEventContext {
  event: { type: string; [key: string]: unknown };
}

function scheduleTmuxStatusRefresh() {
  if (!process.env.TMUX || tmuxRefreshTimer) {
    return;
  }

  tmuxRefreshTimer = setTimeout(() => {
    tmuxRefreshTimer = null;
    spawnSync("tmux", ["refresh-client", "-S"], { stdio: "ignore" });
    const notificationResult = spawnSync(
      "tmux",
      ["show-option", "-gqv", "@coding-agents-tmux-notify-command"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const configured =
      notificationResult.status === 0 && typeof notificationResult.stdout === "string"
        ? notificationResult.stdout.trim()
        : "";

    if (configured) {
      dispatchNotification(configured);
    }
  }, 150);
}

// NOTE: duplicated verbatim in src/core/opencode.ts — the plugin ships as a
// standalone symlink and cannot import from src/. Keep both copies in sync.
function getNestedValue(payload: unknown, path: string[]): unknown {
  let current: unknown = payload;

  for (const key of path) {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }

    if (!(key in current)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

function getStringCandidate(payload: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    const value = getNestedValue(payload, path);
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function getStatusCandidate(payload: unknown): string | null {
  return getStringCandidate(payload, [
    ["status"],
    ["session", "status"],
    ["state", "status"],
    ["properties", "status", "type"],
    ["properties", "part", "state", "status"],
  ]);
}

function getToolCandidate(payload: unknown): string | null {
  return getStringCandidate(payload, [
    ["tool"],
    ["session", "tool"],
    ["state", "tool"],
    ["properties", "part", "tool"],
  ]);
}

function getOptionCount(payload: unknown): number | null {
  const candidates = [
    ["question", "options"],
    ["questions", "0", "options"],
    ["session", "question", "options"],
    ["session", "questions", "0", "options"],
    ["input", "questions", "0", "options"],
    ["state", "input", "questions", "0", "options"],
    ["session", "input", "questions", "0", "options"],
    ["properties", "questions", "0", "options"],
    ["properties", "part", "state", "input", "questions", "0", "options"],
  ];

  for (const path of candidates) {
    const value = getNestedValue(payload, path);
    if (Array.isArray(value)) {
      return value.length;
    }
  }

  return null;
}

function getBooleanCandidate(payload: unknown, paths: string[][]): boolean | null {
  for (const path of paths) {
    const value = getNestedValue(payload, path);
    if (typeof value === "boolean") {
      return value;
    }
  }

  return null;
}

function getNumberCandidate(payload: unknown, paths: string[][]): number | null {
  for (const path of paths) {
    const value = getNestedValue(payload, path);
    if (typeof value === "number") {
      return value;
    }
  }

  return null;
}

function normalizeEnvValue(value: string | undefined) {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function runTmuxCommand(args: string[]) {
  return spawnSync("tmux", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function resolveTmuxPaneTarget(paneId: string | null) {
  if (!paneId) {
    return null;
  }

  const result = runTmuxCommand([
    "display-message",
    "-p",
    "-t",
    paneId,
    "#{session_name}:#{window_index}.#{pane_index}",
  ]);

  if (result.status !== 0) {
    return null;
  }

  const target = result.stdout.trim();
  return target ? target : null;
}

function toFileName(input: { directory: string; paneId: string | null }) {
  if (input.paneId) {
    return `pane-${Buffer.from(input.paneId).toString("hex")}.json`;
  }

  return `cwd-${Buffer.from(input.directory).toString("hex")}.json`;
}

function isWaitingStatus(status: string | null) {
  return status === "waiting-question" || status === "waiting-input";
}

function isQuestionLikeEvent(input: {
  status: string | null;
  tool: string | null;
  optionCount: number | null;
}) {
  if (isWaitingStatus(input.status)) {
    return true;
  }

  if (input.tool === "question") {
    return true;
  }

  return input.optionCount !== null;
}

function getWaitingStatus(input: {
  status: string | null;
  tool: string | null;
  optionCount: number | null;
}) {
  if (input.status === "waiting-question") {
    return "waiting-question" as const;
  }

  if (input.status === "waiting-input") {
    return "waiting-input" as const;
  }

  if (input.optionCount !== null) {
    return input.optionCount > 0 ? ("waiting-question" as const) : ("waiting-input" as const);
  }

  if (
    isQuestionLikeEvent({ status: input.status, tool: input.tool, optionCount: input.optionCount })
  ) {
    return "waiting-input" as const;
  }

  return null;
}

type WaitingStatus = "waiting-question" | "waiting-input";

const MISSING_REQUEST_ID = "__coding-agents-tmux:unknown-request__";

function getRequestId(event: { type: string; [key: string]: unknown }): string {
  const id = getStringCandidate(event, [
    ["properties", "id"],
    ["properties", "requestID"],
  ]);
  return id ?? MISSING_REQUEST_ID;
}

export const CodingAgentsTmuxPlugin = async ({ directory, project, client }: PluginInitContext) => {
  const paneId = normalizeEnvValue(process.env.TMUX_PANE);
  const state = {
    version: 2,
    paneId,
    target: resolveTmuxPaneTarget(paneId),
    sessionId: null as string | null,
    directory,
    title: project?.name ?? directory.split("/").filter(Boolean).pop() ?? "OpenCode session",
    activity: "idle" as "busy" | "idle" | "unknown",
    status: "new" as "running" | "waiting-question" | "waiting-input" | "idle" | "new" | "unknown",
    detail: "plugin initialized; awaiting first session event",
    updatedAt: Date.now(),
    sourceEventType: "plugin.init",
  };

  // Sticky latch of unreplied permission/question prompts, keyed by request id.
  // While non-empty, the pane is forced to the recorded waiting status so that
  // interleaved busy events (message.part.updated, session.status) cannot clobber
  // it. Released per-key on reply/reject and wholesale on session.idle.
  const pendingPrompts = new Map<string, WaitingStatus>();

  function latchWaitingStatus(): WaitingStatus | null {
    let latest: WaitingStatus | null = null;
    for (const value of pendingPrompts.values()) {
      latest = value;
    }
    return latest;
  }

  async function persist() {
    const target = resolveTmuxPaneTarget(state.paneId);

    if (target) {
      state.target = target;
    }

    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(
      join(STATE_DIR, toFileName({ directory: state.directory, paneId: state.paneId })),
      JSON.stringify(state, null, 2),
    );
  }

  function applyDerivedStatus(event: { type: string; [key: string]: unknown }) {
    const sessionId = getStringCandidate(event, [
      ["properties", "sessionID"],
      ["properties", "info", "id"],
      ["properties", "part", "sessionID"],
      ["session", "id"],
      ["sessionID"],
      ["sessionId"],
    ]);
    const sessionTitle = getStringCandidate(event, [
      ["properties", "info", "title"],
      ["session", "title"],
    ]);
    const sessionDirectory = getStringCandidate(event, [
      ["properties", "info", "directory"],
      ["properties", "info", "path", "cwd"],
      ["session", "directory"],
    ]);
    const status = getStatusCandidate(event);
    const tool = getToolCandidate(event);
    const busy = getBooleanCandidate(event, [["busy"], ["session", "busy"], ["state", "busy"]]);
    const optionCount = getOptionCount(event);
    const updatedAt = getNumberCandidate(event, [
      ["timeUpdated"],
      ["session", "timeUpdated"],
      ["timestamp"],
      ["properties", "info", "time", "updated"],
      ["properties", "part", "state", "time", "start"],
      ["properties", "part", "state", "time", "end"],
    ]);

    if (sessionId) {
      state.sessionId = sessionId;
    }

    if (sessionTitle) {
      state.title = sessionTitle;
    }

    if (sessionDirectory) {
      state.directory = sessionDirectory;
    }

    state.updatedAt = updatedAt ?? Date.now();
    state.sourceEventType = event.type;

    if (event.type === "session.idle") {
      pendingPrompts.clear();
      state.activity = "idle";
      state.status = "idle";
      state.detail = "session.idle event";
      return;
    }

    if (event.type === "session.error") {
      state.activity = "unknown";
      state.status = "unknown";
      state.detail = "session.error event";
      return;
    }

    const waitingStatus = getWaitingStatus({ status, tool, optionCount });

    if (event.type === "permission.asked" || event.type === "question.asked") {
      const forced =
        waitingStatus ?? (event.type === "question.asked" ? "waiting-question" : "waiting-input");
      pendingPrompts.set(getRequestId(event), forced);
      state.activity = "busy";
      state.status = forced;
      state.detail = `${event.type} event`;
      return;
    }

    if (
      event.type === "permission.replied" ||
      event.type === "question.replied" ||
      event.type === "question.rejected"
    ) {
      pendingPrompts.delete(getRequestId(event));
      const remaining = latchWaitingStatus();

      if (remaining) {
        state.activity = "busy";
        state.status = remaining;
        state.detail = `${event.type} with pending prompt`;
        return;
      }

      state.activity = "busy";
      state.status = "running";
      state.detail = `${event.type} event`;
      return;
    }

    // Any other event while a prompt is latched keeps the pane waiting.
    const latched = latchWaitingStatus();
    if (latched) {
      state.activity = "busy";
      state.status = latched;
      state.detail = `${event.type} kept latched waiting state`;
      return;
    }

    if (waitingStatus) {
      state.activity = "busy";
      state.status = waitingStatus;
      state.detail = `${event.type} waiting event`;
      return;
    }

    if (status === "idle" || busy === false) {
      state.activity = "idle";
      state.status = "idle";
      state.detail = `${event.type} idle event`;
      return;
    }

    if (
      status === "running" ||
      status === "busy" ||
      busy === true ||
      event.type === "session.status"
    ) {
      state.activity = "busy";
      state.status = "running";
      state.detail = `${event.type} running event`;
      return;
    }
  }

  await client.app.log({
    body: {
      service: "coding-agents-tmux-plugin",
      level: "info",
      message: "plugin initialized",
      extra: { directory, paneId: state.paneId, stateDir: STATE_DIR, target: state.target },
    },
  });

  await persist();
  scheduleTmuxStatusRefresh();

  return {
    event: async ({ event }: PluginEventContext) => {
      applyDerivedStatus(event);
      await persist();
      scheduleTmuxStatusRefresh();
    },
  };
};

export default {
  id: "coding-agents-tmux",
  setup() {},
  server: CodingAgentsTmuxPlugin,
};
