import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  getCodexStateDir,
  readCodexStateEntries,
  type CodexStateEntry,
  type CodexStateFile,
} from "./codex.ts";
import { detectOpenCodeVersion } from "./opencode-generation.ts";
import { getOpenCodeConfigRoot } from "./opencode-install.ts";
import { capturePanePreview } from "./tmux.ts";
import { getEnvValue, getPreferredStateDir, getStateDirCandidates } from "../naming.ts";
import type {
  CodexRuntimeDebug,
  DiscoveredPane,
  InspectDebugInfo,
  OpenCodeRuntimeDebug,
  PaneRuntimeSummary,
  RuntimeInfo,
  RuntimeProviderName,
  RuntimeProviderOptions,
  RuntimeSource,
  RuntimeStatus,
  SessionMatch,
  TmuxPane,
} from "../types.ts";

const RECENT_SESSION_WINDOW_MS = 30 * 60 * 1000;

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  close(): void;
  prepare(sql: string): SqliteStatement;
}

interface SqliteDatabaseConstructor {
  new (path: string, options?: { readonly?: boolean }): SqliteDatabase;
}

interface NodeSqliteDatabaseConstructor {
  new (
    path: string,
    options?: { readOnly?: boolean },
  ): {
    close(): void;
    prepare(sql: string): SqliteStatement;
  };
}

interface SessionRow {
  id: string;
  directory: string;
  title: string;
  time_updated: number;
}

interface RunningPartRow {
  tool: string | null;
  status: string | null;
  option_count: number | null;
}

interface WorkflowStateRow {
  last_step_finish: number | null;
  last_step_start: number | null;
}

interface ServerStatusResult {
  endpoint: string;
  info: RuntimeInfo;
}

interface V2ServerMap {
  generation: "v2";
  endpoint: string;
  panes: Record<string, { sessionId?: string }>;
}

type ParsedServerMap = { generation: "v1"; endpoints: Record<string, string> } | V2ServerMap;

interface HeuristicSessionMatch {
  session: SessionMatch;
  source: RuntimeSource;
  strategy: RuntimeInfo["match"]["strategy"];
  detailPrefix: string;
}

interface PluginStateFile {
  activity?: RuntimeInfo["activity"];
  detail?: string;
  directory?: string;
  paneId?: string | null;
  sessionId?: string;
  selectedSessionId?: string;
  familySessionIds?: string[];
  opencodeGeneration?: "v1" | "v2";
  status?: RuntimeStatus;
  target?: string | null;
  title?: string;
  updatedAt?: number;
  version?: number;
}

interface PluginStateIndex {
  descendantMatches: Map<string, PluginStateFile | null>;
  exactPaneIdMatches: Map<string, PluginStateFile>;
  exactTargetMatches: Map<string, PluginStateFile>;
  statesByDirectory: Map<string, PluginStateFile[]>;
  states: PluginStateFile[];
}

interface PluginStateEntry {
  filePath: string;
  state: PluginStateFile;
}

interface CodexStateIndex {
  entryByState: Map<CodexStateFile, CodexStateEntry>;
  exactPaneIdMatches: Map<string, CodexStateFile>;
  exactTargetMatches: Map<string, CodexStateFile>;
  statesByDirectory: Map<string, CodexStateFile[]>;
}

function getStateUpdatedAt(state: PluginStateFile): number {
  return state.updatedAt ?? 0;
}

function getCodexStateUpdatedAt(state: CodexStateFile): number {
  return state.updatedAt ?? 0;
}

function pickNewerState(
  current: PluginStateFile | undefined,
  candidate: PluginStateFile,
): PluginStateFile {
  if (!current || getStateUpdatedAt(candidate) > getStateUpdatedAt(current)) {
    return candidate;
  }

  return current;
}

function pickNewerCodexState(
  current: CodexStateFile | undefined,
  candidate: CodexStateFile,
): CodexStateFile {
  if (!current || getCodexStateUpdatedAt(candidate) > getCodexStateUpdatedAt(current)) {
    return candidate;
  }

  return current;
}

function getLegacyOpencodeDbPath(): string {
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, "opencode", "opencode.db");
}

async function getOpencodeDbPath(): Promise<{
  path: string;
  source: "env" | "debug-paths" | "legacy";
}> {
  const configured = process.env.OPENCODE_DB?.trim();
  if (configured) return { path: configured, source: "env" };

  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile("opencode", ["debug", "paths", "db"], { timeout: 3_000 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      });
    });
    const lastLine = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    if (lastLine) return { path: lastLine, source: "debug-paths" };
  } catch {
    // Supported V1 versions do not necessarily expose this command.
  }

  return { path: getLegacyOpencodeDbPath(), source: "legacy" };
}

export function getPluginStateDir(): string {
  return getPreferredStateDir({
    env: "CODING_AGENTS_TMUX_STATE_DIR",
    subdirectory: "plugin-state",
  });
}

async function loadSqliteDatabaseConstructor(): Promise<SqliteDatabaseConstructor> {
  const loadNodeModule = new Function('return import("node:sqlite")') as () => Promise<{
    DatabaseSync: NodeSqliteDatabaseConstructor;
  }>;
  const module = await loadNodeModule();

  return class WrappedNodeDatabase implements SqliteDatabase {
    private readonly database;

    constructor(path: string, options?: { readonly?: boolean }) {
      this.database =
        options?.readonly === undefined
          ? new module.DatabaseSync(path)
          : new module.DatabaseSync(path, { readOnly: options.readonly });
    }

    close(): void {
      this.database.close();
    }

    prepare(sql: string): SqliteStatement {
      return this.database.prepare(sql);
    }
  };
}

async function openDatabase(): Promise<SqliteDatabase> {
  const { path: databasePath } = await getOpencodeDbPath();

  if (!existsSync(databasePath)) {
    throw new Error(`opencode database not found at ${databasePath}`);
  }

  const Database = await loadSqliteDatabaseConstructor();
  const database = new Database(databasePath, { readonly: true });
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => (row as { name?: unknown }).name)
    .filter((name): name is string => typeof name === "string");

  if (tables.includes("session_v2")) {
    database.close();
    throw new Error(
      `OpenCode SQLite provider is unavailable for V2 schema at ${databasePath}; use plugin or V2 server state`,
    );
  }
  if (!tables.includes("session") || !tables.includes("part")) {
    database.close();
    throw new Error(`unknown OpenCode SQLite schema at ${databasePath}`);
  }

  return database;
}

function getSessionMatch(database: SqliteDatabase, directory: string): SessionMatch | null {
  const row = database
    .prepare(
      `
        SELECT id, directory, title, time_updated
        FROM session
        WHERE directory = ?1
        ORDER BY time_updated DESC
        LIMIT 1
      `,
    )
    .get(directory) as SessionRow | null;

  if (!row) {
    return null;
  }

  return toSessionMatch(row);
}

function toSessionMatch(row: SessionRow): SessionMatch {
  return {
    id: row.id,
    directory: row.directory,
    title: row.title,
    timeUpdated: row.time_updated,
  };
}

function getDescendantSessions(database: SqliteDatabase, directory: string): SessionMatch[] {
  const normalizedDirectory = directory.endsWith("/") ? directory : `${directory}/`;

  const rows = database
    .prepare(
      `
        SELECT id, directory, title, time_updated
        FROM session
        WHERE directory LIKE ?1
        ORDER BY time_updated DESC
      `,
    )
    .all(`${normalizedDirectory}%`) as SessionRow[];

  return rows.map(toSessionMatch);
}

function getRunningPart(database: SqliteDatabase, sessionId: string): RunningPartRow | null {
  return database
    .prepare(
      `
        SELECT
          json_extract(data, '$.tool') AS tool,
          json_extract(data, '$.state.status') AS status,
          COALESCE(json_array_length(json_extract(data, '$.state.input.questions[0].options')), 0) AS option_count
        FROM part
        WHERE session_id = ?1
          AND json_extract(data, '$.state.status') = 'running'
        ORDER BY time_updated DESC
        LIMIT 1
      `,
    )
    .get(sessionId) as RunningPartRow | null;
}

function getWorkflowState(database: SqliteDatabase, sessionId: string): WorkflowStateRow | null {
  return database
    .prepare(
      `
        SELECT
          MAX(CASE WHEN json_extract(data, '$.type') = 'step-start' THEN time_updated END) AS last_step_start,
          MAX(CASE WHEN json_extract(data, '$.type') = 'step-finish' THEN time_updated END) AS last_step_finish
        FROM part
        WHERE session_id = ?1
      `,
    )
    .get(sessionId) as WorkflowStateRow | null;
}

function createRuntimeInfo(input: {
  activity: RuntimeInfo["activity"];
  status: RuntimeStatus;
  source: RuntimeSource;
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

function toPluginSessionMatch(state: PluginStateFile): SessionMatch | null {
  if (!state.directory || !state.title) {
    return null;
  }

  return {
    id: state.sessionId ?? `plugin:${state.directory}`,
    directory: state.directory,
    title: state.title,
    timeUpdated: state.updatedAt ?? Date.now(),
  };
}

function readPluginStateEntries(): PluginStateEntry[] {
  return getStateDirCandidates({
    env: "CODING_AGENTS_TMUX_STATE_DIR",
    subdirectory: "plugin-state",
  })
    .filter((stateDir) => existsSync(stateDir))
    .flatMap((stateDir) =>
      readdirSync(stateDir)
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => join(stateDir, entry))
        .map((filePath): PluginStateEntry | null => {
          try {
            return {
              filePath,
              state: JSON.parse(readFileSync(filePath, "utf8")) as PluginStateFile,
            };
          } catch {
            return null;
          }
        })
        .filter((entry): entry is PluginStateEntry =>
          Boolean(entry?.state && typeof entry.state === "object" && entry.state.directory),
        ),
    );
}

function readPluginStates(): PluginStateFile[] {
  return readPluginStateEntries().map((entry) => entry.state);
}

function buildPluginStateIndex(states = readPluginStates()): PluginStateIndex {
  const exactPaneIdMatches = new Map<string, PluginStateFile>();
  const exactTargetMatches = new Map<string, PluginStateFile>();
  const statesByDirectory = new Map<string, PluginStateFile[]>();

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
        pickNewerState(exactPaneIdMatches.get(state.paneId), state),
      );
    }

    if (state.target) {
      exactTargetMatches.set(
        state.target,
        pickNewerState(exactTargetMatches.get(state.target), state),
      );
    }
  }

  return {
    descendantMatches: new Map<string, PluginStateFile | null>(),
    exactPaneIdMatches,
    exactTargetMatches,
    statesByDirectory,
    states,
  };
}

function getLatestPluginState(states: PluginStateFile[]): PluginStateFile | null {
  return states.reduce<PluginStateFile | null>((latest, state) => {
    if (!latest || getStateUpdatedAt(state) > getStateUpdatedAt(latest)) {
      return state;
    }

    return latest;
  }, null);
}

const PANE_BOUND_PLUGIN_STATE_MAX_AGE_MS = 30_000;

function isCurrentPaneBoundPluginState(state: PluginStateFile, pane: TmuxPane): boolean {
  const updatedAt = getStateUpdatedAt(state);
  return (
    state.directory === pane.currentPath &&
    updatedAt > 0 &&
    Date.now() - updatedAt <= PANE_BOUND_PLUGIN_STATE_MAX_AGE_MS
  );
}

function getPaneBoundPluginState(index: PluginStateIndex, pane: TmuxPane): PluginStateFile | null {
  const paneIdState = index.exactPaneIdMatches.get(pane.paneId);
  if (paneIdState && isCurrentPaneBoundPluginState(paneIdState, pane)) return paneIdState;

  const targetState = index.exactTargetMatches.get(pane.target);
  return targetState &&
    (!targetState.paneId || targetState.paneId === pane.paneId) &&
    isCurrentPaneBoundPluginState(targetState, pane)
    ? targetState
    : null;
}

function getExactPluginState(index: PluginStateIndex, pane: TmuxPane): PluginStateFile | null {
  const paneIdState = index.exactPaneIdMatches.get(pane.paneId);

  if (paneIdState) {
    return paneIdState;
  }

  const targetState = index.exactTargetMatches.get(pane.target);

  if (targetState && (!targetState.paneId || targetState.paneId === pane.paneId)) {
    return targetState;
  }

  const states = (index.statesByDirectory.get(pane.currentPath) ?? []).filter(
    (state) => !state.paneId || state.paneId === pane.paneId,
  );

  if (states.length === 0) {
    return null;
  }

  const legacyStates = states.filter((state) => !state.paneId && !state.target);

  if (legacyStates.length > 0) {
    return getLatestPluginState(legacyStates);
  }

  if (states.length === 1) {
    return states[0] ?? null;
  }

  return null;
}

function getDescendantPluginState(
  index: PluginStateIndex,
  directory: string,
): PluginStateFile | null {
  if (index.descendantMatches.has(directory)) {
    return index.descendantMatches.get(directory) ?? null;
  }

  const normalizedDirectory = directory.endsWith("/") ? directory : `${directory}/`;
  const states = index.states.filter((state) => state.directory?.startsWith(normalizedDirectory));

  let match: PluginStateFile | null = null;

  if (states.length === 1) {
    match = states[0] ?? null;
  } else if (states.length > 0) {
    const busyStates = states.filter((state) => state.activity === "busy");
    if (busyStates.length === 1) {
      match = busyStates[0] ?? null;
    }
  }

  index.descendantMatches.set(directory, match);
  return match;
}

function classifyPluginState(
  state: PluginStateFile | null,
  source: RuntimeSource,
  heuristic: boolean,
): RuntimeInfo {
  if (!state?.directory) {
    return createRuntimeInfo({
      activity: "unknown",
      status: "unknown",
      source: "unmapped",
      strategy: "unmapped",
      provider: "none",
      heuristic: false,
      session: null,
      detail: "no matching plugin state for pane cwd",
    });
  }

  const status = state.status ?? "unknown";
  const activity =
    state.activity ??
    (status === "idle" || status === "new" ? "idle" : status === "unknown" ? "unknown" : "busy");

  return createRuntimeInfo({
    activity,
    status,
    source,
    strategy: heuristic ? "descendant-only" : "exact",
    provider: "plugin",
    heuristic,
    session: toPluginSessionMatch(state),
    detail: state.detail ?? "plugin state file",
  });
}

function attachRuntimeWithPlugin(
  panes: DiscoveredPane[],
  index = buildPluginStateIndex(),
): PaneRuntimeSummary[] {
  return panes.map((entry) => {
    const exactState = getExactPluginState(index, entry.pane);

    if (exactState) {
      return {
        ...entry,
        runtime: classifyPluginState(exactState, "plugin-exact", false),
      };
    }

    const descendantState = getDescendantPluginState(index, entry.pane.currentPath);

    if (descendantState) {
      return {
        ...entry,
        runtime: classifyPluginState(descendantState, "plugin-descendant", true),
      };
    }

    return {
      ...entry,
      runtime: classifyPluginState(null, "unmapped", false),
    };
  });
}

function hasUnfinishedStep(workflowState: WorkflowStateRow | null): boolean {
  if (!workflowState?.last_step_start) {
    return false;
  }

  return workflowState.last_step_start > (workflowState.last_step_finish ?? 0);
}

function classifyRuntime(
  session: SessionMatch | null,
  runningPart: RunningPartRow | null,
  workflowState: WorkflowStateRow | null,
): RuntimeInfo {
  if (!session) {
    return createRuntimeInfo({
      activity: "unknown",
      status: "unknown",
      source: "unmapped",
      strategy: "unmapped",
      provider: "none",
      heuristic: false,
      session: null,
      detail: "no matching opencode session for pane cwd",
    });
  }

  if (!runningPart || runningPart.status !== "running") {
    if (hasUnfinishedStep(workflowState)) {
      return createRuntimeInfo({
        activity: "busy",
        status: "running",
        source: "sqlite-exact",
        strategy: "exact",
        provider: "sqlite",
        heuristic: false,
        session,
        detail: "session has an unfinished step",
      });
    }

    return createRuntimeInfo({
      activity: "idle",
      status: "idle",
      source: "sqlite-exact",
      strategy: "exact",
      provider: "sqlite",
      heuristic: false,
      session,
      detail: "no running tool parts for matched session",
    });
  }

  const tool = runningPart.tool ?? "unknown";
  const optionCount = runningPart.option_count ?? 0;

  if (tool === "question") {
    return createRuntimeInfo({
      activity: "busy",
      status: optionCount > 0 ? "waiting-question" : "waiting-input",
      source: "sqlite-exact",
      strategy: "exact",
      provider: "sqlite",
      heuristic: false,
      session,
      detail:
        optionCount > 0
          ? "running question tool with options"
          : "running question tool without options",
    });
  }

  return createRuntimeInfo({
    activity: "busy",
    status: "running",
    source: "sqlite-exact",
    strategy: "exact",
    provider: "sqlite",
    heuristic: false,
    session,
    detail: `running ${tool} tool`,
  });
}

function classifyRuntimeWithSource(
  session: SessionMatch,
  runningPart: RunningPartRow | null,
  workflowState: WorkflowStateRow | null,
  source: RuntimeSource,
  strategy: RuntimeInfo["match"]["strategy"],
  detailPrefix: string,
): RuntimeInfo {
  const runtime = classifyRuntime(session, runningPart, workflowState);

  return {
    ...runtime,
    source,
    match: {
      strategy,
      provider: "sqlite",
      heuristic: true,
    },
    detail: `${detailPrefix}; ${runtime.detail}`,
  };
}

function getHeuristicSessionMatch(
  database: SqliteDatabase,
  directory: string,
): HeuristicSessionMatch | null {
  const descendants = getDescendantSessions(database, directory);

  if (descendants.length === 0) {
    return null;
  }

  const runningDescendants = descendants.filter((session) => {
    const runningPart = getRunningPart(database, session.id);
    return (
      runningPart?.status === "running" || hasUnfinishedStep(getWorkflowState(database, session.id))
    );
  });

  if (runningDescendants.length === 1) {
    const session = runningDescendants[0];

    if (!session) {
      return null;
    }

    return {
      session,
      source: "sqlite-descendant-running",
      strategy: "descendant-running",
      detailPrefix: "matched unique running descendant session under pane cwd",
    };
  }

  const recentCutoff = Date.now() - RECENT_SESSION_WINDOW_MS;
  const recentDescendants = descendants.filter((session) => session.timeUpdated >= recentCutoff);

  if (recentDescendants.length === 1) {
    const session = recentDescendants[0];

    if (!session) {
      return null;
    }

    return {
      session,
      source: "sqlite-descendant-recent",
      strategy: "descendant-recent",
      detailPrefix: "matched unique recent descendant session under pane cwd",
    };
  }

  if (descendants.length === 1) {
    const session = descendants[0];

    if (!session) {
      return null;
    }

    return {
      session,
      source: "sqlite-descendant-only",
      strategy: "descendant-only",
      detailPrefix: "matched only descendant session under pane cwd",
    };
  }

  return null;
}

async function attachRuntimeWithSqlite(panes: DiscoveredPane[]): Promise<PaneRuntimeSummary[]> {
  let database: SqliteDatabase;

  try {
    database = await openDatabase();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return panes.map((entry) => ({
      ...entry,
      runtime: createRuntimeInfo({
        activity: "unknown",
        status: "unknown",
        source: "unmapped",
        strategy: "unmapped",
        provider: "none",
        heuristic: false,
        session: null,
        detail: message,
      }),
    }));
  }

  try {
    return panes.map((entry) => {
      const exactSession = getSessionMatch(database, entry.pane.currentPath);

      if (exactSession) {
        const runningPart = getRunningPart(database, exactSession.id);
        const workflowState = getWorkflowState(database, exactSession.id);
        return { ...entry, runtime: classifyRuntime(exactSession, runningPart, workflowState) };
      }

      const heuristicMatch = getHeuristicSessionMatch(database, entry.pane.currentPath);

      if (heuristicMatch) {
        const runningPart = getRunningPart(database, heuristicMatch.session.id);
        const workflowState = getWorkflowState(database, heuristicMatch.session.id);
        return {
          ...entry,
          runtime: classifyRuntimeWithSource(
            heuristicMatch.session,
            runningPart,
            workflowState,
            heuristicMatch.source,
            heuristicMatch.strategy,
            heuristicMatch.detailPrefix,
          ),
        };
      }

      return {
        ...entry,
        runtime: createRuntimeInfo({
          activity: "unknown",
          status: "unknown",
          source: "unmapped",
          strategy: "unmapped",
          provider: "none",
          heuristic: false,
          session: null,
          detail: "no exact or safe heuristic opencode session match for pane cwd",
        }),
      };
    });
  } finally {
    database.close();
  }
}

function normalizeServerMapSource(value: string | undefined): string | null {
  if (value && value.trim()) {
    return value.trim();
  }

  return getEnvValue("CODING_AGENTS_TMUX_SERVER_MAP") ?? null;
}

function parseServerMap(value: string | undefined): ParsedServerMap {
  const source = normalizeServerMapSource(value);

  if (!source) {
    return { generation: "v1", endpoints: {} };
  }

  const raw = existsSync(source) ? readFileSync(source, "utf8") : source;
  const parsed = JSON.parse(raw) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("server map must be a JSON object of pane target to endpoint");
  }

  const record = parsed as Record<string, unknown>;
  if (record.generation === "v2") {
    if (typeof record.endpoint !== "string" || !record.endpoint.trim()) {
      throw new Error("V2 server map requires a non-empty endpoint");
    }
    if (!record.panes || typeof record.panes !== "object" || Array.isArray(record.panes)) {
      throw new Error("V2 server map requires a panes object");
    }

    const panes: Record<string, { sessionId?: string }> = {};
    for (const [target, entry] of Object.entries(record.panes as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const sessionId = (entry as { sessionId?: unknown }).sessionId;
      panes[target] =
        typeof sessionId === "string" && sessionId.trim() ? { sessionId: sessionId.trim() } : {};
    }

    return {
      generation: "v2",
      endpoint: record.endpoint.trim().replace(/\/$/, ""),
      panes,
    };
  }

  const endpoints: Record<string, string> = {};
  for (const [key, valuePart] of Object.entries(record)) {
    if (typeof valuePart === "string" && valuePart.trim()) {
      endpoints[key] = valuePart.trim().replace(/\/$/, "");
    }
  }

  return { generation: "v1", endpoints };
}

// NOTE: duplicated verbatim in plugin/coding-agents-tmux.ts — the plugin ships
// as a standalone symlink and cannot import from src/. Keep both copies in sync.
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

function getBooleanCandidate(payload: unknown, paths: string[][]): boolean | null {
  for (const path of paths) {
    const value = getNestedValue(payload, path);
    if (typeof value === "boolean") {
      return value;
    }
  }
  return null;
}

function getOptionCountCandidate(payload: unknown): number | null {
  const candidates = [
    ["question", "options"],
    ["input", "questions", "0", "options"],
    ["state", "input", "questions", "0", "options"],
  ];

  for (const path of candidates) {
    const value = getNestedValue(payload, path);
    if (Array.isArray(value)) {
      return value.length;
    }
  }

  return null;
}

function getServerSessionMatch(payload: unknown): SessionMatch | null {
  const id = getStringCandidate(payload, [["session", "id"], ["id"]]);
  const directory = getStringCandidate(payload, [["session", "directory"], ["directory"]]);
  const title = getStringCandidate(payload, [["session", "title"], ["title"]]);
  const updatedValue =
    getNestedValue(payload, ["session", "timeUpdated"]) ?? getNestedValue(payload, ["timeUpdated"]);
  const timeUpdated = typeof updatedValue === "number" ? updatedValue : Date.now();

  if (!id || !directory || !title) {
    return null;
  }

  return { id, directory, title, timeUpdated };
}

function classifyServerPayload(endpoint: string, payload: unknown): RuntimeInfo {
  if (
    (payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      Object.keys(payload as Record<string, unknown>).length === 0) ||
    (Array.isArray(payload) && payload.length === 0)
  ) {
    return createRuntimeInfo({
      activity: "unknown",
      status: "unknown",
      source: "server-explicit",
      strategy: "target-map",
      provider: "server",
      heuristic: false,
      session: null,
      detail: `server at ${endpoint} is reachable but has no active session context`,
    });
  }

  const session = getServerSessionMatch(payload);
  const status = getStringCandidate(payload, [
    ["status"],
    ["session", "status"],
    ["state", "status"],
  ]);
  const tool = getStringCandidate(payload, [["tool"], ["session", "tool"], ["state", "tool"]]);
  const busy = getBooleanCandidate(payload, [["busy"], ["session", "busy"], ["state", "busy"]]);
  const optionCount = getOptionCountCandidate(payload);

  if (
    status === "waiting-question" ||
    (tool === "question" && optionCount !== null && optionCount > 0)
  ) {
    return createRuntimeInfo({
      activity: "busy",
      status: "waiting-question",
      source: "server-explicit",
      strategy: "target-map",
      provider: "server",
      heuristic: false,
      session,
      detail: `server status from ${endpoint}`,
    });
  }

  if (status === "waiting-input" || (tool === "question" && optionCount === 0)) {
    return createRuntimeInfo({
      activity: "busy",
      status: "waiting-input",
      source: "server-explicit",
      strategy: "target-map",
      provider: "server",
      heuristic: false,
      session,
      detail: `server status from ${endpoint}`,
    });
  }

  if (status === "running" || busy === true) {
    return createRuntimeInfo({
      activity: "busy",
      status: "running",
      source: "server-explicit",
      strategy: "target-map",
      provider: "server",
      heuristic: false,
      session,
      detail: `server status from ${endpoint}`,
    });
  }

  if (status === "idle" || busy === false) {
    return createRuntimeInfo({
      activity: "idle",
      status: "idle",
      source: "server-explicit",
      strategy: "target-map",
      provider: "server",
      heuristic: false,
      session,
      detail: `server status from ${endpoint}`,
    });
  }

  return createRuntimeInfo({
    activity: "unknown",
    status: "unknown",
    source: "server-explicit",
    strategy: "target-map",
    provider: "server",
    heuristic: false,
    session,
    detail: `server payload from ${endpoint} did not match known status shape`,
  });
}

function shouldFallbackFromServer(runtime: RuntimeInfo): boolean {
  return runtime.status === "unknown";
}

async function fetchServerStatus(target: string, endpoint: string): Promise<ServerStatusResult> {
  const infoResponse = await fetch(`${endpoint}/api/info`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (infoResponse.ok) {
    const info = unwrapV2Data(await infoResponse.json());
    const version = getStringCandidate(info, [["version"]]);
    if (version?.startsWith("2.")) {
      throw new Error(
        `server API mismatch for ${target}: legacy V1 map points to V2 ${version}; use a typed V2 shared-server map`,
      );
    }
  }

  const response = await fetch(`${endpoint}/session/status`, {
    signal: AbortSignal.timeout(3_000),
  });

  if (!response.ok) {
    throw new Error(
      `server provider request failed for ${target}: ${response.status} ${response.statusText}`,
    );
  }

  const payload = (await response.json()) as unknown;
  return { endpoint, info: classifyServerPayload(endpoint, payload) };
}

function unwrapV2Data(payload: unknown): unknown {
  return getNestedValue(payload, ["data"]) ?? payload;
}

async function fetchV2Json(endpoint: string, path: string): Promise<unknown> {
  const response = await fetch(`${endpoint}${path}`, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) {
    throw new Error(
      `V2 server request failed for ${path}: ${response.status} ${response.statusText}`,
    );
  }
  return unwrapV2Data(await response.json());
}

interface V2SessionMetadata {
  id: string;
  parentID: string | null;
}

async function fetchV2SessionMetadata(endpoint: string): Promise<V2SessionMetadata[]> {
  const sessions: V2SessionMetadata[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  do {
    const path =
      cursor === null ? "/api/session" : `/api/session?cursor=${encodeURIComponent(cursor)}`;
    const response = await fetch(`${endpoint}${path}`, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) {
      throw new Error(
        `V2 server request failed for ${path}: ${response.status} ${response.statusText}`,
      );
    }
    const payload = (await response.json()) as unknown;
    if (
      !payload ||
      typeof payload !== "object" ||
      !Array.isArray((payload as { data?: unknown }).data)
    ) {
      throw new Error(
        "V2 session family metadata is incomplete: /api/session data is not an array",
      );
    }
    for (const value of (payload as { data: unknown[] }).data) {
      if (!value || typeof value !== "object") {
        throw new Error("V2 session family metadata is incomplete: session entry is not an object");
      }
      const record = value as Record<string, unknown>;
      if (typeof record.id !== "string" || record.id.length === 0) {
        throw new Error("V2 session family metadata is incomplete: session id is missing");
      }
      if (
        record.parentID !== undefined &&
        record.parentID !== null &&
        typeof record.parentID !== "string"
      ) {
        throw new Error(
          `V2 session family metadata is incomplete for ${record.id}: invalid parentID`,
        );
      }
      sessions.push({
        id: record.id,
        parentID: typeof record.parentID === "string" ? record.parentID : null,
      });
    }

    const next = (payload as { cursor?: unknown }).cursor;
    if (next === undefined || next === null || next === "") {
      cursor = null;
    } else if (typeof next !== "string" || seenCursors.has(next)) {
      throw new Error("V2 session family metadata is ambiguous: invalid or repeated cursor");
    } else {
      seenCursors.add(next);
      cursor = next;
    }
  } while (cursor !== null);

  return sessions;
}

function reconstructV2SessionFamily(
  sessions: V2SessionMetadata[],
  rootSessionId: string,
): string[] {
  const byId = new Map<string, V2SessionMetadata>();
  for (const session of sessions) {
    if (byId.has(session.id)) {
      throw new Error(`V2 session family metadata is ambiguous: duplicate session ${session.id}`);
    }
    byId.set(session.id, session);
  }
  const root = byId.get(rootSessionId);
  if (!root) {
    throw new Error(
      `V2 session family metadata is incomplete: mapped root ${rootSessionId} is absent from /api/session`,
    );
  }
  if (root.parentID !== null) {
    throw new Error(
      `V2 session family metadata is ambiguous: mapped root ${rootSessionId} has parent ${root.parentID}`,
    );
  }
  for (const session of sessions) {
    if (session.parentID !== null && !byId.has(session.parentID)) {
      throw new Error(
        `V2 session family metadata is incomplete: parent ${session.parentID} for ${session.id} is absent`,
      );
    }
    const ancestors = new Set<string>();
    let current: V2SessionMetadata | undefined = session;
    while (current && current.parentID !== null) {
      if (ancestors.has(current.id)) {
        throw new Error(`V2 session family metadata is ambiguous: cycle includes ${current.id}`);
      }
      ancestors.add(current.id);
      current = byId.get(current.parentID);
    }
  }

  const family = [rootSessionId];
  for (let index = 0; index < family.length; index += 1) {
    const parentID = family[index];
    for (const session of sessions) {
      if (session.parentID === parentID) family.push(session.id);
    }
  }
  return family;
}

function hasSelectableForm(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSelectableForm);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type === "select" || record.type === "multi-select") return true;
  if (Array.isArray(record.options) && record.options.length > 0) return true;
  return Object.values(record).some(hasSelectableForm);
}

function toV2SessionMatch(
  payload: unknown,
  rootSessionId: string,
  pluginState: PluginStateFile | null,
): SessionMatch {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const time =
    record.time && typeof record.time === "object" ? (record.time as Record<string, unknown>) : {};
  return {
    id: typeof record.id === "string" ? record.id : rootSessionId,
    directory:
      typeof record.directory === "string"
        ? record.directory
        : (pluginState?.directory ?? "unknown"),
    title: typeof record.title === "string" ? record.title : (pluginState?.title ?? rootSessionId),
    timeUpdated:
      typeof record.timeUpdated === "number"
        ? record.timeUpdated
        : typeof time.updated === "number"
          ? time.updated
          : (pluginState?.updatedAt ?? Date.now()),
  };
}

async function fetchV2ServerRuntime(
  target: string,
  map: V2ServerMap,
  pluginState: PluginStateFile | null,
): Promise<RuntimeInfo> {
  const paneMapping = map.panes[target];
  if (!paneMapping) {
    throw new Error(`no V2 server pane mapping configured for ${target}`);
  }

  const rootSessionId =
    paneMapping.sessionId ||
    (pluginState?.opencodeGeneration === "v2" ? pluginState.sessionId : undefined);
  if (!rootSessionId) {
    throw new Error(
      `V2 server pane mapping for ${target} requires sessionId or exact plugin root state`,
    );
  }
  const trustedPluginState =
    pluginState?.opencodeGeneration === "v2" && pluginState.sessionId === rootSessionId
      ? pluginState
      : null;

  const info = await fetchV2Json(map.endpoint, "/api/info");
  const version = getStringCandidate(info, [["version"]]);
  if (!version?.startsWith("2.")) {
    throw new Error(
      `server API mismatch for ${target}: expected V2 from /api/info, received ${version ?? "unknown"}`,
    );
  }

  const active = await fetchV2Json(map.endpoint, "/api/session/active");
  const rootPayload = await fetchV2Json(
    map.endpoint,
    `/api/session/${encodeURIComponent(rootSessionId)}`,
  );
  const familySessionIds = reconstructV2SessionFamily(
    await fetchV2SessionMetadata(map.endpoint),
    rootSessionId,
  );
  let hasBlocker = false;
  let hasSelectableFamilyForm = false;

  for (const sessionId of familySessionIds) {
    const encoded = encodeURIComponent(sessionId);
    const permissions = await fetchV2Json(map.endpoint, `/api/session/${encoded}/permission`);
    const forms = await fetchV2Json(map.endpoint, `/api/session/${encoded}/form`);
    if (Array.isArray(permissions) && permissions.length > 0) hasBlocker = true;
    if (Array.isArray(forms) && forms.length > 0) {
      hasBlocker = true;
      if (hasSelectableForm(forms)) hasSelectableFamilyForm = true;
    }
  }

  const session = toV2SessionMatch(rootPayload, rootSessionId, trustedPluginState);
  const activeRecord =
    active && typeof active === "object" && !Array.isArray(active)
      ? (active as Record<string, unknown>)
      : {};
  const familyActive = familySessionIds.some((sessionId) => sessionId in activeRecord);
  const status: RuntimeStatus = hasSelectableFamilyForm
    ? "waiting-question"
    : hasBlocker
      ? "waiting-input"
      : familyActive
        ? "running"
        : "idle";

  return createRuntimeInfo({
    activity: status === "idle" ? "idle" : "busy",
    status,
    source: "server-explicit",
    strategy: "target-map",
    provider: "server",
    heuristic: false,
    session,
    detail: `OpenCode V2 ${version} shared-server state from ${map.endpoint}`,
  });
}

function isServerApiMismatch(error: unknown): boolean {
  return error instanceof Error && /server API mismatch/i.test(error.message);
}

function serverFailureRuntime(error: unknown): RuntimeInfo {
  return createRuntimeInfo({
    activity: "unknown",
    status: "unknown",
    source: "unmapped",
    strategy: "unmapped",
    provider: "none",
    heuristic: false,
    session: null,
    detail: error instanceof Error ? error.message : String(error),
  });
}

async function attachRuntimeWithServerMap(
  panes: DiscoveredPane[],
  options: RuntimeProviderOptions,
  fallbackToSqlite: boolean,
): Promise<PaneRuntimeSummary[]> {
  const serverMap = parseServerMap(options.serverMap);
  const pluginIndex = serverMap.generation === "v2" ? buildPluginStateIndex() : null;
  const sqliteFallback =
    fallbackToSqlite && serverMap.generation === "v1" ? await attachRuntimeWithSqlite(panes) : null;

  return Promise.all(
    panes.map(async (entry, index) => {
      try {
        let runtime: RuntimeInfo;
        if (serverMap.generation === "v2") {
          runtime = await fetchV2ServerRuntime(
            entry.pane.target,
            serverMap,
            pluginIndex ? getPaneBoundPluginState(pluginIndex, entry.pane) : null,
          );
        } else {
          const endpoint = serverMap.endpoints[entry.pane.target];
          if (!endpoint) throw new Error(`no server endpoint configured for ${entry.pane.target}`);
          runtime = (await fetchServerStatus(entry.pane.target, endpoint)).info;
        }

        if (sqliteFallback && shouldFallbackFromServer(runtime)) {
          return (
            sqliteFallback[index] ?? { ...entry, runtime: serverFailureRuntime("no fallback") }
          );
        }
        return { ...entry, runtime };
      } catch (error) {
        if (isServerApiMismatch(error)) {
          return { ...entry, runtime: serverFailureRuntime(error) };
        }
        if (sqliteFallback) {
          return sqliteFallback[index] ?? { ...entry, runtime: serverFailureRuntime(error) };
        }
        return { ...entry, runtime: serverFailureRuntime(error) };
      }
    }),
  );
}

function normalizeProvider(provider: RuntimeProviderName | undefined): RuntimeProviderName {
  const value = provider ?? "auto";

  if (value !== "auto" && value !== "plugin" && value !== "sqlite" && value !== "server") {
    throw new Error(`invalid runtime provider: ${value}`);
  }

  return value;
}

function toCodexSessionMatch(state: CodexStateFile): SessionMatch | null {
  if (!state.directory || !state.title) {
    return null;
  }

  return {
    id: state.sessionId ?? `codex:${state.directory}`,
    directory: state.directory,
    title: state.title,
    timeUpdated: state.updatedAt ?? Date.now(),
  };
}

function buildCodexStateIndex(entries = readCodexStateEntries()): CodexStateIndex {
  const entryByState = new Map<CodexStateFile, CodexStateEntry>();
  const exactPaneIdMatches = new Map<string, CodexStateFile>();
  const exactTargetMatches = new Map<string, CodexStateFile>();
  const statesByDirectory = new Map<string, CodexStateFile[]>();

  for (const entry of entries) {
    const { state } = entry;
    const directory = state.directory;

    if (!directory) {
      continue;
    }

    entryByState.set(state, entry);

    const directoryStates = statesByDirectory.get(directory) ?? [];
    directoryStates.push(state);
    statesByDirectory.set(directory, directoryStates);

    if (state.paneId) {
      exactPaneIdMatches.set(
        state.paneId,
        pickNewerCodexState(exactPaneIdMatches.get(state.paneId), state),
      );
    }

    if (state.target) {
      exactTargetMatches.set(
        state.target,
        pickNewerCodexState(exactTargetMatches.get(state.target), state),
      );
    }
  }

  return {
    entryByState,
    exactPaneIdMatches,
    exactTargetMatches,
    statesByDirectory,
  };
}

function getExactCodexState(index: CodexStateIndex, pane: TmuxPane): CodexStateFile | null {
  const targetState = index.exactTargetMatches.get(pane.target);

  if (targetState) {
    return targetState;
  }

  const paneIdState = index.exactPaneIdMatches.get(pane.paneId);

  if (paneIdState) {
    return paneIdState;
  }

  const states = (index.statesByDirectory.get(pane.currentPath) ?? []).filter(
    (state) => !state.paneId && !state.target,
  );

  if (states.length === 1) {
    return states[0] ?? null;
  }

  if (states.length > 1) {
    return states.reduce<CodexStateFile | null>((latest, state) => {
      if (!latest || getCodexStateUpdatedAt(state) > getCodexStateUpdatedAt(latest)) {
        return state;
      }

      return latest;
    }, null);
  }

  return null;
}

function getCodexPromptText(line: string): string | null {
  const match = line.match(/^[›>]\s+(?!\d+\.)(.+)$/);
  return match?.[1]?.trim() || null;
}

function isCodexPreviewChromeLine(line: string): boolean {
  return (
    /^╭[─]+╮$/.test(line) ||
    /^╰[─]+╯$/.test(line) ||
    /^│.*│$/.test(line) ||
    line.startsWith("Tip:") ||
    /^gpt-[^·]+·/.test(line) ||
    /^[-\w.]+\s+·\s+/.test(line) ||
    /^─+$/.test(line)
  );
}

function isCodexPermissionPromptLine(line: string): boolean {
  return (
    line.includes("Hooks need review") ||
    /Approval Required/.test(line) ||
    /codex wants to (run|modify|use|access)/i.test(line) ||
    /Press enter to confirm or esc to (cancel|go back)/i.test(line) ||
    /^Yes, (proceed|just this once|and )/.test(line) ||
    /^\[[a-z]\]\s+/.test(line)
  );
}

function hasCodexTranscriptBetween(lines: string[], startIndex: number, endIndex: number): boolean {
  return lines.slice(Math.max(0, startIndex), Math.max(0, endIndex)).some((line) => {
    if (isCodexPreviewChromeLine(line)) {
      return false;
    }

    return (
      getCodexPromptText(line) !== null ||
      line.startsWith("• ") ||
      line.startsWith("└") ||
      line.startsWith("… +") ||
      line.startsWith("↳")
    );
  });
}

function classifyCodexPreview(
  lines: string[],
): Pick<RuntimeInfo, "activity" | "detail" | "status"> | null {
  const nonEmptyLines = lines.map((line) => line.trim()).filter(Boolean);
  const optionIndices = nonEmptyLines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^\d+\.\s+\S/.test(line) || /^›\s+\d+\./.test(line))
    .map(({ index }) => index);
  const latestPromptIndex = nonEmptyLines.reduce((latest, line, index) => {
    return getCodexPromptText(line) !== null ? index : latest;
  }, -1);
  const latestQuestionIndex = nonEmptyLines.reduce((latest, line, index) => {
    if (
      /^Question\s+\d+\/\d+/.test(line) ||
      line.includes("enter to submit answer") ||
      line.includes("tab to add notes") ||
      (/would you like|do you want|choose|select|what would you like/i.test(line) &&
        optionIndices.length >= 2)
    ) {
      return index;
    }

    return latest;
  }, -1);
  const latestTrustIndex = nonEmptyLines.reduce((latest, line, index) => {
    if (
      line.includes("Do you trust the contents of this directory?") ||
      line.includes("Press enter to continue")
    ) {
      return index;
    }

    return latest;
  }, -1);
  const latestPermissionPromptIndex = nonEmptyLines.reduce((latest, line, index) => {
    return isCodexPermissionPromptLine(line) ? index : latest;
  }, -1);
  const latestModelIndex = nonEmptyLines.reduce((latest, line, index) => {
    return line.startsWith("model:") || line.includes("│ model:") ? index : latest;
  }, -1);
  const latestHeaderIndex = nonEmptyLines.reduce((latest, line, index) => {
    return line.includes("OpenAI Codex") ? index : latest;
  }, -1);

  if (latestQuestionIndex >= 0 && latestQuestionIndex > latestPromptIndex) {
    return {
      activity: "busy",
      detail:
        optionIndices.length >= 2
          ? "Codex is waiting for a multiple-choice response"
          : "Codex is waiting for user input",
      status: optionIndices.length >= 2 ? "waiting-question" : "waiting-input",
    };
  }

  if (
    latestPermissionPromptIndex >= 0 &&
    latestPermissionPromptIndex > latestPromptIndex &&
    latestPermissionPromptIndex > latestHeaderIndex
  ) {
    return {
      activity: "busy",
      detail: "Codex is waiting for permission input",
      status: "waiting-input",
    };
  }

  if (latestPromptIndex >= 0 && latestPromptIndex > latestTrustIndex) {
    const hasTranscript = hasCodexTranscriptBetween(
      nonEmptyLines,
      latestHeaderIndex >= 0 ? latestHeaderIndex + 1 : 0,
      latestPromptIndex,
    );

    if (hasTranscript) {
      return {
        activity: "idle",
        detail: "Codex is idle between turns",
        status: "idle",
      };
    }

    return {
      activity: "idle",
      detail: "Codex is ready for a new prompt",
      status: "new",
    };
  }

  if (latestTrustIndex >= 0) {
    return {
      activity: "idle",
      detail: "Codex startup trust prompt is waiting for confirmation",
      status: "new",
    };
  }

  if (latestModelIndex >= 0) {
    return {
      activity: "idle",
      detail: "Codex is open and waiting for input",
      status: "idle",
    };
  }

  return null;
}

function getCodexBusyGraceMs(): number {
  const value = getEnvValue("CODING_AGENTS_TMUX_CODEX_BUSY_GRACE_MS");

  if (!value) {
    return 3000;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3000;
}

function isRecentCodexBusyHookState(state: CodexStateFile | null, now = Date.now()): boolean {
  if (!state?.updatedAt) {
    return false;
  }

  if (!["UserPromptSubmit", "PreToolUse", "PostToolUse"].includes(state.sourceEventType ?? "")) {
    return false;
  }

  return now - state.updatedAt <= getCodexBusyGraceMs();
}

function shouldPreferCodexPreview(
  hookRuntime: RuntimeInfo,
  preview: RuntimeInfo | null,
  state: CodexStateFile | null,
): boolean {
  if (!preview) {
    return false;
  }

  if (preview.status === "waiting-question" || preview.status === "waiting-input") {
    return true;
  }

  if (
    (preview.status === "new" || preview.status === "idle") &&
    ["running", "waiting-question", "waiting-input"].includes(hookRuntime.status)
  ) {
    if (hookRuntime.status === "running" && isRecentCodexBusyHookState(state)) {
      return false;
    }

    return true;
  }

  return false;
}

function createCodexPreviewRuntime(
  preview: Pick<RuntimeInfo, "activity" | "detail" | "status">,
  session: SessionMatch | null = null,
): RuntimeInfo {
  return createRuntimeInfo({
    activity: preview.activity,
    status: preview.status,
    source: "codex-preview",
    strategy: "exact",
    provider: "codex",
    heuristic: true,
    session,
    detail: preview.detail,
  });
}

async function loadCodexPreviewDebug(target: TmuxPane["target"]): Promise<{
  captureError: string | null;
  classification: Pick<RuntimeInfo, "activity" | "detail" | "status"> | null;
  lines: string[];
}> {
  try {
    const lines = await capturePanePreview(target, 24);
    return {
      lines,
      classification: classifyCodexPreview(lines),
      captureError: null,
    };
  } catch (error) {
    return {
      lines: [],
      classification: null,
      captureError: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildCodexStateDebugMatch(
  entry: CodexStateEntry,
  pane: TmuxPane,
): {
  filePath: string;
  matchKind: "target" | "pane-id" | "directory";
  state: CodexStateEntry["state"];
} {
  const matchKind =
    entry.state.target === pane.target
      ? "target"
      : entry.state.paneId === pane.paneId
        ? "pane-id"
        : "directory";

  return {
    filePath: entry.filePath,
    matchKind,
    state: entry.state,
  };
}

function debugPathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function resolvePluginSource(path: string, directoryLayout: boolean): string | null {
  if (!debugPathExists(path)) return null;
  if (!lstatSync(path).isSymbolicLink()) return directoryLayout ? join(path, "index.ts") : path;
  const target = resolve(dirname(path), readlinkSync(path));
  return directoryLayout ? join(target, "index.ts") : target;
}

function buildOpenCodeInstallDebug(
  generation: 1 | 2 | undefined,
  pluginStateLoaded: boolean,
): OpenCodeRuntimeDebug["plugin"]["installation"] {
  const configRoot = getOpenCodeConfigRoot();
  const pluginRoot = join(configRoot, "opencode", "plugins");
  const v1Path = join(pluginRoot, "coding-agents-tmux.ts");
  const v2Path = join(pluginRoot, "coding-agents-tmux");
  const unrelatedPath = join(pluginRoot, "opencode-tmux.ts");
  const expectedLayout = generation === 1 ? "v1-flat" : "v2-directory";
  const expectedPath = generation === 1 ? v1Path : v2Path;
  const entrypoint = generation === 1 ? expectedPath : join(expectedPath, "index.ts");
  const current =
    generation === 1
      ? debugPathExists(expectedPath)
      : debugPathExists(expectedPath) && debugPathExists(entrypoint);
  const stale: OpenCodeRuntimeDebug["plugin"]["installation"]["stale"] = [];

  const stalePath = generation === 1 ? v2Path : v1Path;
  if (debugPathExists(stalePath)) {
    const directoryLayout = generation === 1;
    stale.push({
      entrypoint: directoryLayout ? join(stalePath, "index.ts") : stalePath,
      source: resolvePluginSource(stalePath, directoryLayout),
      layout: generation === 1 ? "v2-directory" : "v1-flat",
    });
  }
  if (debugPathExists(unrelatedPath)) {
    stale.push({
      entrypoint: unrelatedPath,
      source: resolvePluginSource(unrelatedPath, false),
      layout: "unrelated-flat",
    });
  }

  const status = current ? "current" : stale.length > 0 ? "stale" : "missing";
  const diagnostics: string[] = [];
  if (status === "missing") {
    diagnostics.push("OpenCode plugin is missing; run coding-agents-tmux install-opencode");
  } else if (status === "stale") {
    diagnostics.push(
      `Only stale OpenCode plugin layout(s) are installed; run coding-agents-tmux install-opencode for ${expectedLayout}`,
    );
  }
  if (stale.length > 0) {
    diagnostics.push(
      `Stale OpenCode plugin entries found: ${stale.map((entry) => entry.entrypoint).join(", ")}`,
    );
  }
  if (generation === 2 && current && !pluginStateLoaded) {
    diagnostics.push(
      "V2 plugin appears not loaded in this TUI; restart OpenCode so the TUI loads coding-agents-tmux",
    );
  }

  return {
    configRoot,
    status,
    expectedLayout,
    entrypoint,
    source: current ? resolvePluginSource(expectedPath, generation !== 1) : null,
    stale,
    diagnostics,
  };
}

async function buildOpenCodeSqliteDebug(): Promise<OpenCodeRuntimeDebug["sqlite"]> {
  const resolved = await getOpencodeDbPath();
  if (!existsSync(resolved.path)) {
    return {
      ...resolved,
      schema: "missing",
      tables: [],
      error: `database not found at ${resolved.path}`,
    };
  }

  let database: SqliteDatabase | null = null;
  try {
    const Database = await loadSqliteDatabaseConstructor();
    database = new Database(resolved.path, { readonly: true });
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name?: unknown }).name)
      .filter((name): name is string => typeof name === "string");
    const hasV1 = tables.includes("session") && tables.includes("part");
    const hasV2 = tables.includes("session_v2");
    const schema = hasV1 && hasV2 ? "mixed" : hasV2 ? "v2" : hasV1 ? "v1" : "unknown";
    return { ...resolved, schema, tables, error: null };
  } catch (error) {
    return {
      ...resolved,
      schema: "unknown",
      tables: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    database?.close();
  }
}

async function buildOpenCodeServerDebug(
  pane: TmuxPane,
  options: RuntimeProviderOptions,
  pluginState: PluginStateFile | null,
): Promise<OpenCodeRuntimeDebug["server"]> {
  const source = normalizeServerMapSource(options.serverMap);
  if (!source) {
    return {
      configuredGeneration: null,
      detectedGeneration: null,
      endpoint: null,
      sessionId: null,
      version: null,
      error: null,
    };
  }

  try {
    const map = parseServerMap(options.serverMap);
    if (map.generation === "v1") {
      const endpoint = map.endpoints[pane.target] ?? null;
      if (!endpoint) {
        return {
          configuredGeneration: "v1",
          detectedGeneration: null,
          endpoint: null,
          sessionId: null,
          version: null,
          error: `no server endpoint configured for ${pane.target}`,
        };
      }
      try {
        const response = await fetch(`${endpoint}/api/info`, {
          signal: AbortSignal.timeout(3_000),
        });
        if (!response.ok) {
          return {
            configuredGeneration: "v1",
            detectedGeneration: "v1",
            endpoint,
            sessionId: null,
            version: null,
            error: null,
          };
        }
        const info = unwrapV2Data(await response.json());
        const version = getStringCandidate(info, [["version"]]);
        const detectedGeneration = version?.startsWith("2.")
          ? "v2"
          : version?.startsWith("1.")
            ? "v1"
            : null;
        return {
          configuredGeneration: "v1",
          detectedGeneration,
          endpoint,
          sessionId: null,
          version,
          error:
            detectedGeneration === "v2"
              ? `server API mismatch: legacy V1 map points to V2 ${version}`
              : null,
        };
      } catch (error) {
        return {
          configuredGeneration: "v1",
          detectedGeneration: null,
          endpoint,
          sessionId: null,
          version: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const endpoint = map.endpoint;
    const paneMapping = map.panes[pane.target];
    const trustedPluginState = pluginState?.opencodeGeneration === "v2" ? pluginState : null;
    const sessionId = paneMapping?.sessionId ?? trustedPluginState?.sessionId ?? null;
    if (!paneMapping) {
      return {
        configuredGeneration: "v2",
        detectedGeneration: null,
        endpoint,
        sessionId: null,
        version: null,
        error: `no V2 server pane mapping configured for ${pane.target}`,
      };
    }
    if (!sessionId) {
      return {
        configuredGeneration: "v2",
        detectedGeneration: null,
        endpoint,
        sessionId: null,
        version: null,
        error: `V2 server pane mapping for ${pane.target} requires sessionId or exact plugin root state`,
      };
    }
    try {
      const info = await fetchV2Json(endpoint, "/api/info");
      const version = getStringCandidate(info, [["version"]]);
      const detectedGeneration = version?.startsWith("2.")
        ? "v2"
        : version?.startsWith("1.")
          ? "v1"
          : null;
      return {
        configuredGeneration: "v2",
        detectedGeneration,
        endpoint,
        sessionId,
        version,
        error:
          detectedGeneration === "v2"
            ? null
            : `server API mismatch: configured V2 but /api/info reported ${version ?? "unknown"}`,
      };
    } catch (error) {
      return {
        configuredGeneration: "v2",
        detectedGeneration: null,
        endpoint,
        sessionId,
        version: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  } catch (error) {
    return {
      configuredGeneration: null,
      detectedGeneration: null,
      endpoint: null,
      sessionId: null,
      version: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function buildOpenCodeDebug(
  pane: DiscoveredPane,
  options: RuntimeProviderOptions,
): Promise<OpenCodeRuntimeDebug> {
  const entries = readPluginStateEntries();
  const index = buildPluginStateIndex(entries.map((entry) => entry.state));
  const matchedState = getExactPluginState(index, pane.pane);
  const paneBoundState = getPaneBoundPluginState(index, pane.pane);
  const matchedEntry = matchedState
    ? (entries.find((entry) => entry.state === matchedState) ?? null)
    : null;
  const candidateEntries = entries.filter(
    (entry) =>
      entry.state.target === pane.pane.target ||
      entry.state.paneId === pane.pane.paneId ||
      entry.state.directory === pane.pane.currentPath,
  );
  let detected: OpenCodeRuntimeDebug["detected"] = null;
  let detectionError: string | null = null;
  try {
    detected = await detectOpenCodeVersion({ timeoutMs: 3_000 });
  } catch (error) {
    detectionError = error instanceof Error ? error.message : String(error);
  }

  const matchKind = matchedState
    ? matchedState.target === pane.pane.target
      ? "target"
      : matchedState.paneId === pane.pane.paneId
        ? "pane-id"
        : "directory"
    : null;

  return {
    detected,
    detectionError,
    plugin: {
      stateDir: getPluginStateDir(),
      matchedState:
        matchedEntry && matchKind
          ? { filePath: matchedEntry.filePath, matchKind, state: { ...matchedEntry.state } }
          : null,
      candidateStates: candidateEntries.map((entry) => ({
        filePath: entry.filePath,
        state: { ...entry.state },
      })),
      installation: buildOpenCodeInstallDebug(
        detected?.generation,
        paneBoundState?.opencodeGeneration === "v2",
      ),
    },
    sqlite: await buildOpenCodeSqliteDebug(),
    server: await buildOpenCodeServerDebug(pane.pane, options, paneBoundState),
  };
}

export async function buildInspectDebugInfo(
  pane: DiscoveredPane,
  options: RuntimeProviderOptions = {},
): Promise<InspectDebugInfo> {
  if (pane.detection.agent === "opencode") {
    return { codex: null, opencode: await buildOpenCodeDebug(pane, options) };
  }

  if (pane.detection.agent !== "codex") {
    return { codex: null, opencode: null };
  }

  const entries = readCodexStateEntries();
  const index = buildCodexStateIndex(entries);
  const matchedState = getExactCodexState(index, pane.pane);
  const matchedEntry = matchedState ? (index.entryByState.get(matchedState) ?? null) : null;
  const preview = await loadCodexPreviewDebug(pane.pane.target);
  const previewRuntime = preview.classification
    ? createCodexPreviewRuntime(
        preview.classification,
        matchedState ? toCodexSessionMatch(matchedState) : null,
      )
    : null;
  const hookRuntime = matchedState?.directory
    ? createRuntimeInfo({
        activity: matchedState.activity ?? "unknown",
        status: matchedState.status ?? "unknown",
        source: "codex-hook",
        strategy: "exact",
        provider: "codex",
        heuristic: false,
        session: toCodexSessionMatch(matchedState),
        detail: matchedState.detail ?? "Codex hook state file",
      })
    : null;
  const candidateEntries = entries.filter((entry) => {
    return (
      entry.state.target === pane.pane.target ||
      entry.state.paneId === pane.pane.paneId ||
      (entry.state.directory === pane.pane.currentPath &&
        !entry.state.target &&
        !entry.state.paneId)
    );
  });
  const busyGraceMs = getCodexBusyGraceMs();
  const recentBusyHook = isRecentCodexBusyHookState(matchedState);

  const codex: CodexRuntimeDebug = {
    stateDir: getCodexStateDir(),
    busyGraceMs,
    matchedState: matchedEntry ? buildCodexStateDebugMatch(matchedEntry, pane.pane) : null,
    candidateStates: candidateEntries.map((entry) => buildCodexStateDebugMatch(entry, pane.pane)),
    hookRuntime,
    previewRuntime,
    recentBusyHook,
    preferPreview: hookRuntime
      ? shouldPreferCodexPreview(hookRuntime, previewRuntime, matchedState)
      : false,
    preview,
  };

  return { codex, opencode: null };
}

async function classifyCodexPaneRuntime(
  state: CodexStateFile | null,
  pane: TmuxPane,
): Promise<RuntimeInfo> {
  const preview = await loadCodexPreviewDebug(pane.target);
  const previewRuntime = preview.classification
    ? createCodexPreviewRuntime(preview.classification, state ? toCodexSessionMatch(state) : null)
    : null;

  if (state?.directory) {
    const hookRuntime = createRuntimeInfo({
      activity: state.activity ?? "unknown",
      status: state.status ?? "unknown",
      source: "codex-hook",
      strategy: "exact",
      provider: "codex",
      heuristic: false,
      session: toCodexSessionMatch(state),
      detail: state.detail ?? "Codex hook state file",
    });

    if (shouldPreferCodexPreview(hookRuntime, previewRuntime, state) && previewRuntime) {
      return previewRuntime;
    }

    return hookRuntime;
  }

  if (previewRuntime) {
    return previewRuntime;
  }

  return createRuntimeInfo({
    activity: "busy",
    status: "running",
    source: "codex-command",
    strategy: "exact",
    provider: "codex",
    heuristic: false,
    session: null,
    detail: `detected ${pane.currentCommand} process in tmux pane`,
  });
}

export async function attachRuntimeWithCodex(
  panes: DiscoveredPane[],
): Promise<PaneRuntimeSummary[]> {
  const index = buildCodexStateIndex();

  return Promise.all(
    panes.map(async (entry) => ({
      ...entry,
      runtime: await classifyCodexPaneRuntime(getExactCodexState(index, entry.pane), entry.pane),
    })),
  );
}

export async function attachRuntimeWithOpencodeProvider(
  panes: DiscoveredPane[],
  options: RuntimeProviderOptions,
): Promise<PaneRuntimeSummary[]> {
  if (panes.length === 0) {
    return [];
  }

  const provider = normalizeProvider(options.provider);

  if (provider === "plugin") {
    return attachRuntimeWithPlugin(panes);
  }

  if (provider === "sqlite") {
    return attachRuntimeWithSqlite(panes);
  }

  if (provider === "server") {
    return attachRuntimeWithServerMap(panes, options, false);
  }

  const pluginResults = attachRuntimeWithPlugin(panes);
  const unmatchedPanes = panes.filter(
    (_, index) => pluginResults[index]?.runtime.match.provider !== "plugin",
  );

  if (unmatchedPanes.length === 0) {
    return pluginResults;
  }

  if (unmatchedPanes.length !== panes.length) {
    const fallbackResults = await attachRuntimeWithServerMap(unmatchedPanes, options, true);
    const fallbackByTarget = new Map(fallbackResults.map((entry) => [entry.pane.target, entry]));

    return pluginResults.map((entry) => fallbackByTarget.get(entry.pane.target) ?? entry);
  }

  return attachRuntimeWithServerMap(panes, options, true);
}

export function describeServerMapInput(value: string | undefined): string | null {
  return normalizeServerMapSource(value);
}

export function buildServerMapTemplate(
  panes: TmuxPane[],
  options: {
    basePort?: number;
    hostname?: string;
  } = {},
): V2ServerMap {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.basePort ?? 4096;

  return {
    generation: "v2",
    endpoint: `http://${hostname}:${port}`,
    panes: Object.fromEntries(panes.map((pane) => [pane.target, { sessionId: "" }])),
  };
}
