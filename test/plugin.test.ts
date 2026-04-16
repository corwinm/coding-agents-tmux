import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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

function readOnlyStateFile(stateDir: string): Record<string, unknown> {
  const entries = readdirSync(stateDir);

  assert.equal(entries.length, 1, "expected exactly one plugin state file");

  return JSON.parse(readFileSync(join(stateDir, entries[0] ?? ""), "utf8")) as Record<
    string,
    unknown
  >;
}

async function loadPlugin() {
  return import(`../plugin/coding-agents-tmux.ts?test=${Math.random()}`);
}

async function loadLegacyPluginAlias() {
  return import(`../plugin/opencode-tmux.ts?test=${Math.random()}`);
}

test("plugin preserves waiting state for ambiguous session.status heartbeats", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "opencode-tmux-plugin-test-"));
  const restoreEnv = setEnv({
    OPENCODE_TMUX_STATE_DIR: stateDir,
    TMUX: undefined,
    TMUX_PANE: undefined,
  });

  try {
    const { CodingAgentsTmuxPlugin } = await loadPlugin();
    const plugin = await CodingAgentsTmuxPlugin({
      directory: "/tmp/project",
      project: { name: "Project" },
      client: { app: { log: async () => null } },
    });

    await plugin.event({ event: { type: "permission.asked", timeUpdated: 100 } });
    await plugin.event({ event: { type: "session.status", timeUpdated: 101 } });

    const state = readOnlyStateFile(stateDir);
    assert.equal(state.status, "waiting-input");
    assert.equal(state.activity, "busy");
    assert.equal(state.detail, "session.status kept prior waiting state");
  } finally {
    restoreEnv();
  }
});

test("plugin supports CODING_AGENTS_TMUX_STATE_DIR as a state dir alias", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-plugin-test-"));
  const restoreEnv = setEnv({
    CODING_AGENTS_TMUX_STATE_DIR: stateDir,
    OPENCODE_TMUX_STATE_DIR: undefined,
    TMUX: undefined,
    TMUX_PANE: undefined,
  });

  try {
    const { CodingAgentsTmuxPlugin } = await loadPlugin();
    const plugin = await CodingAgentsTmuxPlugin({
      directory: "/tmp/project",
      project: { name: "Project" },
      client: { app: { log: async () => null } },
    });

    await plugin.event({ event: { type: "session.idle", timeUpdated: 100 } });

    const state = readOnlyStateFile(stateDir);
    assert.equal(state.status, "idle");
    assert.equal(state.title, "Project");
  } finally {
    restoreEnv();
  }
});

test("legacy plugin filename still re-exports the plugin", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-plugin-legacy-test-"));
  const restoreEnv = setEnv({
    CODING_AGENTS_TMUX_STATE_DIR: stateDir,
    OPENCODE_TMUX_STATE_DIR: undefined,
    TMUX: undefined,
    TMUX_PANE: undefined,
  });

  try {
    const { OpencodeTmuxPlugin } = await loadLegacyPluginAlias();
    const plugin = await OpencodeTmuxPlugin({
      directory: "/tmp/project",
      project: { name: "Project" },
      client: { app: { log: async () => null } },
    });

    await plugin.event({ event: { type: "session.idle", timeUpdated: 100 } });

    const state = readOnlyStateFile(stateDir);
    assert.equal(state.status, "idle");
    assert.equal(state.title, "Project");
  } finally {
    restoreEnv();
  }
});

test("plugin switches back to running when session.status explicitly reports busy after a reply", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "opencode-tmux-plugin-test-"));
  const restoreEnv = setEnv({
    OPENCODE_TMUX_STATE_DIR: stateDir,
    TMUX: undefined,
    TMUX_PANE: undefined,
  });

  try {
    const { CodingAgentsTmuxPlugin } = await loadPlugin();
    const plugin = await CodingAgentsTmuxPlugin({
      directory: "/tmp/project",
      project: { name: "Project" },
      client: { app: { log: async () => null } },
    });

    await plugin.event({ event: { type: "permission.asked", timeUpdated: 100 } });
    await plugin.event({
      event: { type: "session.status", status: "running", busy: true, timeUpdated: 101 },
    });

    const state = readOnlyStateFile(stateDir);
    assert.equal(state.status, "running");
    assert.equal(state.activity, "busy");
    assert.equal(state.detail, "session.status running event");
  } finally {
    restoreEnv();
  }
});
