import { spawn } from "node:child_process";

export interface CommandResult {
  exitCode: number;
  stderrText: string;
  stdoutText: string;
}

export async function runCommand(command: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command[0] ?? "", command.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutText = "";
    let stderrText = "";

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");

    proc.stdout.on("data", (chunk: string) => {
      stdoutText += chunk;
    });

    proc.stderr.on("data", (chunk: string) => {
      stderrText += chunk;
    });

    proc.on("error", (error) => {
      reject(error);
    });

    proc.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stderrText,
        stdoutText,
      });
    });
  });
}

export async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
