import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readlinkSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCommand } from "../src/runtime.ts";

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
  const dir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-plugin-tmux-"));
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

function installFakeNpm(pathEntry: string): void {
  const npmPath = join(pathEntry, "npm");

  writeFileSync(
    npmPath,
    `#!/usr/bin/env bash
set -euo pipefail
exit 0
`,
    "utf8",
  );
  chmodSync(npmPath, 0o755);
}

test("coding-agents-tmux.tmux prefers new tmux option aliases over legacy names", async () => {
  const fakeTmux = installFakeTmux(`
log_path='__LOG_PATH__'
option="\${!#}"

case "$1" in
show-option)
  case "$option" in
    @coding-agents-tmux-menu-key)
      printf 'N\n'
      ;;
    @opencode-tmux-menu-key)
      printf 'O\n'
      ;;
    @coding-agents-tmux-status)
      printf 'off\n'
      ;;
  esac
  exit 0
  ;;
bind-key|set-option|set-hook|refresh-client|display-message|unbind-key)
  printf '%s\n' "$*" >> "$log_path"
  exit 0
  ;;
esac

printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  installFakeNpm(fakeTmux.pathEntry);
  const restoreEnv = setEnv({ PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}` });

  try {
    const result = await runCommand([join(process.cwd(), "coding-agents-tmux.tmux")]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderrText.trim(), "");
    assert.match(readFileSync(fakeTmux.logPath, "utf8"), /bind-key N run-shell/);
  } finally {
    restoreEnv();
  }
});

test("coding-agents-tmux.tmux installs new and legacy plugin integration paths", async () => {
  const fakeTmux = installFakeTmux(`
log_path='__LOG_PATH__'
option="\${!#}"

case "$1" in
show-option)
  case "$option" in
    @coding-agents-tmux-status)
      printf 'off\n'
      ;;
  esac
  exit 0
  ;;
bind-key|set-option|set-hook|refresh-client|display-message|unbind-key)
  printf '%s\n' "$*" >> "$log_path"
  exit 0
  ;;
esac

printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  const home = mkdtempSync(join(tmpdir(), "coding-agents-tmux-home-"));
  const configHome = join(home, ".config-home");
  const piHome = join(home, ".pi-home");
  installFakeNpm(fakeTmux.pathEntry);
  const restoreEnv = setEnv({
    HOME: home,
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    XDG_CONFIG_HOME: configHome,
    PI_CODING_AGENT_DIR: piHome,
  });

  try {
    const result = await runCommand([join(process.cwd(), "coding-agents-tmux.tmux")]);
    const newPluginPath = join(configHome, "opencode", "plugins", "coding-agents-tmux.ts");
    const legacyPluginPath = join(configHome, "opencode", "plugins", "opencode-tmux.ts");
    const newPiExtensionPath = join(piHome, "extensions", "coding-agents-tmux", "index.ts");
    const legacyPiExtensionPath = join(piHome, "extensions", "opencode-tmux", "index.ts");

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderrText.trim(), "");
    assert.ok(existsSync(newPluginPath));
    assert.ok(existsSync(legacyPluginPath));
    assert.ok(existsSync(newPiExtensionPath));
    assert.ok(existsSync(legacyPiExtensionPath));
    assert.ok(lstatSync(newPluginPath).isSymbolicLink());
    assert.ok(lstatSync(legacyPluginPath).isSymbolicLink());
    assert.ok(lstatSync(newPiExtensionPath).isSymbolicLink());
    assert.ok(lstatSync(legacyPiExtensionPath).isSymbolicLink());
    assert.equal(
      readlinkSync(newPluginPath),
      join(process.cwd(), "plugin", "coding-agents-tmux.ts"),
    );
    assert.equal(
      readlinkSync(legacyPluginPath),
      join(process.cwd(), "plugin", "coding-agents-tmux.ts"),
    );
    assert.equal(readlinkSync(newPiExtensionPath), join(process.cwd(), "plugin", "pi-tmux.ts"));
    assert.equal(readlinkSync(legacyPiExtensionPath), join(process.cwd(), "plugin", "pi-tmux.ts"));
  } finally {
    restoreEnv();
  }
});
