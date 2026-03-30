import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  buildDetailLines,
  buildListLayout,
  filterPanes,
  formatQueryLine,
  getSelectionIndex,
  matchesQuery,
  promptForPopupSelection,
  renderListHeader,
  renderListRow,
} from "../src/cli/popup.ts";
import type {
  PaneRuntimeSummary,
  RuntimeInfo,
  RuntimeStatus,
  SessionMatch,
  TmuxPane,
} from "../src/types.ts";

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

function createRuntime(
  status: RuntimeStatus,
  overrides: Partial<RuntimeInfo> = {},
  session: SessionMatch | null = null,
): RuntimeInfo {
  const activity =
    status === "running" || status === "waiting-question" || status === "waiting-input"
      ? "busy"
      : status === "unknown"
        ? "unknown"
        : "idle";

  return {
    activity,
    status,
    source: "plugin-exact",
    match: {
      strategy: "exact",
      provider: "plugin",
      heuristic: false,
    },
    session,
    detail: `runtime:${status}`,
    ...overrides,
  };
}

function createSummary(
  status: RuntimeStatus,
  overrides: Partial<PaneRuntimeSummary> = {},
): PaneRuntimeSummary {
  const pane = overrides.pane ?? createPane();

  return {
    pane,
    detection: overrides.detection ?? {
      agent: "opencode",
      confidence: "high",
      reasons: ["title:OpenCode", "command:opencode"],
    },
    runtime: overrides.runtime ?? createRuntime(status),
  };
}

class FakeInput extends EventEmitter {
  isTTY = true;
  encoding: BufferEncoding | null = null;
  rawMode = false;

  setEncoding(encoding: BufferEncoding): void {
    this.encoding = encoding;
  }

  setRawMode(mode: boolean): void {
    this.rawMode = mode;
  }

  resume(): void {}

  pause(): void {}

  send(value: string): void {
    this.emit("data", value);
  }
}

class FakeOutput extends EventEmitter {
  isTTY = true;
  columns = 80;
  rows = 24;
  writes: string[] = [];

  write(chunk: string): void {
    this.writes.push(chunk);
  }
}

async function nextTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("matchesQuery and filterPanes search across target, agent, status, session, title, and path", () => {
  const waitingPane = createSummary("waiting-question", {
    pane: createPane({
      target: "work:1.2",
      paneIndex: 2,
      paneTitle: "Review agent",
      currentPath: "/tmp/customer-project",
    }),
    runtime: createRuntime(
      "waiting-question",
      {},
      {
        id: "sess-1",
        directory: "/tmp/customer-project",
        title: "Customer Portal",
        timeUpdated: 0,
      },
    ),
  });
  const idlePane = createSummary("idle", {
    pane: createPane({ target: "work:1.3", paneIndex: 3, paneTitle: "Shell" }),
  });

  assert.equal(matchesQuery(waitingPane, "work:1.2 waiting customer review"), true);
  assert.equal(matchesQuery(waitingPane, "opencode customer"), true);
  assert.equal(matchesQuery(waitingPane, "customer missing-token"), false);
  assert.deepEqual(
    filterPanes([waitingPane, idlePane], "customer waiting").map((entry) => entry.pane.target),
    ["work:1.2"],
  );
  assert.deepEqual(
    filterPanes([waitingPane, idlePane], "").map((entry) => entry.pane.target),
    ["work:1.2", "work:1.3"],
  );
});

test("formatQueryLine truncates long queries and reports a visible cursor column", () => {
  const short = formatQueryLine("busy panes", 50, 2, 7);
  const long = formatQueryLine("a very long query string that should scroll to the end", 24, 9, 12);

  assert.match(short.line, /> busy panes/);
  assert.match(short.line, /2\/7$/);
  assert.ok(short.cursorColumn > 2);
  assert.match(long.line, /^> \.{3}/);
  assert.match(long.line, /9\/12$/);
  assert.ok(long.cursorColumn <= 24);
});

test("buildListLayout keeps widths within their documented bounds", () => {
  const narrow = buildListLayout(40, 1);
  const wide = buildListLayout(120, 2);

  assert.equal(narrow.targetWidth >= 14, true);
  assert.equal(narrow.sessionWidth >= 12, true);
  assert.equal(narrow.titleWidth >= 12, true);
  assert.equal(wide.targetWidth <= 26, true);
  assert.equal(wide.sessionWidth <= 20, true);
});

test("renderListHeader and renderListRow produce readable rows and highlight selection", () => {
  const pane = createSummary("waiting-input", {
    pane: createPane({
      target: "work:1.7",
      paneIndex: 7,
      paneTitle: "A long title for popup rendering",
    }),
    runtime: createRuntime(
      "waiting-input",
      {},
      { id: "sess-1", directory: "/tmp/project", title: "Popup Session", timeUpdated: 0 },
    ),
  });

  const header = renderListHeader(60, 1).join("\n");
  const unselected = renderListRow(pane, 1, false, 60, 1);
  const selected = renderListRow(pane, 1, true, 60, 1);

  assert.match(header, /TARGET/);
  assert.match(unselected, /work:1\.7/);
  assert.match(unselected, /Popup Ses\.\.\./);
  assert.equal(selected.includes("\u001b[48;5;236m"), true);
  assert.equal(selected.includes("\u001b[38;5;196m> "), true);
});

test("buildDetailLines handles no selection, loading, preview errors, and cached previews", () => {
  const pane = createSummary("running", {
    pane: createPane({ target: "work:1.5", paneIndex: 5 }),
    runtime: createRuntime(
      "running",
      {},
      { id: "sess-1", directory: "/tmp/project", title: "Preview Session", timeUpdated: 0 },
    ),
  });

  assert.deepEqual(
    buildDetailLines(null, { error: null, lines: [], loading: false, target: null }, 40, 6),
    ["No matching panes."],
  );
  assert.match(
    buildDetailLines(
      pane,
      { error: null, lines: [], loading: true, target: pane.pane.target },
      40,
      6,
    )[1] ?? "",
    /Loading preview/,
  );
  assert.match(
    buildDetailLines(
      pane,
      { error: "tmux failed", lines: [], loading: false, target: pane.pane.target },
      40,
      6,
    )[1] ?? "",
    /tmux failed/,
  );
  assert.deepEqual(
    buildDetailLines(
      pane,
      {
        error: null,
        lines: ["line 1", "line 2", "line 3"],
        loading: false,
        target: pane.pane.target,
      },
      40,
      6,
    ).slice(1),
    ["line 1", "line 2", "line 3"],
  );
});

test("getSelectionIndex keeps the current selection when available and falls back to zero", () => {
  const panes = [
    createSummary("idle", { pane: createPane({ target: "work:1.0" }) }),
    createSummary("running", { pane: createPane({ target: "work:1.1", paneIndex: 1 }) }),
  ];

  assert.equal(getSelectionIndex(panes, "work:1.1"), 1);
  assert.equal(getSelectionIndex(panes, "work:9.9"), 0);
  assert.equal(getSelectionIndex(panes, null), 0);
});

test("promptForPopupSelection supports quick select and preview loading without a real TTY", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const previewRequests: string[] = [];
  const panes = [
    createSummary("idle", { pane: createPane({ target: "work:1.0" }) }),
    createSummary("running", { pane: createPane({ target: "work:1.1", paneIndex: 1 }) }),
  ];

  const selectionPromise = promptForPopupSelection({
    loadPanes: async () => panes,
    loadPreview: async (target) => {
      previewRequests.push(target);
      return [`preview:${target}`];
    },
    inputStream: input,
    outputStream: output,
  });

  await nextTick();
  input.send("\u0007");
  input.send("2");

  const selected = await selectionPromise;

  assert.equal(selected?.pane.target, "work:1.1");
  assert.equal(input.encoding, "utf8");
  assert.equal(input.rawMode, false);
  assert.deepEqual(previewRequests, ["work:1.0"]);
  assert.equal(
    output.writes.some((chunk) => chunk.includes("Quick select: press 1-9")),
    true,
  );
});

test("promptForPopupSelection refreshes panes and falls back to the next valid selection", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const paneSets = [
    [
      createSummary("idle", { pane: createPane({ target: "work:1.0" }) }),
      createSummary("running", { pane: createPane({ target: "work:1.1", paneIndex: 1 }) }),
    ],
    [createSummary("waiting-input", { pane: createPane({ target: "work:2.0", windowIndex: 2 }) })],
  ];
  let loadCount = 0;

  const selectionPromise = promptForPopupSelection({
    loadPanes: async () => paneSets[Math.min(loadCount++, paneSets.length - 1)] ?? [],
    loadPreview: async (target) => [`preview:${target}`],
    inputStream: input,
    outputStream: output,
  });

  await nextTick();
  input.send("\u001b[B");
  input.send("\u0012");
  await nextTick();
  await nextTick();
  input.send("\r");

  const selected = await selectionPromise;

  assert.equal(selected?.pane.target, "work:2.0");
  assert.equal(loadCount, 2);
  assert.equal(
    output.writes.some((chunk) => chunk.includes("Refreshing...")),
    true,
  );
  assert.equal(
    output.writes.some((chunk) => chunk.includes("work:2.0")),
    true,
  );
});

test("promptForPopupSelection handles page and end navigation keys", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const panes = Array.from({ length: 12 }, (_, index) =>
    createSummary(index % 2 === 0 ? "idle" : "running", {
      pane: createPane({ target: `work:1.${index}`, paneIndex: index }),
    }),
  );

  const selectionPromise = promptForPopupSelection({
    loadPanes: async () => panes,
    loadPreview: async (target) => [`preview:${target}`],
    inputStream: input,
    outputStream: output,
  });

  await nextTick();
  input.send("\u001b[6~");
  input.send("\u001b[F");
  input.send("\r");

  const selected = await selectionPromise;

  assert.equal(selected?.pane.target, "work:1.11");
  assert.equal(
    output.writes.some((chunk) => chunk.includes("work:1.11")),
    true,
  );
});

test("promptForPopupSelection handles backspace, clear, delete-word, and no-match enter states", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const panes = [createSummary("idle", { pane: createPane({ target: "work:1.0" }) })];

  const selectionPromise = promptForPopupSelection({
    loadPanes: async () => panes,
    loadPreview: async (target) => [`preview:${target}`],
    inputStream: input,
    outputStream: output,
  });

  await nextTick();
  input.send("a");
  input.send("b");
  input.send("\u007f");
  input.send("c");
  input.send("\u0017");
  input.send("z");
  input.send("\r");
  input.send("\u0015");
  input.send("\r");

  const selected = await selectionPromise;

  assert.equal(selected?.pane.target, "work:1.0");
  assert.equal(
    output.writes.some((chunk) => chunk.includes("No filtered match to switch to.")),
    true,
  );
});

test("promptForPopupSelection handles home, page-up, and arrow navigation", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const panes = Array.from({ length: 10 }, (_, index) =>
    createSummary(index % 2 === 0 ? "idle" : "running", {
      pane: createPane({ target: `work:2.${index}`, windowIndex: 2, paneIndex: index }),
    }),
  );

  const selectionPromise = promptForPopupSelection({
    loadPanes: async () => panes,
    loadPreview: async (target) => [`preview:${target}`],
    inputStream: input,
    outputStream: output,
  });

  await nextTick();
  input.send("\u001b[B");
  input.send("\u001b[B");
  input.send("\u001b[A");
  input.send("\u001b[5~");
  input.send("\u001b[H");
  input.send("\r");

  const selected = await selectionPromise;

  assert.equal(selected?.pane.target, "work:2.0");
  assert.equal(
    output.writes.some((chunk) => chunk.includes("work:2.0")),
    true,
  );
});

test("promptForPopupSelection keeps running after quick-select cancel paths", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const panes = [
    createSummary("idle", { pane: createPane({ target: "work:3.0", windowIndex: 3 }) }),
    createSummary("running", {
      pane: createPane({ target: "work:3.1", windowIndex: 3, paneIndex: 1 }),
    }),
  ];

  const selectionPromise = promptForPopupSelection({
    loadPanes: async () => panes,
    loadPreview: async (target) => [`preview:${target}`],
    inputStream: input,
    outputStream: output,
  });

  await nextTick();
  input.send("\u0007");
  input.send("\u001b");
  input.send("\u0007");
  input.send("x");
  input.send("\u0015");
  input.send("\r");

  const selected = await selectionPromise;

  assert.equal(selected?.pane.target, "work:3.0");
  assert.equal(
    output.writes.some((chunk) => chunk.includes("Quick select cancelled")),
    true,
  );
});
