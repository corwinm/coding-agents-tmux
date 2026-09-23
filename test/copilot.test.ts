import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { filterPaneSummaries } from "../src/cli.ts";
import { renderPaneTable, renderStatusSummary, renderSwitchChoices } from "../src/cli/render.ts";
import { attachRuntimeToPanes } from "../src/core/runtime.ts";
import { detectAgentPane, discoverAgentPanesFromList } from "../src/core/tmux.ts";
import { runCommand } from "../src/runtime.ts";
import type { TmuxPane } from "../src/types.ts";

function pane(command: string, title = "shell", paneIndex = 0): TmuxPane {
  return {
    sessionName: "work",
    windowIndex: 1,
    paneIndex,
    paneId: `%${paneIndex + 1}`,
    paneTitle: title,
    currentCommand: command,
    currentPath: "/home/user/project",
    isActive: paneIndex === 0,
    tty: `/dev/ttys00${paneIndex}`,
    target: `work:1.${paneIndex}`,
  };
}

test("Copilot discovery requires the exact CLI command, not text or similarly named binaries", () => {
  for (const command of ["copilot", "copilot.exe"]) {
    assert.deepEqual(detectAgentPane(pane(command)), {
      agent: "copilot",
      confidence: "medium",
      reasons: ["command:copilot"],
    });
  }
  for (const command of ["copilot-helper", "copilot-agent", "mycopilot", "bash", "node"]) {
    assert.equal(detectAgentPane(pane(command, "GitHub Copilot CLI")).agent, null);
  }
  assert.equal(detectAgentPane(pane("bash", "copilot")).agent, null);
  assert.equal(detectAgentPane(pane("copilot-helper", "shell", 1)).agent, null);
  assert.deepEqual(detectAgentPane(pane("copilot", "Codex")), {
    agent: "copilot",
    confidence: "medium",
    reasons: ["command:copilot"],
  });
});

test("Copilot has a pane session and unknown coarse state in mixed-agent views", async () => {
  const discovered = discoverAgentPanesFromList([
    pane("copilot"),
    pane("codex", "Codex", 1),
    pane("bash", "notes about copilot", 2),
  ]);
  const summaries = await attachRuntimeToPanes(discovered);
  assert.deepEqual(
    summaries.map((entry) => entry.detection.agent),
    ["copilot", "codex"],
  );
  const copilot = summaries[0]!;
  assert.equal(copilot.runtime.session?.id, "copilot:work:1.0");
  assert.equal(copilot.runtime.session?.directory, "/home/user/project");
  assert.equal(copilot.runtime.status, "unknown");
  assert.equal(copilot.runtime.activity, "unknown");
  assert.equal(copilot.runtime.source, "copilot-command");
  assert.equal(copilot.runtime.match.provider, "copilot");
  assert.deepEqual(filterPaneSummaries(summaries, { agent: "copilot" }), [copilot]);
  assert.ok(!filterPaneSummaries(summaries, { waiting: true }).includes(copilot));
  assert.match(renderPaneTable(summaries), /copilot/);
  assert.match(renderSwitchChoices(summaries), /copilot/);
  assert.match(renderStatusSummary(null, summaries), //);
});

test("CLI list, status and inspect recognize Copilot without configuration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-copilot-"));
  const tmux = join(dir, "tmux");
  writeFileSync(
    tmux,
    `#!/bin/sh
if [ "$1" = "list-panes" ]; then
  printf 'work\\t1\\t0\\t%%1\\tshell\\tcopilot\\t/home/user/project\\t1\\t/dev/ttys000\\n'
  printf 'work\\t1\\t1\\t%%2\\tshell\\tbash\\t/home/user/copilot-notes\\t0\\t/dev/ttys001\\n'
  printf 'work\\t1\\t2\\t%%3\\tCodex\\tcodex\\t/home/user/codex\\t0\\t/dev/ttys002\\n'
  exit 0
fi
exit 1
`,
  );
  chmodSync(tmux, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}:${previousPath ?? ""}`;
  try {
    const bin = join(import.meta.dirname, "..", "bin", "coding-agents-tmux");
    const list = await runCommand([bin, "list", "--json", "--agent", "copilot"]);
    assert.equal(list.exitCode, 0, list.stderrText);
    const entries = JSON.parse(list.stdoutText);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].detection.agent, "copilot");
    assert.equal(entries[0].runtime.status, "unknown");
    const status = await runCommand([bin, "status", "--summary", "--json", "--agent", "copilot"]);
    assert.equal(status.exitCode, 0, status.stderrText);
    assert.equal(JSON.parse(status.stdoutText).unknown, 1);
    assert.equal(JSON.parse(status.stdoutText).total, 1);
    const inspect = await runCommand([bin, "inspect", "work:1.0"]);
    assert.equal(inspect.exitCode, 0, inspect.stderrText);
    assert.match(inspect.stdoutText, /Signals: command:copilot/);
    assert.match(inspect.stdoutText, /Status: unknown/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});
