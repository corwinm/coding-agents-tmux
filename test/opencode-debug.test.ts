import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { renderInspectResult } from "../src/cli/render.ts";
import { buildInspectDebugInfo } from "../src/core/opencode.ts";
import type { DiscoveredPane, InspectResult, TmuxPane } from "../src/types.ts";

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

function createPane(): TmuxPane {
  return {
    sessionName: "work",
    windowIndex: 1,
    paneIndex: 0,
    paneId: "%1",
    paneTitle: "OpenCode",
    currentCommand: "opencode",
    currentPath: "/tmp/project",
    isActive: true,
    tty: "/dev/ttys001",
    target: "work:1.0",
  };
}

function createDiscoveredPane(): DiscoveredPane {
  return {
    pane: createPane(),
    detection: {
      agent: "opencode",
      confidence: "high",
      reasons: ["title:OpenCode", "command:opencode"],
    },
  };
}

function fakeOpenCode(): string {
  const binDir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-debug-bin-"));
  const executable = join(binDir, "opencode");
  writeFileSync(executable, "#!/bin/sh\nprintf 'opencode v2.0.12\\n'\n", "utf8");
  chmodSync(executable, 0o755);
  return binDir;
}

function makeLayout(layout: "current" | "stale" | "missing"): {
  configRoot: string;
  pluginRoot: string;
  sourceRoot: string;
} {
  const configRoot = mkdtempSync(join(tmpdir(), `opencode-${layout}-config-`));
  const pluginRoot = join(configRoot, "opencode", "plugins");
  const sourceRoot = mkdtempSync(join(tmpdir(), `opencode-${layout}-source-`));
  mkdirSync(join(sourceRoot, "plugin", "opencode"), { recursive: true });
  writeFileSync(join(sourceRoot, "plugin", "opencode", "index.ts"), "export default {};\n");
  mkdirSync(pluginRoot, { recursive: true });
  if (layout === "current") {
    symlinkSync(
      join(sourceRoot, "plugin", "opencode"),
      join(pluginRoot, "coding-agents-tmux"),
      "dir",
    );
    symlinkSync(
      join(sourceRoot, "plugin", "opencode", "index.ts"),
      join(pluginRoot, "coding-agents-tmux.ts"),
    );
    writeFileSync(join(pluginRoot, "opencode-tmux.ts"), "export default {};\n");
  } else if (layout === "stale") {
    symlinkSync(
      join(sourceRoot, "plugin", "opencode", "index.ts"),
      join(pluginRoot, "coding-agents-tmux.ts"),
    );
  }
  return { configRoot, pluginRoot, sourceRoot };
}

test("OpenCode inspect debug reports current, stale, and missing plugin layouts from XDG config", async () => {
  const binDir = fakeOpenCode();
  for (const layout of ["current", "stale", "missing"] as const) {
    const fixture = makeLayout(layout);
    const restoreEnv = setEnv({
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      XDG_CONFIG_HOME: fixture.configRoot,
      CODING_AGENTS_TMUX_STATE_DIR: mkdtempSync(join(tmpdir(), "empty-plugin-state-")),
      OPENCODE_DB: join(fixture.configRoot, "missing.db"),
    });
    try {
      const debug = await buildInspectDebugInfo(createDiscoveredPane());
      const installation = debug.opencode?.plugin.installation;
      assert.equal(installation?.configRoot, fixture.configRoot);
      assert.equal(installation?.status, layout);
      assert.equal(installation?.expectedLayout, "v2-directory");
      assert.equal(
        installation?.entrypoint,
        join(fixture.pluginRoot, "coding-agents-tmux", "index.ts"),
      );
      if (layout === "current") {
        assert.equal(
          installation?.source,
          join(fixture.sourceRoot, "plugin", "opencode", "index.ts"),
        );
        assert.deepEqual(
          installation?.stale.map((entry) => entry.layout),
          ["v1-flat", "unrelated-flat"],
        );
      }
    } finally {
      restoreEnv();
    }
  }
});

test("OpenCode inspect debug renders actionable V2 TUI-not-loaded diagnostics", async () => {
  const fixture = makeLayout("current");
  const binDir = fakeOpenCode();
  const pluginStateDir = mkdtempSync(join(tmpdir(), "legacy-plugin-state-"));
  writeFileSync(
    join(pluginStateDir, "legacy.json"),
    JSON.stringify({
      directory: "/tmp/project",
      title: "legacy V1 state from another pane",
      status: "idle",
      activity: "idle",
      opencodeGeneration: "v1",
    }),
  );
  const restoreEnv = setEnv({
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    XDG_CONFIG_HOME: fixture.configRoot,
    CODING_AGENTS_TMUX_STATE_DIR: pluginStateDir,
    OPENCODE_DB: join(fixture.configRoot, "missing.db"),
  });
  try {
    const discovered = createDiscoveredPane();
    const debug = await buildInspectDebugInfo(discovered);
    assert.match(
      debug.opencode?.plugin.installation.diagnostics.join("\n") ?? "",
      /V2 plugin.*not loaded.*TUI.*restart OpenCode/i,
    );
    const result: InspectResult = {
      target: discovered.pane.target,
      summary: {
        ...discovered,
        runtime: {
          activity: "unknown",
          status: "unknown",
          source: "unmapped",
          match: { strategy: "unmapped", provider: "none", heuristic: false },
          session: null,
          detail: "no state",
        },
      },
      debug,
    };
    const output = renderInspectResult(result);
    assert.match(output, /Plugin Install Status: current/);
    assert.match(output, /Plugin Layout: v2-directory/);
    assert.match(output, /Plugin Entrypoint: .*coding-agents-tmux\/index\.ts/);
    assert.match(output, /Plugin Source: .*plugin\/opencode\/index\.ts/);
    assert.match(output, /Plugin Diagnostic: .*restart OpenCode/i);
  } finally {
    restoreEnv();
  }
});
