import { lstatSync, readlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isCheckoutSymlink } from "../src/core/integration-ownership.ts";

const [path, source] = process.argv.slice(2);
try {
  const owned =
    lstatSync(path).isSymbolicLink() &&
    (resolve(dirname(path), readlinkSync(path)) === resolve(source) ||
      isCheckoutSymlink(path, ["plugin", "pi-tmux.ts"], ["coding-agents-tmux", "opencode-tmux"]));
  process.exitCode = owned ? 0 : 1;
} catch {
  process.exitCode = 1;
}
