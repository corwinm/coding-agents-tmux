import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  buildInspectDebugInfo,
  buildServerMapTemplate,
  describeServerMapInput,
} from "../src/core/opencode.ts";
import { attachRuntimeToPanes, getRuntimeProviderHelpText } from "../src/core/runtime.ts";
import type { DiscoveredPane, PaneRuntimeSummary, TmuxPane } from "../src/types.ts";

function createPane(overrides: Partial<TmuxPane> = {}): TmuxPane {
  const sessionName = overrides.sessionName ?? "work";
  const windowIndex = overrides.windowIndex ?? 1;
  const paneIndex = overrides.paneIndex ?? 0;

  return {
    sessionName,
    windowIndex,
    paneIndex,
    paneId: overrides.paneId ?? `%${paneIndex + 1}`,
    paneTitle: overrides.paneTitle ?? "OpenCode",
    currentCommand: overrides.currentCommand ?? "opencode",
    currentPath: overrides.currentPath ?? "/tmp/project",
    isActive: overrides.isActive ?? false,
    tty: overrides.tty ?? "/dev/ttys001",
    target: overrides.target ?? `${sessionName}:${windowIndex}.${paneIndex}`,
  };
}

function createDiscoveredPane(overrides: Partial<TmuxPane> = {}): DiscoveredPane {
  const pane = createPane(overrides);

  return {
    pane,
    detection: {
      agent: "opencode",
      confidence: "high",
      reasons: ["title:OpenCode", "command:opencode"],
    },
  };
}

function setEnv(updates: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(updates)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

function createPluginStateDir(states: Record<string, unknown>[]): string {
  const root = mkdtempSync(join(tmpdir(), "coding-agents-tmux-plugin-state-"));

  states.forEach((state, index) => {
    writeFileSync(join(root, `state-${index + 1}.json`), JSON.stringify(state), "utf8");
  });

  return root;
}

function createSqliteDataHome(): { dataHome: string; databasePath: string } {
  const dataHome = mkdtempSync(join(tmpdir(), "coding-agents-tmux-data-home-"));
  const opencodeDir = join(dataHome, "opencode");
  mkdirSync(opencodeDir, { recursive: true });
  return {
    dataHome,
    databasePath: join(opencodeDir, "opencode.db"),
  };
}

function initializeSqliteDatabase(databasePath: string): DatabaseSync {
  const database = new DatabaseSync(databasePath);

  database.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE part (
      session_id TEXT NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);

  return database;
}

function insertSession(
  database: DatabaseSync,
  session: { id: string; directory: string; title: string; timeUpdated: number },
): void {
  database
    .prepare(`INSERT INTO session (id, directory, title, time_updated) VALUES (?1, ?2, ?3, ?4)`)
    .run(session.id, session.directory, session.title, session.timeUpdated);
}

function insertPart(
  database: DatabaseSync,
  entry: { sessionId: string; timeUpdated: number; data: Record<string, unknown> },
): void {
  database
    .prepare(`INSERT INTO part (session_id, time_updated, data) VALUES (?1, ?2, ?3)`)
    .run(entry.sessionId, entry.timeUpdated, JSON.stringify(entry.data));
}

function getRuntime(summary: PaneRuntimeSummary) {
  return summary.runtime;
}

function getSummary(summaries: PaneRuntimeSummary[], index: number): PaneRuntimeSummary {
  const summary = summaries[index];

  assert.ok(summary, `expected summary at index ${index}`);
  return summary;
}

test("plugin provider matches panes by target, pane id, and directory state", async () => {
  const pluginStateDir = createPluginStateDir([
    {
      target: "work:1.0",
      paneId: "%1",
      directory: "/tmp/project-a",
      title: "Session A",
      status: "running",
      activity: "busy",
      updatedAt: 100,
    },
    {
      paneId: "%9",
      directory: "/tmp/project-b",
      title: "Session B",
      status: "waiting-input",
      activity: "busy",
      updatedAt: 200,
    },
    {
      directory: "/tmp/project-c",
      title: "Session C",
      status: "idle",
      activity: "idle",
      updatedAt: 300,
    },
  ]);
  const restoreEnv = setEnv({ CODING_AGENTS_TMUX_STATE_DIR: pluginStateDir });

  try {
    const panes = [
      createDiscoveredPane({ target: "work:1.0", paneId: "%1", currentPath: "/tmp/project-a" }),
      createDiscoveredPane({ target: "work:1.1", paneId: "%9", currentPath: "/tmp/project-b" }),
      createDiscoveredPane({ target: "work:1.2", paneId: "%3", currentPath: "/tmp/project-c" }),
    ];
    const summaries = await attachRuntimeToPanes(panes, { provider: "plugin" });

    assert.equal(getRuntime(getSummary(summaries, 0)).status, "running");
    assert.equal(getRuntime(getSummary(summaries, 0)).source, "plugin-exact");
    assert.equal(getRuntime(getSummary(summaries, 1)).status, "waiting-input");
    assert.equal(getRuntime(getSummary(summaries, 1)).source, "plugin-exact");
    assert.equal(getRuntime(getSummary(summaries, 2)).status, "idle");
    assert.equal(getRuntime(getSummary(summaries, 2)).source, "plugin-exact");
    assert.equal(getRuntime(getSummary(summaries, 2)).session?.title, "Session C");
  } finally {
    restoreEnv();
  }
});

test("plugin provider prefers stable pane identity over a conflicting target record", async () => {
  const pluginStateDir = createPluginStateDir([
    {
      target: "work:1.0",
      paneId: "%99",
      directory: "/tmp/stale-project",
      title: "Stale target session",
      status: "idle",
      activity: "idle",
      updatedAt: 200,
    },
    {
      target: "work:9.9",
      paneId: "%1",
      directory: "/tmp/project",
      title: "Current pane session",
      status: "running",
      activity: "busy",
      updatedAt: 100,
    },
  ]);
  const restoreEnv = setEnv({ CODING_AGENTS_TMUX_STATE_DIR: pluginStateDir });

  try {
    const [summary] = await attachRuntimeToPanes([createDiscoveredPane()], { provider: "plugin" });

    assert.equal(summary?.runtime.status, "running");
    assert.equal(summary?.runtime.session?.title, "Current pane session");
  } finally {
    restoreEnv();
  }
});

test("plugin provider rejects a target record bound to a different pane", async () => {
  const pluginStateDir = createPluginStateDir([
    {
      target: "work:1.0",
      paneId: "%99",
      directory: "/tmp/project",
      title: "Conflicting identity",
      status: "idle",
      activity: "idle",
      updatedAt: 200,
    },
  ]);
  const restoreEnv = setEnv({ CODING_AGENTS_TMUX_STATE_DIR: pluginStateDir });

  try {
    const [summary] = await attachRuntimeToPanes([createDiscoveredPane()], { provider: "plugin" });

    assert.equal(summary?.runtime.status, "unknown");
    assert.equal(summary?.runtime.match.provider, "none");
  } finally {
    restoreEnv();
  }
});

test("plugin provider uses safe descendant heuristics and leaves ambiguous panes unmapped", async () => {
  const pluginStateDir = createPluginStateDir([
    {
      directory: "/tmp/project-unique/sub",
      title: "Unique Busy Session",
      status: "running",
      activity: "busy",
      updatedAt: 100,
    },
    {
      directory: "/tmp/project-ambiguous/one",
      title: "Ambiguous One",
      status: "idle",
      activity: "idle",
      updatedAt: 200,
    },
    {
      directory: "/tmp/project-ambiguous/two",
      title: "Ambiguous Two",
      status: "idle",
      activity: "idle",
      updatedAt: 300,
    },
  ]);
  const restoreEnv = setEnv({ CODING_AGENTS_TMUX_STATE_DIR: pluginStateDir });

  try {
    const panes = [
      createDiscoveredPane({ target: "work:1.0", currentPath: "/tmp/project-unique" }),
      createDiscoveredPane({ target: "work:1.1", currentPath: "/tmp/project-ambiguous" }),
    ];
    const summaries = await attachRuntimeToPanes(panes, { provider: "plugin" });

    assert.equal(getRuntime(getSummary(summaries, 0)).status, "running");
    assert.equal(getRuntime(getSummary(summaries, 0)).source, "plugin-descendant");
    assert.equal(getRuntime(getSummary(summaries, 0)).match.strategy, "descendant-only");
    assert.equal(getRuntime(getSummary(summaries, 1)).status, "unknown");
    assert.equal(getRuntime(getSummary(summaries, 1)).match.provider, "none");
  } finally {
    restoreEnv();
  }
});

test("sqlite provider classifies exact matches across idle, waiting, running, and unfinished steps", async () => {
  const { databasePath } = createSqliteDataHome();
  const restoreEnv = setEnv({
    OPENCODE_DB: databasePath,
    CODING_AGENTS_TMUX_STATE_DIR: undefined,
  });
  const database = initializeSqliteDatabase(databasePath);

  try {
    const now = Date.now();

    insertSession(database, {
      id: "idle-session",
      directory: "/tmp/sqlite-idle",
      title: "Idle Session",
      timeUpdated: now,
    });
    insertSession(database, {
      id: "waiting-question-session",
      directory: "/tmp/sqlite-waiting-question",
      title: "Waiting Question Session",
      timeUpdated: now + 1,
    });
    insertSession(database, {
      id: "waiting-input-session",
      directory: "/tmp/sqlite-waiting-input",
      title: "Waiting Input Session",
      timeUpdated: now + 2,
    });
    insertSession(database, {
      id: "running-session",
      directory: "/tmp/sqlite-running",
      title: "Running Session",
      timeUpdated: now + 3,
    });
    insertSession(database, {
      id: "unfinished-step-session",
      directory: "/tmp/sqlite-step",
      title: "Workflow Session",
      timeUpdated: now + 4,
    });

    insertPart(database, {
      sessionId: "waiting-question-session",
      timeUpdated: now + 10,
      data: {
        tool: "question",
        state: {
          status: "running",
          input: {
            questions: [{ options: ["a", "b"] }],
          },
        },
      },
    });
    insertPart(database, {
      sessionId: "waiting-input-session",
      timeUpdated: now + 11,
      data: {
        tool: "question",
        state: {
          status: "running",
          input: {
            questions: [{ options: [] }],
          },
        },
      },
    });
    insertPart(database, {
      sessionId: "running-session",
      timeUpdated: now + 12,
      data: {
        tool: "edit",
        state: {
          status: "running",
        },
      },
    });
    insertPart(database, {
      sessionId: "unfinished-step-session",
      timeUpdated: now + 13,
      data: {
        type: "step-start",
      },
    });

    const summaries = await attachRuntimeToPanes(
      [
        createDiscoveredPane({ target: "work:1.0", currentPath: "/tmp/sqlite-idle" }),
        createDiscoveredPane({ target: "work:1.1", currentPath: "/tmp/sqlite-waiting-question" }),
        createDiscoveredPane({ target: "work:1.2", currentPath: "/tmp/sqlite-waiting-input" }),
        createDiscoveredPane({ target: "work:1.3", currentPath: "/tmp/sqlite-running" }),
        createDiscoveredPane({ target: "work:1.4", currentPath: "/tmp/sqlite-step" }),
      ],
      { provider: "sqlite" },
    );

    assert.equal(getRuntime(getSummary(summaries, 0)).status, "idle");
    assert.equal(getRuntime(getSummary(summaries, 1)).status, "waiting-question");
    assert.equal(getRuntime(getSummary(summaries, 2)).status, "waiting-input");
    assert.equal(getRuntime(getSummary(summaries, 3)).status, "running");
    assert.equal(getRuntime(getSummary(summaries, 4)).status, "running");
    assert.match(getRuntime(getSummary(summaries, 4)).detail, /unfinished step/);
  } finally {
    database.close();
    restoreEnv();
  }
});

test("sqlite provider uses descendant heuristics only when they are unambiguous", async () => {
  const { databasePath } = createSqliteDataHome();
  const restoreEnv = setEnv({
    OPENCODE_DB: databasePath,
    CODING_AGENTS_TMUX_STATE_DIR: undefined,
  });
  const database = initializeSqliteDatabase(databasePath);

  try {
    const now = Date.now();

    insertSession(database, {
      id: "running-descendant",
      directory: "/tmp/heuristic-running/sub",
      title: "Running Descendant",
      timeUpdated: now,
    });
    insertPart(database, {
      sessionId: "running-descendant",
      timeUpdated: now + 1,
      data: {
        tool: "edit",
        state: { status: "running" },
      },
    });

    insertSession(database, {
      id: "recent-descendant",
      directory: "/tmp/heuristic-recent/sub",
      title: "Recent Descendant",
      timeUpdated: now,
    });

    insertSession(database, {
      id: "only-descendant",
      directory: "/tmp/heuristic-only/sub",
      title: "Only Descendant",
      timeUpdated: now - 9999999,
    });

    insertSession(database, {
      id: "ambiguous-a",
      directory: "/tmp/heuristic-ambiguous/one",
      title: "Ambiguous A",
      timeUpdated: now,
    });
    insertSession(database, {
      id: "ambiguous-b",
      directory: "/tmp/heuristic-ambiguous/two",
      title: "Ambiguous B",
      timeUpdated: now,
    });

    const summaries = await attachRuntimeToPanes(
      [
        createDiscoveredPane({ target: "work:1.0", currentPath: "/tmp/heuristic-running" }),
        createDiscoveredPane({ target: "work:1.1", currentPath: "/tmp/heuristic-recent" }),
        createDiscoveredPane({ target: "work:1.2", currentPath: "/tmp/heuristic-only" }),
        createDiscoveredPane({ target: "work:1.3", currentPath: "/tmp/heuristic-ambiguous" }),
      ],
      { provider: "sqlite" },
    );

    assert.equal(getRuntime(getSummary(summaries, 0)).source, "sqlite-descendant-running");
    assert.equal(getRuntime(getSummary(summaries, 0)).match.strategy, "descendant-running");
    assert.equal(getRuntime(getSummary(summaries, 1)).source, "sqlite-descendant-recent");
    assert.equal(getRuntime(getSummary(summaries, 1)).match.strategy, "descendant-recent");
    assert.equal(getRuntime(getSummary(summaries, 2)).source, "sqlite-descendant-only");
    assert.equal(getRuntime(getSummary(summaries, 2)).match.strategy, "descendant-only");
    assert.equal(getRuntime(getSummary(summaries, 3)).status, "unknown");
    assert.equal(getRuntime(getSummary(summaries, 3)).match.provider, "none");
  } finally {
    database.close();
    restoreEnv();
  }
});

test("server provider parses inline and file-backed maps and normalizes endpoints", async () => {
  const mapFile = join(mkdtempSync(join(tmpdir(), "coding-agents-tmux-server-map-")), "map.json");
  writeFileSync(mapFile, JSON.stringify({ "work:1.1": "http://127.0.0.1:4097/" }), "utf8");

  const responses = new Map<string, unknown>([
    ["http://127.0.0.1:4096/session/status", { status: "idle", session: null, busy: false }],
    [
      "http://127.0.0.1:4097/session/status",
      {
        status: "waiting-question",
        tool: "question",
        state: { tool: "question", input: { questions: [{ options: ["a"] }] } },
      },
    ],
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const key = String(input);
    if (key.endsWith("/api/info")) {
      return new Response(null, { status: 404, statusText: "Not Found" });
    }
    const payload = responses.get(key);

    if (payload === undefined) {
      throw new Error(`unexpected fetch: ${key}`);
    }

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const summaries = await attachRuntimeToPanes(
      [
        createDiscoveredPane({ target: "work:1.0", currentPath: "/tmp/server-inline" }),
        createDiscoveredPane({ target: "work:1.1", currentPath: "/tmp/server-file" }),
      ],
      {
        provider: "server",
        serverMap: JSON.stringify({ "work:1.0": "http://127.0.0.1:4096/" }),
      },
    );

    const fileBackedSummaries = await attachRuntimeToPanes(
      [createDiscoveredPane({ target: "work:1.1", currentPath: "/tmp/server-file" })],
      { provider: "server", serverMap: mapFile },
    );

    assert.equal(getRuntime(getSummary(summaries, 0)).status, "idle");
    assert.equal(getRuntime(getSummary(fileBackedSummaries, 0)).status, "waiting-question");
    assert.equal(describeServerMapInput(undefined), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("describeServerMapInput falls back to env when no explicit value is provided", () => {
  const restoreEnv = setEnv({
    CODING_AGENTS_TMUX_SERVER_MAP: '{"work:1.0":"http://127.0.0.1:4096"}',
  });

  try {
    assert.equal(describeServerMapInput(undefined), '{"work:1.0":"http://127.0.0.1:4096"}');
  } finally {
    restoreEnv();
  }
});

test("server provider rejects non-object maps", async () => {
  await assert.rejects(
    attachRuntimeToPanes([createDiscoveredPane()], { provider: "server", serverMap: "[]" }),
    /server map must be a JSON object/,
  );
});

test("runtime provider helpers expose provider docs, template output, and validation", async () => {
  const template = buildServerMapTemplate(
    [createPane({ target: "work:1.0" }), createPane({ target: "work:1.1", paneIndex: 1 })],
    { basePort: 4096, hostname: "127.0.0.2" },
  );
  const helpText = getRuntimeProviderHelpText();

  assert.deepEqual(template, {
    generation: "v2",
    endpoint: "http://127.0.0.2:4096",
    panes: {
      "work:1.0": { sessionId: "" },
      "work:1.1": { sessionId: "" },
    },
  });
  assert.match(helpText, /Runtime providers:/);
  assert.match(helpText, /plugin  Use pane-local OpenCode plugin state files only/);
  assert.match(helpText, /V2 uses one shared endpoint plus exact pane-to-root-session mappings/);
  assert.match(helpText, /SQLite is V1-only and reports V2 schemas as unavailable/);
  assert.match(helpText, /Override with CODING_AGENTS_TMUX_STATE_DIR\./);
  assert.match(helpText, /Generate hooks\.json with: coding-agents-tmux codex-hooks-template/);
  assert.match(helpText, /CODING_AGENTS_TMUX_SERVER_MAP with the same value/);
  assert.match(helpText, /Codex hook state:/);
  await assert.rejects(
    attachRuntimeToPanes([createDiscoveredPane()], { provider: "bogus" as never }),
    /invalid runtime provider: bogus/,
  );
});

test("plugin state supports env override and default state root", async () => {
  const preferredStateDir = createPluginStateDir([
    {
      target: "work:1.0",
      directory: "/tmp/preferred-project",
      title: "Preferred Plugin Session",
      status: "running",
      activity: "busy",
      updatedAt: 200,
    },
  ]);
  const explicitEnvRestore = setEnv({
    CODING_AGENTS_TMUX_STATE_DIR: preferredStateDir,
  });

  try {
    const summaries = await attachRuntimeToPanes(
      [createDiscoveredPane({ target: "work:1.0", currentPath: "/tmp/preferred-project" })],
      { provider: "plugin" },
    );

    assert.equal(getRuntime(getSummary(summaries, 0)).status, "running");
    assert.equal(getRuntime(getSummary(summaries, 0)).session?.title, "Preferred Plugin Session");
  } finally {
    explicitEnvRestore();
  }

  const stateHome = mkdtempSync(join(tmpdir(), "coding-agents-tmux-state-home-"));
  const preferredRoot = join(stateHome, "coding-agents-tmux", "plugin-state");
  mkdirSync(preferredRoot, { recursive: true });
  writeFileSync(
    join(preferredRoot, "preferred.json"),
    JSON.stringify({
      target: "work:1.1",
      directory: "/tmp/preferred-root",
      title: "Preferred Root Session",
      status: "idle",
      activity: "idle",
      updatedAt: 300,
    }),
  );
  const restoreEnv = setEnv({
    XDG_STATE_HOME: stateHome,
    CODING_AGENTS_TMUX_STATE_DIR: undefined,
  });

  try {
    const summaries = await attachRuntimeToPanes(
      [createDiscoveredPane({ target: "work:1.1", currentPath: "/tmp/preferred-root" })],
      { provider: "plugin" },
    );

    assert.equal(getRuntime(getSummary(summaries, 0)).session?.title, "Preferred Root Session");
  } finally {
    restoreEnv();
  }
});

test("codex panes use a coarse command-backed runtime classification", async () => {
  const summaries = await attachRuntimeToPanes(
    [
      {
        pane: createPane({
          target: "work:1.4",
          paneIndex: 4,
          paneTitle: "shell",
          currentCommand: "codex-aarch64-apple-darwin",
        }),
        detection: {
          agent: "codex",
          confidence: "medium",
          reasons: ["command:codex"],
        },
      },
    ],
    { provider: "auto" },
  );

  assert.equal(getRuntime(getSummary(summaries, 0)).status, "running");
  assert.equal(getRuntime(getSummary(summaries, 0)).activity, "busy");
  assert.equal(getRuntime(getSummary(summaries, 0)).source, "codex-command");
  assert.equal(getRuntime(getSummary(summaries, 0)).match.provider, "codex");
  assert.equal(
    getRuntime(getSummary(summaries, 0)).detail,
    "detected codex-aarch64-apple-darwin process in tmux pane",
  );
});

test("sqlite provider reports a missing database as unknown runtime detail", async () => {
  const dataHome = mkdtempSync(join(tmpdir(), "coding-agents-tmux-missing-db-"));
  const databasePath = join(dataHome, "opencode", "opencode.db");
  const restoreEnv = setEnv({
    OPENCODE_DB: databasePath,
    CODING_AGENTS_TMUX_STATE_DIR: undefined,
  });

  try {
    const summaries = await attachRuntimeToPanes([createDiscoveredPane()], { provider: "sqlite" });

    assert.equal(getRuntime(getSummary(summaries, 0)).status, "unknown");
    assert.match(getRuntime(getSummary(summaries, 0)).detail, /opencode database not found/);
  } finally {
    restoreEnv();
  }
});

test("server provider surfaces request failures when explicit endpoints fail", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("boom", { status: 500, statusText: "Internal Server Error" });

  try {
    const summaries = await attachRuntimeToPanes([createDiscoveredPane({ target: "work:1.0" })], {
      provider: "server",
      serverMap: JSON.stringify({ "work:1.0": "http://127.0.0.1:4096" }),
    });

    assert.equal(getRuntime(getSummary(summaries, 0)).status, "unknown");
    assert.match(
      getRuntime(getSummary(summaries, 0)).detail,
      /server provider request failed for work:1.0: 500 Internal Server Error/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("auto provider keeps plugin matches and falls back to sqlite when server status is unknown", async () => {
  const pluginStateDir = createPluginStateDir([
    {
      target: "work:1.0",
      directory: "/tmp/auto-plugin",
      title: "Plugin Session",
      status: "running",
      activity: "busy",
      updatedAt: 100,
    },
  ]);
  const { databasePath } = createSqliteDataHome();
  const restoreEnv = setEnv({
    CODING_AGENTS_TMUX_STATE_DIR: pluginStateDir,
    OPENCODE_DB: databasePath,
  });
  const database = initializeSqliteDatabase(databasePath);
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const url = String(input);

    if (url === "http://127.0.0.1:4096/api/info") {
      return new Response(null, { status: 404, statusText: "Not Found" });
    }

    if (url === "http://127.0.0.1:4096/session/status") {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const now = Date.now();
    insertSession(database, {
      id: "auto-sqlite-session",
      directory: "/tmp/auto-sqlite",
      title: "Auto Sqlite Session",
      timeUpdated: now,
    });
    insertPart(database, {
      sessionId: "auto-sqlite-session",
      timeUpdated: now + 1,
      data: {
        tool: "question",
        state: { status: "running", input: { questions: [{ options: [] }] } },
      },
    });

    const summaries = await attachRuntimeToPanes(
      [
        createDiscoveredPane({ target: "work:1.0", currentPath: "/tmp/auto-plugin" }),
        createDiscoveredPane({ target: "work:1.1", currentPath: "/tmp/auto-sqlite" }),
      ],
      {
        provider: "auto",
        serverMap: JSON.stringify({ "work:1.1": "http://127.0.0.1:4096/" }),
      },
    );

    assert.equal(getRuntime(getSummary(summaries, 0)).source, "plugin-exact");
    assert.equal(getRuntime(getSummary(summaries, 0)).status, "running");
    assert.equal(getRuntime(getSummary(summaries, 1)).source, "sqlite-exact");
    assert.equal(getRuntime(getSummary(summaries, 1)).status, "waiting-input");
  } finally {
    database.close();
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test("plugin state reader ignores JSON null entries", async () => {
  const pluginStateDir = createPluginStateDir([null as unknown as Record<string, unknown>]);
  const restoreEnv = setEnv({ CODING_AGENTS_TMUX_STATE_DIR: pluginStateDir });

  try {
    const [summary] = await attachRuntimeToPanes([createDiscoveredPane()], { provider: "plugin" });
    assert.equal(summary?.runtime.status, "unknown");
  } finally {
    restoreEnv();
  }
});

test("SQLite path discovery uses bounded OpenCode debug output even when XDG is configured", async () => {
  const root = mkdtempSync(join(tmpdir(), "coding-agents-tmux-debug-path-"));
  const databasePath = join(root, "channel.db");
  const database = initializeSqliteDatabase(databasePath);
  insertSession(database, {
    id: "debug-path-session",
    directory: "/tmp/project",
    title: "Debug Path Session",
    timeUpdated: Date.now(),
  });
  database.close();
  const binDir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-debug-path-bin-"));
  const executable = join(binDir, "opencode");
  writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${databasePath}'\n`, "utf8");
  chmodSync(executable, 0o755);
  const restoreEnv = setEnv({
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    OPENCODE_DB: undefined,
    XDG_DATA_HOME: join(root, "wrong-xdg"),
  });

  try {
    const [summary] = await attachRuntimeToPanes([createDiscoveredPane()], { provider: "sqlite" });
    assert.equal(summary?.runtime.status, "idle");
    assert.equal(summary?.runtime.session?.id, "debug-path-session");
  } finally {
    restoreEnv();
  }
});

test("V2 server ignores stale plugin family metadata for a different mapped root", async () => {
  const pluginStateDir = createPluginStateDir([
    {
      opencodeGeneration: "v2",
      target: "work:1.0",
      directory: "/tmp/project",
      title: "Old root",
      sessionId: "old-root",
      selectedSessionId: "old-child",
      familySessionIds: ["old-root", "old-child"],
      status: "idle",
    },
  ]);
  const restoreEnv = setEnv({ CODING_AGENTS_TMUX_STATE_DIR: pluginStateDir });
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path === "/api/info") return Response.json({ data: { version: "2.0.12" } });
    if (path === "/api/session/active") return Response.json({ data: {} });
    if (path === "/api/session") {
      return Response.json({
        data: [{ id: "new-root", directory: "/tmp/project", title: "New" }],
        cursor: null,
      });
    }
    if (path === "/api/session/new-root") {
      return Response.json({ data: { id: "new-root", directory: "/tmp/project", title: "New" } });
    }
    if (path.endsWith("/permission") || path.endsWith("/form")) {
      return Response.json({ data: [] });
    }
    throw new Error(`unexpected fetch: ${path}`);
  };

  try {
    const [summary] = await attachRuntimeToPanes([createDiscoveredPane()], {
      provider: "server",
      serverMap: JSON.stringify({
        generation: "v2",
        endpoint: "http://127.0.0.1:4096",
        panes: { "work:1.0": { sessionId: "new-root" } },
      }),
    });
    assert.equal(summary?.runtime.status, "idle");
    assert.equal(summary?.runtime.session?.id, "new-root");
    assert.ok(calls.every((path) => !path.includes("old-")));
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test("V2 server reconstructs a current family when plugin metadata omits a new active blocker", async () => {
  const pluginStateDir = createPluginStateDir([
    {
      opencodeGeneration: "v2",
      target: "work:1.0",
      paneId: "%1",
      directory: "/tmp/project",
      title: "Root session",
      sessionId: "root",
      selectedSessionId: "root",
      familySessionIds: ["root"],
      status: "idle",
      activity: "idle",
      updatedAt: Date.now(),
    },
  ]);
  const restoreEnv = setEnv({ CODING_AGENTS_TMUX_STATE_DIR: pluginStateDir });
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path === "/api/info") return Response.json({ data: { version: "2.0.12" } });
    if (path === "/api/session/active") return Response.json({ data: { "new-child": {} } });
    if (path === "/api/session") {
      return Response.json({
        data: [
          { id: "root", directory: "/tmp/project", title: "Root session" },
          { id: "new-child", parentID: "root", directory: "/tmp/project" },
        ],
        cursor: null,
      });
    }
    if (path === "/api/session/root") {
      return Response.json({ data: { id: "root", directory: "/tmp/project" } });
    }
    if (path === "/api/session/new-child/permission") {
      return Response.json({ data: [{ id: "permission-1" }] });
    }
    if (path.endsWith("/permission") || path.endsWith("/form")) {
      return Response.json({ data: [] });
    }
    throw new Error(`unexpected fetch: ${path}`);
  };

  try {
    const [summary] = await attachRuntimeToPanes([createDiscoveredPane()], {
      provider: "server",
      serverMap: JSON.stringify({
        generation: "v2",
        endpoint: "http://127.0.0.1:4096",
        panes: { "work:1.0": {} },
      }),
    });

    assert.equal(summary?.runtime.status, "waiting-input");
    assert.ok(calls.includes("/api/session"));
    assert.ok(calls.includes("/api/session/new-child/permission"));
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test("V2 server prefers the stable pane identity over a conflicting target root", async () => {
  const pluginStateDir = createPluginStateDir([
    {
      opencodeGeneration: "v2",
      target: "work:1.0",
      paneId: "%99",
      directory: "/tmp/stale-project",
      title: "Stale root",
      sessionId: "stale-root",
      familySessionIds: ["stale-root"],
      updatedAt: 200,
    },
    {
      opencodeGeneration: "v2",
      target: "work:9.9",
      paneId: "%1",
      directory: "/tmp/project",
      title: "Current root",
      sessionId: "current-root",
      familySessionIds: ["current-root"],
      updatedAt: Date.now(),
    },
  ]);
  const restoreEnv = setEnv({ CODING_AGENTS_TMUX_STATE_DIR: pluginStateDir });
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path === "/api/info") return Response.json({ data: { version: "2.0.12" } });
    if (path === "/api/session/active") return Response.json({ data: {} });
    if (path === "/api/session") {
      return Response.json({
        data: [{ id: "current-root", directory: "/tmp/project", title: "Current root" }],
        cursor: null,
      });
    }
    if (path === "/api/session/current-root") {
      return Response.json({ data: { id: "current-root", directory: "/tmp/project" } });
    }
    if (path.endsWith("/permission") || path.endsWith("/form")) {
      return Response.json({ data: [] });
    }
    throw new Error(`unexpected fetch: ${path}`);
  };

  try {
    const [summary] = await attachRuntimeToPanes([createDiscoveredPane()], {
      provider: "server",
      serverMap: JSON.stringify({
        generation: "v2",
        endpoint: "http://127.0.0.1:4096",
        panes: { "work:1.0": {} },
      }),
    });

    assert.equal(summary?.runtime.status, "idle");
    assert.equal(summary?.runtime.session?.id, "current-root");
    assert.ok(calls.every((path) => !path.includes("stale-root")));
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test("V2 server rejects a stale pane-bound plugin root mapping", async () => {
  const pluginStateDir = createPluginStateDir([
    {
      opencodeGeneration: "v2",
      target: "work:1.0",
      paneId: "%1",
      directory: "/tmp/project",
      title: "Previous pane occupant",
      sessionId: "stale-root",
      familySessionIds: ["stale-root"],
      updatedAt: Date.now() - 60_000,
    },
  ]);
  const restoreEnv = setEnv({ CODING_AGENTS_TMUX_STATE_DIR: pluginStateDir });
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    throw new Error("stale plugin state must not select a server root");
  };

  try {
    const [summary] = await attachRuntimeToPanes([createDiscoveredPane()], {
      provider: "server",
      serverMap: JSON.stringify({
        generation: "v2",
        endpoint: "http://127.0.0.1:4096",
        panes: { "work:1.0": {} },
      }),
    });

    assert.equal(summary?.runtime.status, "unknown");
    assert.match(summary?.runtime.detail ?? "", /requires sessionId or exact plugin root state/);
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test("auto does not replace a V2 server failure with a separate V1 SQLite session", async () => {
  const { databasePath } = createSqliteDataHome();
  const database = initializeSqliteDatabase(databasePath);
  insertSession(database, {
    id: "legacy",
    directory: "/tmp/project",
    title: "Legacy",
    timeUpdated: Date.now(),
  });
  database.close();
  const restoreEnv = setEnv({
    CODING_AGENTS_TMUX_STATE_DIR: mkdtempSync(join(tmpdir(), "empty-plugin-state-")),
    OPENCODE_DB: databasePath,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("V2 server unavailable");
  };

  try {
    const [summary] = await attachRuntimeToPanes([createDiscoveredPane()], {
      provider: "auto",
      serverMap: JSON.stringify({
        generation: "v2",
        endpoint: "http://127.0.0.1:4096",
        panes: { "work:1.0": { sessionId: "root" } },
      }),
    });
    assert.equal(summary?.runtime.status, "unknown");
    assert.match(summary?.runtime.detail ?? "", /V2 server unavailable/);
    assert.notEqual(summary?.runtime.session?.id, "legacy");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test("sqlite provider treats OPENCODE_DB V2 mixed schemas as unavailable without querying V1 tables", async () => {
  const root = mkdtempSync(join(tmpdir(), "coding-agents-tmux-v2-db-"));
  const databasePath = join(root, "custom.db");
  const database = initializeSqliteDatabase(databasePath);
  database.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL)");
  insertSession(database, {
    id: "stale-v1-row",
    directory: "/tmp/project",
    title: "Must Not Be Used",
    timeUpdated: Date.now(),
  });
  database.close();
  const restoreEnv = setEnv({ OPENCODE_DB: databasePath, CODING_AGENTS_TMUX_STATE_DIR: undefined });

  try {
    const summaries = await attachRuntimeToPanes([createDiscoveredPane()], { provider: "sqlite" });
    const runtime = getRuntime(getSummary(summaries, 0));

    assert.equal(runtime.status, "unknown");
    assert.equal(runtime.match.provider, "none");
    assert.match(runtime.detail, /SQLite.*unavailable.*V2/i);
    assert.doesNotMatch(runtime.detail, /Must Not Be Used/);
  } finally {
    restoreEnv();
  }
});

test("V2 server validates API generation and aggregates exact root-family blockers", async () => {
  const pluginStateDir = createPluginStateDir([
    {
      opencodeGeneration: "v2",
      target: "work:1.0",
      paneId: "%1",
      directory: "/tmp/project",
      title: "Root session",
      sessionId: "root",
      selectedSessionId: "child-question",
      familySessionIds: ["root", "child-permission", "child-question"],
      status: "idle",
      activity: "idle",
      updatedAt: Date.now(),
    },
  ]);
  const restoreEnv = setEnv({ CODING_AGENTS_TMUX_STATE_DIR: pluginStateDir });
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  const responses = new Map<string, unknown>([
    ["/api/info", { data: { version: "2.0.12" } }],
    ["/api/session/active", { data: { root: {}, "child-permission": {} } }],
    [
      "/api/session/root",
      { data: { id: "root", directory: "/tmp/project", title: "Root session" } },
    ],
    [
      "/api/session",
      {
        data: [
          { id: "root", directory: "/tmp/project", title: "Root session" },
          { id: "child-permission", parentID: "root", directory: "/tmp/project" },
          { id: "child-question", parentID: "root", directory: "/tmp/project" },
        ],
        cursor: null,
      },
    ],
    ["/api/session/root/permission", { data: [] }],
    ["/api/session/root/form", { data: [] }],
    ["/api/session/child-permission/permission", { data: [{ id: "perm-1" }] }],
    ["/api/session/child-permission/form", { data: [] }],
    ["/api/session/child-question/permission", { data: [] }],
    [
      "/api/session/child-question/form",
      { data: [{ id: "form-1", fields: [{ type: "select", options: [{ label: "A" }] }] }] },
    ],
  ]);
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const payload = responses.get(url.pathname);
    if (payload === undefined) throw new Error(`unexpected fetch: ${url.pathname}`);
    return Response.json(payload);
  };

  try {
    const [summary] = await attachRuntimeToPanes([createDiscoveredPane()], {
      provider: "server",
      serverMap: JSON.stringify({
        generation: "v2",
        endpoint: "http://127.0.0.1:4096",
        panes: { "work:1.0": {} },
      }),
    });

    assert.equal(summary?.runtime.status, "waiting-question");
    assert.equal(summary?.runtime.session?.id, "root");
    assert.deepEqual(calls, [
      "/api/info",
      "/api/session/active",
      "/api/session/root",
      "/api/session",
      "/api/session/root/permission",
      "/api/session/root/form",
      "/api/session/child-permission/permission",
      "/api/session/child-permission/form",
      "/api/session/child-question/permission",
      "/api/session/child-question/form",
    ]);
    assert.ok(!calls.includes("/session/status"));
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test("V2 server classifies a selectable child form when the root session is selected", async () => {
  const pluginStateDir = createPluginStateDir([
    {
      opencodeGeneration: "v2",
      target: "work:1.0",
      paneId: "%1",
      directory: "/tmp/project",
      title: "Root session",
      sessionId: "root",
      selectedSessionId: "root",
      familySessionIds: ["root", "child-question"],
      status: "idle",
      activity: "idle",
      updatedAt: Date.now(),
    },
  ]);
  const restoreEnv = setEnv({ CODING_AGENTS_TMUX_STATE_DIR: pluginStateDir });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/info") return Response.json({ data: { version: "2.0.12" } });
    if (path === "/api/session/active") return Response.json({ data: {} });
    if (path === "/api/session/root") {
      return Response.json({ data: { id: "root", directory: "/tmp/project" } });
    }
    if (path === "/api/session") {
      return Response.json({
        data: [
          { id: "root", directory: "/tmp/project" },
          { id: "child-question", parentID: "root", directory: "/tmp/project" },
        ],
        cursor: null,
      });
    }
    if (path === "/api/session/child-question/form") {
      return Response.json({
        data: [{ id: "form-1", fields: [{ type: "select", options: [{ label: "A" }] }] }],
      });
    }
    if (path.endsWith("/permission") || path.endsWith("/form")) {
      return Response.json({ data: [] });
    }
    throw new Error(`unexpected fetch: ${path}`);
  };

  try {
    const [summary] = await attachRuntimeToPanes([createDiscoveredPane()], {
      provider: "server",
      serverMap: JSON.stringify({
        generation: "v2",
        endpoint: "http://127.0.0.1:4096",
        panes: { "work:1.0": {} },
      }),
    });

    assert.equal(summary?.runtime.status, "waiting-question");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test("V2 server discovers active child sessions from the stable session listing without plugin state", async () => {
  const restoreEnv = setEnv({
    CODING_AGENTS_TMUX_STATE_DIR: mkdtempSync(join(tmpdir(), "empty-plugin-state-")),
  });
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  const responses = new Map<string, unknown>([
    ["/api/info", { data: { version: "2.0.12" } }],
    ["/api/session/active", { data: { "grandchild-running": {} } }],
    [
      "/api/session",
      {
        data: [
          { id: "root", directory: "/tmp/project", title: "Root" },
          { id: "child", parentID: "root", directory: "/tmp/project" },
          { id: "grandchild-running", parentID: "child", directory: "/tmp/project" },
          { id: "other-root", directory: "/tmp/other" },
        ],
        cursor: null,
      },
    ],
    ["/api/session/root", { data: { id: "root", directory: "/tmp/project", title: "Root" } }],
  ]);
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path.endsWith("/permission") || path.endsWith("/form")) {
      return Response.json({ data: [] });
    }
    const payload = responses.get(path);
    if (payload === undefined) throw new Error(`unexpected fetch: ${path}`);
    return Response.json(payload);
  };

  try {
    const [summary] = await attachRuntimeToPanes([createDiscoveredPane()], {
      provider: "server",
      serverMap: JSON.stringify({
        generation: "v2",
        endpoint: "http://127.0.0.1:4096",
        panes: { "work:1.0": { sessionId: "root" } },
      }),
    });

    assert.equal(summary?.runtime.status, "running");
    assert.ok(calls.includes("/api/session"));
    assert.ok(calls.includes("/api/session/grandchild-running/permission"));
    assert.ok(calls.every((path) => path !== "/session/status"));
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test("V2 server discovers child blockers from the session listing without plugin state", async () => {
  const restoreEnv = setEnv({
    CODING_AGENTS_TMUX_STATE_DIR: mkdtempSync(join(tmpdir(), "empty-plugin-state-")),
  });
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path === "/api/info") return Response.json({ data: { version: "2.0.12" } });
    if (path === "/api/session/active") return Response.json({ data: {} });
    if (path === "/api/session") {
      return Response.json({
        data: [
          { id: "root", directory: "/tmp/project" },
          { id: "child-blocked", parentID: "root", directory: "/tmp/project" },
        ],
        cursor: null,
      });
    }
    if (path === "/api/session/root") {
      return Response.json({ data: { id: "root", directory: "/tmp/project" } });
    }
    if (path === "/api/session/child-blocked/permission") {
      return Response.json({ data: [{ id: "permission-1" }] });
    }
    if (path.endsWith("/permission") || path.endsWith("/form")) {
      return Response.json({ data: [] });
    }
    throw new Error(`unexpected fetch: ${path}`);
  };

  try {
    const [summary] = await attachRuntimeToPanes([createDiscoveredPane()], {
      provider: "server",
      serverMap: JSON.stringify({
        generation: "v2",
        endpoint: "http://127.0.0.1:4096",
        panes: { "work:1.0": { sessionId: "root" } },
      }),
    });

    assert.equal(summary?.runtime.status, "waiting-input");
    assert.ok(calls.every((path) => path !== "/session/status"));
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test("V2 server fails safely when session family metadata is incomplete or ambiguous", async () => {
  for (const sessions of [
    [{ id: "child", parentID: "root", directory: "/tmp/project" }],
    [
      { id: "root", directory: "/tmp/project" },
      { id: "child", parentID: "root", directory: "/tmp/project" },
      { id: "child", parentID: "other-root", directory: "/tmp/project" },
    ],
  ]) {
    const restoreEnv = setEnv({
      CODING_AGENTS_TMUX_STATE_DIR: mkdtempSync(join(tmpdir(), "empty-plugin-state-")),
    });
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (path === "/api/info") return Response.json({ data: { version: "2.0.12" } });
      if (path === "/api/session/active") return Response.json({ data: {} });
      if (path === "/api/session") return Response.json({ data: sessions, cursor: null });
      if (path === "/api/session/root") {
        return Response.json({ data: { id: "root", directory: "/tmp/project" } });
      }
      throw new Error(`unexpected fetch: ${path}`);
    };

    try {
      const [summary] = await attachRuntimeToPanes([createDiscoveredPane()], {
        provider: "server",
        serverMap: JSON.stringify({
          generation: "v2",
          endpoint: "http://127.0.0.1:4096",
          panes: { "work:1.0": { sessionId: "root" } },
        }),
      });

      assert.equal(summary?.runtime.status, "unknown");
      assert.match(
        summary?.runtime.detail ?? "",
        /session family metadata.*(?:incomplete|ambiguous)/i,
      );
      assert.ok(calls.every((path) => path !== "/session/status"));
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  }
});

test("legacy server maps probe API info and never send V1 status requests to V2", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    return Response.json({ data: { version: "2.0.12" } });
  };

  try {
    const [summary] = await attachRuntimeToPanes([createDiscoveredPane()], {
      provider: "server",
      serverMap: JSON.stringify({ "work:1.0": "http://127.0.0.1:4096" }),
    });

    assert.equal(summary?.runtime.status, "unknown");
    assert.match(summary?.runtime.detail ?? "", /API mismatch.*legacy V1 map.*V2/i);
    assert.deepEqual(calls, ["/api/info"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("auto preserves a legacy-map V2 API mismatch instead of using V1 SQLite", async () => {
  const { databasePath } = createSqliteDataHome();
  const database = initializeSqliteDatabase(databasePath);
  insertSession(database, {
    id: "unrelated-v1",
    directory: "/tmp/project",
    title: "Old V1",
    timeUpdated: Date.now(),
  });
  database.close();
  const restoreEnv = setEnv({
    CODING_AGENTS_TMUX_STATE_DIR: mkdtempSync(join(tmpdir(), "empty-plugin-state-")),
    OPENCODE_DB: databasePath,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: { version: "2.0.12" } });

  try {
    const [summary] = await attachRuntimeToPanes([createDiscoveredPane()], {
      provider: "auto",
      serverMap: JSON.stringify({ "work:1.0": "http://127.0.0.1:4096" }),
    });
    assert.equal(summary?.runtime.status, "unknown");
    assert.match(summary?.runtime.detail ?? "", /API mismatch.*legacy V1 map.*V2/i);
    assert.notEqual(summary?.runtime.session?.id, "unrelated-v1");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test("V2 server rejects API mismatches before making session requests", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    return Response.json({ data: { version: "1.18.29" } });
  };

  try {
    const [summary] = await attachRuntimeToPanes([createDiscoveredPane()], {
      provider: "server",
      serverMap: JSON.stringify({
        generation: "v2",
        endpoint: "http://127.0.0.1:4096",
        panes: { "work:1.0": { sessionId: "root" } },
      }),
    });

    assert.equal(summary?.runtime.status, "unknown");
    assert.match(summary?.runtime.detail ?? "", /API mismatch.*expected V2.*1\.18\.29/i);
    assert.deepEqual(calls, ["/api/info"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("V2 server requires an exact pane/root mapping and does not infer by directory", async () => {
  const pluginStateDir = createPluginStateDir([
    {
      opencodeGeneration: "v2",
      directory: "/tmp/project",
      title: "Directory-only state",
      sessionId: "root",
      familySessionIds: ["root"],
      status: "idle",
      activity: "idle",
    },
  ]);
  const restoreEnv = setEnv({ CODING_AGENTS_TMUX_STATE_DIR: pluginStateDir });
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    throw new Error("must not fetch");
  };

  try {
    const [summary] = await attachRuntimeToPanes([createDiscoveredPane()], {
      provider: "server",
      serverMap: JSON.stringify({
        generation: "v2",
        endpoint: "http://127.0.0.1:4096",
        panes: { "work:1.0": {} },
      }),
    });

    assert.equal(summary?.runtime.status, "unknown");
    assert.match(summary?.runtime.detail ?? "", /requires sessionId or exact plugin root state/);
    assert.deepEqual(calls, []);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test("V2 shared-server template describes one endpoint with explicit pane session mappings", () => {
  assert.deepEqual(
    buildServerMapTemplate(
      [createPane({ target: "work:1.0" }), createPane({ target: "work:1.1", paneIndex: 1 })],
      { basePort: 4096 },
    ),
    {
      generation: "v2",
      endpoint: "http://127.0.0.1:4096",
      panes: {
        "work:1.0": { sessionId: "" },
        "work:1.1": { sessionId: "" },
      },
    },
  );
});

test("OpenCode inspect debug reports generation, plugin family, database schema, and server mismatch", async () => {
  const binDir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-debug-bin-"));
  const executable = join(binDir, "opencode");
  writeFileSync(executable, "#!/bin/sh\nprintf 'opencode v2.0.12\\n'\n", "utf8");
  chmodSync(executable, 0o755);
  const pluginStateDir = createPluginStateDir([
    {
      opencodeGeneration: "v2",
      target: "work:1.0",
      paneId: "%1",
      directory: "/tmp/project",
      title: "Root session",
      sessionId: "root",
      selectedSessionId: "child",
      familySessionIds: ["root", "child"],
      status: "idle",
      activity: "idle",
      updatedAt: Date.now(),
    },
  ]);
  const databasePath = join(mkdtempSync(join(tmpdir(), "coding-agents-tmux-debug-db-")), "v2.db");
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY)");
  database.close();
  const restoreEnv = setEnv({
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    OPENCODE_DB: databasePath,
    CODING_AGENTS_TMUX_STATE_DIR: pluginStateDir,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: { version: "1.18.29" } });

  try {
    const debug = await buildInspectDebugInfo(createDiscoveredPane(), {
      serverMap: JSON.stringify({
        generation: "v2",
        endpoint: "http://127.0.0.1:4096",
        panes: { "work:1.0": {} },
      }),
    });

    assert.equal(debug.codex, null);
    assert.deepEqual(debug.opencode?.detected, { generation: 2, version: "2.0.12" });
    assert.equal(debug.opencode?.plugin.matchedState?.state.sessionId, "root");
    assert.deepEqual(debug.opencode?.plugin.matchedState?.state.familySessionIds, [
      "root",
      "child",
    ]);
    assert.match(debug.opencode?.plugin.matchedState?.filePath ?? "", /state-1\.json$/);
    assert.equal(debug.opencode?.sqlite.path, databasePath);
    assert.equal(debug.opencode?.sqlite.source, "env");
    assert.equal(debug.opencode?.sqlite.schema, "v2");
    assert.equal(debug.opencode?.server.configuredGeneration, "v2");
    assert.equal(debug.opencode?.server.detectedGeneration, "v1");
    assert.match(debug.opencode?.server.error ?? "", /API mismatch/i);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});
