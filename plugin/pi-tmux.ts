import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

interface PiSessionManager {
  getSessionFile(): string | undefined;
  getSessionName(): string | undefined;
}

interface PiExtensionContext {
  cwd: string;
  sessionManager: PiSessionManager;
}

interface PiExtensionAPI {
  getSessionName(): string | undefined;
  on(
    eventName: "session_start" | "agent_start" | "turn_start" | "agent_end" | "session_shutdown",
    handler: (event: unknown, ctx: PiExtensionContext) => void | Promise<void>,
  ): void;
}

const STATE_DIR =
  process.env.OPENCODE_TMUX_PI_STATE_DIR ??
  join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "opencode-tmux",
    "pi-state",
  );

interface PiStateFile {
  activity?: "busy" | "idle" | "unknown";
  detail?: string;
  directory?: string;
  paneId?: string | null;
  sessionFile?: string | null;
  sourceEventType?: string;
  status?: "running" | "waiting-input" | "idle" | "new" | "unknown";
  target?: string | null;
  title?: string;
  updatedAt?: number;
  version?: number;
}

interface AssistantTextBlock {
  type?: string;
  text?: string;
}

interface AssistantLikeMessage {
  content?: AssistantTextBlock[] | string;
  role?: string;
}

interface AgentEndEvent {
  messages?: AssistantLikeMessage[];
}

function normalizeEnvValue(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function getPiStateDir(): string {
  return STATE_DIR;
}

function runTmuxCommand(args: string[]) {
  return spawnSync("tmux", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function resolveTmuxPaneTarget(paneId: string | null): string | null {
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

function readStateFile(filePath: string): PiStateFile | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as PiStateFile;
  } catch {
    return null;
  }
}

function getDefaultTitle(directory: string, sessionName: string | undefined): string {
  const trimmedSessionName = sessionName?.trim();

  if (trimmedSessionName) {
    return trimmedSessionName;
  }

  const name = basename(directory);
  return name ? name : "Pi session";
}

function extractLatestAssistantText(event: AgentEndEvent): string | null {
  const messages = Array.isArray(event.messages) ? event.messages : [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message?.role !== "assistant") {
      continue;
    }

    if (typeof message.content === "string") {
      const trimmed = message.content.trim();
      return trimmed ? trimmed : null;
    }

    if (!Array.isArray(message.content)) {
      continue;
    }

    const text = message.content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text?.trim() ?? "")
      .filter(Boolean)
      .join("\n")
      .trim();

    if (text) {
      return text;
    }
  }

  return null;
}

function classifyAssistantWaitingText(text: string | null): {
  detail: string;
  status: "idle" | "waiting-input";
} {
  if (!text) {
    return {
      detail: "Pi is idle and ready for input",
      status: "idle",
    };
  }

  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  if (
    /\?\s*$/.test(trimmed) ||
    ["would you like", "do you want", "should i", "please confirm", "can you", "could you"].some(
      (fragment) => lower.includes(fragment),
    )
  ) {
    return {
      detail: "Pi is waiting for user input",
      status: "waiting-input",
    };
  }

  return {
    detail: "Pi is idle and ready for input",
    status: "idle",
  };
}

export default function (pi: PiExtensionAPI) {
  const paneId = normalizeEnvValue(process.env.TMUX_PANE);

  function getStateFilePath(directory: string): string {
    return join(getPiStateDir(), toFileName({ directory, paneId }));
  }

  function persistState(input: {
    activity: NonNullable<PiStateFile["activity"]>;
    detail: string;
    directory: string;
    sessionFile: string | null;
    sourceEventType: string;
    status: NonNullable<PiStateFile["status"]>;
    title: string | undefined;
  }) {
    const filePath = getStateFilePath(input.directory);
    const existing = readStateFile(filePath);
    const target = resolveTmuxPaneTarget(paneId) ?? existing?.target ?? null;
    const title =
      input.title ?? existing?.title ?? getDefaultTitle(input.directory, pi.getSessionName());
    const state = {
      version: 1,
      paneId,
      target,
      directory: input.directory,
      title,
      activity: input.activity,
      status: input.status,
      detail: input.detail,
      updatedAt: Date.now(),
      sourceEventType: input.sourceEventType,
      sessionFile: input.sessionFile ?? existing?.sessionFile ?? null,
    } satisfies PiStateFile;

    mkdirSync(getPiStateDir(), { recursive: true });
    writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
  }

  function removeState(directory: string) {
    const filePath = getStateFilePath(directory);

    if (!existsSync(filePath)) {
      return;
    }

    try {
      unlinkSync(filePath);
    } catch {
      // Ignore cleanup failures.
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    persistState({
      activity: "idle",
      detail: "Pi session initialized",
      directory: ctx.cwd,
      sessionFile: ctx.sessionManager.getSessionFile() ?? null,
      sourceEventType: "session_start",
      status: "new",
      title: ctx.sessionManager.getSessionName(),
    });
  });

  pi.on("agent_start", async (_event, ctx) => {
    persistState({
      activity: "busy",
      detail: "Pi is processing a user request",
      directory: ctx.cwd,
      sessionFile: ctx.sessionManager.getSessionFile() ?? null,
      sourceEventType: "agent_start",
      status: "running",
      title: ctx.sessionManager.getSessionName(),
    });
  });

  pi.on("turn_start", async (_event, ctx) => {
    persistState({
      activity: "busy",
      detail: "Pi is processing a user request",
      directory: ctx.cwd,
      sessionFile: ctx.sessionManager.getSessionFile() ?? null,
      sourceEventType: "turn_start",
      status: "running",
      title: ctx.sessionManager.getSessionName(),
    });
  });

  pi.on("agent_end", async (event, ctx) => {
    const waiting = classifyAssistantWaitingText(
      extractLatestAssistantText(event as AgentEndEvent),
    );

    persistState({
      activity: waiting.status === "waiting-input" ? "busy" : "idle",
      detail: waiting.detail,
      directory: ctx.cwd,
      sessionFile: ctx.sessionManager.getSessionFile() ?? null,
      sourceEventType: "agent_end",
      status: waiting.status,
      title: ctx.sessionManager.getSessionName(),
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    removeState(ctx.cwd);
  });
}
