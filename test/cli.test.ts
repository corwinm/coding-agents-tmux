import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildStatusOutput,
  buildTmuxSnippet,
  filterPaneSummaries,
  getPopupFilterArgs,
  getTmuxConfigPath,
  getWindowKeyFromTarget,
  parsePort,
  parseWatchInterval,
  pickWindowStatusRepresentative,
  updateTmuxConfig,
} from "../src/cli.ts";
import { runCommand } from "../src/runtime.ts";
import type {
  PaneRuntimeSummary,
  RuntimeInfo,
  RuntimeStatus,
  SessionMatch,
  TmuxPane,
} from "../src/types.ts";

const BIN_PATH = join(process.cwd(), "bin", "opencode-tmux");

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
  const root = mkdtempSync(join(tmpdir(), "opencode-tmux-cli-state-"));

  states.forEach((state, index) => {
    writeFileSync(join(root, `state-${index + 1}.json`), JSON.stringify(state), "utf8");
  });

  return root;
}

function installFakeTmux(script: string): { pathEntry: string; logPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "opencode-tmux-cli-tmux-"));
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
      isOpencode: true,
      confidence: "high",
      reasons: ["title:OpenCode", "command:opencode"],
    },
    runtime: overrides.runtime ?? createRuntime(status),
  };
}

test("parseWatchInterval and parsePort accept valid values and reject invalid ones", () => {
  assert.equal(parseWatchInterval(undefined), 2);
  assert.equal(parseWatchInterval("1.5"), 1.5);
  assert.equal(parsePort(undefined, "port"), undefined);
  assert.equal(parsePort("0", "base port"), 0);
  assert.equal(parsePort("65535", "base port"), 65535);

  assert.throws(() => parseWatchInterval("0"), /Invalid watch interval/);
  assert.throws(() => parseWatchInterval("oops"), /Invalid watch interval/);
  assert.throws(() => parsePort("-1", "base port"), /Invalid base port/);
  assert.throws(() => parsePort("65536", "base port"), /Invalid base port/);
  assert.throws(() => parsePort("1.2", "base port"), /Invalid base port/);
});

test("filterPaneSummaries applies active, waiting, busy, and running filters together", () => {
  const panes = [
    createSummary("idle", { pane: createPane({ target: "work:1.0", isActive: true }) }),
    createSummary("waiting-question", { pane: createPane({ target: "work:1.1", paneIndex: 1 }) }),
    createSummary("waiting-input", { pane: createPane({ target: "work:1.2", paneIndex: 2 }) }),
    createSummary("running", { pane: createPane({ target: "work:1.3", paneIndex: 3 }) }),
  ];

  assert.deepEqual(
    filterPaneSummaries(panes, { active: true }).map((entry) => entry.pane.target),
    ["work:1.0"],
  );
  assert.deepEqual(
    filterPaneSummaries(panes, { waiting: true }).map((entry) => entry.pane.target),
    ["work:1.1", "work:1.2"],
  );
  assert.deepEqual(
    filterPaneSummaries(panes, { busy: true }).map((entry) => entry.pane.target),
    ["work:1.1", "work:1.2", "work:1.3"],
  );
  assert.deepEqual(
    filterPaneSummaries(panes, { waiting: true, busy: true }).map((entry) => entry.pane.target),
    ["work:1.1", "work:1.2"],
  );
  assert.deepEqual(
    filterPaneSummaries(panes, { running: true }).map((entry) => entry.pane.target),
    ["work:1.3"],
  );
});

test("getWindowKeyFromTarget parses valid targets and rejects malformed ones", () => {
  assert.equal(getWindowKeyFromTarget("work:12.3"), "work:12");
  assert.throws(() => getWindowKeyFromTarget("work"), /Unexpected tmux target/);
  assert.throws(() => getWindowKeyFromTarget("work:abc.1"), /Unexpected tmux target/);
});

test("pickWindowStatusRepresentative prefers higher priority states and stable target ordering", () => {
  const idle = createSummary("idle", { pane: createPane({ target: "work:1.2", paneIndex: 2 }) });
  const waiting = createSummary("waiting-question", {
    pane: createPane({ target: "work:1.5", paneIndex: 5 }),
  });
  const running = createSummary("running", {
    pane: createPane({ target: "work:1.3", paneIndex: 3 }),
  });
  const anotherRunning = createSummary("running", {
    pane: createPane({ target: "work:1.1", paneIndex: 1 }),
  });

  assert.equal(pickWindowStatusRepresentative([idle, running, waiting]), waiting);
  assert.equal(pickWindowStatusRepresentative([idle, running, anotherRunning]), anotherRunning);
  assert.equal(pickWindowStatusRepresentative([]), null);
});

test("getPopupFilterArgs maps popup presets to command flags", () => {
  assert.deepEqual(getPopupFilterArgs("all"), []);
  assert.deepEqual(getPopupFilterArgs("busy"), ["--busy"]);
  assert.deepEqual(getPopupFilterArgs("waiting"), ["--waiting"]);
  assert.deepEqual(getPopupFilterArgs("running"), ["--running"]);
  assert.deepEqual(getPopupFilterArgs("active"), ["--active"]);
});

test("buildTmuxSnippet includes provider, server map, popup filter, and refresh hooks", () => {
  const snippet = buildTmuxSnippet({
    provider: "server",
    serverMap: "/tmp/server-map.json",
    popupFilter: "waiting",
    menuKey: "M",
    popupKey: "P",
    waitingMenuKey: "W",
    waitingPopupKey: "C-w",
  });

  assert.match(snippet, /bind-key M run-shell/);
  assert.match(snippet, /'--provider' 'server'/);
  assert.match(snippet, /'--server-map' '\/tmp\/server-map\.json'/);
  assert.match(snippet, /--waiting/);
  assert.match(snippet, /set-hook -g client-attached\[200\]/);
  assert.match(snippet, /set -g status-right/);
});

test("getTmuxConfigPath and updateTmuxConfig choose defaults, append, and replace marked blocks", () => {
  assert.equal(getTmuxConfigPath("/tmp/custom.conf"), "/tmp/custom.conf");
  assert.equal(getTmuxConfigPath(undefined), `${homedir()}/.tmux.conf`);

  const snippet = ["# >>> opencode-tmux >>>", "new config", "# <<< opencode-tmux <<<"].join("\n");
  const appended = updateTmuxConfig("set -g mouse on\n", snippet);
  const replaced = updateTmuxConfig(
    [
      "set -g mouse on",
      "",
      "# >>> opencode-tmux >>>",
      "old config",
      "# <<< opencode-tmux <<<",
      "",
    ].join("\n"),
    snippet,
  );

  assert.match(appended, /set -g mouse on\n\n# >>> opencode-tmux >>>/);
  assert.doesNotMatch(replaced, /old config/);
  assert.match(replaced, /new config/);
});

test("buildStatusOutput renders summary, tone, and summary json outside tmux", () => {
  const panes = [
    createSummary("idle", { pane: createPane({ target: "work:1.0" }) }),
    createSummary("waiting-input", { pane: createPane({ target: "work:1.1", paneIndex: 1 }) }),
    createSummary("running", { pane: createPane({ target: "work:1.2", paneIndex: 2 }) }),
  ];

  assert.equal(buildStatusOutput(panes, { summary: true }, { tmuxAvailable: false }), "󰚩 |   ");
  assert.equal(
    buildStatusOutput(panes, { summary: true, tone: true }, { tmuxAvailable: false }),
    "waiting",
  );
  assert.deepEqual(
    JSON.parse(buildStatusOutput(panes, { summary: true, json: true }, { tmuxAvailable: false })),
    { mode: "summary", total: 3, busy: 2, waiting: 1 },
  );
});

test("buildStatusOutput renders current pane status inside tmux and falls back to a window representative", () => {
  const current = createSummary("running", {
    pane: createPane({ target: "work:1.2", paneIndex: 2 }),
  });
  const sameWindowWaiting = createSummary("waiting-question", {
    pane: createPane({ target: "work:1.1", paneIndex: 1 }),
  });
  const otherWindowIdle = createSummary("idle", {
    pane: createPane({ target: "work:2.0", windowIndex: 2 }),
  });
  const panes = [sameWindowWaiting, current, otherWindowIdle];

  assert.equal(
    buildStatusOutput(panes, {}, { tmuxAvailable: true, currentTarget: "work:1.2" }),
    "󰚩 |  busy | ",
  );
  assert.equal(
    buildStatusOutput(panes, { tone: true }, { tmuxAvailable: true, currentTarget: "work:1.9" }),
    "waiting",
  );

  const jsonOutput = JSON.parse(
    buildStatusOutput(panes, { json: true }, { tmuxAvailable: true, currentTarget: "work:1.9" }),
  );
  assert.equal(jsonOutput.mode, "current");
  assert.equal(jsonOutput.current.pane.target, "work:1.1");
  assert.match(jsonOutput.summary, /waiting/);
});

test("buildStatusOutput uses a current placeholder when the active tmux pane has no opencode match", () => {
  const panes = [
    createSummary("idle", { pane: createPane({ target: "work:2.0", windowIndex: 2 }) }),
  ];

  assert.equal(
    buildStatusOutput(panes, {}, { tmuxAvailable: true, currentTarget: "work:1.9" }),
    "󰚩 | none | ",
  );
});

test("CLI help and tmux-config work through the entrypoint script", async () => {
  const helpResult = await runCommand([BIN_PATH, "--help"]);
  const configResult = await runCommand([
    BIN_PATH,
    "tmux-config",
    "--provider",
    "server",
    "--server-map",
    "/tmp/server-map.json",
    "--popup-filter",
    "waiting",
  ]);

  assert.equal(helpResult.exitCode, 0);
  assert.match(helpResult.stdoutText, /Usage: opencode-tmux/);
  assert.match(helpResult.stdoutText, /tmux-config/);
  assert.equal(configResult.exitCode, 0);
  assert.match(configResult.stdoutText, /# >>> opencode-tmux >>>/);
  assert.match(configResult.stdoutText, /--provider/);
  assert.match(configResult.stdoutText, /--waiting/);
});

test("CLI install-tmux writes and replaces a marked config block", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-tmux-cli-test-"));
  const filePath = join(dir, "tmux.conf");
  const firstRun = await runCommand([BIN_PATH, "install-tmux", "--file", filePath]);
  const secondRun = await runCommand([
    BIN_PATH,
    "install-tmux",
    "--file",
    filePath,
    "--provider",
    "server",
  ]);
  const contents = readFileSync(filePath, "utf8");

  assert.equal(firstRun.exitCode, 0);
  assert.equal(secondRun.exitCode, 0);
  assert.match(contents, /# >>> opencode-tmux >>>/);
  assert.match(contents, /# <<< opencode-tmux <<</);
  assert.match(contents, /--provider/);
  assert.equal(contents.match(/# >>> opencode-tmux >>>/g)?.length, 1);
});

test("CLI inspect emits JSON for a discovered pane", async () => {
  const fakeTmux = installFakeTmux(`
if [ "$1" = "list-panes" ]; then
  printf 'work\t1\t0\t%%1\tOpenCode\topencode\t/tmp/project\t1\t/dev/ttys001\n'
  exit 0
fi
printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  const pluginStateDir = createPluginStateDir([
    {
      target: "work:1.0",
      directory: "/tmp/project",
      title: "CLI Inspect Session",
      status: "running",
      activity: "busy",
      updatedAt: 100,
    },
  ]);
  const restoreEnv = setEnv({
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    OPENCODE_TMUX_STATE_DIR: pluginStateDir,
  });

  try {
    const result = await runCommand([
      BIN_PATH,
      "inspect",
      "work:1.0",
      "--json",
      "--provider",
      "plugin",
    ]);
    const payload = JSON.parse(result.stdoutText);

    assert.equal(result.exitCode, 0);
    assert.equal(payload.target, "work:1.0");
    assert.equal(payload.summary.pane.target, "work:1.0");
    assert.deepEqual(payload.summary.detection, {
      isOpencode: true,
      confidence: "high",
      reasons: ["title:OpenCode", "command:opencode"],
    });
    assert.equal(payload.summary.runtime.status, "running");
    assert.equal(payload.summary.runtime.source, "plugin-exact");
    assert.deepEqual(payload.summary.runtime.match, {
      strategy: "exact",
      provider: "plugin",
      heuristic: false,
    });
    assert.equal(payload.summary.runtime.session.directory, "/tmp/project");
    assert.equal(payload.summary.runtime.session.title, "CLI Inspect Session");
    assert.equal(payload.summary.runtime.detail, "plugin state file");
  } finally {
    restoreEnv();
  }
});

test("CLI switch selects an explicit target through tmux", async () => {
  const fakeTmux = installFakeTmux(`
if [ "$1" = "list-panes" ]; then
  printf 'work\t4\t2\t%%4\tOpenCode\topencode\t/tmp/project\t1\t/dev/ttys004\n'
  exit 0
fi
printf '%s\n' "$*" >> '__LOG_PATH__'
exit 0
`);
  const pluginStateDir = createPluginStateDir([
    {
      target: "work:4.2",
      directory: "/tmp/project",
      title: "CLI Switch Session",
      status: "running",
      activity: "busy",
      updatedAt: 100,
    },
  ]);
  const restoreEnv = setEnv({
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    OPENCODE_TMUX_STATE_DIR: pluginStateDir,
    TMUX: "1",
  });

  try {
    const result = await runCommand([BIN_PATH, "switch", "work:4.2", "--provider", "plugin"]);

    assert.equal(result.exitCode, 0);
    assert.match(
      readFileSync(fakeTmux.logPath, "utf8"),
      /switch-client -t work ; select-window -t work:4 ; select-pane -t work:4\.2/,
    );
  } finally {
    restoreEnv();
  }
});

test("CLI server-map-template prints sequential endpoints for discovered panes", async () => {
  const fakeTmux = installFakeTmux(`
if [ "$1" = "list-panes" ]; then
  printf 'work\t1\t0\t%%1\tOpenCode\topencode\t/tmp/project-a\t1\t/dev/ttys001\n'
  printf 'work\t1\t1\t%%2\tOpenCode\topencode\t/tmp/project-b\t0\t/dev/ttys002\n'
  exit 0
fi
printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  const restoreEnv = setEnv({ PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}` });

  try {
    const result = await runCommand([
      BIN_PATH,
      "server-map-template",
      "--base-port",
      "4096",
      "--hostname",
      "127.0.0.2",
    ]);

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdoutText), {
      "work:1.0": "http://127.0.0.2:4096",
      "work:1.1": "http://127.0.0.2:4097",
    });
  } finally {
    restoreEnv();
  }
});

test("CLI list supports compact and json output with runtime filters", async () => {
  const fakeTmux = installFakeTmux(`
if [ "$1" = "list-panes" ]; then
  printf 'work\t1\t0\t%%1\tOpenCode\topencode\t/tmp/project-a\t1\t/dev/ttys001\n'
  printf 'work\t1\t1\t%%2\tOpenCode\topencode\t/tmp/project-b\t0\t/dev/ttys002\n'
  printf 'work\t2\t0\t%%3\tShell\tbash\t/tmp/other\t0\t/dev/ttys003\n'
  exit 0
fi
printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  const pluginStateDir = createPluginStateDir([
    {
      target: "work:1.0",
      directory: "/tmp/project-a",
      title: "Idle Session",
      status: "idle",
      activity: "idle",
      updatedAt: 100,
    },
    {
      target: "work:1.1",
      directory: "/tmp/project-b",
      title: "Waiting Session",
      status: "waiting-input",
      activity: "busy",
      updatedAt: 200,
    },
  ]);
  const restoreEnv = setEnv({
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    OPENCODE_TMUX_STATE_DIR: pluginStateDir,
  });

  try {
    const compactResult = await runCommand([
      BIN_PATH,
      "list",
      "--compact",
      "--waiting",
      "--provider",
      "plugin",
    ]);
    const jsonResult = await runCommand([
      BIN_PATH,
      "list",
      "--json",
      "--busy",
      "--provider",
      "plugin",
    ]);

    assert.equal(compactResult.exitCode, 0);
    assert.equal(
      compactResult.stdoutText.trim(),
      "work:1.1\tbusy\twaiting-input\tplugin-exact\t0\tWaiting Session\tOpenCode\t/tmp/project-b",
    );
    assert.equal(jsonResult.exitCode, 0);
    assert.deepEqual(
      JSON.parse(jsonResult.stdoutText).map(
        (entry: { pane: { target: string } }) => entry.pane.target,
      ),
      ["work:1.1"],
    );
  } finally {
    restoreEnv();
  }
});

test("CLI status supports summary json and current-pane rendering", async () => {
  const fakeTmux = installFakeTmux(`
if [ "$1" = "list-panes" ]; then
  printf 'work\t1\t0\t%%1\tOpenCode\topencode\t/tmp/project-a\t0\t/dev/ttys001\n'
  printf 'work\t1\t1\t%%2\tOpenCode\topencode\t/tmp/project-b\t1\t/dev/ttys002\n'
  printf 'work\t2\t0\t%%3\tOpenCode\topencode\t/tmp/project-c\t0\t/dev/ttys003\n'
  exit 0
fi
if [ "$1" = "display-message" ]; then
  printf 'work:1.1\n'
  exit 0
fi
printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  const pluginStateDir = createPluginStateDir([
    {
      target: "work:1.0",
      directory: "/tmp/project-a",
      title: "Idle Session",
      status: "idle",
      activity: "idle",
      updatedAt: 100,
    },
    {
      target: "work:1.1",
      directory: "/tmp/project-b",
      title: "Waiting Session",
      status: "waiting-question",
      activity: "busy",
      updatedAt: 200,
    },
    {
      target: "work:2.0",
      directory: "/tmp/project-c",
      title: "Running Session",
      status: "running",
      activity: "busy",
      updatedAt: 300,
    },
  ]);
  const restoreEnv = setEnv({
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    OPENCODE_TMUX_STATE_DIR: pluginStateDir,
    TMUX: "1",
  });

  try {
    const summaryJson = await runCommand([
      BIN_PATH,
      "status",
      "--summary",
      "--json",
      "--provider",
      "plugin",
    ]);
    const currentOutput = await runCommand([BIN_PATH, "status", "--provider", "plugin"]);

    assert.equal(summaryJson.exitCode, 0);
    assert.deepEqual(JSON.parse(summaryJson.stdoutText), {
      mode: "summary",
      total: 3,
      busy: 2,
      waiting: 1,
    });
    assert.equal(currentOutput.exitCode, 0);
    assert.equal(currentOutput.stdoutText.trim(), "󰚩 |  waiting | ");
  } finally {
    restoreEnv();
  }
});

test("CLI popup --print-command prints the inner popup-ui command without tmux", async () => {
  const result = await runCommand([
    BIN_PATH,
    "popup",
    "--print-command",
    "--provider",
    "server",
    "--server-map",
    "/tmp/server-map.json",
    "--busy",
  ]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdoutText, /popup-ui/);
  assert.match(result.stdoutText, /--provider/);
  assert.match(result.stdoutText, /server/);
  assert.match(result.stdoutText, /--server-map/);
  assert.match(result.stdoutText, /\/tmp\/server-map\.json/);
  assert.match(result.stdoutText, /--busy/);
});
