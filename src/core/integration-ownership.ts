import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Verify an exact integration path and checkout identity without requiring a live target. */
export function isCheckoutSymlink(
  path: string,
  expectedRelativeTarget: string[],
  packageNames = ["coding-agents-tmux"],
): boolean {
  try {
    if (!lstatSync(path).isSymbolicLink()) return false;
    const target = resolve(dirname(path), readlinkSync(path));
    let checkoutRoot = target;
    for (const _segment of expectedRelativeTarget) checkoutRoot = dirname(checkoutRoot);
    if (target !== join(checkoutRoot, ...expectedRelativeTarget)) return false;
    const packageJson = JSON.parse(readFileSync(join(checkoutRoot, "package.json"), "utf8")) as {
      name?: unknown;
    };
    return typeof packageJson.name === "string" && packageNames.includes(packageJson.name);
  } catch {
    return false;
  }
}
