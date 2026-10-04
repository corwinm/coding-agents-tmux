import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { observePane, readCycleLedger } from "../src/core/cycle-ledger.ts";
import { listAllPanes, parsePaneLine } from "../src/core/tmux.ts";

const row = "work\t0\t0\t%0\tCodex\tcodex\t/project\t1\t/dev/pts/1";

test("pane snapshots carry server lifetime identity, never a socket-only fallback", () => {
  const first = parsePaneLine(`${row}\t123\t100\t/socket`);
  assert.ok(first.serverIdentity);
  assert.notEqual(first.serverIdentity, parsePaneLine(`${row}\t456\t100\t/socket`).serverIdentity);
  assert.notEqual(first.serverIdentity, parsePaneLine(`${row}\t123\t101\t/socket`).serverIdentity);
  assert.notEqual(first.serverIdentity, parsePaneLine(`${row}\t123\t100\t/other`).serverIdentity);
  for (const suffix of ["", "\t\t\t/socket", "\t123\t\t/socket", "\tbad\t100\t/socket"]) {
    assert.equal(parsePaneLine(row + suffix).serverIdentity, null);
  }
});

const tmuxAvailable = (() => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test(
  "real concurrent tmux servers and same-socket restart isolate the cycle ledger",
  {
    skip: !tmuxAvailable,
  },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "cat-server-"));
    const sockets = [join(root, "a"), join(root, "b")];
    const previousTmux = process.env.TMUX;
    const previousState = process.env.CODING_AGENTS_TMUX_CYCLE_STATE_DIR;
    const tmux = (socket: string, ...args: string[]) =>
      execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8" });
    const snapshot = async (socket: string) => {
      process.env.TMUX = `${socket},0,0`;
      return (await listAllPanes())[0]!;
    };
    process.env.CODING_AGENTS_TMUX_CYCLE_STATE_DIR = join(root, "ledger");
    try {
      for (const socket of sockets)
        tmux(socket, "-f", "/dev/null", "new-session", "-d", "-s", "test", "sleep 60");
      const a = await snapshot(sockets[0]!);
      const b = await snapshot(sockets[1]!);
      assert.equal(a.paneId, b.paneId);
      assert.ok(a.serverIdentity);
      assert.ok(b.serverIdentity);
      assert.notEqual(a.serverIdentity, b.serverIdentity);
      observePane(a.paneId, "idle", true, 1000, a.serverIdentity);
      observePane(b.paneId, "idle", false, 2000, b.serverIdentity);
      assert.equal(readCycleLedger(b.serverIdentity).get(b.paneId)?.seen, false);
      assert.equal(readCycleLedger(b.serverIdentity).get(b.paneId)?.statusSince, 2000);
      // Attach and detach a real control-mode client twice (including reattachment).
      for (let attempt = 0; attempt < 2; attempt++) {
        const client = spawn("tmux", ["-S", sockets[0]!, "-C", "attach-session", "-t", "test"], {
          timeout: 5000,
          env: { ...process.env, TMUX: "" },
        });
        let output = "";
        client.stdout.on("data", (data: Buffer) => {
          output += data.toString();
          if (output.includes("%session-changed") && !client.stdin.writableEnded)
            client.stdin.end("detach-client\n");
        });
        const [exitCode] = await once(client, "close");
        assert.equal(exitCode, 0, output);
        assert.match(output, /%session-changed/);
      }
      // Session churn also leaves surviving panes in the same namespace.
      tmux(sockets[0]!, "new-session", "-d", "-s", "extra", "sleep 60");
      tmux(sockets[0]!, "kill-session", "-t", "extra");
      const surviving = await snapshot(sockets[0]!);
      assert.equal(surviving.serverIdentity, a.serverIdentity);
      assert.equal(readCycleLedger(surviving.serverIdentity).get(a.paneId)?.seen, true);
      tmux(sockets[0]!, "kill-server");
      tmux(sockets[0]!, "-f", "/dev/null", "new-session", "-d", "-s", "test", "sleep 60");
      const restored = await snapshot(sockets[0]!);
      assert.equal(restored.paneId, a.paneId);
      assert.notEqual(restored.serverIdentity, a.serverIdentity);
      assert.equal(readCycleLedger(restored.serverIdentity).size, 0);
      observePane(restored.paneId, "idle", false, 3000, restored.serverIdentity);
      assert.equal(readCycleLedger(restored.serverIdentity).get(restored.paneId)?.seen, false);
      assert.equal(
        readCycleLedger(restored.serverIdentity).get(restored.paneId)?.statusSince,
        3000,
      );
      assert.equal(readCycleLedger(b.serverIdentity).get(b.paneId)?.statusSince, 2000);
    } finally {
      for (const socket of sockets) {
        try {
          tmux(socket, "kill-server");
        } catch {
          /* already stopped */
        }
      }
      if (previousTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = previousTmux;
      if (previousState === undefined) delete process.env.CODING_AGENTS_TMUX_CYCLE_STATE_DIR;
      else process.env.CODING_AGENTS_TMUX_CYCLE_STATE_DIR = previousState;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
