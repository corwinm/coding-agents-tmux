import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCommand } from "../src/runtime.ts";

function setEnv(updates: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(updates)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, "utf8");
  chmodSync(path, 0o755);
}

test("SketchyBar integration renders the summary and configured tone color", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-sketchybar-"));
  const cli = join(dir, "coding-agents-tmux");
  const sketchybar = join(dir, "sketchybar");
  const log = join(dir, "sketchybar.log");
  executable(
    cli,
    `printf '%s' '{"mode":"summary","total":2,"busy":1,"waiting":1,"running":0,"idle":1,"new":0,"unknown":0,"tone":"waiting","summary":"agents | waiting idle"}'`,
  );
  executable(sketchybar, `printf '%s\\n' "$*" > '${log}'`);
  const restoreEnv = setEnv({
    CODING_AGENTS_TMUX_BIN: cli,
    SKETCHYBAR_BIN: sketchybar,
    NAME: "agents",
    CODING_AGENTS_TMUX_COLOR_WAITING: "0xffff0000",
  });

  try {
    const result = await runCommand([join(process.cwd(), "integrations/sketchybar/agents.sh")]);
    assert.equal(result.exitCode, 0);
    const rendered = readFileSync(log, "utf8");
    assert.match(rendered, /--set agents/);
    assert.match(rendered, /label=agents \| waiting idle/);
    assert.match(rendered, /label.color=0xffff0000/);
  } finally {
    restoreEnv();
  }
});

test("notification hook refreshes tmux and invokes the configured integration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-hook-notify-"));
  const log = join(dir, "notify.log");
  executable(
    join(dir, "tmux"),
    `printf 'tmux %s\\n' "$*" >> '${log}'\nif [ "$1" = "show-option" ]; then printf 'printf integration >> ${log}'; fi`,
  );
  const restoreEnv = setEnv({ PATH: `${dir}:${process.env.PATH ?? ""}` });

  try {
    const result = await runCommand([join(process.cwd(), "scripts/notify-status-change.sh")]);
    assert.equal(result.exitCode, 0);
    const output = readFileSync(log, "utf8");
    assert.match(output, /tmux refresh-client -S/);
    assert.match(output, /integration/);
  } finally {
    restoreEnv();
  }
});

test("external launcher focuses the terminal before targeting the tmux popup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-launcher-"));
  const cli = join(dir, "coding-agents-tmux");
  const log = join(dir, "launcher.log");
  executable(cli, `printf 'popup %s\\n' "$*" >> '${log}'`);
  const restoreEnv = setEnv({
    CODING_AGENTS_TMUX_BIN: cli,
    CODING_AGENTS_TMUX_FOCUS_COMMAND: `printf 'focus\\n' >> '${log}'`,
  });

  try {
    const result = await runCommand([
      join(process.cwd(), "integrations/external/focus-and-popup.sh"),
      "--waiting",
    ]);
    assert.equal(result.exitCode, 0);
    assert.equal(readFileSync(log, "utf8"), "focus\npopup popup --client auto --waiting\n");
  } finally {
    restoreEnv();
  }
});
