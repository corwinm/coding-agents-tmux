import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildClaudeHooksTemplate,
  installClaudeIntegration,
  persistClaudeHookState,
  readClaudeStates,
  updateClaudeSettings,
} from "../src/core/claude.ts";
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
    paneTitle: overrides.paneTitle ?? "Claude Code",
    currentCommand: overrides.currentCommand ?? "claude",
    currentPath: overrides.currentPath ?? "/tmp/claude-project",
    isActive: overrides.isActive ?? false,
    tty: overrides.tty ?? "/dev/ttys001",
    target: overrides.target ?? `${sessionName}:${windowIndex}.${paneIndex}`,
  };
}

function createDiscoveredClaudePane(overrides: Partial<TmuxPane> = {}): DiscoveredPane {
  const pane = createPane(overrides);

  return {
    pane,
    detection: {
      agent: "claude",
      confidence: "medium",
      reasons: ["command:claude"],
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
  const dir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-claude-fake-tmux-"));
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

function createClaudeStateDir(states: Record<string, unknown>[]): string {
  const root = mkdtempSync(join(tmpdir(), "coding-agents-tmux-claude-state-"));

  states.forEach((state, index) => {
    writeFileSync(join(root, `state-${index + 1}.json`), JSON.stringify(state), "utf8");
  });

  return root;
}

test("buildClaudeHooksTemplate emits the managed Claude hook events", () => {
  const template = JSON.parse(
    buildClaudeHooksTemplate("/tmp/coding-agents-tmux/bin/coding-agents-tmux claude-hook-state"),
  ) as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };

  assert.deepEqual(Object.keys(template.hooks), [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "Elicitation",
    "ElicitationResult",
    "PostToolUse",
    "PostToolUseFailure",
    "PostToolBatch",
    "Stop",
    "SessionEnd",
  ]);
  assert.equal(
    template.hooks.Stop?.[0]?.hooks[0]?.command,
    "/tmp/coding-agents-tmux/bin/coding-agents-tmux claude-hook-state",
  );
});

test("updateClaudeSettings merges managed hooks without dropping unrelated settings", () => {
  const updated = JSON.parse(
    updateClaudeSettings(
      JSON.stringify({
        theme: "dark",
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: "/old/coding-agents-tmux claude-hook-state",
                  statusMessage: "Updating Claude tmux state",
                },
              ],
            },
            {
              hooks: [{ type: "command", command: "python3 ~/.claude/custom-stop.py" }],
            },
          ],
        },
      }),
      "/new/coding-agents-tmux claude-hook-state",
    ),
  ) as {
    theme: string;
    hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };

  assert.equal(updated.theme, "dark");
  assert.equal(updated.hooks.Stop?.[0]?.hooks[0]?.command, "python3 ~/.claude/custom-stop.py");
  assert.equal(
    updated.hooks.Stop?.[1]?.hooks[0]?.command,
    "/new/coding-agents-tmux claude-hook-state",
  );
  assert.ok(updated.hooks.SessionStart);
});

test("installClaudeIntegration writes settings.json under CLAUDE_HOME", () => {
  const claudeHome = mkdtempSync(join(tmpdir(), "coding-agents-tmux-claude-home-"));
  const restoreEnv = setEnv({ CLAUDE_HOME: claudeHome });

  try {
    const result = installClaudeIntegration(
      "/tmp/coding-agents-tmux/bin/coding-agents-tmux claude-hook-state",
    );
    const settings = readFileSync(result.settingsPath, "utf8");

    assert.match(result.settingsPath, /settings\.json$/);
    assert.match(settings, /claude-hook-state/);
    assert.match(settings, /SessionStart/);
  } finally {
    restoreEnv();
  }
});

test("persistClaudeHookState classifies AskUserQuestion and SessionEnd removes state", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-claude-state-"));
  const restoreEnv = setEnv({
    CODING_AGENTS_TMUX_CLAUDE_STATE_DIR: stateDir,
    TMUX_PANE: undefined,
  });

  try {
    await persistClaudeHookState(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd: "/tmp/claude-project",
        session_id: "claude-session",
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [
            {
              question: "Which framework?",
              options: [{ label: "React" }, { label: "Vue" }],
            },
          ],
        },
      }),
    );

    let states = readClaudeStates();
    assert.equal(states[0]?.status, "waiting-question");
    assert.equal(states[0]?.detail, "Claude Code is waiting for a multiple-choice response");

    await persistClaudeHookState(
      JSON.stringify({
        hook_event_name: "SessionEnd",
        cwd: "/tmp/claude-project",
        session_id: "claude-session",
      }),
    );

    states = readClaudeStates();
    assert.equal(states.length, 0);
  } finally {
    restoreEnv();
  }
});

test("Claude runtime matches panes by target, pane id, and unique cwd fallback", async () => {
  const stateDir = createClaudeStateDir([
    {
      target: "work:1.0",
      paneId: "%1",
      directory: "/tmp/claude-a",
      title: "Claude Session A",
      status: "running",
      activity: "busy",
      updatedAt: 100,
    },
    {
      paneId: "%9",
      directory: "/tmp/claude-b",
      title: "Claude Session B",
      status: "idle",
      activity: "idle",
      updatedAt: 200,
    },
    {
      directory: "/tmp/claude-c",
      title: "Claude Session C",
      status: "waiting-input",
      activity: "busy",
      updatedAt: 300,
    },
  ]);
  const restoreEnv = setEnv({ CODING_AGENTS_TMUX_CLAUDE_STATE_DIR: stateDir });

  try {
    const summaries = await attachRuntimeToPanes([
      createDiscoveredClaudePane({
        target: "work:1.0",
        paneId: "%1",
        currentPath: "/tmp/claude-a",
      }),
      createDiscoveredClaudePane({
        target: "work:1.1",
        paneId: "%9",
        currentPath: "/tmp/claude-b",
      }),
      createDiscoveredClaudePane({
        target: "work:1.2",
        paneId: "%3",
        currentPath: "/tmp/claude-c",
      }),
    ]);

    assert.equal(summaries[0]?.runtime.status, "running");
    assert.equal(summaries[0]?.runtime.source, "claude-hook");
    assert.equal(summaries[0]?.runtime.match.provider, "claude");

    assert.equal(summaries[1]?.runtime.status, "idle");
    assert.equal(summaries[1]?.runtime.source, "claude-hook");
    assert.equal(summaries[1]?.runtime.match.provider, "claude");

    assert.equal(summaries[2]?.runtime.status, "waiting-input");
    assert.equal(summaries[2]?.runtime.match.heuristic, true);
    assert.equal(summaries[2]?.runtime.session?.title, "Claude Session C");
  } finally {
    restoreEnv();
  }
});

test("Claude runtime falls back to preview and command classification", async () => {
  const fakeTmux = installFakeTmux(`
if [ "$1" = "capture-pane" ]; then
  printf 'What would you like me to do next?\n'
  printf '› 1. Apply the fix\n'
  printf '2. Explain the change first\n'
  exit 0
fi
printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  const restoreEnv = setEnv({
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    CODING_AGENTS_TMUX_CLAUDE_STATE_DIR: mkdtempSync(
      join(tmpdir(), "coding-agents-tmux-empty-claude-state-"),
    ),
  });

  try {
    const previewSummaries = await attachRuntimeToPanes([
      createDiscoveredClaudePane({
        target: "work:1.0",
        paneId: "%1",
        currentPath: "/tmp/claude-project",
      }),
    ]);

    assert.equal(previewSummaries[0]?.runtime.status, "waiting-question");
    assert.equal(previewSummaries[0]?.runtime.source, "claude-preview");
    assert.equal(previewSummaries[0]?.runtime.match.provider, "claude");
  } finally {
    restoreEnv();
  }

  const restoreEmptyEnv = setEnv({
    CODING_AGENTS_TMUX_CLAUDE_STATE_DIR: mkdtempSync(
      join(tmpdir(), "coding-agents-tmux-empty-claude-state-"),
    ),
  });

  try {
    const summaries = await attachRuntimeToPanes([
      createDiscoveredClaudePane({ currentCommand: "claude", currentPath: "/tmp/claude-project" }),
    ]);

    assert.equal(summaries[0]?.runtime.status, "running");
    assert.equal(summaries[0]?.runtime.source, "claude-command");
    assert.equal(summaries[0]?.runtime.match.provider, "claude");
    assert.match(summaries[0]?.runtime.detail ?? "", /detected claude process in tmux pane/);
  } finally {
    restoreEmptyEnv();
  }
});
