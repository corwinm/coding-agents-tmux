import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type RuntimeStatus =
  | "running"
  | "waiting-question"
  | "waiting-input"
  | "idle"
  | "new"
  | "unknown";

interface SessionInfo {
  readonly id: string;
  readonly title?: string;
  readonly location: { readonly directory: string };
  readonly time?: { readonly updated?: number };
}

interface CachedCollection<T> {
  list(sessionID: string): T[] | undefined;
  sync(sessionID: string): Promise<void>;
  invalidate(sessionID: string): void;
}

interface FormInfo {
  readonly id?: string;
  readonly fields?: ReadonlyArray<{
    readonly type?: string;
    readonly options?: readonly unknown[];
  }>;
}

export interface PanePluginContext {
  readonly location?: { readonly directory: string };
  readonly ui: {
    readonly router: {
      current():
        | { readonly type: "home" }
        | { readonly type: "session"; readonly sessionID: string }
        | { readonly type: "plugin"; readonly id: string; readonly name: string };
    };
  };
  readonly data: {
    readonly on: (
      type: string,
      handler: (event: { readonly type: string; readonly data: Record<string, unknown> }) => void,
    ) => () => void;
    readonly session: {
      get(sessionID: string): SessionInfo | undefined;
      root(sessionID: string): string;
      family(sessionID: string): string[];
      status(sessionID: string): "idle" | "running" | "retry";
      sync(sessionID: string): Promise<void>;
      invalidate(sessionID: string): void;
      readonly pending: CachedCollection<unknown>;
      readonly permission: CachedCollection<unknown>;
      readonly form: CachedCollection<FormInfo>;
    };
  };
}

export interface PaneState {
  readonly version: 2;
  readonly paneId: string | null;
  readonly target: string | null;
  readonly sessionId: string | null;
  readonly selectedSessionId: string | null;
  readonly familySessionIds: string[];
  readonly directory: string;
  readonly title: string;
  readonly activity: "busy" | "idle" | "unknown";
  readonly status: RuntimeStatus;
  readonly detail: string;
  readonly updatedAt: number;
  readonly sourceEventType: string;
  readonly opencodeGeneration: "v2";
}

interface DeriveOptions {
  readonly paneId: string | null;
  readonly target: string | null;
  readonly sourceEventType: string;
  readonly now: number;
  readonly statusOverrides?: ReadonlyMap<string, "idle" | "running" | "retry">;
}

type Cleanup = () => void;

interface SetupOptions {
  readonly navigationPollMs?: number;
  readonly reconcileMs?: number;
  readonly refreshRetryMs?: number;
  readonly paneId?: string | null;
  readonly resolveTarget?: (paneId: string | null) => string | null;
  readonly writeState?: (state: PaneState) => void;
  readonly scheduleTmuxRefresh?: () => Cleanup | void;
  readonly now?: () => number;
}

const EVENT_TYPES = [
  "session.status",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
] as const;

function normalizeEnvValue(value: string | undefined): string | null {
  const result = value?.trim();
  return result ? result : null;
}

function defaultStateDir(): string {
  return (
    normalizeEnvValue(process.env.CODING_AGENTS_TMUX_STATE_DIR) ??
    join(
      normalizeEnvValue(process.env.XDG_STATE_HOME) ?? join(homedir(), ".local", "state"),
      "coding-agents-tmux",
      "plugin-state",
    )
  );
}

function stateFileName(state: Pick<PaneState, "directory" | "paneId">): string {
  if (state.paneId) return `pane-${Buffer.from(state.paneId).toString("hex")}.json`;
  return `cwd-${Buffer.from(state.directory).toString("hex")}.json`;
}

function familyFor(
  context: PanePluginContext,
  selectedSessionId: string,
): {
  rootSessionId: string;
  familySessionIds: string[];
} {
  const rootSessionId = context.data.session.root(selectedSessionId);
  const familySessionIds = Array.from(
    new Set([rootSessionId, ...context.data.session.family(rootSessionId)]),
  );
  return { rootSessionId, familySessionIds };
}

function hasSelectableOptions(form: FormInfo): boolean {
  return (
    form.fields?.some(
      (field) =>
        (field.type === "multiselect" && (field.options?.length ?? 0) > 0) ||
        (field.options?.length ?? 0) > 0,
    ) ?? false
  );
}

export function derivePaneState(
  context: PanePluginContext,
  selectedSessionId: string,
  options: DeriveOptions,
): PaneState {
  const { rootSessionId, familySessionIds } = familyFor(context, selectedSessionId);
  const root = context.data.session.get(rootSessionId);
  const hasQuestion = familySessionIds.some((sessionID) =>
    context.data.session.form.list(sessionID)?.some(hasSelectableOptions),
  );
  const hasForms = familySessionIds.some(
    (sessionID) => (context.data.session.form.list(sessionID)?.length ?? 0) > 0,
  );
  const hasPermissions = familySessionIds.some(
    (sessionID) => (context.data.session.permission.list(sessionID)?.length ?? 0) > 0,
  );
  const hasPending = familySessionIds.some(
    (sessionID) => (context.data.session.pending.list(sessionID)?.length ?? 0) > 0,
  );
  const familyStatuses = familySessionIds.map(
    (sessionID) =>
      options.statusOverrides?.get(sessionID) ?? context.data.session.status(sessionID),
  );
  const hasRunning =
    hasPending || familyStatuses.some((status) => status === "running" || status === "retry");

  let status: RuntimeStatus;
  let detail: string;
  if (hasQuestion) {
    status = "waiting-question";
    detail = "session family has a selectable form";
  } else if (hasForms || hasPermissions) {
    status = "waiting-input";
    detail = "session family has pending input";
  } else if (hasRunning) {
    status = "running";
    detail = "session family is running";
  } else {
    status = "idle";
    detail = "session family is idle";
  }

  return {
    version: 2,
    paneId: options.paneId,
    target: options.target,
    sessionId: rootSessionId,
    selectedSessionId,
    familySessionIds,
    directory: root?.location.directory ?? context.location?.directory ?? process.cwd(),
    title: root?.title ?? rootSessionId,
    activity: status === "idle" ? "idle" : "busy",
    status,
    detail,
    updatedAt: options.now,
    sourceEventType: options.sourceEventType,
    opencodeGeneration: "v2",
  };
}

function deriveUnselectedState(context: PanePluginContext, options: DeriveOptions): PaneState {
  const directory = context.location?.directory ?? process.cwd();
  return {
    version: 2,
    paneId: options.paneId,
    target: options.target,
    sessionId: null,
    selectedSessionId: null,
    familySessionIds: [],
    directory,
    title: directory.split("/").filter(Boolean).at(-1) ?? "OpenCode session",
    activity: "idle",
    status: "new",
    detail: "no session selected",
    updatedAt: options.now,
    sourceEventType: options.sourceEventType,
    opencodeGeneration: "v2",
  };
}

export function writeStateAtomically(stateDir: string, state: PaneState): void {
  mkdirSync(stateDir, { recursive: true });
  const destination = join(stateDir, stateFileName(state));
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state, null, 2), "utf8");
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function runTmuxCommand(args: string[]) {
  return spawnSync("tmux", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export function resolveTmuxPaneTarget(paneId: string | null): string | null {
  if (!paneId) return null;
  const result = runTmuxCommand([
    "display-message",
    "-p",
    "-t",
    paneId,
    "#{session_name}:#{window_index}.#{pane_index}",
  ]);
  if (result.status !== 0) return null;
  const target = result.stdout.trim();
  return target || null;
}

function createTmuxRefreshScheduler(): { schedule: () => void; cleanup: Cleanup } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const children = new Set<ChildProcess>();
  const childTimers = new Map<ChildProcess, ReturnType<typeof setTimeout>>();

  const finishChild = (child: ChildProcess) => {
    children.delete(child);
    const timeout = childTimers.get(child);
    if (timeout) clearTimeout(timeout);
    childTimers.delete(child);
  };

  const dispatchNotification = (command: string) => {
    const child = spawn(process.env.SHELL ?? "/bin/sh", ["-c", command], { stdio: "ignore" });
    children.add(child);
    const timeout = setTimeout(() => child.kill(), 5_000);
    timeout.unref();
    childTimers.set(child, timeout);
    child.once("error", () => finishChild(child));
    child.once("exit", () => finishChild(child));
    child.unref();
  };

  return {
    schedule() {
      if (!process.env.TMUX || timer) return;
      timer = setTimeout(() => {
        timer = null;
        runTmuxCommand(["refresh-client", "-S"]);
        const result = runTmuxCommand([
          "show-option",
          "-gqv",
          "@coding-agents-tmux-notify-command",
        ]);
        const command = result.status === 0 ? result.stdout.trim() : "";
        if (command) dispatchNotification(command);
      }, 150);
      timer.unref();
    },
    cleanup() {
      if (timer) clearTimeout(timer);
      timer = null;
      for (const child of children) child.kill();
      for (const timeout of childTimers.values()) clearTimeout(timeout);
      children.clear();
      childTimers.clear();
    },
  };
}

function selectedSession(context: PanePluginContext): string | null {
  const route = context.ui.router.current();
  return route.type === "session" ? route.sessionID : null;
}

function eventSessionID(event: { readonly data: Record<string, unknown> }): string | null {
  if (typeof event.data.sessionID === "string") return event.data.sessionID;
  const form = event.data.form;
  if (form && typeof form === "object" && "sessionID" in form) {
    const sessionID = (form as { readonly sessionID?: unknown }).sessionID;
    if (typeof sessionID === "string") return sessionID;
  }
  return null;
}

function eventStatus(event: {
  readonly type: string;
  readonly data: Record<string, unknown>;
}): "idle" | "running" | "retry" | null {
  if (event.type === "session.status") {
    const status = event.data.status;
    if (status && typeof status === "object" && "type" in status) {
      const type = (status as { type?: unknown }).type;
      if (type === "idle" || type === "busy" || type === "retry") {
        return type === "busy" ? "running" : type;
      }
    }
  }
  if (event.type === "session.execution.started") return "running";
  if (
    event.type === "session.execution.succeeded" ||
    event.type === "session.execution.failed" ||
    event.type === "session.execution.interrupted"
  ) {
    return "idle";
  }
  return null;
}

async function syncFamily(context: PanePluginContext, selectedSessionId: string): Promise<void> {
  await context.data.session.sync(selectedSessionId);

  for (let generation = 0; generation < 8; generation += 1) {
    const before = familyFor(context, selectedSessionId);
    await Promise.all(
      before.familySessionIds.flatMap((sessionID) => [
        context.data.session.sync(sessionID),
        context.data.session.pending.sync(sessionID),
        context.data.session.permission.sync(sessionID),
        context.data.session.form.sync(sessionID),
      ]),
    );
    const after = familyFor(context, selectedSessionId);
    if (
      before.rootSessionId === after.rootSessionId &&
      before.familySessionIds.length === after.familySessionIds.length &&
      before.familySessionIds.every((sessionID) => after.familySessionIds.includes(sessionID))
    ) {
      return;
    }
  }
}

export async function setupPanePlugin(
  context: PanePluginContext,
  options: SetupOptions = {},
): Promise<Cleanup> {
  const paneId = options.paneId ?? normalizeEnvValue(process.env.TMUX_PANE);
  const resolveTarget = options.resolveTarget ?? resolveTmuxPaneTarget;
  const writeState =
    options.writeState ?? ((state: PaneState) => writeStateAtomically(defaultStateDir(), state));
  const tmuxScheduler = options.scheduleTmuxRefresh ? null : createTmuxRefreshScheduler();
  const scheduleTmuxRefresh = options.scheduleTmuxRefresh ?? tmuxScheduler!.schedule;
  const now = options.now ?? Date.now;
  const statusOverrides = new Map<string, "idle" | "running" | "retry">();
  const effectCleanups = new Set<Cleanup>();
  const unsubscribers: Cleanup[] = [];
  let disposed = false;
  let generation = 0;
  let lastSelectedSessionId: string | null = null;
  let pendingNavigationSessionId: string | null | undefined;
  let navigationTimer: ReturnType<typeof setInterval> | null = null;
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    generation += 1;
    pendingNavigationSessionId = undefined;
    if (navigationTimer) clearInterval(navigationTimer);
    navigationTimer = null;
    if (reconcileTimer) clearInterval(reconcileTimer);
    reconcileTimer = null;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    for (const unsubscribe of unsubscribers) unsubscribe();
    for (const cleanupEffect of effectCleanups) cleanupEffect();
    effectCleanups.clear();
    tmuxScheduler?.cleanup();
  };

  const refresh = async (sourceEventType: string) => {
    const currentGeneration = ++generation;
    const sessionID = selectedSession(context);
    if (sessionID) await syncFamily(context, sessionID);
    if (disposed || currentGeneration !== generation || selectedSession(context) !== sessionID)
      return;

    const base = {
      paneId,
      target: resolveTarget(paneId),
      sourceEventType,
      now: now(),
      statusOverrides,
    } satisfies DeriveOptions;
    const state = sessionID
      ? derivePaneState(context, sessionID, base)
      : deriveUnselectedState(context, base);
    writeState(state);
    for (const familySessionID of state.familySessionIds) {
      statusOverrides.delete(familySessionID);
    }
    const cleanupEffect = scheduleTmuxRefresh();
    if (cleanupEffect) effectCleanups.add(cleanupEffect);
    lastSelectedSessionId = sessionID;
  };

  const queueRefresh = (sourceEventType: string, onSettled?: () => void) => {
    void refresh(sourceEventType)
      .catch(() => {
        if (disposed || retryTimer) return;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          queueRefresh("cache.reconcile");
        }, options.refreshRetryMs ?? 250);
        retryTimer.unref();
      })
      .finally(onSettled);
  };

  for (const type of EVENT_TYPES) {
    unsubscribers.push(
      context.data.on(type, (event) => {
        const sessionID = eventSessionID(event);
        if (sessionID) {
          context.data.session.invalidate(sessionID);
          context.data.session.pending.invalidate(sessionID);
          context.data.session.permission.invalidate(sessionID);
          context.data.session.form.invalidate(sessionID);
          const status = eventStatus(event);
          const selected = selectedSession(context);
          const selectedFamily = selected ? familyFor(context, selected).familySessionIds : [];
          if (status && selectedFamily.includes(sessionID)) {
            statusOverrides.set(sessionID, status);
          } else {
            statusOverrides.delete(sessionID);
          }
        }
        queueRefresh(event.type);
      }),
    );
  }

  try {
    await refresh("plugin.init");
  } catch (error) {
    cleanup();
    throw error;
  }

  navigationTimer = setInterval(() => {
    const current = selectedSession(context);
    if (current === lastSelectedSessionId || current === pendingNavigationSessionId) return;
    pendingNavigationSessionId = current;
    queueRefresh("ui.navigation", () => {
      if (pendingNavigationSessionId === current) pendingNavigationSessionId = undefined;
    });
  }, options.navigationPollMs ?? 100);
  navigationTimer.unref();

  reconcileTimer = setInterval(() => {
    queueRefresh("cache.reconcile");
  }, options.reconcileMs ?? 2_000);
  reconcileTimer.unref();

  return cleanup;
}
