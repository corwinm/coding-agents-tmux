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

interface TestEvent {
  type: string;
  properties?: Record<string, unknown>;
  timeUpdated?: number;
}

async function startPlugin() {
  const { CodingAgentsTmuxPlugin } = await loadPlugin();
  return CodingAgentsTmuxPlugin({
    directory: "/tmp/project",
    project: { name: "Project" },
    client: { app: { log: async () => null } },
  }) as Promise<{ event: (input: { event: TestEvent }) => Promise<void> }>;
}

function isolatedStateDir(): { stateDir: string; restoreEnv: () => void } {
  const stateDir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-plugin-test-"));
  const restoreEnv = setEnv({
    CODING_AGENTS_TMUX_STATE_DIR: stateDir,
    TMUX: undefined,
    TMUX_PANE: undefined,
  });
  return { stateDir, restoreEnv };
}

function installExecutable(dir: string, name: string, script: string): void {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${script}\n`, "utf8");
  chmodSync(path, 0o755);
}

test("plugin latches waiting through a busy session.status heartbeat", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();

  try {
    const plugin = await startPlugin();

    await plugin.event({
      event: { type: "permission.asked", properties: { id: "req-1", sessionID: "ses_a" } },
    });
    await plugin.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_a", status: { type: "busy" } },
      },
    });

    const state = readOnlyStateFile(stateDir);
    assert.equal(state.status, "waiting-input");
    assert.equal(state.activity, "busy");
    assert.equal(state.detail, "session.status kept latched waiting state");
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

test("plugin switches back to running after the prompt is replied", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();

  try {
    const plugin = await startPlugin();

    await plugin.event({
      event: { type: "permission.asked", properties: { id: "req-1", sessionID: "ses_a" } },
    });
    await plugin.event({
      event: {
        type: "permission.replied",
        properties: { sessionID: "ses_a", requestID: "req-1", reply: "once" },
      },
    });
    await plugin.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_a", status: { type: "busy" } },
      },
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

test("plugin latches waiting through a running message.part.updated", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();

  try {
    const plugin = await startPlugin();

    await plugin.event({
      event: { type: "permission.asked", properties: { id: "req-1", sessionID: "ses_a" } },
    });
    await plugin.event({
      event: {
        type: "message.part.updated",
        properties: { sessionID: "ses_a", part: { state: { status: "running" } } },
      },
    });

    const state = readOnlyStateFile(stateDir);
    assert.equal(state.status, "waiting-input");
    assert.equal(state.detail, "message.part.updated kept latched waiting state");
  } finally {
    restoreEnv();
  }
});

test("plugin keeps waiting until every concurrent prompt is replied", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();

  try {
    const plugin = await startPlugin();

    await plugin.event({
      event: { type: "permission.asked", properties: { id: "req-1", sessionID: "ses_a" } },
    });
    await plugin.event({
      event: { type: "permission.asked", properties: { id: "req-2", sessionID: "ses_a" } },
    });
    await plugin.event({
      event: {
        type: "permission.replied",
        properties: { sessionID: "ses_a", requestID: "req-1" },
      },
    });

    let state = readOnlyStateFile(stateDir);
    assert.equal(state.status, "waiting-input", "still waiting while one prompt is pending");
    assert.equal(state.detail, "permission.replied with pending prompt");

    await plugin.event({
      event: {
        type: "permission.replied",
        properties: { sessionID: "ses_a", requestID: "req-2" },
      },
    });

    state = readOnlyStateFile(stateDir);
    assert.equal(state.status, "running", "running once all prompts are replied");
  } finally {
    restoreEnv();
  }
});

test("plugin releases the latch on question.rejected", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();

  try {
    const plugin = await startPlugin();

    await plugin.event({
      event: {
        type: "question.asked",
        properties: { id: "q-1", sessionID: "ses_a", questions: [{ options: ["a", "b"] }] },
      },
    });
    assert.equal(readOnlyStateFile(stateDir).status, "waiting-question");

    await plugin.event({
      event: { type: "question.rejected", properties: { sessionID: "ses_a", requestID: "q-1" } },
    });

    assert.equal(readOnlyStateFile(stateDir).status, "running");
  } finally {
    restoreEnv();
  }
});

test("plugin clears the latch on session.idle", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();

  try {
    const plugin = await startPlugin();

    await plugin.event({
      event: { type: "permission.asked", properties: { id: "req-1", sessionID: "ses_a" } },
    });
    await plugin.event({
      event: { type: "session.idle", properties: { sessionID: "ses_a" } },
    });

    assert.equal(readOnlyStateFile(stateDir).status, "idle");

    await plugin.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_a", status: { type: "busy" } },
      },
    });

    assert.equal(
      readOnlyStateFile(stateDir).status,
      "running",
      "latch cleared: busy heartbeat is no longer held at waiting",
    );
  } finally {
    restoreEnv();
  }
});

test("plugin latches on an ask with no request id and still releases on idle", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();

  try {
    const plugin = await startPlugin();

    await plugin.event({ event: { type: "permission.asked", properties: { sessionID: "ses_a" } } });
    await plugin.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_a", status: { type: "busy" } },
      },
    });
    assert.equal(readOnlyStateFile(stateDir).status, "waiting-input", "sentinel key latches");

    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_a" } } });
    assert.equal(readOnlyStateFile(stateDir).status, "idle");
  } finally {
    restoreEnv();
  }
});

test("plugin records the session id from properties.sessionID, not the event id", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();

  try {
    const plugin = await startPlugin();

    await plugin.event({
      event: {
        type: "session.status",
        id: "evt_should_not_win",
        properties: { sessionID: "ses_real", status: { type: "busy" } },
      } as TestEvent,
    });

    assert.equal(readOnlyStateFile(stateDir).sessionId, "ses_real");
  } finally {
    restoreEnv();
  }
});

test("plugin leaves session identity untouched for unrelated events", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();

  try {
    const plugin = await startPlugin();

    await plugin.event({
      event: {
        type: "session.updated",
        properties: {
          sessionID: "ses_real",
          info: { id: "ses_real", title: "Real title" },
        },
      },
    });
    await plugin.event({
      event: { type: "file.watcher.updated", id: "evt_other", properties: {} } as TestEvent,
    });

    const state = readOnlyStateFile(stateDir);
    assert.equal(state.sessionId, "ses_real");
    assert.equal(state.title, "Real title");
    assert.equal(state.directory, "/tmp/project");
  } finally {
    restoreEnv();
  }
});

test("plugin maps question.asked without options to waiting-input", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();

  try {
    const plugin = await startPlugin();

    await plugin.event({
      event: {
        type: "question.asked",
        properties: { id: "q-1", sessionID: "ses_a", questions: [{ options: [] }] },
      },
    });

    assert.equal(readOnlyStateFile(stateDir).status, "waiting-input");
  } finally {
    restoreEnv();
  }
});

test("plugin keeps root identity when a child session emits events", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();

  try {
    const plugin = await startPlugin();

    await plugin.event({
      event: {
        type: "session.updated",
        properties: { sessionID: "ses_root", info: { id: "ses_root", title: "Root" } },
      },
    });
    await plugin.event({
      event: {
        type: "session.created",
        properties: {
          sessionID: "ses_child",
          info: { id: "ses_child", title: "Child", parentID: "ses_root" },
        },
      },
    });
    await plugin.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_child", info: { id: "ses_child", title: "Child" } },
      },
    });

    const state = readOnlyStateFile(stateDir);
    assert.equal(state.sessionId, "ses_root");
    assert.equal(state.title, "Root");
  } finally {
    restoreEnv();
  }
});

test("plugin lets a child prompt project waiting onto the root pane", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();

  try {
    const plugin = await startPlugin();

    await plugin.event({
      event: {
        type: "session.created",
        properties: { sessionID: "ses_root", info: { id: "ses_root", title: "Root" } },
      },
    });
    await plugin.event({
      event: {
        type: "session.created",
        properties: {
          sessionID: "ses_child",
          info: { id: "ses_child", parentID: "ses_root" },
        },
      },
    });
    await plugin.event({
      event: { type: "permission.asked", properties: { id: "req-1", sessionID: "ses_child" } },
    });

    const state = readOnlyStateFile(stateDir);
    assert.equal(state.status, "waiting-input");
    assert.equal(state.sessionId, "ses_root");
    assert.equal(state.detail, "permission.asked event (child session)");
  } finally {
    restoreEnv();
  }
});

test("plugin does not idle the root pane when a child session goes idle", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();

  try {
    const plugin = await startPlugin();

    await plugin.event({
      event: {
        type: "session.created",
        properties: { sessionID: "ses_root", info: { id: "ses_root", title: "Root" } },
      },
    });
    await plugin.event({
      event: {
        type: "session.created",
        properties: { sessionID: "ses_child", info: { id: "ses_child", parentID: "ses_root" } },
      },
    });
    await plugin.event({
      event: { type: "permission.asked", properties: { id: "req-1", sessionID: "ses_root" } },
    });
    await plugin.event({
      event: { type: "session.idle", properties: { sessionID: "ses_child" } },
    });

    const state = readOnlyStateFile(stateDir);
    assert.equal(state.status, "waiting-input", "root prompt latch survives child idle");
  } finally {
    restoreEnv();
  }
});

test("plugin child idle clears only its own latch and falls through", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();

  try {
    const plugin = await startPlugin();

    await plugin.event({
      event: {
        type: "session.created",
        properties: { sessionID: "ses_root", info: { id: "ses_root", title: "Root" } },
      },
    });
    await plugin.event({
      event: {
        type: "session.created",
        properties: { sessionID: "ses_child", info: { id: "ses_child", parentID: "ses_root" } },
      },
    });
    await plugin.event({
      event: { type: "permission.asked", properties: { id: "req-c", sessionID: "ses_child" } },
    });
    assert.equal(readOnlyStateFile(stateDir).status, "waiting-input");

    await plugin.event({
      event: { type: "session.idle", properties: { sessionID: "ses_child" } },
    });

    const state = readOnlyStateFile(stateDir);
    assert.notEqual(state.status, "idle", "child idle must not idle root");
  } finally {
    restoreEnv();
  }
});

test("plugin resolves nested children up to the root ancestor", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();

  try {
    const plugin = await startPlugin();

    await plugin.event({
      event: {
        type: "session.created",
        properties: { sessionID: "ses_root", info: { id: "ses_root", title: "Root" } },
      },
    });
    await plugin.event({
      event: {
        type: "session.created",
        properties: { sessionID: "ses_mid", info: { id: "ses_mid", parentID: "ses_root" } },
      },
    });
    await plugin.event({
      event: {
        type: "session.created",
        properties: { sessionID: "ses_leaf", info: { id: "ses_leaf", parentID: "ses_mid" } },
      },
    });
    await plugin.event({
      event: {
        type: "session.updated",
        properties: {
          sessionID: "ses_leaf",
          info: { id: "ses_leaf", title: "Leaf", directory: "/tmp/leaf" },
        },
      },
    });

    const state = readOnlyStateFile(stateDir);
    assert.equal(state.sessionId, "ses_root");
    assert.equal(state.title, "Root");
    assert.equal(state.directory, "/tmp/project");
  } finally {
    restoreEnv();
  }
});

test("plugin treats a session id seen before its metadata as a child", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();

  try {
    const plugin = await startPlugin();

    await plugin.event({
      event: {
        type: "session.created",
        properties: { sessionID: "ses_root", info: { id: "ses_root", title: "Root" } },
      },
    });
    await plugin.event({
      event: { type: "permission.asked", properties: { id: "req-1", sessionID: "ses_late" } },
    });
    await plugin.event({
      event: { type: "session.idle", properties: { sessionID: "ses_late" } },
    });

    const state = readOnlyStateFile(stateDir);
    assert.equal(state.sessionId, "ses_root", "delayed-metadata session cannot take identity");
    assert.notEqual(state.status, "idle", "delayed-metadata child idle cannot idle root");
  } finally {
    restoreEnv();
  }
});

test("plugin ignores a child completion arriving after the root idles", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();

  try {
    const plugin = await startPlugin();

    await plugin.event({
      event: {
        type: "session.created",
        properties: { sessionID: "ses_root", info: { id: "ses_root", title: "Root" } },
      },
    });
    await plugin.event({
      event: {
        type: "session.created",
        properties: { sessionID: "ses_child", info: { id: "ses_child", parentID: "ses_root" } },
      },
    });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_root" } } });
    assert.equal(readOnlyStateFile(stateDir).status, "idle");

    // Real child completion emits session.status(idle) before session.idle;
    // neither may re-project the idle root as running.
    await plugin.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_child", status: { type: "idle" } },
      },
    });
    assert.equal(
      readOnlyStateFile(stateDir).status,
      "idle",
      "child status(idle) must not wake root",
    );

    await plugin.event({
      event: { type: "session.idle", properties: { sessionID: "ses_child" } },
    });

    const state = readOnlyStateFile(stateDir);
    assert.equal(state.sessionId, "ses_root");
    assert.equal(state.status, "idle");
  } finally {
    restoreEnv();
  }
});

test("plugin keeps the root busy when a child emits session.status(idle) then idle", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();

  try {
    const plugin = await startPlugin();

    await plugin.event({
      event: {
        type: "session.created",
        properties: { sessionID: "ses_root", info: { id: "ses_root", title: "Root" } },
      },
    });
    await plugin.event({
      event: {
        type: "session.created",
        properties: { sessionID: "ses_child", info: { id: "ses_child", parentID: "ses_root" } },
      },
    });
    await plugin.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_root", status: { type: "running" } },
      },
    });
    assert.equal(readOnlyStateFile(stateDir).activity, "busy", "root is working");

    await plugin.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_child", status: { type: "idle" } },
      },
    });
    await plugin.event({
      event: { type: "session.idle", properties: { sessionID: "ses_child" } },
    });

    const state = readOnlyStateFile(stateDir);
    assert.notEqual(state.status, "idle", "child completion must not idle the root pane");
    assert.equal(state.sessionId, "ses_root", "child completion must not take identity");
    assert.equal(state.title, "Root", "root title preserved through child completion");
  } finally {
    restoreEnv();
  }
});

test("plugin adopts a replacement root after the previous root is deleted", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();

  try {
    const plugin = await startPlugin();

    await plugin.event({
      event: {
        type: "session.created",
        properties: { sessionID: "ses_root1", info: { id: "ses_root1", title: "Root1" } },
      },
    });
    await plugin.event({
      event: {
        type: "session.created",
        properties: { sessionID: "ses_child", info: { id: "ses_child", parentID: "ses_root1" } },
      },
    });
    // Metadata-light update omitting parentID must not erase the known parent,
    // or the child could later usurp the root slot.
    await plugin.event({
      event: {
        type: "session.updated",
        properties: { sessionID: "ses_child", info: { id: "ses_child", title: "Child" } },
      },
    });
    await plugin.event({
      event: {
        type: "session.deleted",
        properties: { sessionID: "ses_root1", info: { id: "ses_root1" } },
      },
    });
    await plugin.event({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_child", status: { type: "running" } },
      },
    });
    await plugin.event({
      event: {
        type: "session.created",
        properties: { sessionID: "ses_root2", info: { id: "ses_root2", title: "Root2" } },
      },
    });

    const state = readOnlyStateFile(stateDir);
    assert.equal(state.sessionId, "ses_root2", "replacement root must reclaim identity");
    assert.equal(state.title, "Root2", "stale Root1 title must be replaced");
  } finally {
    restoreEnv();
  }
});

test("plugin adopts a new root after the previous root is deleted", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();

  try {
    const plugin = await startPlugin();

    await plugin.event({
      event: {
        type: "session.created",
        properties: { sessionID: "ses_root1", info: { id: "ses_root1", title: "Root1" } },
      },
    });
    await plugin.event({
      event: {
        type: "session.deleted",
        properties: { sessionID: "ses_root1", info: { id: "ses_root1" } },
      },
    });
    await plugin.event({
      event: {
        type: "session.created",
        properties: { sessionID: "ses_root2", info: { id: "ses_root2", title: "Root2" } },
      },
    });

    const state = readOnlyStateFile(stateDir);
    assert.equal(state.sessionId, "ses_root2");
    assert.equal(state.title, "Root2");
  } finally {
    restoreEnv();
  }
});

test("plugin single-session behavior is unchanged by scope tracking", async () => {
  const { stateDir, restoreEnv } = isolatedStateDir();

  try {
    const plugin = await startPlugin();

    await plugin.event({
      event: { type: "permission.asked", properties: { id: "req-1", sessionID: "ses_a" } },
    });
    assert.equal(readOnlyStateFile(stateDir).status, "waiting-input");

    await plugin.event({
      event: { type: "permission.replied", properties: { id: "req-1", sessionID: "ses_a" } },
    });
    assert.equal(readOnlyStateFile(stateDir).status, "running");

    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_a" } } });
    assert.equal(readOnlyStateFile(stateDir).status, "idle");
  } finally {
    restoreEnv();
  }
});
