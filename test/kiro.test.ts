import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { attachRuntimeToPanes } from "../src/core/runtime.ts";
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
    paneTitle: overrides.paneTitle ?? "Kiro CLI",
    currentCommand: overrides.currentCommand ?? "kiro-cli",
    currentPath: overrides.currentPath ?? "/tmp/kiro-project",
    isActive: overrides.isActive ?? false,
    tty: overrides.tty ?? "/dev/ttys001",
    target: overrides.target ?? `${sessionName}:${windowIndex}.${paneIndex}`,
  };
}

function createDiscoveredKiroPane(overrides: Partial<TmuxPane> = {}): DiscoveredPane {
  const pane = createPane(overrides);

  return {
    pane,
    detection: {
      agent: "kiro",
      confidence: "medium",
      reasons: ["command:kiro"],
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

function installFakeTmux(script: string): { pathEntry: string } {
  const dir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-kiro-fake-tmux-"));
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

test("Kiro preview fallback detects waiting state", async () => {
  const fakeTmux = installFakeTmux(`
if [ "$1" = "capture-pane" ]; then
  printf 'Kiro wants to run a shell command.\n'
  printf 'Allow this command?\n'
  printf '1. Yes\n'
  printf '2. No\n'
  exit 0
fi
exit 1
`);
  const restoreEnv = setEnv({
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
  });

  try {
    const summaries = await attachRuntimeToPanes([
      createDiscoveredKiroPane({ target: "work:1.0", currentPath: "/tmp/kiro-project" }),
    ]);

    assert.equal(summaries[0]?.runtime.source, "kiro-preview");
    assert.equal(summaries[0]?.runtime.status, "waiting-question");
    assert.equal(summaries[0]?.runtime.session?.title, "kiro-project");
    assert.equal(summaries[0]?.runtime.session?.directory, "/tmp/kiro-project");
  } finally {
    restoreEnv();
  }
});

test("Kiro command fallback marks unmatched panes as idle", async () => {
  const summaries = await attachRuntimeToPanes([
    createDiscoveredKiroPane({ currentCommand: "kiro-cli-chat", currentPath: "/tmp/kiro-project" }),
  ]);

  assert.equal(summaries[0]?.runtime.source, "kiro-command");
  assert.equal(summaries[0]?.runtime.status, "idle");
  assert.equal(summaries[0]?.runtime.activity, "idle");
  assert.equal(summaries[0]?.runtime.match.provider, "kiro");
  assert.equal(summaries[0]?.runtime.session?.id, "kiro:work:1.0");
  assert.equal(summaries[0]?.runtime.session?.title, "kiro-project");
  assert.equal(summaries[0]?.runtime.session?.directory, "/tmp/kiro-project");
  assert.match(summaries[0]?.runtime.detail ?? "", /assuming idle/);
});
