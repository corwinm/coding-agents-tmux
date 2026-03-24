import test from "node:test";
import assert from "node:assert/strict";

import {
  getPaneStatusLabel,
  getPaneStatusSymbol,
  renderStatusSummary,
  renderStatusTone,
  renderSwitchChoices,
} from "../src/cli/render.ts";
import { detectOpencodePane, findDiscoveredPaneByTarget } from "../src/core/tmux.ts";
import type {
  DiscoveredPane,
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
    currentPath: overrides.currentPath ?? "/Users/corwin/Developer/opencode-tmux",
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
      isOpencode: true,
      confidence: "high",
      reasons: ["title:OpenCode", "command:opencode"],
    },
    runtime: overrides.runtime ?? createRuntime(status),
  };
}

test("detectOpencodePane recognizes strong title and command signals", () => {
  const pane = createPane({
    paneTitle: "OpenCode",
    currentCommand: "opencode",
    currentPath: "/tmp/project",
  });

  assert.deepEqual(detectOpencodePane(pane), {
    isOpencode: true,
    confidence: "high",
    reasons: ["title:OpenCode", "command:opencode"],
  });
});

test("detectOpencodePane keeps path-only matches low confidence and not opencode", () => {
  const pane = createPane({
    paneTitle: "shell",
    currentCommand: "bash",
    currentPath: "/tmp/opencode-scratch",
  });

  assert.deepEqual(detectOpencodePane(pane), {
    isOpencode: false,
    confidence: "low",
    reasons: ["path:opencode-like"],
  });
});

test("findDiscoveredPaneByTarget finds matching panes", () => {
  const firstPane = createPane({ target: "work:1.0" });
  const secondPane = createPane({ target: "work:1.1", paneIndex: 1 });
  const panes: DiscoveredPane[] = [
    { pane: firstPane, detection: detectOpencodePane(firstPane) },
    { pane: secondPane, detection: detectOpencodePane(secondPane) },
  ];

  assert.equal(findDiscoveredPaneByTarget(panes, "work:1.1"), panes[1]);
  assert.equal(findDiscoveredPaneByTarget(panes, "work:1.9"), null);
});

test("status helpers map runtime states to labels and symbols", () => {
  assert.equal(getPaneStatusLabel(createSummary("waiting-question")), "waiting");
  assert.equal(getPaneStatusLabel(createSummary("running")), "busy");
  assert.equal(getPaneStatusLabel(createSummary("new")), "new");
  assert.equal(getPaneStatusSymbol(createSummary("waiting-input")), "");
  assert.equal(getPaneStatusSymbol(createSummary("running")), "");
  assert.equal(getPaneStatusSymbol(createSummary("idle")), "");
  assert.equal(getPaneStatusSymbol(createSummary("new")), "");
  assert.equal(getPaneStatusSymbol(createSummary("unknown")), "");
});

test("renderStatusTone prioritizes waiting over other activity", () => {
  const current = createSummary("idle", { pane: createPane({ target: "work:1.0" }) });
  const waiting = createSummary("waiting-question", {
    pane: createPane({ target: "work:1.1", paneIndex: 1 }),
  });
  const running = createSummary("running", {
    pane: createPane({ target: "work:1.2", paneIndex: 2 }),
  });

  assert.equal(renderStatusTone(current, [current, waiting, running]), "waiting");
  assert.equal(renderStatusTone(null, [running]), "busy");
});

test("renderStatusSummary includes current and background panes in stable order", () => {
  const current = createSummary("running", {
    pane: createPane({ target: "work:1.2", paneIndex: 2 }),
  });
  const waiting = createSummary("waiting-input", {
    pane: createPane({ target: "work:1.0" }),
  });
  const idle = createSummary("idle", {
    pane: createPane({ target: "work:1.1", paneIndex: 1 }),
  });

  assert.equal(renderStatusSummary(current, [current, idle, waiting]), "󰚩 |  busy |  ");
  assert.equal(renderStatusSummary(null, [idle]), "󰚩 | ");
  assert.equal(
    renderStatusSummary(null, [idle], { includeCurrentPlaceholder: true }),
    "󰚩 | none | ",
  );
});

test("renderSwitchChoices shows numbered choices with truncated metadata", () => {
  const panes = [
    createSummary("waiting-question", {
      pane: createPane({
        isActive: true,
        target: "work:1.0",
        currentPath: "/very/long/path/that/should/still/render/cleanly/in/the-menu/view",
      }),
      runtime: createRuntime(
        "waiting-question",
        {},
        {
          id: "sess-1",
          directory: "/tmp/project",
          title: "A very long session title that should truncate",
          timeUpdated: 0,
        },
      ),
    }),
  ];

  const output = renderSwitchChoices(panes);

  assert.match(output, /Select an opencode pane:/);
  assert.match(output, /#\s+\*\s+TARGET\s+S\s+SESSION\s+TITLE\s+PATH/);
  assert.match(output, /1\s+\*\s+work:1\.0\s+/);
  assert.match(output, /A very long sessi\.\.\./);
});
