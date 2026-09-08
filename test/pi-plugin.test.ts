import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

type InstallPiPlugin = (typeof import("../plugin/pi-tmux.ts"))["default"];
type PiPluginApi = Parameters<InstallPiPlugin>[0];
type PiPluginEventName = Parameters<PiPluginApi["on"]>[0];
type PiPluginHandler = Parameters<PiPluginApi["on"]>[1];
type PiPluginContext = Parameters<PiPluginHandler>[1];

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

function installFakeTmux(script: string): { pathEntry: string; logPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-pi-plugin-fake-tmux-"));
  const tmuxPath = join(dir, "tmux");
  const logPath = join(dir, "tmux.log");
  const resolvedScript = script.replaceAll("__LOG_PATH__", logPath);

  writeFileSync(
    tmuxPath,
    `#!/usr/bin/env bash
set -euo pipefail
${resolvedScript}
`,
    "utf8",
  );
  chmodSync(tmuxPath, 0o755);

  return { pathEntry: dir, logPath };
}

async function loadPiPlugin(): Promise<{ default: InstallPiPlugin }> {
  return import(`../plugin/pi-tmux.ts?test=${Math.random()}`) as Promise<{
    default: InstallPiPlugin;
  }>;
}

function readOnlyStateFile(stateDir: string): Record<string, unknown> {
  const entries = readdirSync(stateDir);

  assert.equal(entries.length, 1, "expected exactly one pi state file");

  return JSON.parse(readFileSync(join(stateDir, entries[0] ?? ""), "utf8")) as Record<
    string,
    unknown
  >;
}

test("Pi plugin notifies integrations when tmux refresh fails", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-pi-plugin-state-"));
  const fakeTmux = installFakeTmux(`
if [ "$1" = "display-message" ]; then
  printf 'work:1.1\n'
  exit 0
fi
if [ "$1" = "refresh-client" ]; then
  printf '%s\n' "$*" >> __LOG_PATH__
  exit 1
fi
if [ "$1" = "show-option" ]; then
  printf 'integration-notify __LOG_PATH__\n'
  exit 0
fi
printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  const notifyPath = join(fakeTmux.pathEntry, "integration-notify");
  writeFileSync(
    notifyPath,
    "#!/usr/bin/env bash\nsleep 1\nprintf 'notified\\n' >> \"$1\"\n",
    "utf8",
  );
  chmodSync(notifyPath, 0o755);
  const restoreEnv = setEnv({
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    CODING_AGENTS_TMUX_PI_STATE_DIR: stateDir,
    TMUX_PANE: "%42",
  });

  try {
    const { default: installPiPlugin } = await loadPiPlugin();
    const handlers = new Map<PiPluginEventName, PiPluginHandler>();

    installPiPlugin({
      getSessionName: () => "Pi Session",
      on: (eventName: PiPluginEventName, handler: PiPluginHandler) => {
        handlers.set(eventName, handler);
      },
    });

    const handler = handlers.get("agent_start");
    assert.ok(handler, "expected agent_start handler");

    const ctx: PiPluginContext = {
      cwd: "/tmp/pi-project",
      sessionManager: {
        getSessionFile: () => "/tmp/pi-session.json",
        getSessionName: () => "Pi Session",
      },
    };

    const startedAt = Date.now();
    await handler?.({}, ctx);
    assert.ok(Date.now() - startedAt < 900, "Pi event handler waited for the integration command");

    const state = readOnlyStateFile(stateDir);
    let log = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      log = readFileSync(fakeTmux.logPath, "utf8");
      if (log.includes("notified")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.equal(state.target, "work:1.1");
    assert.equal(state.status, "running");
    assert.match(log, /refresh-client -S/);
    assert.match(log, /notified/);
  } finally {
    restoreEnv();
  }
});

test("Pi plugin supports CODING_AGENTS_TMUX_PI_STATE_DIR as a state dir override", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-pi-plugin-state-"));
  const emptyPath = mkdtempSync(join(tmpdir(), "coding-agents-tmux-no-tmux-"));
  const restoreEnv = setEnv({
    CODING_AGENTS_TMUX_PI_STATE_DIR: stateDir,
    PATH: emptyPath,
    TMUX_PANE: undefined,
  });

  try {
    const { default: installPiPlugin } = await loadPiPlugin();
    const handlers = new Map<PiPluginEventName, PiPluginHandler>();

    installPiPlugin({
      getSessionName: () => "Pi Session",
      on: (eventName: PiPluginEventName, handler: PiPluginHandler) => {
        handlers.set(eventName, handler);
      },
    });

    const handler = handlers.get("agent_end");
    assert.ok(handler, "expected agent_end handler");

    await handler?.(
      {},
      {
        cwd: "/tmp/pi-project",
        sessionManager: {
          getSessionFile: () => "/tmp/pi-session.json",
          getSessionName: () => "Pi Session",
        },
      },
    );

    const state = readOnlyStateFile(stateDir);
    assert.equal(state.status, "idle");
    assert.equal(state.title, "Pi Session");
  } finally {
    restoreEnv();
  }
});

test("Pi plugin refreshes tmux clients after removing state on shutdown", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-pi-plugin-state-"));
  const fakeTmux = installFakeTmux(`
if [ "$1" = "display-message" ]; then
  printf 'work:1.1\n'
  exit 0
fi
if [ "$1" = "refresh-client" ]; then
  printf '%s\n' "$*" >> __LOG_PATH__
  exit 0
fi
printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  const restoreEnv = setEnv({
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    CODING_AGENTS_TMUX_PI_STATE_DIR: stateDir,
    TMUX_PANE: "%42",
  });

  try {
    const { default: installPiPlugin } = await loadPiPlugin();
    const handlers = new Map<PiPluginEventName, PiPluginHandler>();

    installPiPlugin({
      getSessionName: () => "Pi Session",
      on: (eventName: PiPluginEventName, handler: PiPluginHandler) => {
        handlers.set(eventName, handler);
      },
    });

    const ctx: PiPluginContext = {
      cwd: "/tmp/pi-project",
      sessionManager: {
        getSessionFile: () => "/tmp/pi-session.json",
        getSessionName: () => "Pi Session",
      },
    };

    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("session_shutdown")?.({}, ctx);

    assert.deepEqual(readdirSync(stateDir), []);
    const log = readFileSync(fakeTmux.logPath, "utf8");
    assert.ok((log.match(/refresh-client -S/g)?.length ?? 0) >= 2);
  } finally {
    restoreEnv();
  }
});
