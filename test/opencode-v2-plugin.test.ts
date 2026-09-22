import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  derivePaneState,
  setupPanePlugin,
  writeStateAtomically,
  type PanePluginContext,
  type PaneState,
} from "../plugin/opencode/state.ts";

type Event = { type: string; data: Record<string, unknown> };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const sessions = new Map([
    [
      "root-a",
      {
        id: "root-a",
        title: "Root A",
        location: { directory: "/work/a" },
        time: { updated: 10 },
      },
    ],
    [
      "child-a",
      {
        id: "child-a",
        parentID: "root-a",
        title: "Child A",
        location: { directory: "/work/a" },
        time: { updated: 20 },
      },
    ],
    [
      "root-b",
      {
        id: "root-b",
        title: "Root B",
        location: { directory: "/work/b" },
        time: { updated: 30 },
      },
    ],
  ]);
  const status = new Map<string, "idle" | "running" | "retry">([
    ["root-a", "idle"],
    ["child-a", "running"],
    ["root-b", "idle"],
  ]);
  const permissions = new Map<string, unknown[]>([
    ["root-a", []],
    ["child-a", []],
    ["root-b", []],
  ]);
  const forms = new Map<string, Array<Record<string, unknown>>>([
    ["root-a", []],
    ["child-a", []],
    ["root-b", []],
  ]);
  const handlers = new Map<string, Set<(event: Event) => void>>();
  const unsubscribed: string[] = [];
  let route: { type: "home" } | { type: "session"; sessionID: string } = {
    type: "session",
    sessionID: "child-a",
  };
  const syncCalls: string[] = [];
  const invalidations: string[] = [];

  const collection = <T>(kind: "permission" | "form", values: Map<string, T[]>) => ({
    list(sessionID: string) {
      return values.get(sessionID);
    },
    async sync(sessionID: string) {
      syncCalls.push(`${kind}:${sessionID}`);
    },
    invalidate(sessionID: string) {
      invalidations.push(`${kind}:${sessionID}`);
    },
  });

  const context = {
    ui: {
      router: {
        current: () => route,
      },
    },
    data: {
      on(type: string, handler: (event: Event) => void) {
        const callbacks = handlers.get(type) ?? new Set();
        callbacks.add(handler);
        handlers.set(type, callbacks);
        return () => {
          callbacks.delete(handler);
          unsubscribed.push(type);
        };
      },
      session: {
        get: (id: string) => sessions.get(id),
        root: (id: string) => (id === "child-a" ? "root-a" : id),
        family: (id: string) =>
          id === "root-a" || id === "child-a" ? ["root-a", "child-a"] : [id],
        status: (id: string) => status.get(id) ?? "idle",
        async sync(id: string) {
          syncCalls.push(`session:${id}`);
        },
        invalidate(id: string) {
          invalidations.push(`session:${id}`);
        },
        pending: {
          list: () => [],
          async sync(id: string) {
            syncCalls.push(`pending:${id}`);
          },
          invalidate(id: string) {
            invalidations.push(`pending:${id}`);
          },
        },
        permission: collection("permission", permissions),
        form: collection("form", forms),
      },
    },
  } satisfies PanePluginContext;

  return {
    context,
    forms,
    handlers,
    invalidations,
    permissions,
    sessions,
    setRoute(next: typeof route) {
      route = next;
    },
    status,
    syncCalls,
    unsubscribed,
  };
}

function emit(handlers: Map<string, Set<(event: Event) => void>>, event: Event): void {
  for (const handler of handlers.get(event.type) ?? []) handler(event);
}

test("derivePaneState keeps root identity while aggregating child activity", () => {
  const fx = fixture();

  const state = derivePaneState(fx.context, "child-a", {
    paneId: "%7",
    target: "dev:1.2",
    sourceEventType: "plugin.init",
    now: 100,
  });

  assert.equal(state.sessionId, "root-a");
  assert.equal(state.selectedSessionId, "child-a");
  assert.deepEqual(state.familySessionIds, ["root-a", "child-a"]);
  assert.equal(state.title, "Root A");
  assert.equal(state.directory, "/work/a");
  assert.equal(state.status, "running");
  assert.equal(state.activity, "busy");
  assert.equal(state.opencodeGeneration, "v2");
});

test("selectable forms anywhere in the selected root family are questions", () => {
  const fx = fixture();
  fx.forms.set("child-a", [
    { id: "frm_child", fields: [{ key: "choice", type: "string", options: [{ value: "a" }] }] },
  ]);

  const childFormState = derivePaneState(fx.context, "root-a", {
    paneId: null,
    target: null,
    sourceEventType: "form.created",
    now: 100,
  });
  assert.equal(childFormState.status, "waiting-question");
  assert.equal(childFormState.sessionId, "root-a");
  assert.equal(childFormState.selectedSessionId, "root-a");

  fx.forms.set("child-a", []);
  fx.forms.set("root-a", [
    {
      id: "frm_root",
      fields: [{ key: "choice", type: "multiselect", options: [{ value: "a" }] }],
    },
  ]);
  assert.equal(
    derivePaneState(fx.context, "child-a", {
      paneId: null,
      target: null,
      sourceEventType: "form.created",
      now: 100,
    }).status,
    "waiting-question",
  );

  fx.forms.set("root-a", []);
  fx.permissions.set("child-a", [{ id: "per_1" }]);
  assert.equal(
    derivePaneState(fx.context, "child-a", {
      paneId: null,
      target: null,
      sourceEventType: "permission.asked",
      now: 100,
    }).status,
    "waiting-input",
  );
});

test("setup initializes cached family state and recalculates after blocker replies", async () => {
  const fx = fixture();
  fx.permissions.set("child-a", [{ id: "per_1" }]);
  const writes: PaneState[] = [];
  const refreshes: string[] = [];

  const cleanup = await setupPanePlugin(fx.context, {
    navigationPollMs: 5,
    paneId: "%7",
    resolveTarget: () => "dev:1.2",
    writeState: (state) => writes.push(structuredClone(state)),
    scheduleTmuxRefresh: () => {
      refreshes.push("refresh");
    },
  });

  assert.equal(writes.at(-1)?.status, "waiting-input");
  assert.ok(fx.syncCalls.includes("permission:child-a"));
  assert.ok(fx.syncCalls.includes("form:root-a"));

  fx.permissions.set("child-a", []);
  fx.status.set("child-a", "idle");
  emit(fx.handlers, {
    type: "permission.replied",
    data: { sessionID: "child-a", requestID: "per_1", reply: "once" },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(writes.at(-1)?.status, "idle");
  assert.equal(writes.at(-1)?.sourceEventType, "permission.replied");
  assert.ok(fx.invalidations.includes("permission:child-a"));
  assert.ok(refreshes.length >= 2);
  cleanup();
});

test("form.created invalidates the owning session from the V2 event envelope", async () => {
  const fx = fixture();
  const cleanup = await setupPanePlugin(fx.context, {
    navigationPollMs: 1_000,
    paneId: null,
    resolveTarget: () => null,
    writeState: () => undefined,
    scheduleTmuxRefresh: () => undefined,
  });

  emit(fx.handlers, {
    type: "form.created",
    data: { form: { id: "frm_1", sessionID: "child-a", fields: [] } },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.ok(fx.invalidations.includes("form:child-a"));
  cleanup();
});

test("setup notices navigation, changes roots, and cleans every resource", async () => {
  const fx = fixture();
  const writes: PaneState[] = [];
  let effectsCleaned = 0;
  const cleanup = await setupPanePlugin(fx.context, {
    navigationPollMs: 5,
    paneId: "%7",
    resolveTarget: () => null,
    writeState: (state) => writes.push(structuredClone(state)),
    scheduleTmuxRefresh: () => () => {
      effectsCleaned += 1;
    },
  });

  fx.setRoute({ type: "session", sessionID: "root-b" });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(writes.at(-1)?.sessionId, "root-b");
  assert.equal(writes.at(-1)?.directory, "/work/b");

  const count = writes.length;
  cleanup();
  assert.equal(fx.unsubscribed.length, 10);
  assert.ok(effectsCleaned >= 1);
  fx.setRoute({ type: "session", sessionID: "root-a" });
  emit(fx.handlers, {
    type: "session.status",
    data: { sessionID: "root-a", status: { type: "busy" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(writes.length, count);
});

test("navigation polling coalesces refreshes while the selected session is syncing", async (t) => {
  const fx = fixture();
  const slowRootB = deferred();
  const rootBSyncStarted = deferred();
  let rootBSyncCalls = 0;
  fx.context.data.session.sync = async (id: string) => {
    if (id === "root-b") {
      rootBSyncCalls += 1;
      rootBSyncStarted.resolve();
      await slowRootB.promise;
    }
  };
  const writes: PaneState[] = [];
  const cleanup = await setupPanePlugin(fx.context, {
    navigationPollMs: 5,
    reconcileMs: 1_000,
    paneId: null,
    resolveTarget: () => null,
    writeState: (state) => writes.push(structuredClone(state)),
    scheduleTmuxRefresh: () => undefined,
  });
  t.after(() => {
    slowRootB.resolve();
    cleanup();
  });

  fx.setRoute({ type: "session", sessionID: "root-b" });
  await rootBSyncStarted.promise;
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(rootBSyncCalls, 1);
  slowRootB.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(writes.at(-1)?.sessionId, "root-b");
});

test("newer refresh generations discard stale async results", async () => {
  const fx = fixture();
  const slow = deferred();
  let delayRootA = false;
  fx.context.data.session.sync = async (id: string) => {
    if (delayRootA && id === "root-a") await slow.promise;
  };
  const writes: PaneState[] = [];
  const cleanup = await setupPanePlugin(fx.context, {
    navigationPollMs: 1_000,
    paneId: null,
    resolveTarget: () => null,
    writeState: (state) => writes.push(structuredClone(state)),
    scheduleTmuxRefresh: () => undefined,
  });

  delayRootA = true;
  emit(fx.handlers, {
    type: "session.status",
    data: { sessionID: "root-a", status: { type: "busy" } },
  });
  fx.setRoute({ type: "session", sessionID: "root-b" });
  emit(fx.handlers, {
    type: "session.status",
    data: { sessionID: "root-b", status: { type: "idle" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  slow.resolve();
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(writes.at(-1)?.sessionId, "root-b");
  cleanup();
});

test("event status overrides expire after publication so cache recovery can win", async () => {
  const fx = fixture();
  fx.status.set("child-a", "idle");
  const writes: PaneState[] = [];
  const cleanup = await setupPanePlugin(fx.context, {
    navigationPollMs: 1_000,
    paneId: null,
    resolveTarget: () => null,
    writeState: (state) => writes.push(structuredClone(state)),
    scheduleTmuxRefresh: () => undefined,
  });

  emit(fx.handlers, {
    type: "session.status",
    data: { sessionID: "child-a", status: { type: "busy" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(writes.at(-1)?.status, "running");

  emit(fx.handlers, {
    type: "form.replied",
    data: { id: "frm_1", sessionID: "child-a", answer: {} },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(writes.at(-1)?.status, "idle");
  cleanup();
});

test("initial sync follows a cold ancestor chain before deriving the root", async () => {
  const fx = fixture();
  const loaded = new Set(["child-a"]);
  fx.context.data.session.root = (id: string) => {
    if (id === "child-a") return loaded.has("parent-a") ? "root-a" : "parent-a";
    if (id === "parent-a") return loaded.has("parent-a") ? "root-a" : "parent-a";
    return id;
  };
  fx.context.data.session.family = (id: string) => {
    if (id === "parent-a") return ["parent-a", "child-a"];
    return id === "root-a" ? ["root-a", "parent-a", "child-a"] : [id];
  };
  const getSession = fx.context.data.session.get;
  fx.context.data.session.get = (id: string) => (loaded.has(id) ? getSession(id) : undefined);
  fx.context.data.session.sync = async (id: string) => {
    loaded.add(id);
  };
  fx.sessions.set("parent-a", {
    id: "parent-a",
    parentID: "root-a",
    title: "Parent A",
    location: { directory: "/work/a" },
    time: { updated: 15 },
  });
  fx.status.set("parent-a", "idle");
  fx.permissions.set("parent-a", []);
  fx.forms.set("parent-a", []);
  const writes: PaneState[] = [];

  const cleanup = await setupPanePlugin(fx.context, {
    navigationPollMs: 1_000,
    paneId: null,
    resolveTarget: () => null,
    writeState: (state) => writes.push(structuredClone(state)),
    scheduleTmuxRefresh: () => undefined,
  });

  assert.equal(writes.at(-1)?.sessionId, "root-a");
  assert.equal(writes.at(-1)?.title, "Root A");
  assert.ok(loaded.has("root-a"));
  cleanup();
});

test("failed initial refresh unsubscribes every registered event", async () => {
  const fx = fixture();
  fx.context.data.session.sync = async () => {
    throw new Error("sync failed");
  };

  await assert.rejects(
    setupPanePlugin(fx.context, {
      paneId: null,
      resolveTarget: () => null,
      writeState: () => undefined,
      scheduleTmuxRefresh: () => undefined,
    }),
    /sync failed/,
  );

  assert.equal(fx.unsubscribed.length, 10);
});

test("a transient event refresh failure retries the selected session", async () => {
  const fx = fixture();
  const writes: PaneState[] = [];
  let failNext = false;
  const sync = fx.context.data.session.sync;
  fx.context.data.session.sync = async (id: string) => {
    if (failNext) {
      failNext = false;
      throw new Error("transient sync failure");
    }
    await sync(id);
  };
  const cleanup = await setupPanePlugin(fx.context, {
    navigationPollMs: 1_000,
    refreshRetryMs: 5,
    paneId: null,
    resolveTarget: () => null,
    writeState: (state) => writes.push(structuredClone(state)),
    scheduleTmuxRefresh: () => undefined,
  });

  failNext = true;
  fx.status.set("child-a", "idle");
  emit(fx.handlers, {
    type: "session.execution.succeeded",
    data: { sessionID: "child-a" },
  });
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(writes.at(-1)?.status, "idle");
  assert.equal(writes.at(-1)?.sourceEventType, "cache.reconcile");
  cleanup();
});

test("events outside the selected family do not poison later navigation", async () => {
  const fx = fixture();
  const writes: PaneState[] = [];
  const cleanup = await setupPanePlugin(fx.context, {
    navigationPollMs: 5,
    paneId: null,
    resolveTarget: () => null,
    writeState: (state) => writes.push(structuredClone(state)),
    scheduleTmuxRefresh: () => undefined,
  });

  emit(fx.handlers, {
    type: "session.status",
    data: { sessionID: "root-b", status: { type: "busy" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  fx.status.set("root-b", "idle");
  fx.setRoute({ type: "session", sessionID: "root-b" });
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(writes.at(-1)?.sessionId, "root-b");
  assert.equal(writes.at(-1)?.status, "idle");
  cleanup();
});

test("periodic reconciliation republishes silently hydrated cache state", async () => {
  const fx = fixture();
  const writes: PaneState[] = [];
  const cleanup = await setupPanePlugin(fx.context, {
    navigationPollMs: 1_000,
    reconcileMs: 5,
    paneId: null,
    resolveTarget: () => null,
    writeState: (state) => writes.push(structuredClone(state)),
    scheduleTmuxRefresh: () => undefined,
  });

  fx.status.set("child-a", "idle");
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(writes.at(-1)?.status, "idle");
  assert.equal(writes.at(-1)?.sourceEventType, "cache.reconcile");
  cleanup();
});

test("atomic writer leaves only the pane-specific state file", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-v2-state-"));
  const state = {
    version: 2,
    paneId: "%7",
    target: "dev:1.2",
    sessionId: "root-a",
    selectedSessionId: "child-a",
    familySessionIds: ["root-a", "child-a"],
    directory: "/work/a",
    title: "Root A",
    activity: "idle",
    status: "idle",
    detail: "family is idle",
    updatedAt: 100,
    sourceEventType: "plugin.init",
    opencodeGeneration: "v2",
  } satisfies PaneState;

  writeStateAtomically(stateDir, state);

  const entries = readdirSync(stateDir);
  assert.deepEqual(entries, [`pane-${Buffer.from("%7").toString("hex")}.json`]);
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir, entries[0]!), "utf8")), state);
});

test("default state directory treats empty environment overrides as unset", async () => {
  const fx = fixture();
  const stateHome = mkdtempSync(join(tmpdir(), "coding-agents-tmux-empty-state-env-"));
  const previousStateDir = process.env.CODING_AGENTS_TMUX_STATE_DIR;
  const previousStateHome = process.env.XDG_STATE_HOME;
  process.env.CODING_AGENTS_TMUX_STATE_DIR = "";
  process.env.XDG_STATE_HOME = `  ${stateHome}  `;

  try {
    const cleanup = await setupPanePlugin(fx.context, {
      navigationPollMs: 1_000,
      reconcileMs: 1_000,
      paneId: "%7",
      resolveTarget: () => "dev:1.2",
      scheduleTmuxRefresh: () => undefined,
    });
    cleanup();

    const stateDir = join(stateHome, "coding-agents-tmux", "plugin-state");
    assert.deepEqual(readdirSync(stateDir), [`pane-${Buffer.from("%7").toString("hex")}.json`]);
  } finally {
    if (previousStateDir === undefined) delete process.env.CODING_AGENTS_TMUX_STATE_DIR;
    else process.env.CODING_AGENTS_TMUX_STATE_DIR = previousStateDir;
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
  }
});
