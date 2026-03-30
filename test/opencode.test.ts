import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  attachRuntimeToPanes,
  buildServerMapTemplate,
  describeServerMapInput,
  getRuntimeProviderHelpText,
} from "../src/core/opencode.ts";
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
  const root = mkdtempSync(join(tmpdir(), "opencode-tmux-plugin-state-"));

  states.forEach((state, index) => {
    writeFileSync(join(root, `state-${index + 1}.json`), JSON.stringify(state), "utf8");
  });

  return root;
}

function createSqliteDataHome(): { dataHome: string; databasePath: string } {
  const dataHome = mkdtempSync(join(tmpdir(), "opencode-tmux-data-home-"));
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

test("plugin provider matches panes by target, pane id, and legacy directory state", async () => {
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
  const restoreEnv = setEnv({ OPENCODE_TMUX_STATE_DIR: pluginStateDir });

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
  const restoreEnv = setEnv({ OPENCODE_TMUX_STATE_DIR: pluginStateDir });

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
  const { dataHome, databasePath } = createSqliteDataHome();
  const restoreEnv = setEnv({ XDG_DATA_HOME: dataHome, OPENCODE_TMUX_STATE_DIR: undefined });
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
  const { dataHome, databasePath } = createSqliteDataHome();
  const restoreEnv = setEnv({ XDG_DATA_HOME: dataHome, OPENCODE_TMUX_STATE_DIR: undefined });
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
  const mapFile = join(mkdtempSync(join(tmpdir(), "opencode-tmux-server-map-")), "map.json");
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
  const restoreEnv = setEnv({ OPENCODE_TMUX_SERVER_MAP: '{"work:1.0":"http://127.0.0.1:4096"}' });

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
    "work:1.0": "http://127.0.0.2:4096",
    "work:1.1": "http://127.0.0.2:4097",
  });
  assert.match(helpText, /Runtime providers:/);
  assert.match(helpText, /plugin  Use opencode plugin state files only/);
  await assert.rejects(
    attachRuntimeToPanes([createDiscoveredPane()], { provider: "bogus" as never }),
    /invalid runtime provider: bogus/,
  );
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
  const dataHome = mkdtempSync(join(tmpdir(), "opencode-tmux-missing-db-"));
  const restoreEnv = setEnv({ XDG_DATA_HOME: dataHome, OPENCODE_TMUX_STATE_DIR: undefined });

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
  const { dataHome, databasePath } = createSqliteDataHome();
  const restoreEnv = setEnv({
    OPENCODE_TMUX_STATE_DIR: pluginStateDir,
    XDG_DATA_HOME: dataHome,
  });
  const database = initializeSqliteDatabase(databasePath);
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const url = String(input);

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
