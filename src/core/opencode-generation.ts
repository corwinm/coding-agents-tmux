import { spawn } from "node:child_process";

export type OpenCodeGeneration = 1 | 2;

export interface OpenCodeVersion {
  generation: OpenCodeGeneration;
  version: string;
}

export type OpenCodeVersionErrorKind =
  | "command-failed"
  | "malformed"
  | "not-found"
  | "timeout"
  | "unsupported";

export class OpenCodeVersionError extends Error {
  readonly kind: OpenCodeVersionErrorKind;

  constructor(message: string, kind: OpenCodeVersionErrorKind) {
    super(message);
    this.name = "OpenCodeVersionError";
    this.kind = kind;
  }
}

export interface DetectOpenCodeVersionOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const DEFAULT_VERSION_TIMEOUT_MS = 3_000;
const MINIMUM_V1 = [1, 18, 29] as const;

function compareVersion(
  actual: readonly [number, number, number],
  minimum: readonly [number, number, number],
): number {
  for (let index = 0; index < actual.length; index += 1) {
    const difference = (actual[index] ?? 0) - (minimum[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function parseOpenCodeVersion(output: string): OpenCodeVersion {
  const trimmed = output.trim();
  const prefixed = /^opencode v(\d+)\.(\d+)\.(\d+)$/.exec(trimmed);
  const bare = /^(\d+)\.(\d+)\.(\d+)$/.exec(trimmed);
  const match = prefixed ?? bare;

  if (!match || (!prefixed && match[1] !== "1")) {
    throw new OpenCodeVersionError(
      `Unrecognized OpenCode version output: ${JSON.stringify(trimmed)}`,
      "malformed",
    );
  }

  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  const version = `${parts[0]}.${parts[1]}.${parts[2]}`;

  if (parts[0] === 1) {
    if (compareVersion(parts, MINIMUM_V1) < 0) {
      throw new OpenCodeVersionError(
        `OpenCode V1 ${version} is unsupported; install OpenCode V1 1.18.29 or newer, or upgrade to V2`,
        "unsupported",
      );
    }
    return { generation: 1, version };
  }

  if (parts[0] === 2) {
    return { generation: 2, version };
  }

  throw new OpenCodeVersionError(
    `OpenCode major version ${parts[0]} is unsupported; supported versions are V1 1.18.29+ and V2`,
    "unsupported",
  );
}

export async function detectOpenCodeVersion(
  options: DetectOpenCodeVersionOptions = {},
): Promise<OpenCodeVersion> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn("opencode", ["--version"], {
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      action();
    };

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() =>
        reject(
          new OpenCodeVersionError(`opencode --version timed out after ${timeoutMs}ms`, "timeout"),
        ),
      );
    }, timeoutMs);
    timeout.unref();

    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(() => {
        if (error.code === "ENOENT") {
          reject(
            new OpenCodeVersionError(
              "OpenCode executable was not found in PATH; install OpenCode before installing its plugin",
              "not-found",
            ),
          );
          return;
        }
        reject(
          new OpenCodeVersionError(
            `Unable to run opencode --version: ${error.message}`,
            "command-failed",
          ),
        );
      });
    });

    child.once("close", (exitCode) => {
      finish(() => {
        if (exitCode !== 0) {
          const detail = (stderr || stdout).trim();
          reject(
            new OpenCodeVersionError(
              `opencode --version failed with exit code ${exitCode ?? 1}${detail ? `: ${detail}` : ""}`,
              "command-failed",
            ),
          );
          return;
        }

        try {
          resolve(parseOpenCodeVersion(stdout));
        } catch (error) {
          reject(error);
        }
      });
    });
  });
}
