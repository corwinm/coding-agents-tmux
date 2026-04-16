import { homedir } from "node:os";
import { join } from "node:path";

export const PRODUCT_SLUG = "coding-agents-tmux";
export const LEGACY_PRODUCT_SLUG = "opencode-tmux";
export const PRIMARY_CLI_NAME = "coding-agents-tmux";
export const LEGACY_CLI_NAME = "opencode-tmux";

export function getEnvAliasValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];

    if (value && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

export function getStateHome(): string {
  return process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
}

export function getPreferredStateDir(input: {
  preferredEnv: string;
  legacyEnv: string;
  subdirectory: string;
}): string {
  return (
    getEnvAliasValue(input.preferredEnv, input.legacyEnv) ??
    join(getStateHome(), PRODUCT_SLUG, input.subdirectory)
  );
}

export function getStateDirCandidates(input: {
  preferredEnv: string;
  legacyEnv: string;
  subdirectory: string;
}): string[] {
  const explicitDir = getEnvAliasValue(input.preferredEnv, input.legacyEnv);

  if (explicitDir) {
    return [explicitDir];
  }

  return [
    join(getStateHome(), PRODUCT_SLUG, input.subdirectory),
    join(getStateHome(), LEGACY_PRODUCT_SLUG, input.subdirectory),
  ];
}
