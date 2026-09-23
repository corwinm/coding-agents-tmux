import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readlinkSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

function installFakeOpenCode(pathEntry: string, versionOutput: string): void {
  const opencodePath = join(pathEntry, "opencode");

  writeFileSync(
    opencodePath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%b' ${JSON.stringify(versionOutput)}
`,
    "utf8",
  );
  chmodSync(opencodePath, 0o755);
}

test("coding-agents-tmux.tmux reads renamed tmux options", async () => {
  const fakeTmux = installFakeTmux(`
log_path='__LOG_PATH__'
option="\${!#}"

case "$1" in
show-option)
  case "$option" in
    @coding-agents-tmux-menu-key)
      printf 'N\n'
      ;;
    @coding-agents-tmux-menu-key)
      printf 'O\n'
      ;;
    @coding-agents-tmux-status)
      printf 'off\n'
      ;;
    @coding-agents-tmux-install-opencode-plugin)
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

test("coding-agents-tmux.tmux installs renamed plugin integration paths", async () => {
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
  const home = mkdtempSync(join(tmpdir(), "coding-agents-tmux home with spaces "));
  const configHome = join(home, ".config home");
  const piHome = join(home, ".pi-home");
  installFakeNpm(fakeTmux.pathEntry);
  installFakeOpenCode(fakeTmux.pathEntry, "opencode v2.0.9\n");
  const restoreEnv = setEnv({
    HOME: home,
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    XDG_CONFIG_HOME: configHome,
    PI_CODING_AGENT_DIR: piHome,
  });

  try {
    const result = await runCommand([join(process.cwd(), "coding-agents-tmux.tmux")]);
    const pluginPath = join(configHome, "opencode", "plugins", "coding-agents-tmux");
    const piExtensionPath = join(piHome, "extensions", "coding-agents-tmux", "index.ts");

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderrText.trim(), "");
    assert.ok(existsSync(pluginPath));
    assert.ok(existsSync(piExtensionPath));
    assert.ok(lstatSync(pluginPath).isSymbolicLink());
    assert.ok(lstatSync(piExtensionPath).isSymbolicLink());
    assert.equal(readlinkSync(pluginPath), join(process.cwd(), "plugin", "opencode"));
    assert.equal(readlinkSync(piExtensionPath), join(process.cwd(), "plugin", "pi-tmux.ts"));
  } finally {
    restoreEnv();
  }
});

test("coding-agents-tmux.tmux silently skips OpenCode auto-install when OpenCode is missing", async () => {
  const fakeTmux = installFakeTmux(`
log_path='__LOG_PATH__'
option="\${!#}"
case "$1" in
show-option)
  case "$option" in
    @coding-agents-tmux-status) printf 'off\n' ;;
    @coding-agents-tmux-auto-install) printf 'opencode\n' ;;
  esac
  exit 0
  ;;
display-message|bind-key|set-option|set-hook|refresh-client|unbind-key)
  printf '%s\n' "$*" >> "$log_path"
  exit 0
  ;;
esac
exit 1
`);
  installFakeNpm(fakeTmux.pathEntry);
  const home = mkdtempSync(join(tmpdir(), "coding-agents-tmux-home-"));
  const restoreEnv = setEnv({
    HOME: home,
    PATH: `${fakeTmux.pathEntry}:${dirname(process.execPath)}:/usr/bin:/bin`,
    XDG_CONFIG_HOME: join(home, ".config"),
  });

  try {
    const result = await runCommand([join(process.cwd(), "coding-agents-tmux.tmux")]);
    const log = existsSync(fakeTmux.logPath) ? readFileSync(fakeTmux.logPath, "utf8") : "";
    assert.equal(result.exitCode, 0);
    assert.doesNotMatch(log, /OpenCode|opencode|failed to install/);
  } finally {
    restoreEnv();
  }
});

test("coding-agents-tmux.tmux surfaces unsupported OpenCode diagnostics", async () => {
  const fakeTmux = installFakeTmux(`
log_path='__LOG_PATH__'
option="\${!#}"
case "$1" in
show-option)
  case "$option" in
    @coding-agents-tmux-status) printf 'off\n' ;;
    @coding-agents-tmux-auto-install) printf 'opencode\n' ;;
  esac
  exit 0
  ;;
display-message|bind-key|set-option|set-hook|refresh-client|unbind-key)
  printf '%s\n' "$*" >> "$log_path"
  exit 0
  ;;
esac
exit 1
`);
  installFakeNpm(fakeTmux.pathEntry);
  installFakeOpenCode(fakeTmux.pathEntry, "1.18.28\n");
  const home = mkdtempSync(join(tmpdir(), "coding-agents-tmux-home-"));
  const restoreEnv = setEnv({
    HOME: home,
    PATH: `${fakeTmux.pathEntry}:${dirname(process.execPath)}:/usr/bin:/bin`,
    XDG_CONFIG_HOME: join(home, ".config"),
  });

  try {
    const result = await runCommand([join(process.cwd(), "coding-agents-tmux.tmux")]);
    assert.equal(result.exitCode, 0);
    assert.match(
      readFileSync(fakeTmux.logPath, "utf8"),
      /display-message.*OpenCode V1 1\.18\.28 is unsupported.*1\.18\.29 or newer/,
    );
  } finally {
    restoreEnv();
  }
});

test("coding-agents-tmux.tmux keeps integration hooks when tmux status is disabled", async () => {
  const fakeTmux = installFakeTmux(`
log_path='__LOG_PATH__'
option="\${!#}"

case "$1" in
show-option)
  case "$option" in
    @coding-agents-tmux-status)
      printf 'off\n'
      ;;
    @coding-agents-tmux-install-opencode-plugin)
      printf 'off\n'
      ;;
    @coding-agents-tmux-notify-command)
      printf 'sketchybar --trigger coding_agents_changed\n'
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
    const log = readFileSync(fakeTmux.logPath, "utf8");

    assert.equal(result.exitCode, 0);
    assert.match(log, /set-hook -g client-attached\[200\].*coding-agents-tmux.*notify/);
    assert.doesNotMatch(log, /set-hook -gu client-attached\[200\]/);
  } finally {
    restoreEnv();
  }
});

test("coding-agents-tmux.tmux honors @coding-agents-tmux-auto-install lists including claude and copilot", async () => {
  const fakeTmux = installFakeTmux(`
log_path='__LOG_PATH__'
option="\${!#}"

case "$1" in
show-option)
  case "$option" in
    @coding-agents-tmux-status)
      printf 'off\n'
      ;;
    @coding-agents-tmux-install-opencode-plugin)
      printf 'off\n'
      ;;
    @coding-agents-tmux-auto-install)
      printf '%s\n' "\${AUTO_INSTALL_SELECTION:-pi,claude,copilot}"
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
  const codexHome = join(home, ".codex-home");
  const claudeHome = join(home, ".claude-home");
  const copilotHome = join(home, ".copilot-home");
  installFakeNpm(fakeTmux.pathEntry);
  const restoreEnv = setEnv({
    HOME: home,
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    XDG_CONFIG_HOME: configHome,
    PI_CODING_AGENT_DIR: piHome,
    CODEX_HOME: codexHome,
    CLAUDE_HOME: claudeHome,
    COPILOT_HOME: copilotHome,
    AUTO_INSTALL_SELECTION: "pi,claude",
  });

  try {
    const result = await runCommand([join(process.cwd(), "coding-agents-tmux.tmux")]);
    const newPluginPath = join(configHome, "opencode", "plugins", "coding-agents-tmux.ts");
    const newPiExtensionPath = join(piHome, "extensions", "coding-agents-tmux", "index.ts");
    const claudeSettingsPath = join(claudeHome, "settings.json");
    const copilotHooksPath = join(copilotHome, "hooks", "coding-agents-tmux.json");
    const codexHooksPath = join(codexHome, "hooks.json");

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderrText.trim(), "");
    assert.equal(existsSync(copilotHooksPath), false);
    process.env.AUTO_INSTALL_SELECTION = "pi,claude,copilot";
    const optedIn = await runCommand([join(process.cwd(), "coding-agents-tmux.tmux")]);
    assert.equal(optedIn.exitCode, 0);
    assert.equal(optedIn.stderrText.trim(), "");
    assert.equal(existsSync(newPluginPath), false);
    assert.ok(existsSync(newPiExtensionPath));
    assert.ok(existsSync(claudeSettingsPath));
    assert.ok(existsSync(copilotHooksPath));
    assert.equal(existsSync(codexHooksPath), false);
    assert.match(readFileSync(claudeSettingsPath, "utf8"), /claude-hook-state/);
    assert.match(readFileSync(copilotHooksPath, "utf8"), /copilot-hook-state/);
    rmSync(copilotHooksPath);
    process.env.AUTO_INSTALL_SELECTION = "auto";
    const all = await runCommand([join(process.cwd(), "coding-agents-tmux.tmux")]);
    assert.equal(all.exitCode, 0);
    assert.ok(existsSync(copilotHooksPath));
  } finally {
    restoreEnv();
  }
});
