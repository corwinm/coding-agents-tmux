import test from "node:test";
import assert from "node:assert/strict";

import {
  getPaneStatusLabel,
  getPaneStatusSymbol,
  renderCompactPaneList,
  renderInspectResult,
  renderPaneTable,
  renderStatusSummary,
  renderStatusTone,
  renderSwitchChoices,
} from "../src/cli/render.ts";
import { detectAgentPane, findDiscoveredPaneByTarget } from "../src/core/tmux.ts";
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
      agent: "opencode",
      confidence: "high",
      reasons: ["title:OpenCode", "command:opencode"],
    },
    runtime: overrides.runtime ?? createRuntime(status),
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

test("detectAgentPane recognizes strong OpenCode title and command signals", () => {
  const pane = createPane({
    paneTitle: "OpenCode",
    currentCommand: "opencode",
    currentPath: "/tmp/project",
  });

  assert.deepEqual(detectAgentPane(pane), {
    agent: "opencode",
    confidence: "high",
    reasons: ["title:OpenCode", "command:opencode"],
  });
});

test("detectAgentPane recognizes Pi command and title signals", () => {
  const pane = createPane({
    paneTitle: "π - repo",
    currentCommand: "pi",
    currentPath: "/tmp/project",
  });

  assert.deepEqual(detectAgentPane(pane), {
    agent: "pi",
    confidence: "high",
    reasons: ["title:Pi", "command:pi"],
  });
});

test("detectAgentPane keeps path-only matches low confidence and unmatched", () => {
  const pane = createPane({
    paneTitle: "shell",
    currentCommand: "bash",
    currentPath: "/tmp/opencode-scratch",
  });

  assert.deepEqual(detectAgentPane(pane), {
    agent: null,
    confidence: "low",
    reasons: ["path:opencode-like"],
  });
});

test("findDiscoveredPaneByTarget finds matching panes", () => {
  const firstPane = createPane({ target: "work:1.0" });
  const secondPane = createPane({ target: "work:1.1", paneIndex: 1 });
  const panes: DiscoveredPane[] = [
    { pane: firstPane, detection: detectAgentPane(firstPane) },
    { pane: secondPane, detection: detectAgentPane(secondPane) },
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

test("renderStatusTone handles all-idle and all-unknown pane lists", () => {
  const idle = createSummary("idle");
  const unknown = createSummary("unknown", {
    runtime: createRuntime("unknown", {
      source: "unmapped",
      match: { strategy: "unmapped", provider: "none", heuristic: false },
    }),
  });

  assert.equal(renderStatusTone(null, [idle]), "idle");
  assert.equal(renderStatusTone(null, [unknown]), "unknown");
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

  assert.match(output, /Select a coding agent pane:/);
  assert.match(output, /#\s+\*\s+AGENT\s+TARGET\s+S\s+SESSION\s+TITLE\s+PATH/);
  assert.match(output, /1\s+\*\s+opencode\s+work:1\.0\s+/);
  assert.match(output, /A very long sessi\.\.\./);
});

test("renderPaneTable covers empty, tabular, and truncated output", () => {
  assert.equal(renderPaneTable([]), "No likely coding agent tmux panes found.");

  const pane = createSummary("running", {
    pane: createPane({
      target: "work:1.0",
      currentPath: "/very/long/path/that/needs/to/be/truncated/because/the/table/is-limited",
      paneTitle: "A very long pane title that should be truncated in the table output",
    }),
    runtime: createRuntime(
      "running",
      {},
      {
        id: "sess-1",
        directory: "/tmp/project",
        title: "A very long session title that should also be truncated here",
        timeUpdated: 0,
      },
    ),
  });
  const output = renderPaneTable([pane]);

  assert.match(
    output,
    /TARGET\s+AGENT\s+ACTIVE\s+ACT\s+STATUS\s+SRC\s+CONF\s+SESSION\s+TITLE\s+PATH\s+SIGNALS/,
  );
  assert.match(output, /work:1\.0/);
  assert.match(output, /opencode/);
  assert.match(output, /A very long session title that sh\.\.\./);
  assert.match(output, /A very long pane title that should be t\.\.\./);
  assert.match(output, /\/very\/long\/path\/that\/needs\/to\/be\/truncated\/beca\.\.\./);
});

test("renderCompactPaneList prints tab-separated rows", () => {
  const pane = createSummary("idle", {
    pane: createPane({ target: "work:1.0", isActive: true }),
    runtime: createRuntime(
      "idle",
      {},
      { id: "sess-1", directory: "/tmp/project", title: "Session Title", timeUpdated: 0 },
    ),
  });

  assert.equal(
    renderCompactPaneList([pane]),
    "work:1.0\tidle\tidle\tplugin-exact\t1\tSession Title\tOpenCode\t/Users/corwin/Developer/opencode-tmux",
  );
  assert.equal(renderCompactPaneList([]), "");
});

test("renderCompactPaneList falls back to unmatched and untitled labels", () => {
  const pane = createSummary("unknown", {
    pane: createPane({ target: "work:1.1", paneIndex: 1, paneTitle: "" }),
    runtime: createRuntime("unknown", {
      source: "unmapped",
      match: { strategy: "unmapped", provider: "none", heuristic: false },
      session: null,
    }),
  });

  assert.equal(
    renderCompactPaneList([pane]),
    "work:1.1\tunknown\tunknown\tunmapped\t0\t(unmatched)\t(untitled)\t/Users/corwin/Developer/opencode-tmux",
  );
});

test("renderPaneTable and renderCompactPaneList handle mixed OpenCode, Codex, and Pi panes", () => {
  const opencodePane = createSummary("idle", {
    pane: createPane({ target: "work:1.0" }),
  });
  const codexPane = createSummary("running", {
    pane: createPane({
      target: "work:1.1",
      paneIndex: 1,
      paneTitle: "Codex",
      currentCommand: "codex",
    }),
    detection: { agent: "codex", confidence: "medium", reasons: ["command:codex"] },
    runtime: createRuntime("running", {
      source: "codex-command",
      match: { strategy: "exact", provider: "codex", heuristic: false },
      session: null,
    }),
  });
  const piPane = createSummary("running", {
    pane: createPane({
      target: "work:1.2",
      paneIndex: 2,
      paneTitle: "π - repo",
      currentCommand: "pi",
    }),
    detection: { agent: "pi", confidence: "high", reasons: ["title:Pi", "command:pi"] },
    runtime: createRuntime("running", {
      source: "pi-command",
      match: { strategy: "exact", provider: "pi", heuristic: false },
      session: null,
    }),
  });

  const tableOutput = renderPaneTable([opencodePane, codexPane, piPane]);
  const compactOutput = renderCompactPaneList([opencodePane, codexPane, piPane]);

  assert.match(tableOutput, /opencode/);
  assert.match(tableOutput, /codex/);
  assert.match(tableOutput, /pi/);
  assert.match(compactOutput, /work:1\.2\tbusy\trunning\tpi-command/);
});

test("renderInspectResult includes pane, detection, and session details", () => {
  const withSession = renderInspectResult({
    target: "work:1.0",
    summary: createSummary("running", {
      pane: createPane({ target: "work:1.0" }),
      runtime: createRuntime(
        "running",
        {},
        { id: "sess-1", directory: "/tmp/project", title: "Session Title", timeUpdated: 0 },
      ),
    }),
  });
  const withoutSession = renderInspectResult({
    target: "work:1.1",
    summary: createSummary("unknown", {
      pane: createPane({ target: "work:1.1", paneIndex: 1 }),
      runtime: createRuntime("unknown", {
        source: "unmapped",
        match: { strategy: "unmapped", provider: "none", heuristic: false },
        session: null,
      }),
    }),
  });

  assert.match(withSession, /Target: work:1\.0/);
  assert.match(withSession, /Agent: opencode/);
  assert.match(withSession, /Session ID: sess-1/);
  assert.match(withSession, /Session Updated: 1970-01-01T00:00:00\.000Z/);
  assert.match(withoutSession, /Session: none/);
});

test("renderStatusSummary supports tmux formatting and compact background mode", () => {
  const current = createSummary("running", {
    pane: createPane({ target: "work:1.9", paneIndex: 9 }),
  });
  const backgroundPanes = Array.from({ length: 9 }, (_, index) =>
    createSummary(index % 2 === 0 ? "idle" : "waiting-input", {
      pane: createPane({ target: `work:1.${index}`, paneIndex: index }),
    }),
  );
  const tmuxOutput = renderStatusSummary(current, [current, ...backgroundPanes], { style: "tmux" });
  const compactOutput = renderStatusSummary(current, [current, ...backgroundPanes]);

  assert.match(tmuxOutput, /#\[fg=colour252\]/);
  assert.match(tmuxOutput, /#\[fg=colour220\] busy/);
  assert.doesNotMatch(compactOutput, / | /);
  assert.match(compactOutput, /\|/);
});

test("renderSwitchChoices shows empty state and status summary honors custom tmux colors", async () => {
  assert.equal(renderSwitchChoices([]), "No likely coding agent tmux panes found.");

  const restoreEnv = setEnv({
    CODING_AGENTS_TMUX_STATUS_PREFIX: "OC",
    CODING_AGENTS_TMUX_STATUS_COLOR_NEUTRAL: "colour33",
    CODING_AGENTS_TMUX_STATUS_COLOR_BUSY: "colour220",
    CODING_AGENTS_TMUX_STATUS_COLOR_UNKNOWN: "colour244",
  });

  try {
    const moduleUrl = new URL(`../src/cli/render.ts?custom-colors=${Date.now()}`, import.meta.url);
    const renderModule = await import(moduleUrl.href);
    const current = createSummary("new", {
      runtime: createRuntime("new", { activity: "busy" }),
    });
    const unknown = createSummary("unknown", {
      pane: createPane({ target: "work:1.1", paneIndex: 1 }),
      runtime: createRuntime("unknown", {
        source: "unmapped",
        match: { strategy: "unmapped", provider: "none", heuristic: false },
      }),
    });

    const output = renderModule.renderStatusSummary(current, [current, unknown], { style: "tmux" });

    assert.match(output, /#\[fg=colour33\]OC#\[default\]/);
    assert.match(output, /#\[fg=colour220\] new#\[default\]/);
    assert.match(output, /#\[bold,fg=colour244\]#\[nobold\]#\[default\]/);
  } finally {
    restoreEnv();
  }
});

test("renderStatusSummary honors the prefix toggle when reloaded with env overrides", async () => {
  const restoreEnv = setEnv({ CODING_AGENTS_TMUX_STATUS_SHOW_PREFIX: "off" });

  try {
    const moduleUrl = new URL(`../src/cli/render.ts?prefix-off=${Date.now()}`, import.meta.url);
    const renderModule = await import(moduleUrl.href);

    assert.equal(renderModule.renderStatusSummary(null, [createSummary("idle")]), "");
  } finally {
    restoreEnv();
  }
});
