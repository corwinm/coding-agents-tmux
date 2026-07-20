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

test("persistClaudeHookState treats Stop as idle even when the last message reads like a question", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-claude-state-"));
  const restoreEnv = setEnv({
    CODING_AGENTS_TMUX_CLAUDE_STATE_DIR: stateDir,
    TMUX_PANE: undefined,
  });

  try {
    for (const message of [
      "Would you like me to run the tests?",
      "Let me know if you want anything else.",
      "I finished the change. Should I proceed with the next step?",
    ]) {
      await persistClaudeHookState(
        JSON.stringify({
          hook_event_name: "Stop",
          cwd: "/tmp/claude-project",
          session_id: "claude-session",
          last_assistant_message: message,
        }),
      );

      const states = readClaudeStates();
      assert.equal(states[0]?.status, "idle");
      assert.equal(states[0]?.activity, "idle");
      assert.equal(states[0]?.detail, "Claude Code is idle between turns");
    }
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

test("live preview overrides a stale running hook state so idle panes read idle", async () => {
  const fakeTmux = installFakeTmux(`
if [ "$1" = "capture-pane" ]; then
  printf '  \xe2\x8e\xbf  Done reviewing the changes.\n'
  printf '\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\n'
  printf '\xe2\x9d\xaf \n'
  printf '\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\n'
  printf '  auto mode on (shift+tab to cycle) \xc2\xb7 \xe2\x86\x90 for agents\n'
  exit 0
fi
printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  const stateDir = createClaudeStateDir([
    {
      version: 1,
      target: "work:1.0",
      paneId: "%1",
      directory: "/tmp/claude-project",
      title: "Stale Session",
      status: "running",
      activity: "busy",
      sourceEventType: "PostToolBatch",
      updatedAt: Date.now() - 5 * 60_000,
    },
  ]);
  const restoreEnv = setEnv({
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    CODING_AGENTS_TMUX_CLAUDE_STATE_DIR: stateDir,
  });

  try {
    const summaries = await attachRuntimeToPanes([
      createDiscoveredClaudePane({
        target: "work:1.0",
        paneId: "%1",
        currentPath: "/tmp/claude-project",
      }),
    ]);

    assert.equal(summaries[0]?.runtime.status, "idle");
    assert.equal(summaries[0]?.runtime.activity, "idle");
    assert.equal(summaries[0]?.runtime.source, "claude-preview");
    // Session metadata is still enriched from the matched hook state.
    assert.equal(summaries[0]?.runtime.session?.title, "Stale Session");
  } finally {
    restoreEnv();
  }
});

test("live preview treats an open slash-command dialog as waiting", async () => {
  const fakeTmux = installFakeTmux(`
if [ "$1" = "capture-pane" ]; then
  printf '   Effort\n'
  printf '   low     medium     high     xhigh      max\n'
  printf '   \xe2\x86\x90/\xe2\x86\x92 to adjust \xc2\xb7 Enter to confirm \xc2\xb7 Esc to cancel\n'
  exit 0
fi
exit 1
`);
  const restoreEnv = setEnv({
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    CODING_AGENTS_TMUX_CLAUDE_STATE_DIR: mkdtempSync(
      join(tmpdir(), "coding-agents-tmux-empty-claude-state-"),
    ),
  });

  try {
    const summaries = await attachRuntimeToPanes([
      createDiscoveredClaudePane({
        target: "work:1.0",
        paneId: "%1",
        currentPath: "/tmp/claude-project",
      }),
    ]);

    assert.equal(summaries[0]?.runtime.status, "waiting-question");
    assert.equal(summaries[0]?.runtime.source, "claude-preview");
  } finally {
    restoreEnv();
  }
});

test("live preview reports running when Claude shows the interrupt footer", async () => {
  const fakeTmux = installFakeTmux(`
if [ "$1" = "capture-pane" ]; then
  printf '  auto mode on (shift+tab to cycle) \xc2\xb7 esc to interrupt \xc2\xb7 \xe2\x86\x90 for agents\n'
  exit 0
fi
exit 1
`);
  const restoreEnv = setEnv({
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    CODING_AGENTS_TMUX_CLAUDE_STATE_DIR: mkdtempSync(
      join(tmpdir(), "coding-agents-tmux-empty-claude-state-"),
    ),
  });

  try {
    const summaries = await attachRuntimeToPanes([
      createDiscoveredClaudePane({
        target: "work:1.0",
        paneId: "%1",
        currentPath: "/tmp/claude-project",
      }),
    ]);

    assert.equal(summaries[0]?.runtime.status, "running");
    assert.equal(summaries[0]?.runtime.activity, "busy");
    assert.equal(summaries[0]?.runtime.source, "claude-preview");
  } finally {
    restoreEnv();
  }
});

test("live preview reports busy while Claude waits on background agents", async () => {
  // Glyphs are written literally (not via printf \xHH escapes) so the bytes
  // reach the classifier as real UTF-8 — the leading spinner glyph must decode
  // correctly for the anchored background-agents matcher to strip it.
  const fakeTmux = installFakeTmux(`
if [ "$1" = "capture-pane" ]; then
  printf '%s\\n' '  on it and fork-dial — then I will run the full verification.'
  printf '%s\\n' '✻ Waiting for 2 background agents to finish'
  printf '%s\\n' '─────'
  printf '%s\\n' '❯ '
  printf '%s\\n' '─────'
  printf '%s\\n' '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents · ↓ to manage'
  printf '%s\\n' '  ◯ general-purpose  Build fork-ledger piece   20m 51s · 73.8k tokens'
  exit 0
fi
exit 1
`);
  const stateDir = createClaudeStateDir([
    {
      version: 1,
      target: "work:1.0",
      paneId: "%1",
      directory: "/tmp/claude-project",
      title: "Background Agents Session",
      status: "running",
      activity: "busy",
      sourceEventType: "PreToolUse",
      updatedAt: Date.now() - 5 * 60_000,
    },
  ]);
  const restoreEnv = setEnv({
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    CODING_AGENTS_TMUX_CLAUDE_STATE_DIR: stateDir,
  });

  try {
    const summaries = await attachRuntimeToPanes([
      createDiscoveredClaudePane({
        target: "work:1.0",
        paneId: "%1",
        currentPath: "/tmp/claude-project",
      }),
    ]);

    assert.equal(summaries[0]?.runtime.status, "running");
    assert.equal(summaries[0]?.runtime.activity, "busy");
    assert.equal(summaries[0]?.runtime.source, "claude-preview");
    assert.equal(summaries[0]?.runtime.detail, "Claude Code is waiting on background agents");
  } finally {
    restoreEnv();
  }
});

test("live preview reports busy with a large background-agent list past the tail window", async () => {
  // With many agents the status line renders well above the prompt while one
  // row per agent stacks below the footer, pushing "Waiting for N background
  // agents" outside the last dozen lines. The detector must scan the whole
  // captured buffer to still see it.
  const agentRows = Array.from(
    { length: 10 },
    (_unused, i) =>
      `  printf '%s\\n' '  ◯ general-purpose  Build concept ${i + 1}   ${i + 3}m 12s · ${i + 40}.1k tokens'`,
  ).join("\n");
  const fakeTmux = installFakeTmux(`
if [ "$1" = "capture-pane" ]; then
  printf '%s\\n' '  kicking off ten concept builds in parallel now.'
  printf '%s\\n' '✳ Waiting for 10 background agents to finish'
  printf '%s\\n' '─────'
  printf '%s\\n' '❯ '
  printf '%s\\n' '─────'
  printf '%s\\n' '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents · ↓ to manage'
  printf '%s\\n' '  ⏺ main'
${agentRows}
  exit 0
fi
exit 1
`);
  const restoreEnv = setEnv({
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    CODING_AGENTS_TMUX_CLAUDE_STATE_DIR: mkdtempSync(
      join(tmpdir(), "coding-agents-tmux-empty-claude-state-"),
    ),
  });

  try {
    const summaries = await attachRuntimeToPanes([
      createDiscoveredClaudePane({
        target: "work:1.0",
        paneId: "%1",
        currentPath: "/tmp/claude-project",
      }),
    ]);

    assert.equal(summaries[0]?.runtime.status, "running");
    assert.equal(summaries[0]?.runtime.activity, "busy");
    assert.equal(summaries[0]?.runtime.source, "claude-preview");
    assert.equal(summaries[0]?.runtime.detail, "Claude Code is waiting on background agents");
  } finally {
    restoreEnv();
  }
});

test("live preview stays idle when background-agents text only appears in prose", async () => {
  // The background-agents phrase appears only inside transcript prose — as a
  // mid-line quote, a line-leading quote, and a bulleted mention — but never as
  // a spinner-glyph status row, so the matcher must leave the pane idle.
  const fakeTmux = installFakeTmux(`
if [ "$1" = "capture-pane" ]; then
  printf '%s\\n' '❯ Why did it say "Waiting for 2 background agents to finish" earlier?'
  printf '%s\\n' '  "Waiting for 2 background agents to finish" was the old status line.'
  printf '%s\\n' '  - Waiting for 3 background agents to finish only shows while they run.'
  printf '%s\\n' '  ⎿  That was the spinner shown while your Task subagents ran.'
  printf '%s\\n' '─────'
  printf '%s\\n' '❯ '
  printf '%s\\n' '─────'
  printf '%s\\n' '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents'
  exit 0
fi
exit 1
`);
  const restoreEnv = setEnv({
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    CODING_AGENTS_TMUX_CLAUDE_STATE_DIR: mkdtempSync(
      join(tmpdir(), "coding-agents-tmux-empty-claude-state-"),
    ),
  });

  try {
    const summaries = await attachRuntimeToPanes([
      createDiscoveredClaudePane({
        target: "work:1.0",
        paneId: "%1",
        currentPath: "/tmp/claude-project",
      }),
    ]);

    assert.equal(summaries[0]?.runtime.status, "idle");
    assert.equal(summaries[0]?.runtime.activity, "idle");
    assert.equal(summaries[0]?.runtime.source, "claude-preview");
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
