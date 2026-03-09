import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  DiscoveredPane,
  PaneRuntimeSummary,
  RuntimeInfo,
  RuntimeProviderName,
  RuntimeProviderOptions,
  RuntimeSource,
  RuntimeStatus,
  SessionMatch,
  TmuxPane,
} from "../types";

const RECENT_SESSION_WINDOW_MS = 30 * 60 * 1000;

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

interface ServerStatusResult {
  endpoint: string;
  info: RuntimeInfo;
}

interface HeuristicSessionMatch {
  session: SessionMatch;
  source: RuntimeSource;
  strategy: RuntimeInfo["match"]["strategy"];
  detailPrefix: string;
}

function getOpencodeDbPath(): string {
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, "opencode", "opencode.db");
}

function openDatabase(): Database {
  const databasePath = getOpencodeDbPath();

  if (!existsSync(databasePath)) {
    throw new Error(`opencode database not found at ${databasePath}`);
  }

  return new Database(databasePath, { readonly: true });
}

function getSessionMatch(database: Database, directory: string): SessionMatch | null {
  const row = database
    .query(
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

function getDescendantSessions(database: Database, directory: string): SessionMatch[] {
  const normalizedDirectory = directory.endsWith("/") ? directory : `${directory}/`;

  const rows = database
    .query(
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

function getRunningPart(database: Database, sessionId: string): RunningPartRow | null {
  return database
    .query(
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

function classifyRuntime(session: SessionMatch | null, runningPart: RunningPartRow | null): RuntimeInfo {
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
      detail: optionCount > 0 ? "running question tool with options" : "running question tool without options",
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
  source: RuntimeSource,
  strategy: RuntimeInfo["match"]["strategy"],
  detailPrefix: string,
): RuntimeInfo {
  const runtime = classifyRuntime(session, runningPart);

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

function getHeuristicSessionMatch(database: Database, directory: string): HeuristicSessionMatch | null {
  const descendants = getDescendantSessions(database, directory);

  if (descendants.length === 0) {
    return null;
  }

  const runningDescendants = descendants.filter((session) => {
    const runningPart = getRunningPart(database, session.id);
    return runningPart?.status === "running";
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

function attachRuntimeWithSqlite(panes: DiscoveredPane[]): PaneRuntimeSummary[] {
  let database: Database;

  try {
    database = openDatabase();
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
        return { ...entry, runtime: classifyRuntime(exactSession, runningPart) };
      }

      const heuristicMatch = getHeuristicSessionMatch(database, entry.pane.currentPath);

      if (heuristicMatch) {
        const runningPart = getRunningPart(database, heuristicMatch.session.id);
        return {
          ...entry,
          runtime: classifyRuntimeWithSource(
            heuristicMatch.session,
            runningPart,
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

  const envValue = process.env.OPENCODE_TMUX_SERVER_MAP;
  return envValue && envValue.trim() ? envValue.trim() : null;
}

function parseServerMap(value: string | undefined): Record<string, string> {
  const source = normalizeServerMapSource(value);

  if (!source) {
    return {};
  }

  const raw = existsSync(source) ? readFileSync(source, "utf8") : source;
  const parsed = JSON.parse(raw) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("server map must be a JSON object of pane target to endpoint");
  }

  const result: Record<string, string> = {};

  for (const [key, valuePart] of Object.entries(parsed)) {
    if (typeof valuePart === "string" && valuePart.trim()) {
      result[key] = valuePart.trim().replace(/\/$/, "");
    }
  }

  return result;
}

function getNestedValue(payload: unknown, path: string[]): unknown {
  let current: unknown = payload;

  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !(key in current)) {
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
  const updatedValue = getNestedValue(payload, ["session", "timeUpdated"]) ?? getNestedValue(payload, ["timeUpdated"]);
  const timeUpdated = typeof updatedValue === "number" ? updatedValue : Date.now();

  if (!id || !directory || !title) {
    return null;
  }

  return { id, directory, title, timeUpdated };
}

function classifyServerPayload(endpoint: string, payload: unknown): RuntimeInfo {
  if (
    (payload && typeof payload === "object" && !Array.isArray(payload) && Object.keys(payload as Record<string, unknown>).length === 0) ||
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
  const status = getStringCandidate(payload, [["status"], ["session", "status"], ["state", "status"]]);
  const tool = getStringCandidate(payload, [["tool"], ["session", "tool"], ["state", "tool"]]);
  const busy = getBooleanCandidate(payload, [["busy"], ["session", "busy"], ["state", "busy"]]);
  const optionCount = getOptionCountCandidate(payload);

  if (status === "waiting-question" || (tool === "question" && optionCount !== null && optionCount > 0)) {
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
  const response = await fetch(`${endpoint}/session/status`);

  if (!response.ok) {
    throw new Error(`server provider request failed for ${target}: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as unknown;
  return { endpoint, info: classifyServerPayload(endpoint, payload) };
}

async function attachRuntimeWithServerMap(
  panes: DiscoveredPane[],
  options: RuntimeProviderOptions,
  fallbackToSqlite: boolean,
): Promise<PaneRuntimeSummary[]> {
  const sqliteFallback = fallbackToSqlite ? attachRuntimeWithSqlite(panes) : null;
  const serverMap = parseServerMap(options.serverMap);

  const results = await Promise.all(
    panes.map(async (entry, index) => {
      const endpoint = serverMap[entry.pane.target];

      if (!endpoint) {
        if (sqliteFallback) {
          return sqliteFallback[index] ?? { ...entry, runtime: classifyRuntime(null, null) };
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
            detail: `no server endpoint configured for ${entry.pane.target}`,
          }),
        };
      }

      try {
        const result = await fetchServerStatus(entry.pane.target, endpoint);

        if (sqliteFallback && shouldFallbackFromServer(result.info)) {
          return sqliteFallback[index] ?? { ...entry, runtime: classifyRuntime(null, null) };
        }

        return { ...entry, runtime: result.info };
      } catch (error) {
        if (sqliteFallback) {
          return sqliteFallback[index] ?? { ...entry, runtime: classifyRuntime(null, null) };
        }

        const message = error instanceof Error ? error.message : String(error);
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
            detail: message,
          }),
        };
      }
    }),
  );

  return results;
}

function normalizeProvider(provider: RuntimeProviderName | undefined): RuntimeProviderName {
  const value = provider ?? "auto";

  if (value !== "auto" && value !== "sqlite" && value !== "server") {
    throw new Error(`invalid runtime provider: ${value}`);
  }

  return value;
}

export async function attachRuntimeToPanes(
  panes: DiscoveredPane[],
  options: RuntimeProviderOptions = {},
): Promise<PaneRuntimeSummary[]> {
  const provider = normalizeProvider(options.provider);

  if (provider === "sqlite") {
    return attachRuntimeWithSqlite(panes);
  }

  if (provider === "server") {
    return attachRuntimeWithServerMap(panes, options, false);
  }

  return attachRuntimeWithServerMap(panes, options, true);
}

export function describeServerMapInput(value: string | undefined): string | null {
  return normalizeServerMapSource(value);
}

export function getRuntimeProviderHelpText(): string {
  return [
    "Runtime providers:",
    "  auto    Use explicit server endpoints when configured, then fall back to sqlite",
    "  sqlite  Use local opencode sqlite state only",
    "  server  Use explicit server endpoints only",
    "",
    "Server map:",
    "  Pass --server-map with a JSON object or a path to a JSON file.",
    '  Example: {"opencode-tmux:1.2":"http://127.0.0.1:4096"}',
    "  You can also set OPENCODE_TMUX_SERVER_MAP with the same value.",
  ].join("\n");
}

export function buildServerMapTemplate(
  panes: TmuxPane[],
  options: {
    basePort?: number;
    hostname?: string;
  } = {},
): Record<string, string> {
  const hostname = options.hostname ?? "127.0.0.1";
  const basePort = options.basePort;

  return Object.fromEntries(
    panes.map((pane, index) => {
      const port = basePort === undefined ? 0 : basePort + index;
      return [pane.target, `http://${hostname}:${port}`];
    }),
  );
}
