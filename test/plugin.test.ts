import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

function installExecutable(dir: string, name: string, script: string): void {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${script}\n`, "utf8");
  chmodSync(path, 0o755);
}

test("plugin preserves waiting state for ambiguous session.status heartbeats", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-plugin-test-"));
  const restoreEnv = setEnv({
    CODING_AGENTS_TMUX_STATE_DIR: stateDir,
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

test("plugin supports CODING_AGENTS_TMUX_STATE_DIR as a state dir override", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-plugin-test-"));
  const restoreEnv = setEnv({
    CODING_AGENTS_TMUX_STATE_DIR: stateDir,
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

test("plugin switches back to running when session.status explicitly reports busy after a reply", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-plugin-test-"));
  const restoreEnv = setEnv({
    CODING_AGENTS_TMUX_STATE_DIR: stateDir,
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

test("plugin tolerates tmux disappearing before its debounced refresh", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-plugin-test-"));
  const emptyPath = mkdtempSync(join(tmpdir(), "coding-agents-tmux-no-tmux-"));
  const restoreEnv = setEnv({
    CODING_AGENTS_TMUX_STATE_DIR: stateDir,
    PATH: emptyPath,
    TMUX: "/tmp/tmux-test/default,1,0",
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
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(readOnlyStateFile(stateDir).status, "idle");
  } finally {
    restoreEnv();
  }
});

test("plugin notifies the configured integration after its debounced refresh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-plugin-notify-"));
  const stateDir = join(dir, "state");
  const logPath = join(dir, "notify.log");
  installExecutable(
    dir,
    "tmux",
    `if [ "$1" = "display-message" ]; then printf 'work:1.1\\n'; exit 0; fi\nif [ "$1" = "refresh-client" ]; then exit 0; fi\nif [ "$1" = "show-option" ]; then printf 'integration-notify %s\\n' '${logPath}'; exit 0; fi\nexit 1`,
  );
  installExecutable(dir, "integration-notify", `sleep 1\nprintf 'changed\\n' > "$1"`);
  const restoreEnv = setEnv({
    PATH: `${dir}:${process.env.PATH ?? ""}`,
    CODING_AGENTS_TMUX_STATE_DIR: stateDir,
    TMUX: "1",
    TMUX_PANE: "%42",
  });

  try {
    const { CodingAgentsTmuxPlugin } = await loadPlugin();
    const plugin = await CodingAgentsTmuxPlugin({
      directory: "/tmp/project",
      project: { name: "Project" },
      client: { app: { log: async () => null } },
    });
    const startedAt = Date.now();
    await plugin.event({ event: { type: "session.idle", timeUpdated: 100 } });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.ok(Date.now() - startedAt < 500, "notification blocked the plugin event loop");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if (readFileSync(logPath, "utf8") === "changed\n") break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(readFileSync(logPath, "utf8"), "changed\n");
  } finally {
    restoreEnv();
  }
});
