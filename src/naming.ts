import { homedir } from "node:os";
import { join } from "node:path";

export const PRODUCT_SLUG = "coding-agents-tmux";
export const PRIMARY_CLI_NAME = "coding-agents-tmux";

export function getEnvValue(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

export function getStateHome(): string {
  return process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
}

export function getPreferredStateDir(input: { env: string; subdirectory: string }): string {
  return getEnvValue(input.env) ?? join(getStateHome(), PRODUCT_SLUG, input.subdirectory);
}

export function getStateDirCandidates(input: { env: string; subdirectory: string }): string[] {
  const explicitDir = getEnvValue(input.env);

  if (explicitDir) {
    return [explicitDir];
  }

  return [join(getStateHome(), PRODUCT_SLUG, input.subdirectory)];
}
