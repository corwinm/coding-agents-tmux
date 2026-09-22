import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { OpenCodeVersion } from "./opencode-generation.ts";

export interface OpenCodeInstallOptions {
  configRoot?: string;
  repoRoot?: string;
}

export interface OpenCodeInstallResult extends OpenCodeVersion {
  changed: boolean;
  pluginPath: string;
  sourcePath: string;
}

interface InstallPath {
  path: string;
  source: string;
  sourceType?: "dir";
}

const DEFAULT_REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function symlinkPointsTo(path: string, sources: string[]): boolean {
  if (!pathExists(path) || !lstatSync(path).isSymbolicLink()) return false;
  const target = readlinkSync(path);
  const resolvedTarget = resolve(join(path, ".."), target);
  return sources.some((source) => resolvedTarget === resolve(source));
}

function isCheckoutSymlink(path: string, expectedRelativeTarget: string[]): boolean {
  if (!pathExists(path) || !lstatSync(path).isSymbolicLink()) return false;

  const target = resolve(dirname(path), readlinkSync(path));
  let checkoutRoot = target;
  for (const _segment of expectedRelativeTarget) checkoutRoot = dirname(checkoutRoot);
  if (target !== join(checkoutRoot, ...expectedRelativeTarget)) return false;

  try {
    const packageJson = JSON.parse(readFileSync(join(checkoutRoot, "package.json"), "utf8")) as {
      name?: unknown;
    };
    return packageJson.name === "coding-agents-tmux";
  } catch {
    return false;
  }
}

function isLegacyV1Symlink(path: string): boolean {
  return isCheckoutSymlink(path, ["plugin", "coding-agents-tmux.ts"]);
}

function isCurrentV1Symlink(path: string): boolean {
  return isCheckoutSymlink(path, ["plugin", "opencode", "index.ts"]);
}

function isV1Symlink(path: string): boolean {
  return isCurrentV1Symlink(path) || isLegacyV1Symlink(path);
}

function isV2Symlink(path: string): boolean {
  return isCheckoutSymlink(path, ["plugin", "opencode"]);
}

function assertSourceExists(source: string): void {
  if (!existsSync(source)) {
    throw new Error(`OpenCode plugin source is missing: ${source}`);
  }
}

function assertManagedOrAbsent(
  path: string,
  ownedSources: string[],
  action: "remove" | "replace",
  acceptV1 = false,
  acceptV2 = false,
): void {
  if (
    !pathExists(path) ||
    symlinkPointsTo(path, ownedSources) ||
    (acceptV1 && isV1Symlink(path)) ||
    (acceptV2 && isV2Symlink(path))
  ) {
    return;
  }
  throw new Error(
    `Refusing to ${action} ${path} because it is not managed by coding-agents-tmux; move it aside and retry`,
  );
}

export function getOpenCodeConfigRoot(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  return xdgConfigHome || join(homedir(), ".config");
}

export function installOpenCodeIntegration(
  detected: OpenCodeVersion,
  options: OpenCodeInstallOptions = {},
): OpenCodeInstallResult {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const configRoot = options.configRoot ?? getOpenCodeConfigRoot();
  const pluginRoot = join(configRoot, "opencode", "plugins");
  const v1: InstallPath = {
    path: join(pluginRoot, "coding-agents-tmux.ts"),
    source: join(repoRoot, "plugin", "opencode", "index.ts"),
  };
  const legacyV1Source = join(repoRoot, "plugin", "coding-agents-tmux.ts");
  const v2: InstallPath = {
    path: join(pluginRoot, "coding-agents-tmux"),
    source: join(repoRoot, "plugin", "opencode"),
    sourceType: "dir",
  };
  const current = detected.generation === 1 ? v1 : v2;
  const stale = detected.generation === 1 ? v2 : v1;
  const currentSources =
    detected.generation === 1 ? [current.source, legacyV1Source] : [current.source];
  const staleSources = detected.generation === 1 ? [stale.source] : [stale.source, legacyV1Source];

  assertSourceExists(current.source);
  assertManagedOrAbsent(
    current.path,
    currentSources,
    "replace",
    detected.generation === 1,
    detected.generation === 2,
  );
  assertManagedOrAbsent(
    stale.path,
    staleSources,
    "remove",
    detected.generation === 2,
    detected.generation === 1,
  );

  let changed = false;
  if (pathExists(stale.path)) {
    unlinkSync(stale.path);
    changed = true;
  }

  if (!symlinkPointsTo(current.path, [current.source])) {
    if (pathExists(current.path)) unlinkSync(current.path);
    mkdirSync(pluginRoot, { recursive: true });
    symlinkSync(current.source, current.path, current.sourceType);
    changed = true;
  }

  return {
    generation: detected.generation,
    version: detected.version,
    pluginPath: current.path,
    sourcePath: current.source,
    changed,
  };
}
