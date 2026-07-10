import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repoRoot = join(import.meta.dirname, "..");
const syncScript = join(repoRoot, "scripts", "sync-tmux-plugin.sh");

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

test("--restore returns a synced TPM checkout to a clean install", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "coding-agents-tmux-sync-"));
  const target = join(tempRoot, "plugin");

  mkdirSync(join(target, "node_modules"), { recursive: true });
  writeFileSync(join(target, "README.md"), "installed version\n");
  writeFileSync(join(target, ".gitignore"), "node_modules/\n");
  writeFileSync(join(target, "node_modules", "keep.txt"), "keep\n");

  git(target, "init", "-q");
  git(target, "config", "user.name", "Test User");
  git(target, "config", "user.email", "test@example.com");
  git(target, "add", "README.md", ".gitignore");
  git(target, "commit", "-qm", "installed plugin");

  execFileSync(syncScript, ["--target", target], { cwd: repoRoot, stdio: "pipe" });
  assert.notEqual(readFileSync(join(target, "README.md"), "utf8"), "installed version\n");

  execFileSync(syncScript, ["--target", target, "--restore"], {
    cwd: repoRoot,
    stdio: "pipe",
  });

  assert.equal(readFileSync(join(target, "README.md"), "utf8"), "installed version\n");
  assert.equal(readFileSync(join(target, "node_modules", "keep.txt"), "utf8"), "keep\n");
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], { cwd: target, encoding: "utf8" }),
    "",
  );
});
