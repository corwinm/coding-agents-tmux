import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { attachRuntimeToPanes } from "../src/core/opencode.ts";
import type { DiscoveredPane, TmuxPane } from "../src/types.ts";

function createPane(overrides: Partial<TmuxPane> = {}): TmuxPane {
  const sessionName = overrides.sessionName ?? "work";
  const windowIndex = overrides.windowIndex ?? 1;
  const paneIndex = overrides.paneIndex ?? 0;

  return {
    sessionName,
    windowIndex,
    paneIndex,
    paneId: overrides.paneId ?? `%${paneIndex + 1}`,
    paneTitle: overrides.paneTitle ?? "π - project",
    currentCommand: overrides.currentCommand ?? "pi",
    currentPath: overrides.currentPath ?? "/tmp/pi-project",
    isActive: overrides.isActive ?? false,
    tty: overrides.tty ?? "/dev/ttys001",
    target: overrides.target ?? `${sessionName}:${windowIndex}.${paneIndex}`,
  };
}

function createDiscoveredPiPane(overrides: Partial<TmuxPane> = {}): DiscoveredPane {
  const pane = createPane(overrides);

  return {
    pane,
    detection: {
      agent: "pi",
      confidence: "medium",
      reasons: ["command:pi"],
    },
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

function createPiStateDir(states: Record<string, unknown>[]): string {
  const root = mkdtempSync(join(tmpdir(), "opencode-tmux-pi-state-"));

  states.forEach((state, index) => {
    writeFileSync(join(root, `state-${index + 1}.json`), JSON.stringify(state), "utf8");
  });

  return root;
}

function installFakeTmux(script: string): { pathEntry: string } {
  const dir = mkdtempSync(join(tmpdir(), "opencode-tmux-pi-fake-tmux-"));
  const tmuxPath = join(dir, "tmux");

  writeFileSync(
    tmuxPath,
    `#!/usr/bin/env bash
set -euo pipefail
${script}
`,
    "utf8",
  );
  chmodSync(tmuxPath, 0o755);

  return { pathEntry: dir };
}

test("Pi runtime matches panes by target, pane id, and unique cwd fallback", async () => {
  const stateDir = createPiStateDir([
    {
      target: "work:1.0",
      paneId: "%1",
      directory: "/tmp/pi-a",
      title: "Pi Session A",
      status: "running",
      activity: "busy",
      updatedAt: 100,
    },
    {
      paneId: "%9",
      directory: "/tmp/pi-b",
      title: "Pi Session B",
      status: "idle",
      activity: "idle",
      updatedAt: 200,
    },
    {
      directory: "/tmp/pi-c",
      title: "Pi Session C",
      status: "waiting-input",
      activity: "busy",
      updatedAt: 300,
    },
  ]);
  const restoreEnv = setEnv({ OPENCODE_TMUX_PI_STATE_DIR: stateDir });

  try {
    const summaries = await attachRuntimeToPanes([
      createDiscoveredPiPane({ target: "work:1.0", paneId: "%1", currentPath: "/tmp/pi-a" }),
      createDiscoveredPiPane({ target: "work:1.1", paneId: "%9", currentPath: "/tmp/pi-b" }),
      createDiscoveredPiPane({ target: "work:1.2", paneId: "%3", currentPath: "/tmp/pi-c" }),
    ]);

    assert.equal(summaries[0]?.runtime.status, "running");
    assert.equal(summaries[0]?.runtime.source, "pi-extension");
    assert.equal(summaries[0]?.runtime.match.provider, "pi");

    assert.equal(summaries[1]?.runtime.status, "idle");
    assert.equal(summaries[1]?.runtime.source, "pi-extension");
    assert.equal(summaries[1]?.runtime.match.provider, "pi");

    assert.equal(summaries[2]?.runtime.status, "waiting-input");
    assert.equal(summaries[2]?.runtime.source, "pi-extension");
    assert.equal(summaries[2]?.runtime.match.heuristic, true);
    assert.equal(summaries[2]?.runtime.session?.title, "Pi Session C");
  } finally {
    restoreEnv();
  }
});

test("Pi runtime uses preview classification when no extension state matches", async () => {
  const fakeTmux = installFakeTmux(`
if [ "$1" = "capture-pane" ]; then
  printf 'Pi is ready to continue your task.\n'
  printf 'Would you like me to apply the patch now?\n'
  exit 0
fi
printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  const stateDir = createPiStateDir([]);
  const restoreEnv = setEnv({
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    OPENCODE_TMUX_PI_STATE_DIR: stateDir,
  });

  try {
    const summaries = await attachRuntimeToPanes([createDiscoveredPiPane()], { provider: "auto" });

    assert.equal(summaries[0]?.runtime.status, "waiting-input");
    assert.equal(summaries[0]?.runtime.activity, "busy");
    assert.equal(summaries[0]?.runtime.source, "pi-preview");
    assert.equal(summaries[0]?.runtime.match.provider, "pi");
  } finally {
    restoreEnv();
  }
});

test("Pi runtime falls back to coarse command detection when preview is inconclusive", async () => {
  const fakeTmux = installFakeTmux(`
if [ "$1" = "capture-pane" ]; then
  printf 'recent output without an obvious prompt\n'
  printf 'tool finished successfully\n'
  exit 0
fi
printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  const stateDir = createPiStateDir([]);
  const restoreEnv = setEnv({
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    OPENCODE_TMUX_PI_STATE_DIR: stateDir,
  });

  try {
    const summaries = await attachRuntimeToPanes([createDiscoveredPiPane()], { provider: "auto" });

    assert.equal(summaries[0]?.runtime.status, "running");
    assert.equal(summaries[0]?.runtime.activity, "busy");
    assert.equal(summaries[0]?.runtime.source, "pi-command");
    assert.equal(summaries[0]?.runtime.match.provider, "pi");
    assert.match(summaries[0]?.runtime.detail ?? "", /detected pi process in tmux pane/);
  } finally {
    restoreEnv();
  }
});
