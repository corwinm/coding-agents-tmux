import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { detectOpenCodeVersion, parseOpenCodeVersion } from "../src/core/opencode-generation.ts";
import { installOpenCodeIntegration } from "../src/core/opencode-install.ts";

function makeFixture(): { configRoot: string; repoRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "coding-agents-tmux opencode install "));
  const configRoot = join(root, "config root");
  const repoRoot = join(root, "repository with spaces");
  const sourceDir = join(repoRoot, "plugin", "opencode");

  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, "index.ts"), "export default {};\n", "utf8");
  writeFileSync(join(sourceDir, "tui.ts"), "export default {};\n", "utf8");
  writeFileSync(join(repoRoot, "plugin", "coding-agents-tmux.ts"), "export default {};\n", "utf8");

  return { configRoot, repoRoot };
}

function installFakeOpenCode(
  output: string,
  options: { exitCode?: number; sleep?: number } = {},
): string {
  const binDir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-opencode-bin-"));
  const executable = join(binDir, "opencode");
  writeFileSync(
    executable,
    `#!/usr/bin/env bash
set -euo pipefail
${options.sleep ? `sleep ${options.sleep}` : ""}
printf '%b' ${JSON.stringify(output)}
exit ${options.exitCode ?? 0}
`,
    "utf8",
  );
  chmodSync(executable, 0o755);
  return binDir;
}

test("parseOpenCodeVersion accepts exact V1 and V2 version output", () => {
  assert.deepEqual(parseOpenCodeVersion("1.18.29\n"), {
    generation: 1,
    version: "1.18.29",
  });
  assert.deepEqual(parseOpenCodeVersion("opencode v2.0.9\n"), {
    generation: 2,
    version: "2.0.9",
  });
});

test("parseOpenCodeVersion rejects malformed and unsupported OpenCode versions", () => {
  assert.throws(
    () => parseOpenCodeVersion("opencode 2.0.9\n"),
    /Unrecognized OpenCode version output/,
  );
  assert.throws(
    () => parseOpenCodeVersion("opencode v2.0.9 extra\n"),
    /Unrecognized OpenCode version output/,
  );
  assert.throws(
    () => parseOpenCodeVersion("1.18.28\n"),
    /OpenCode V1 1\.18\.28 is unsupported.*1\.18\.29 or newer/,
  );
  assert.throws(
    () => parseOpenCodeVersion("opencode v3.0.0\n"),
    /OpenCode major version 3 is unsupported/,
  );
});

test("detectOpenCodeVersion runs opencode --version", async () => {
  const binDir = installFakeOpenCode("opencode v2.0.9\n");
  const detected = await detectOpenCodeVersion({
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    timeoutMs: 1_000,
  });

  assert.deepEqual(detected, { generation: 2, version: "2.0.9" });
});

test("detectOpenCodeVersion reports missing binaries, command failures, and bounded timeouts", async () => {
  await assert.rejects(
    detectOpenCodeVersion({ env: { ...process.env, PATH: "" }, timeoutMs: 100 }),
    /OpenCode executable was not found/,
  );

  const failedBin = installFakeOpenCode("broken\n", { exitCode: 7 });
  await assert.rejects(
    detectOpenCodeVersion({
      env: { ...process.env, PATH: `${failedBin}:/usr/bin:/bin` },
      timeoutMs: 1_000,
    }),
    /opencode --version failed with exit code 7.*broken/,
  );

  const slowBin = installFakeOpenCode("1.18.29\n", { sleep: 2 });
  const startedAt = Date.now();
  await assert.rejects(
    detectOpenCodeVersion({
      env: { ...process.env, PATH: `${slowBin}:/usr/bin:/bin` },
      timeoutMs: 50,
    }),
    /timed out after 50ms/,
  );
  assert.ok(Date.now() - startedAt < 1_000, "version detection should stop the child promptly");
});

test("V1 installation is idempotent, respects XDG config paths, and removes its owned V2 link", () => {
  const fixture = makeFixture();
  const pluginRoot = join(fixture.configRoot, "opencode", "plugins");
  const staleV2Path = join(pluginRoot, "coding-agents-tmux");
  mkdirSync(pluginRoot, { recursive: true });
  symlinkSync(join(fixture.repoRoot, "plugin", "opencode"), staleV2Path, "dir");

  const first = installOpenCodeIntegration(
    { generation: 1, version: "1.18.29" },
    { configRoot: fixture.configRoot, repoRoot: fixture.repoRoot },
  );
  const second = installOpenCodeIntegration(
    { generation: 1, version: "1.18.29" },
    { configRoot: fixture.configRoot, repoRoot: fixture.repoRoot },
  );

  const expectedPath = join(pluginRoot, "coding-agents-tmux.ts");
  assert.deepEqual(first, {
    generation: 1,
    version: "1.18.29",
    pluginPath: expectedPath,
    sourcePath: join(fixture.repoRoot, "plugin", "opencode", "index.ts"),
    changed: true,
  });
  assert.equal(second.changed, false);
  assert.equal(
    readlinkSync(expectedPath),
    join(fixture.repoRoot, "plugin", "opencode", "index.ts"),
  );
  assert.equal(existsSync(staleV2Path), false);
});

test("V1 rollback removes an owned V2 link from a different checkout", () => {
  const fixture = makeFixture();
  const pluginRoot = join(fixture.configRoot, "opencode", "plugins");
  const staleV2Path = join(pluginRoot, "coding-agents-tmux");
  const oldCheckout = join(fixture.repoRoot, "..", "old checkout");
  const oldPlugin = join(oldCheckout, "plugin", "opencode");
  mkdirSync(oldPlugin, { recursive: true });
  writeFileSync(
    join(oldCheckout, "package.json"),
    JSON.stringify({ name: "coding-agents-tmux" }),
    "utf8",
  );
  mkdirSync(pluginRoot, { recursive: true });
  symlinkSync(oldPlugin, staleV2Path, "dir");

  const result = installOpenCodeIntegration(
    { generation: 1, version: "1.18.29" },
    { configRoot: fixture.configRoot, repoRoot: fixture.repoRoot },
  );

  assert.equal(result.changed, true);
  assert.equal(existsSync(staleV2Path), false);
  assert.equal(
    readlinkSync(join(pluginRoot, "coding-agents-tmux.ts")),
    join(fixture.repoRoot, "plugin", "opencode", "index.ts"),
  );
});

test("V1 reinstall replaces an owned current V1 link from a different checkout", () => {
  const fixture = makeFixture();
  const pluginRoot = join(fixture.configRoot, "opencode", "plugins");
  const pluginPath = join(pluginRoot, "coding-agents-tmux.ts");
  const oldCheckout = join(fixture.repoRoot, "..", "old V1 checkout");
  const oldPlugin = join(oldCheckout, "plugin", "opencode", "index.ts");
  mkdirSync(join(oldCheckout, "plugin", "opencode"), { recursive: true });
  writeFileSync(
    join(oldCheckout, "package.json"),
    JSON.stringify({ name: "coding-agents-tmux" }),
    "utf8",
  );
  writeFileSync(oldPlugin, "export default {};\n", "utf8");
  mkdirSync(pluginRoot, { recursive: true });
  symlinkSync(oldPlugin, pluginPath);

  const result = installOpenCodeIntegration(
    { generation: 1, version: "1.18.29" },
    { configRoot: fixture.configRoot, repoRoot: fixture.repoRoot },
  );

  assert.equal(result.changed, true);
  assert.equal(readlinkSync(pluginPath), join(fixture.repoRoot, "plugin", "opencode", "index.ts"));
});

test("V2 reinstall replaces an owned V2 link from a different checkout", () => {
  const fixture = makeFixture();
  const pluginRoot = join(fixture.configRoot, "opencode", "plugins");
  const pluginPath = join(pluginRoot, "coding-agents-tmux");
  const oldCheckout = join(fixture.repoRoot, "..", "old checkout");
  const oldPlugin = join(oldCheckout, "plugin", "opencode");
  mkdirSync(oldPlugin, { recursive: true });
  writeFileSync(
    join(oldCheckout, "package.json"),
    JSON.stringify({ name: "coding-agents-tmux" }),
    "utf8",
  );
  mkdirSync(pluginRoot, { recursive: true });
  symlinkSync(oldPlugin, pluginPath, "dir");

  const result = installOpenCodeIntegration(
    { generation: 2, version: "2.0.9" },
    { configRoot: fixture.configRoot, repoRoot: fixture.repoRoot },
  );

  assert.equal(result.changed, true);
  assert.equal(readlinkSync(pluginPath), join(fixture.repoRoot, "plugin", "opencode"));
});

test("installer refuses a V2 link from an unrelated package checkout", () => {
  const fixture = makeFixture();
  const pluginRoot = join(fixture.configRoot, "opencode", "plugins");
  const staleV2Path = join(pluginRoot, "coding-agents-tmux");
  const unrelatedCheckout = join(fixture.repoRoot, "..", "unrelated checkout v2");
  const unrelatedPlugin = join(unrelatedCheckout, "plugin", "opencode");
  mkdirSync(unrelatedPlugin, { recursive: true });
  writeFileSync(
    join(unrelatedCheckout, "package.json"),
    JSON.stringify({ name: "some-other-package" }),
    "utf8",
  );
  mkdirSync(pluginRoot, { recursive: true });
  symlinkSync(unrelatedPlugin, staleV2Path, "dir");

  assert.throws(
    () =>
      installOpenCodeIntegration(
        { generation: 1, version: "1.18.29" },
        { configRoot: fixture.configRoot, repoRoot: fixture.repoRoot },
      ),
    /Refusing to remove.*not managed by coding-agents-tmux/,
  );
  assert.equal(readlinkSync(staleV2Path), unrelatedPlugin);
  assert.equal(existsSync(join(pluginRoot, "coding-agents-tmux.ts")), false);
});

test("installer refuses a V2 link whose target is not the exact plugin path", () => {
  const fixture = makeFixture();
  const pluginRoot = join(fixture.configRoot, "opencode", "plugins");
  const staleV2Path = join(pluginRoot, "coding-agents-tmux");
  const otherCheckout = join(fixture.repoRoot, "..", "wrong V2 path checkout");
  const unexpectedTarget = join(otherCheckout, "plugin", "opencode-copy");
  mkdirSync(unexpectedTarget, { recursive: true });
  writeFileSync(
    join(otherCheckout, "package.json"),
    JSON.stringify({ name: "coding-agents-tmux" }),
    "utf8",
  );
  mkdirSync(pluginRoot, { recursive: true });
  symlinkSync(unexpectedTarget, staleV2Path, "dir");

  assert.throws(
    () =>
      installOpenCodeIntegration(
        { generation: 1, version: "1.18.29" },
        { configRoot: fixture.configRoot, repoRoot: fixture.repoRoot },
      ),
    /Refusing to remove.*not managed by coding-agents-tmux/,
  );
  assert.equal(readlinkSync(staleV2Path), unexpectedTarget);
});

test("V2 installation is idempotent and removes both current and legacy owned V1 links", () => {
  for (const staleSource of [
    join("plugin", "opencode", "index.ts"),
    join("plugin", "coding-agents-tmux.ts"),
  ]) {
    const fixture = makeFixture();
    const pluginRoot = join(fixture.configRoot, "opencode", "plugins");
    const staleV1Path = join(pluginRoot, "coding-agents-tmux.ts");
    mkdirSync(pluginRoot, { recursive: true });
    symlinkSync(join(fixture.repoRoot, staleSource), staleV1Path);

    const first = installOpenCodeIntegration(
      { generation: 2, version: "2.0.9" },
      { configRoot: fixture.configRoot, repoRoot: fixture.repoRoot },
    );
    const second = installOpenCodeIntegration(
      { generation: 2, version: "2.0.9" },
      { configRoot: fixture.configRoot, repoRoot: fixture.repoRoot },
    );

    const expectedPath = join(pluginRoot, "coding-agents-tmux");
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(first.pluginPath, expectedPath);
    assert.equal(readlinkSync(expectedPath), join(fixture.repoRoot, "plugin", "opencode"));
    assert.equal(existsSync(staleV1Path), false);
  }
});

test("V2 installation removes an owned current V1 link from a different checkout", () => {
  const fixture = makeFixture();
  const pluginRoot = join(fixture.configRoot, "opencode", "plugins");
  const staleV1Path = join(pluginRoot, "coding-agents-tmux.ts");
  const oldCheckout = join(fixture.repoRoot, "..", "old current V1 checkout");
  const oldPlugin = join(oldCheckout, "plugin", "opencode", "index.ts");
  mkdirSync(join(oldCheckout, "plugin", "opencode"), { recursive: true });
  writeFileSync(
    join(oldCheckout, "package.json"),
    JSON.stringify({ name: "coding-agents-tmux" }),
    "utf8",
  );
  writeFileSync(oldPlugin, "export default {};\n", "utf8");
  mkdirSync(pluginRoot, { recursive: true });
  symlinkSync(oldPlugin, staleV1Path);

  const result = installOpenCodeIntegration(
    { generation: 2, version: "2.0.9" },
    { configRoot: fixture.configRoot, repoRoot: fixture.repoRoot },
  );

  assert.equal(result.changed, true);
  assert.equal(existsSync(staleV1Path), false);
  assert.equal(
    readlinkSync(join(pluginRoot, "coding-agents-tmux")),
    join(fixture.repoRoot, "plugin", "opencode"),
  );
});

test("V2 installation removes an owned legacy V1 link from a different checkout", () => {
  const fixture = makeFixture();
  const pluginRoot = join(fixture.configRoot, "opencode", "plugins");
  const staleV1Path = join(pluginRoot, "coding-agents-tmux.ts");
  const oldCheckout = join(fixture.repoRoot, "..", "old tpm", "plugins", "coding-agents-tmux");
  const oldPlugin = join(oldCheckout, "plugin", "coding-agents-tmux.ts");
  mkdirSync(join(oldCheckout, "plugin"), { recursive: true });
  writeFileSync(
    join(oldCheckout, "package.json"),
    JSON.stringify({ name: "coding-agents-tmux" }),
    "utf8",
  );
  writeFileSync(oldPlugin, "export default {};\n", "utf8");
  mkdirSync(pluginRoot, { recursive: true });
  symlinkSync(oldPlugin, staleV1Path);

  const result = installOpenCodeIntegration(
    { generation: 2, version: "2.0.9" },
    { configRoot: fixture.configRoot, repoRoot: fixture.repoRoot },
  );

  assert.equal(result.changed, true);
  assert.equal(existsSync(staleV1Path), false);
  assert.equal(
    readlinkSync(join(pluginRoot, "coding-agents-tmux")),
    join(fixture.repoRoot, "plugin", "opencode"),
  );
});

test("installer refuses current V1 links without both the exact target and package ownership", () => {
  const cases: Array<{
    generation: 1 | 2;
    checkoutName: string;
    targetName: string;
  }> = [
    { generation: 1, checkoutName: "some-other-package", targetName: "index.ts" },
    { generation: 2, checkoutName: "coding-agents-tmux", targetName: "not-index.ts" },
  ];

  for (const testCase of cases) {
    const fixture = makeFixture();
    const pluginRoot = join(fixture.configRoot, "opencode", "plugins");
    const staleV1Path = join(pluginRoot, "coding-agents-tmux.ts");
    const otherCheckout = join(fixture.repoRoot, "..", `current V1 refusal ${testCase.generation}`);
    const otherPlugin = join(otherCheckout, "plugin", "opencode", testCase.targetName);
    mkdirSync(join(otherCheckout, "plugin", "opencode"), { recursive: true });
    writeFileSync(
      join(otherCheckout, "package.json"),
      JSON.stringify({ name: testCase.checkoutName }),
      "utf8",
    );
    writeFileSync(otherPlugin, "export default {};\n", "utf8");
    mkdirSync(pluginRoot, { recursive: true });
    symlinkSync(otherPlugin, staleV1Path);

    assert.throws(
      () =>
        installOpenCodeIntegration(
          {
            generation: testCase.generation,
            version: testCase.generation === 1 ? "1.18.29" : "2.0.9",
          },
          { configRoot: fixture.configRoot, repoRoot: fixture.repoRoot },
        ),
      /Refusing to (?:remove|replace).*not managed by coding-agents-tmux/,
    );
    assert.equal(readlinkSync(staleV1Path), otherPlugin);
  }
});

test("installer refuses a legacy-named symlink from an unrelated checkout", () => {
  const fixture = makeFixture();
  const pluginRoot = join(fixture.configRoot, "opencode", "plugins");
  const staleV1Path = join(pluginRoot, "coding-agents-tmux.ts");
  const unrelatedCheckout = join(fixture.repoRoot, "..", "unrelated checkout");
  const unrelatedPlugin = join(unrelatedCheckout, "plugin", "coding-agents-tmux.ts");
  mkdirSync(join(unrelatedCheckout, "plugin"), { recursive: true });
  writeFileSync(
    join(unrelatedCheckout, "package.json"),
    JSON.stringify({ name: "some-other-package" }),
    "utf8",
  );
  writeFileSync(unrelatedPlugin, "export default {};\n", "utf8");
  mkdirSync(pluginRoot, { recursive: true });
  symlinkSync(unrelatedPlugin, staleV1Path);

  assert.throws(
    () =>
      installOpenCodeIntegration(
        { generation: 2, version: "2.0.9" },
        { configRoot: fixture.configRoot, repoRoot: fixture.repoRoot },
      ),
    /Refusing to remove.*not managed by coding-agents-tmux/,
  );
  assert.equal(readlinkSync(staleV1Path), unrelatedPlugin);
});

test("installer never removes or replaces unrelated user files, directories, or symlinks", () => {
  const cases: Array<{
    generation: 1 | 2;
    conflictingName: string;
    kind: "file" | "directory" | "symlink";
  }> = [
    { generation: 1, conflictingName: "coding-agents-tmux", kind: "directory" },
    { generation: 1, conflictingName: "coding-agents-tmux.ts", kind: "file" },
    { generation: 2, conflictingName: "coding-agents-tmux.ts", kind: "file" },
    { generation: 2, conflictingName: "coding-agents-tmux", kind: "symlink" },
  ];

  for (const testCase of cases) {
    const fixture = makeFixture();
    const pluginRoot = join(fixture.configRoot, "opencode", "plugins");
    const conflictingPath = join(pluginRoot, testCase.conflictingName);
    mkdirSync(pluginRoot, { recursive: true });

    if (testCase.kind === "directory") {
      mkdirSync(conflictingPath);
      writeFileSync(join(conflictingPath, "keep.txt"), "user data", "utf8");
    } else if (testCase.kind === "file") {
      writeFileSync(conflictingPath, "user data", "utf8");
    } else {
      symlinkSync(join(fixture.repoRoot, "unrelated"), conflictingPath);
    }

    assert.throws(
      () =>
        installOpenCodeIntegration(
          {
            generation: testCase.generation,
            version: testCase.generation === 1 ? "1.18.29" : "2.0.9",
          },
          { configRoot: fixture.configRoot, repoRoot: fixture.repoRoot },
        ),
      /Refusing to (?:remove|replace).*not managed by coding-agents-tmux/,
    );
    assert.ok(lstatSync(conflictingPath));
    if (testCase.kind === "file") assert.equal(readFileSync(conflictingPath, "utf8"), "user data");
    if (testCase.kind === "directory") {
      assert.equal(readFileSync(join(conflictingPath, "keep.txt"), "utf8"), "user data");
    }
  }
});
