import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  capturePanePreview,
  captureWindowPreview,
  buildSwitchToPaneCommand,
  detectAgentPane,
  discoverAgentPanesFromList,
  getCurrentTmuxTarget,
  listAllPanes,
  normalizeCapturedPaneLines,
  parseListAllPanesOutput,
  parsePaneLine,
  switchToPane,
} from "../src/core/tmux.ts";
import type { TmuxPane } from "../src/types.ts";

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
  const dir = mkdtempSync(join(tmpdir(), "opencode-tmux-fake-tmux-"));
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

test("detectAgentPane recognizes OpenCode, Codex, Pi, and no-signal panes", () => {
  assert.deepEqual(
    detectAgentPane(createPane({ paneTitle: "OC | reviewing", currentCommand: "bash" })),
    {
      agent: "opencode",
      confidence: "high",
      reasons: ["title:OC prefix"],
    },
  );

  assert.deepEqual(
    detectAgentPane(
      createPane({
        paneTitle: "shell",
        currentCommand: "opencode",
        currentPath: "/tmp/opencode-scratch",
      }),
    ),
    {
      agent: "opencode",
      confidence: "medium",
      reasons: ["command:opencode", "path:opencode-like"],
    },
  );

  assert.deepEqual(
    detectAgentPane(
      createPane({ paneTitle: "shell", currentCommand: "codex-aarch64-apple-darwin" }),
    ),
    {
      agent: "codex",
      confidence: "medium",
      reasons: ["command:codex"],
    },
  );

  assert.deepEqual(detectAgentPane(createPane({ paneTitle: "π - work", currentCommand: "pi" })), {
    agent: "pi",
    confidence: "high",
    reasons: ["title:Pi", "command:pi"],
  });

  assert.deepEqual(
    detectAgentPane(
      createPane({ paneTitle: "shell", currentCommand: "bash", currentPath: "/tmp/project" }),
    ),
    {
      agent: null,
      confidence: "low",
      reasons: [],
    },
  );
});

test("parsePaneLine and parseListAllPanesOutput parse tmux rows and reject malformed output", () => {
  const line = [
    "work",
    "12",
    "3",
    "%9",
    "OpenCode",
    "opencode",
    "/tmp/project",
    "1",
    "/dev/ttys009",
  ].join("\t");

  assert.deepEqual(parsePaneLine(line), {
    sessionName: "work",
    windowIndex: 12,
    paneIndex: 3,
    paneId: "%9",
    paneTitle: "OpenCode",
    currentCommand: "opencode",
    currentPath: "/tmp/project",
    isActive: true,
    tty: "/dev/ttys009",
    target: "work:12.3",
  });

  assert.deepEqual(parseListAllPanesOutput(`${line}\n${line}\n`).length, 2);
  assert.throws(() => parsePaneLine("too\tfew\tfields"), /Unexpected tmux output/);
});

test("discoverAgentPanesFromList filters non-agent panes and sorts targets", () => {
  const panes = [
    createPane({ target: "work:2.1", windowIndex: 2, paneIndex: 1 }),
    createPane({
      target: "work:1.0",
      currentCommand: "bash",
      paneTitle: "shell",
      currentPath: "/tmp/project",
    }),
    createPane({
      target: "work:1.1",
      paneIndex: 1,
      paneTitle: "shell",
      currentCommand: "codex",
    }),
    createPane({
      target: "work:1.2",
      paneIndex: 2,
      paneTitle: "π - project",
      currentCommand: "pi",
      currentPath: "/tmp/pi-project",
    }),
    createPane({ target: "work:1.3", paneIndex: 3 }),
  ];

  assert.deepEqual(
    discoverAgentPanesFromList(panes).map((entry) => entry.pane.target),
    ["work:1.1", "work:1.2", "work:1.3", "work:2.1"],
  );
});

test("normalizeCapturedPaneLines strips ANSI escapes, expands tabs, and preserves internal blanks", () => {
  const raw = ["plain\ttext", "\u001b[31mred\u001b[0m", "", "   ", "tail", ""].join("\n");

  assert.deepEqual(normalizeCapturedPaneLines(raw), ["plain    text", "red", "", "", "tail"]);
});

test("buildSwitchToPaneCommand targets the pane correctly inside and outside tmux", () => {
  const pane = createPane({
    sessionName: "work",
    windowIndex: 4,
    paneIndex: 2,
    target: "work:4.2",
  });

  assert.deepEqual(buildSwitchToPaneCommand(pane, true), [
    "tmux",
    "switch-client",
    "-t",
    "work",
    ";",
    "select-window",
    "-t",
    "work:4",
    ";",
    "select-pane",
    "-t",
    "work:4.2",
  ]);
  assert.deepEqual(buildSwitchToPaneCommand(pane, false), [
    "tmux",
    "attach-session",
    "-t",
    "work",
    ";",
    "select-window",
    "-t",
    "work:4",
    ";",
    "select-pane",
    "-t",
    "work:4.2",
  ]);
});

test("listAllPanes and getCurrentTmuxTarget call tmux and parse their output", async () => {
  const fakeTmux = installFakeTmux(`
if [ "$1" = "list-panes" ] && [ "$2" = "-a" ]; then
  printf 'work\t1\t0\t%%1\tOpenCode\topencode\t/tmp/project\t1\t/dev/ttys001\n'
  exit 0
fi
if [ "$1" = "display-message" ]; then
  printf 'work:1.0\n'
  exit 0
fi
printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  const restoreEnv = setEnv({ PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}` });

  try {
    const panes = await listAllPanes();

    assert.equal(panes.length, 1);
    assert.equal(panes[0]?.target, "work:1.0");
    assert.equal(await getCurrentTmuxTarget(), "work:1.0");
  } finally {
    restoreEnv();
  }
});

test("capturePanePreview and captureWindowPreview normalize tmux capture output", async () => {
  const fakeTmux = installFakeTmux(`
if [ "$1" = "capture-pane" ]; then
  printf 'line\tone\n\\033[31mred\\033[0m\n\n'
  exit 0
fi
if [ "$1" = "list-panes" ] && [ "$2" = "-t" ]; then
  printf 'work\t1\t0\t1\t0\t0\t20\t2\tOpenCode\n'
  printf 'work\t1\t1\t0\t20\t0\t20\t2\tShell\n'
  exit 0
fi
printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  const restoreEnv = setEnv({ PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}` });

  try {
    assert.deepEqual(await capturePanePreview("work:1.0", 4), ["line    one", "red", ""]);

    const snapshot = await captureWindowPreview("work:1.0");
    assert.equal(snapshot.sessionName, "work");
    assert.equal(snapshot.width, 40);
    assert.equal(snapshot.height, 2);
    assert.equal(snapshot.panes.length, 2);
    assert.deepEqual(snapshot.panes[0]?.lines, ["line    one", "red", ""]);
  } finally {
    restoreEnv();
  }
});

test("switchToPane forwards tmux failures and uses the expected command shape", async () => {
  const fakeTmux = installFakeTmux(`
printf '%s\n' "$*" >> '__LOG_PATH__'
printf 'switch failed\n' >&2
exit 1
`);
  const restoreEnv = setEnv({
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    TMUX: "1",
  });

  try {
    await assert.rejects(
      switchToPane(createPane({ target: "work:4.2", windowIndex: 4, paneIndex: 2 })),
      /switch failed/,
    );

    const log = readFileSync(fakeTmux.logPath, "utf8");
    assert.match(log, /switch-client -t work ; select-window -t work:4 ; select-pane -t work:4\.2/);
  } finally {
    restoreEnv();
  }
});

test("switchToPane falls back to attach-session when tmux has no current client", async () => {
  const fakeTmux = installFakeTmux(`
printf '%s\n' "$*" >> '__LOG_PATH__'
if [ "$1" = "switch-client" ]; then
  printf 'no current client\n' >&2
  exit 1
fi
if [ "$1" = "attach-session" ]; then
  exit 0
fi
printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  const restoreEnv = setEnv({
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    TMUX: "1",
  });

  try {
    await switchToPane(createPane({ target: "work:4.2", windowIndex: 4, paneIndex: 2 }));

    const log = readFileSync(fakeTmux.logPath, "utf8");
    assert.match(log, /switch-client -t work ; select-window -t work:4 ; select-pane -t work:4\.2/);
    assert.match(
      log,
      /attach-session -t work ; select-window -t work:4 ; select-pane -t work:4\.2/,
    );
  } finally {
    restoreEnv();
  }
});

test("tmux helpers surface subprocess failures with stderr context", async () => {
  const fakeTmux = installFakeTmux(`
printf 'tmux failed: %s\n' "$1" >&2
exit 1
`);
  const restoreEnv = setEnv({ PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}` });

  try {
    await assert.rejects(listAllPanes(), /tmux failed: list-panes/);
    await assert.rejects(getCurrentTmuxTarget(), /tmux failed: display-message/);
    await assert.rejects(capturePanePreview("work:1.0"), /tmux failed: capture-pane/);
  } finally {
    restoreEnv();
  }
});
