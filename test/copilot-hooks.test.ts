import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  attachRuntimeWithCopilot,
  buildCopilotHooksTemplate,
  getCopilotHooksPath,
  installCopilotIntegration,
  persistCopilotHookState,
} from "../src/core/copilot.ts";
import type { DiscoveredPane } from "../src/types.ts";

const start = 1_790_000_000_000;
function pane(id: string): DiscoveredPane {
  return {
    pane: {
      paneId: id,
      target: `work:1.${id === "%20" ? 0 : 1}`,
      sessionName: "work",
      windowIndex: 1,
      paneIndex: id === "%20" ? 0 : 1,
      paneTitle: "shell",
      currentCommand: "copilot",
      currentPath: "/shared",
      isActive: true,
      tty: "/dev/ttys000",
    },
    detection: { agent: "copilot", confidence: "medium", reasons: ["command:copilot"] },
  };
}
function event(sessionId: string, timestamp: number, extras: Record<string, unknown> = {}) {
  return JSON.stringify({ sessionId, timestamp, cwd: "/shared", ...extras });
}

test("hook events isolate same-directory panes and clear only resolved prompts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-hooks-"));
  const ingest = (id: string, payload: string) =>
    persistCopilotHookState(payload, {
      paneId: id,
      stateDir: dir,
      now: start + 10_000,
      notify: async () => {},
    });
  const view = () =>
    attachRuntimeWithCopilot([pane("%20"), pane("%21")], {
      stateDir: dir,
      now: start + 10_000,
      isForeground: () => true,
    });
  await ingest("%20", event("s1", start + 10, { event: "userPromptSubmitted" }));
  await ingest("%20", event("s1", start + 15, { event: "sessionStart", source: "startup" }));
  await ingest("%21", event("s2", start + 20, { event: "sessionStart", source: "startup" }));
  assert.deepEqual(
    view().map((x) => x.runtime.status),
    ["running", "idle"],
  );
  await ingest(
    "%20",
    event("s1", start + 30, { event: "notification", notification_type: "permission_prompt" }),
  );
  await ingest(
    "%21",
    event("s2", start + 35, { event: "notification", notification_type: "elicitation_dialog" }),
  );
  assert.deepEqual(
    view().map((x) => x.runtime.status),
    ["waiting-question", "waiting-input"],
  );
  await ingest("%20", event("s1", start + 40, { event: "agentStop" }));
  assert.deepEqual(
    view().map((x) => x.runtime.status),
    ["idle", "waiting-input"],
  );
  await ingest("%21", event("s2", start + 45, { event: "agentStop" }));
  assert.deepEqual(
    view().map((x) => x.runtime.status),
    ["idle", "idle"],
  );
});

test("idle hook state persists past the activity TTL only for the same foreground process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-idle-"));
  await persistCopilotHookState(event("s1", start + 1, { event: "agentStop" }), {
    paneId: "%20",
    stateDir: dir,
    now: start + 2,
    notify: async () => {},
  });
  const view = (foreground: boolean) =>
    attachRuntimeWithCopilot([pane("%20")], {
      stateDir: dir,
      now: start + 120_000,
      isForeground: () => foreground,
    })[0]!.runtime;
  assert.equal(view(true).status, "idle");
  assert.equal(view(true).source, "copilot-hook");
  assert.equal(view(true).session?.id, "s1");
  assert.equal(view(false).status, "unknown");
  assert.equal(view(false).source, "copilot-command");
});

test("automatically approved checks never wait; unmatched notifications do not clear genuine waits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-hooks-"));
  const ingest = (payload: string) =>
    persistCopilotHookState(payload, {
      paneId: "%20",
      stateDir: dir,
      now: start + 500,
      notify: async () => {},
    });
  const status = () =>
    attachRuntimeWithCopilot([pane("%20")], {
      stateDir: dir,
      now: start + 500,
      isForeground: () => true,
    })[0]!.runtime.status;
  await ingest(event("s1", start + 1, { event: "userPromptSubmitted" }));
  await ingest(event("s1", start + 2, { event: "preToolUse" }));
  await ingest(event("s1", start + 3, { event: "permissionRequest" }));
  assert.equal(status(), "running");
  await ingest(
    event("s1", start + 4, { event: "notification", notification_type: "permission_prompt" }),
  );
  await ingest(
    event("s1", start + 5, { event: "notification", notification_type: "shell_completed" }),
  );
  assert.equal(status(), "waiting-question");
  await ingest(event("s1", start + 6, { event: "agentStop" }));
  assert.equal(status(), "idle");
});

test("clear, late old-session hooks, stale waits, malformed events and missing pane identity fail safely", async () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-hooks-"));
  const ingest = (payload: string, paneId: string | null = "%20") =>
    persistCopilotHookState(payload, {
      paneId,
      stateDir: dir,
      now: start + 500,
      notify: async () => {},
    });
  const status = (now = start + 500) =>
    attachRuntimeWithCopilot([pane("%20")], { stateDir: dir, now, isForeground: () => true })[0]!
      .runtime;
  await ingest(
    event("old", start + 1, { event: "notification", notification_type: "permission_prompt" }),
  );
  assert.equal(status().status, "waiting-question");
  await ingest(event("old", start + 2, { event: "sessionEnd", reason: "user_exit" }));
  assert.equal(status().status, "unknown");
  await ingest(event("new", start + 3, { event: "userPromptSubmitted" }));
  await ingest(event("new", start + 4, { event: "sessionStart", source: "new" }));
  await ingest(event("old", start + 5, { event: "sessionEnd" }));
  assert.equal(status().status, "running");
  assert.equal(status().session?.id, "new");
  await ingest(
    event("new", start + 6, { event: "notification", notification_type: "permission_prompt" }),
  );
  const stale = status(start + 120_000);
  assert.equal(stale.status, "unknown");
  assert.equal(stale.source, "copilot-command");
  await ingest("{}", null);
  await ingest("not json");
  await ingest(
    event("new", start + 7, { event: "notification", notification_type: "permission_prompt" }),
    null,
  );
  assert.equal(readdirSync(dir).filter((name) => name.endsWith(".json")).length, 1);
  assert.equal(status().status, "waiting-question");
});

test("resuming a session clears stale waiting state but a late startup event preserves the first prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-resume-"));
  const ingest = (payload: string) =>
    persistCopilotHookState(payload, {
      paneId: "%20",
      stateDir: dir,
      now: start + 500,
      notify: async () => {},
    });
  const status = () =>
    attachRuntimeWithCopilot([pane("%20")], {
      stateDir: dir,
      now: start + 500,
      isForeground: () => true,
    })[0]!.runtime.status;
  await ingest(
    event("s1", start + 1, { event: "notification", notification_type: "permission_prompt" }),
  );
  await ingest(event("s1", start + 2, { event: "sessionStart", source: "resume" }));
  assert.equal(status(), "idle");
  await ingest(event("s1", start + 3, { event: "userPromptSubmitted" }));
  await ingest(event("s1", start + 4, { event: "sessionStart", source: "startup" }));
  assert.equal(status(), "running");
});

test("a newer resume returns to the previous session without accepting its late callbacks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-resume-"));
  const ingest = (session: string, offset: number, eventName: string, extras = {}) =>
    persistCopilotHookState(event(session, start + offset, { event: eventName, ...extras }), {
      paneId: "%20",
      stateDir: dir,
      now: start + 500,
      notify: async () => {},
    });
  const runtime = () =>
    attachRuntimeWithCopilot([pane("%20")], {
      stateDir: dir,
      now: start + 500,
      isForeground: () => true,
    })[0]!.runtime;
  await ingest("A", 1, "sessionStart", { source: "startup" });
  await ingest("B", 3, "sessionStart", { source: "new" });
  await ingest("A", 4, "agentStop");
  assert.equal(runtime().session?.id, "B");
  await ingest("A", 2, "sessionStart", { source: "resume" });
  assert.equal(runtime().session?.id, "B");
  await ingest("A", 5, "sessionStart", { source: "resume" });
  assert.equal(runtime().session?.id, "A");
  await ingest("A", 6, "userPromptSubmitted");
  assert.equal(runtime().status, "running");
  await ingest("B", 7, "agentStop");
  assert.equal(runtime().session?.id, "A");
  assert.equal(runtime().status, "running");
});

test("multiple retired sessions cannot overwrite the current session, but can resume explicitly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-retired-"));
  const ingest = (session: string, offset: number, eventName: string, extras = {}) =>
    persistCopilotHookState(event(session, start + offset, { event: eventName, ...extras }), {
      paneId: "%20",
      stateDir: dir,
      now: start + 500,
      notify: async () => {},
    });
  const runtime = () =>
    attachRuntimeWithCopilot([pane("%20")], {
      stateDir: dir,
      now: start + 500,
      isForeground: () => true,
    })[0]!.runtime;
  await ingest("A", 1, "sessionStart", { source: "new" });
  await ingest("B", 2, "sessionStart", { source: "new" });
  await ingest("C", 3, "sessionStart", { source: "new" });
  await ingest("A", 4, "userPromptSubmitted");
  await ingest("A", 5, "sessionStart", { source: "new" });
  assert.equal(runtime().session?.id, "C");
  await ingest("A", 6, "sessionStart", { source: "resume" });
  assert.equal(runtime().session?.id, "A");
  await ingest("B", 7, "userPromptSubmitted");
  assert.equal(runtime().session?.id, "A");
  await ingest("B", 8, "sessionStart", { source: "resume" });
  assert.equal(runtime().session?.id, "B");
});

test("a background process cannot replace a different foreground PID's state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-processes-"));
  const foregroundPid = process.pid;
  const backgroundPid = process.ppid;
  const ingest = (pid: number, session: string, offset: number, foreground: boolean) =>
    persistCopilotHookState(
      event(session, start + offset, {
        event: "notification",
        notification_type: "permission_prompt",
      }),
      {
        paneId: "%20",
        stateDir: dir,
        now: start + 500,
        processPid: pid,
        isForeground: () => foreground,
        notify: async () => {},
      },
    );
  const runtime = () =>
    attachRuntimeWithCopilot([pane("%20")], {
      stateDir: dir,
      now: start + 500,
      isForeground: (pid) => pid === foregroundPid,
    })[0]!.runtime;
  await ingest(backgroundPid, "old", 1, false);
  await ingest(foregroundPid, "new", 2, true);
  assert.equal(runtime().status, "waiting-question");
  await ingest(backgroundPid, "old", 3, false);
  assert.equal(runtime().session?.id, "new");
  assert.equal(runtime().status, "waiting-question");
});

test("blank COPILOT_HOME installs into the default home, not the working directory", () => {
  for (const blank of ["", "   "]) {
    const root = mkdtempSync(join(tmpdir(), "copilot-blank-home-"));
    const cwd = join(root, "work");
    const home = join(root, "home");
    mkdirSync(cwd);
    mkdirSync(home);
    const moduleUrl = new URL("../src/core/copilot.ts", import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { installCopilotIntegration } from ${JSON.stringify(moduleUrl)}; installCopilotIntegration('/example/bin');`,
      ],
      {
        cwd,
        env: { ...process.env, HOME: home, COPILOT_HOME: blank },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(home, ".copilot", "hooks", "coding-agents-tmux.json")), true);
    assert.equal(existsSync(join(cwd, "hooks")), false);
  }
});

test("state from an exited Copilot process cannot attach to a replacement in the same pane", async () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-exit-"));
  await persistCopilotHookState(
    event("old", start + 1, { event: "notification", notification_type: "permission_prompt" }),
    {
      paneId: "%20",
      stateDir: dir,
      now: start + 10,
      processPid: 999_999_999,
      notify: async () => {},
    },
  );
  const runtime = attachRuntimeWithCopilot([pane("%20")], {
    stateDir: dir,
    now: start + 20,
    isForeground: () => true,
  })[0]!.runtime;
  assert.equal(runtime.status, "unknown");
  assert.equal(runtime.source, "copilot-command");
});

test("suspended process state does not classify another foreground Copilot pane occupant", async () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-background-"));
  await persistCopilotHookState(
    event("s1", start + 1, { event: "notification", notification_type: "permission_prompt" }),
    {
      paneId: "%20",
      stateDir: dir,
      now: start + 5,
      notify: async () => {},
    },
  );
  const runtime = attachRuntimeWithCopilot([pane("%20")], {
    stateDir: dir,
    now: start + 10,
    isForeground: () => false,
  })[0]!.runtime;
  assert.equal(runtime.status, "unknown");
  assert.equal(runtime.session?.id, "copilot:work:1.0");
  const stale = attachRuntimeWithCopilot([pane("%20")], {
    stateDir: dir,
    now: start + 120_000,
    isForeground: () => true,
  })[0]!.runtime;
  assert.equal(stale.session?.id, "copilot:work:1.0");
  assert.equal(stale.session?.timeUpdated, start + 120_000);
});

test("configured CLI hook args ingest real camelCase payloads without emitting decisions", () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-cli-"));
  const bin = join(import.meta.dirname, "..", "bin", "coding-agents-tmux");
  const config = JSON.parse(buildCopilotHooksTemplate(bin));
  const hook = config.hooks.notification[0];
  const result = spawnSync(hook.exec, hook.args, {
    input: JSON.stringify({
      sessionId: "s1",
      timestamp: Date.now(),
      cwd: "/shared",
      notification_type: "permission_prompt",
    }),
    env: {
      ...process.env,
      TMUX: "test,1,0",
      TMUX_PANE: "%20",
      CODING_AGENTS_TMUX_COPILOT_STATE_DIR: dir,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(
    attachRuntimeWithCopilot([pane("%20")], { stateDir: dir, isForeground: () => true })[0]!.runtime
      .status,
    "waiting-question",
  );
});

test("installer owns one user-level file, preserves unrelated hooks, and is idempotent", () => {
  const home = mkdtempSync(join(tmpdir(), "copilot-home-"));
  const hooks = join(home, "hooks");
  const path = getCopilotHooksPath(home);
  const command = "/example/bin/coding-agents-tmux";
  const template = JSON.parse(buildCopilotHooksTemplate(command));
  assert.equal(template.version, 1);
  assert.deepEqual(Object.keys(template.hooks).sort(), [
    "agentStop",
    "notification",
    "sessionEnd",
    "sessionStart",
    "userPromptSubmitted",
  ]);
  installCopilotIntegration(command, home);
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, "other.json"), '{"version":1,"hooks":{"agentStop":[]}}');
  const first = readFileSync(path, "utf8");
  installCopilotIntegration(command, home);
  assert.equal(readFileSync(path, "utf8"), first);
  const withExtra = JSON.parse(first);
  withExtra.hooks.agentStop.push({ type: "command", exec: "/other" });
  withExtra.custom = true;
  writeFileSync(path, JSON.stringify(withExtra));
  installCopilotIntegration(command, home);
  const merged = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(merged.custom, true);
  assert.equal(merged.hooks.agentStop.length, 2);
  installCopilotIntegration(command, home);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), merged);
  assert.equal(
    readFileSync(join(hooks, "other.json"), "utf8"),
    '{"version":1,"hooks":{"agentStop":[]}}',
  );
  assert.equal(template.hooks.notification[0].matcher, "permission_prompt|elicitation_dialog");
});
