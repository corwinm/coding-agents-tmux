import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildCodexHooksTemplate,
  installCodexIntegration,
  persistCodexHookState,
  readCodexStates,
  updateCodexConfig,
  updateCodexHooks,
} from "../src/core/codex.ts";
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
    paneTitle: overrides.paneTitle ?? "shell",
    currentCommand: overrides.currentCommand ?? "codex",
    currentPath: overrides.currentPath ?? "/tmp/codex-project",
    isActive: overrides.isActive ?? false,
    tty: overrides.tty ?? "/dev/ttys001",
    target: overrides.target ?? `${sessionName}:${windowIndex}.${paneIndex}`,
  };
}

function createDiscoveredCodexPane(overrides: Partial<TmuxPane> = {}): DiscoveredPane {
  const pane = createPane(overrides);

  return {
    pane,
    detection: {
      agent: "codex",
      confidence: "medium",
      reasons: ["command:codex"],
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
  const dir = mkdtempSync(join(tmpdir(), "opencode-tmux-fake-tmux-"));
  const scriptPath = join(dir, "tmux");

  writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash
set -eu
${script}
`,
  );
  chmodSync(scriptPath, 0o755);

  return { pathEntry: dir };
}

test("buildCodexHooksTemplate emits all hook events with the ingest command", () => {
  const template = JSON.parse(
    buildCodexHooksTemplate("/tmp/opencode-tmux/bin/opencode-tmux codex-hook-state"),
  ) as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };

  assert.deepEqual(Object.keys(template.hooks), [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
  ]);
  assert.equal(
    template.hooks.Stop?.[0]?.hooks[0]?.command,
    "/tmp/opencode-tmux/bin/opencode-tmux codex-hook-state",
  );
});

test("persistCodexHookState classifies multiple-choice prompts as waiting-question", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "opencode-tmux-codex-state-"));
  const restoreEnv = setEnv({
    OPENCODE_TMUX_CODEX_STATE_DIR: stateDir,
    TMUX_PANE: undefined,
  });

  try {
    await persistCodexHookState(
      JSON.stringify({
        hook_event_name: "Stop",
        cwd: "/tmp/codex-project",
        session_id: "codex-session",
        last_assistant_message:
          "Would you like me to continue?\n1. Yes, apply the fix\n2. No, explain first",
      }),
    );

    const states = readCodexStates();

    assert.equal(states[0]?.status, "waiting-question");
    assert.equal(states[0]?.detail, "Codex is waiting for a multiple-choice response");
  } finally {
    restoreEnv();
  }
});

test("updateCodexConfig enables hooks in existing or empty config files", () => {
  assert.equal(updateCodexConfig(""), "[features]\ncodex_hooks = true\n");
  assert.equal(
    updateCodexConfig(
      '[features]\nanalytics = true\ncodex_hooks = false\n[profiles.work]\nmodel = "gpt-5"\n',
    ),
    '[features]\nanalytics = true\ncodex_hooks = true\n[profiles.work]\nmodel = "gpt-5"\n',
  );
  assert.equal(
    updateCodexConfig('model = "gpt-5"\n'),
    'model = "gpt-5"\n\n[features]\ncodex_hooks = true\n',
  );
});

test("updateCodexHooks merges managed hooks without dropping existing user hooks", () => {
  const updated = JSON.parse(
    updateCodexHooks(
      JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                hooks: [
                  {
                    type: "command",
                    command: "/old/opencode-tmux codex-hook-state",
                    statusMessage: "Updating Codex tmux state",
                  },
                ],
              },
              {
                hooks: [{ type: "command", command: "python3 ~/.codex/custom-stop.py" }],
              },
            ],
          },
        },
        null,
        2,
      ),
      "/new/opencode-tmux codex-hook-state",
    ),
  ) as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };

  assert.equal(updated.hooks.Stop?.length, 2);
  assert.equal(updated.hooks.Stop?.[0]?.hooks[0]?.command, "python3 ~/.codex/custom-stop.py");
  assert.equal(updated.hooks.Stop?.[1]?.hooks[0]?.command, "/new/opencode-tmux codex-hook-state");
  assert.deepEqual(Object.keys(updated.hooks), [
    "Stop",
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
  ]);
});

test("installCodexIntegration writes config.toml and hooks.json under CODEX_HOME", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "opencode-tmux-codex-home-"));
  const restoreEnv = setEnv({ CODEX_HOME: codexHome });

  try {
    const result = installCodexIntegration("/tmp/opencode-tmux/bin/opencode-tmux codex-hook-state");
    const config = readFileSync(result.configPath, "utf8");
    const hooks = readFileSync(result.hooksPath, "utf8");

    assert.match(config, /\[features\]/);
    assert.match(config, /codex_hooks = true/);
    assert.match(hooks, /SessionStart/);
    assert.match(hooks, /codex-hook-state/);
  } finally {
    restoreEnv();
  }
});

test("fresh Codex panes infer a new idle state from the visible Codex TUI", async () => {
  const fakeTmux = installFakeTmux(`
if [ "$1" = "capture-pane" ]; then
  printf '╭──────────────────────────────────────────────╮\n'
  printf '│ >_ OpenAI Codex (v0.117.0)                   │\n'
  printf '│ model:     gpt-5.4 medium   /model to change │\n'
  printf '╰──────────────────────────────────────────────╯\n'
  printf '\n'
  printf '› Find and fix a bug in @filename\n'
  exit 0
fi
printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  const stateDir = mkdtempSync(join(tmpdir(), "opencode-tmux-codex-state-"));
  const restoreEnv = setEnv({
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    OPENCODE_TMUX_CODEX_STATE_DIR: stateDir,
  });

  try {
    const summaries = await attachRuntimeToPanes([createDiscoveredCodexPane()], {
      provider: "auto",
    });

    assert.equal(summaries[0]?.runtime.status, "new");
    assert.equal(summaries[0]?.runtime.activity, "idle");
    assert.equal(summaries[0]?.runtime.source, "codex-preview");
    assert.equal(summaries[0]?.runtime.match.heuristic, true);
    assert.equal(summaries[0]?.runtime.detail, "Codex is ready for a new prompt");
  } finally {
    restoreEnv();
  }
});

test("Codex preview classifies visible numbered choices as waiting-question", async () => {
  const fakeTmux = installFakeTmux(`
if [ "$1" = "capture-pane" ]; then
  printf '╭──────────────────────────────────────────────╮\n'
  printf '│ >_ OpenAI Codex (v0.117.0)                   │\n'
  printf '│ model:     gpt-5.4 medium   /model to change │\n'
  printf '╰──────────────────────────────────────────────╯\n'
  printf '\n'
  printf 'Would you like me to continue?\n'
  printf '1. Yes, apply the fix\n'
  printf '2. No, explain first\n'
  exit 0
fi
printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  const stateDir = mkdtempSync(join(tmpdir(), "opencode-tmux-codex-state-"));
  const restoreEnv = setEnv({
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    OPENCODE_TMUX_CODEX_STATE_DIR: stateDir,
  });

  try {
    const summaries = await attachRuntimeToPanes([createDiscoveredCodexPane()], {
      provider: "auto",
    });

    assert.equal(summaries[0]?.runtime.status, "waiting-question");
    assert.equal(summaries[0]?.runtime.activity, "busy");
    assert.equal(summaries[0]?.runtime.source, "codex-preview");
    assert.equal(summaries[0]?.runtime.detail, "Codex is waiting for a multiple-choice response");
  } finally {
    restoreEnv();
  }
});

test("Codex preview classifies plan-mode question UI even when the Codex header is out of view", async () => {
  const fakeTmux = installFakeTmux(`
if [ "$1" = "capture-pane" ]; then
  printf 'Question 1/1 (1 unanswered)\n'
  printf 'What would you like to work on next?\n'
  printf '› 1. Repo change\n'
  printf '2. Code review\n'
  printf '3. Question only\n'
  printf 'tab to add notes | enter to submit answer | esc to interrupt\n'
  exit 0
fi
printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  const stateDir = mkdtempSync(join(tmpdir(), "opencode-tmux-codex-state-"));
  writeFileSync(
    join(stateDir, "pane.json"),
    JSON.stringify({
      version: 1,
      paneId: "%1",
      target: "work:1.0",
      directory: "/tmp/codex-project",
      title: "codex-project",
      activity: "busy",
      status: "running",
      detail: "Codex is handling a user prompt",
      updatedAt: 123,
      sourceEventType: "UserPromptSubmit",
      sessionId: "codex-session",
    }),
  );
  const restoreEnv = setEnv({
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    OPENCODE_TMUX_CODEX_STATE_DIR: stateDir,
  });

  try {
    const summaries = await attachRuntimeToPanes([createDiscoveredCodexPane()], {
      provider: "auto",
    });

    assert.equal(summaries[0]?.runtime.status, "waiting-question");
    assert.equal(summaries[0]?.runtime.source, "codex-preview");
  } finally {
    restoreEnv();
  }
});

test("Codex preview overrides stale running hook state when a question is visibly pending", async () => {
  const fakeTmux = installFakeTmux(`
if [ "$1" = "capture-pane" ]; then
  printf '╭──────────────────────────────────────────────╮\n'
  printf '│ >_ OpenAI Codex (v0.117.0)                   │\n'
  printf '│ model:     gpt-5.4 medium   /model to change │\n'
  printf '╰──────────────────────────────────────────────╯\n'
  printf '\n'
  printf 'What would you like to work on next?\n'
  printf '1. Repo change\n'
  printf '2. Code review\n'
  printf '3. Question only\n'
  exit 0
fi
printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  const stateDir = mkdtempSync(join(tmpdir(), "opencode-tmux-codex-state-"));
  writeFileSync(
    join(stateDir, "pane.json"),
    JSON.stringify({
      version: 1,
      paneId: "%1",
      target: "work:1.0",
      directory: "/tmp/codex-project",
      title: "codex-project",
      activity: "busy",
      status: "running",
      detail: "Codex is handling a user prompt",
      updatedAt: 123,
      sourceEventType: "UserPromptSubmit",
      sessionId: "codex-session",
    }),
  );
  const restoreEnv = setEnv({
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    OPENCODE_TMUX_CODEX_STATE_DIR: stateDir,
  });

  try {
    const summaries = await attachRuntimeToPanes([createDiscoveredCodexPane()], {
      provider: "auto",
    });

    assert.equal(summaries[0]?.runtime.status, "waiting-question");
    assert.equal(summaries[0]?.runtime.activity, "busy");
    assert.equal(summaries[0]?.runtime.source, "codex-preview");
    assert.equal(summaries[0]?.runtime.detail, "Codex is waiting for a multiple-choice response");
  } finally {
    restoreEnv();
  }
});

test("Codex preview overrides stale waiting hook state when the pane is back at a prompt", async () => {
  const fakeTmux = installFakeTmux(`
if [ "$1" = "capture-pane" ]; then
  printf '╭──────────────────────────────────────────────╮\n'
  printf '│ >_ OpenAI Codex (v0.117.0)                   │\n'
  printf '│ model:     gpt-5.4 medium   /model to change │\n'
  printf '╰──────────────────────────────────────────────╯\n'
  printf '\n'
  printf '› Find and fix a bug in @filename\n'
  printf '\n'
  printf '  gpt-5.4 medium · 97%% left · ~/Documents/GitHub/.dotfiles         Plan mode\n'
  exit 0
fi
printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  const stateDir = mkdtempSync(join(tmpdir(), "opencode-tmux-codex-state-"));
  writeFileSync(
    join(stateDir, "pane.json"),
    JSON.stringify({
      version: 1,
      paneId: "%1",
      target: "work:1.0",
      directory: "/tmp/codex-project",
      title: "codex-project",
      activity: "busy",
      status: "waiting-input",
      detail: "Codex is waiting for user input",
      updatedAt: 123,
      sourceEventType: "Stop",
      sessionId: "codex-session",
    }),
  );
  const restoreEnv = setEnv({
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    OPENCODE_TMUX_CODEX_STATE_DIR: stateDir,
  });

  try {
    const summaries = await attachRuntimeToPanes([createDiscoveredCodexPane()], {
      provider: "auto",
    });

    assert.equal(summaries[0]?.runtime.status, "new");
    assert.equal(summaries[0]?.runtime.activity, "idle");
    assert.equal(summaries[0]?.runtime.source, "codex-preview");
    assert.equal(summaries[0]?.runtime.detail, "Codex is ready for a new prompt");
  } finally {
    restoreEnv();
  }
});

test("recent Codex busy hook state stays running briefly even if the prompt is visible", async () => {
  const fakeTmux = installFakeTmux(`
if [ "$1" = "capture-pane" ]; then
  printf '╭──────────────────────────────────────────────╮\n'
  printf '│ >_ OpenAI Codex (v0.117.0)                   │\n'
  printf '│ model:     gpt-5.4 medium   /model to change │\n'
  printf '╰──────────────────────────────────────────────╯\n'
  printf '\n'
  printf '› Find and fix a bug in @filename\n'
  exit 0
fi
printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  const stateDir = mkdtempSync(join(tmpdir(), "opencode-tmux-codex-state-"));
  writeFileSync(
    join(stateDir, "pane.json"),
    JSON.stringify({
      version: 1,
      paneId: "%1",
      target: "work:1.0",
      directory: "/tmp/codex-project",
      title: "codex-project",
      activity: "busy",
      status: "running",
      detail: "Codex is handling a user prompt",
      updatedAt: Date.now(),
      sourceEventType: "UserPromptSubmit",
      sessionId: "codex-session",
    }),
  );
  const restoreEnv = setEnv({
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    OPENCODE_TMUX_CODEX_STATE_DIR: stateDir,
    OPENCODE_TMUX_CODEX_BUSY_GRACE_MS: "3000",
  });

  try {
    const summaries = await attachRuntimeToPanes([createDiscoveredCodexPane()], {
      provider: "auto",
    });

    assert.equal(summaries[0]?.runtime.status, "running");
    assert.equal(summaries[0]?.runtime.activity, "busy");
    assert.equal(summaries[0]?.runtime.source, "codex-hook");
  } finally {
    restoreEnv();
  }
});

test("fresh Codex prompt wins over stale trust text in scrollback", async () => {
  const fakeTmux = installFakeTmux(`
if [ "$1" = "capture-pane" ]; then
  printf 'Do you trust the contents of this directory?\n'
  printf '› 1. Yes, continue\n'
  printf 'Press enter to continue\n'
  printf '╭──────────────────────────────────────────────╮\n'
  printf '│ >_ OpenAI Codex (v0.117.0)                   │\n'
  printf '│ model:     gpt-5.4 medium   /model to change │\n'
  printf '╰──────────────────────────────────────────────╯\n'
  printf '\n'
  printf '› Find and fix a bug in @filename\n'
  exit 0
fi
printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  const stateDir = mkdtempSync(join(tmpdir(), "opencode-tmux-codex-state-"));
  const restoreEnv = setEnv({
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    OPENCODE_TMUX_CODEX_STATE_DIR: stateDir,
  });

  try {
    const summaries = await attachRuntimeToPanes([createDiscoveredCodexPane()], {
      provider: "auto",
    });

    assert.equal(summaries[0]?.runtime.status, "new");
    assert.equal(summaries[0]?.runtime.activity, "idle");
    assert.equal(summaries[0]?.runtime.source, "codex-preview");
  } finally {
    restoreEnv();
  }
});

test("fresh Codex startup trust prompt stays new instead of counting as waiting", async () => {
  const fakeTmux = installFakeTmux(`
if [ "$1" = "capture-pane" ]; then
  printf 'Do you trust the contents of this directory?\n'
  printf '› 1. Yes, continue\n'
  printf '2. No, quit\n'
  printf 'Press enter to continue\n'
  exit 0
fi
printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  const stateDir = mkdtempSync(join(tmpdir(), "opencode-tmux-codex-state-"));
  const restoreEnv = setEnv({
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    OPENCODE_TMUX_CODEX_STATE_DIR: stateDir,
  });

  try {
    const summaries = await attachRuntimeToPanes([createDiscoveredCodexPane()], {
      provider: "auto",
    });

    assert.equal(summaries[0]?.runtime.status, "new");
    assert.equal(summaries[0]?.runtime.activity, "idle");
    assert.equal(summaries[0]?.runtime.source, "codex-preview");
    assert.equal(
      summaries[0]?.runtime.detail,
      "Codex startup trust prompt is waiting for confirmation",
    );
  } finally {
    restoreEnv();
  }
});

test("Codex runtime does not borrow another pane's hook state by directory alone", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "opencode-tmux-codex-state-"));
  const fakeTmux = installFakeTmux(`
if [ "$1" = "capture-pane" ]; then
  printf '╭──────────────────────────────────────────────╮\n'
  printf '│ >_ OpenAI Codex (v0.117.0)                   │\n'
  printf '│ model:     gpt-5.4 medium   /model to change │\n'
  printf '╰──────────────────────────────────────────────╯\n'
  printf '\n'
  printf '› Find and fix a bug in @filename\n'
  exit 0
fi
printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  writeFileSync(
    join(stateDir, "other-pane.json"),
    JSON.stringify({
      version: 1,
      paneId: "%99",
      target: "other:1.9",
      directory: "/tmp/codex-project",
      title: "Other Pane",
      activity: "idle",
      status: "idle",
      detail: "Other pane state",
      updatedAt: 123,
      sourceEventType: "Stop",
      sessionId: "other",
    }),
  );
  const restoreEnv = setEnv({
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    OPENCODE_TMUX_CODEX_STATE_DIR: stateDir,
  });

  try {
    const summaries = await attachRuntimeToPanes([createDiscoveredCodexPane()], {
      provider: "auto",
    });

    assert.equal(summaries[0]?.runtime.source, "codex-preview");
    assert.equal(summaries[0]?.runtime.session, null);
    assert.equal(summaries[0]?.runtime.detail, "Codex is ready for a new prompt");
  } finally {
    restoreEnv();
  }
});

test("persistCodexHookState records waiting-input and attachRuntimeToPanes prefers hook state", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "opencode-tmux-codex-state-"));
  const restoreEnv = setEnv({
    OPENCODE_TMUX_CODEX_STATE_DIR: stateDir,
    TMUX_PANE: undefined,
  });

  try {
    await persistCodexHookState(
      JSON.stringify({
        hook_event_name: "SessionStart",
        cwd: "/tmp/codex-project",
        session_id: "codex-session",
      }),
    );
    await persistCodexHookState(
      JSON.stringify({
        hook_event_name: "Stop",
        cwd: "/tmp/codex-project",
        session_id: "codex-session",
        last_assistant_message: "Would you like me to apply that change?",
      }),
    );

    const states = readCodexStates();

    assert.equal(states.length, 1);
    assert.equal(states[0]?.status, "waiting-input");
    assert.equal(states[0]?.activity, "busy");
    assert.equal(states[0]?.title, "codex-project");

    const summaries = await attachRuntimeToPanes([createDiscoveredCodexPane()], {
      provider: "auto",
    });

    assert.equal(summaries[0]?.runtime.status, "waiting-input");
    assert.equal(summaries[0]?.runtime.activity, "busy");
    assert.equal(summaries[0]?.runtime.source, "codex-hook");
    assert.equal(summaries[0]?.runtime.match.provider, "codex");
    assert.equal(summaries[0]?.runtime.session?.title, "codex-project");
    assert.equal(summaries[0]?.runtime.detail, "Codex is waiting for user input");
  } finally {
    restoreEnv();
  }
});
