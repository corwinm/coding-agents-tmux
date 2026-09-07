import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { persistClaudeHookState } from "../src/core/claude.ts";
import { persistCodexHookState } from "../src/core/codex.ts";
import { notifyIntegration } from "../src/core/notifications.ts";

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

function installExecutable(dir: string, name: string, script: string): void {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${script}\n`, "utf8");
  chmodSync(path, 0o755);
}

test("notifyIntegration runs the configured tmux notification command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-notify-"));
  const logPath = join(dir, "notify.log");
  installExecutable(
    dir,
    "tmux",
    `if [ "$1" = "show-option" ]; then printf 'integration-notify %s\\n' '${logPath}'; exit 0; fi\nexit 1`,
  );
  installExecutable(dir, "integration-notify", `printf 'changed\\n' > "$1"`);
  const restoreEnv = setEnv({ PATH: `${dir}:${process.env.PATH ?? ""}` });

  try {
    await notifyIntegration();
    assert.equal(readFileSync(logPath, "utf8"), "changed\n");
  } finally {
    restoreEnv();
  }
});

test("notifyIntegration is a no-op when tmux or a command is unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-notify-"));
  installExecutable(dir, "tmux", "exit 1");
  const restoreEnv = setEnv({ PATH: dir });

  try {
    await notifyIntegration();
  } finally {
    restoreEnv();
  }
});

test("Codex and Claude state publishers notify configured integrations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-publisher-notify-"));
  const logPath = join(dir, "notify.log");
  installExecutable(
    dir,
    "tmux",
    `if [ "$1" = "show-option" ]; then printf 'integration-notify %s\\n' '${logPath}'; exit 0; fi\nexit 1`,
  );
  installExecutable(dir, "integration-notify", `printf 'changed\\n' >> "$1"`);
  const restoreEnv = setEnv({
    PATH: `${dir}:${process.env.PATH ?? ""}`,
    CODING_AGENTS_TMUX_CODEX_STATE_DIR: join(dir, "codex-state"),
    CODING_AGENTS_TMUX_CLAUDE_STATE_DIR: join(dir, "claude-state"),
    TMUX_PANE: undefined,
  });

  try {
    await persistCodexHookState(
      JSON.stringify({ hook_event_name: "Stop", cwd: "/tmp/codex", session_id: "codex-1" }),
    );
    await persistClaudeHookState(
      JSON.stringify({ hook_event_name: "Stop", cwd: "/tmp/claude", session_id: "claude-1" }),
    );
    assert.equal(readFileSync(logPath, "utf8"), "changed\nchanged\n");
  } finally {
    restoreEnv();
  }
});
