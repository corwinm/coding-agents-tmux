import { spawn, type ChildProcess } from "node:child_process";

import { runCommand } from "../runtime.ts";

export const NOTIFY_COMMAND_OPTION = "@coding-agents-tmux-notify-command";
const NOTIFICATION_TIMEOUT_MS = 5_000;

export function dispatchNotificationCommand(
  command: string,
  timeoutMs = NOTIFICATION_TIMEOUT_MS,
): ChildProcess {
  const child = spawn(process.env.SHELL ?? "/bin/sh", ["-c", command], { stdio: "ignore" });
  const timeout = setTimeout(() => child.kill(), timeoutMs);
  const clear = () => clearTimeout(timeout);

  timeout.unref();
  child.once("error", clear);
  child.once("exit", clear);
  child.unref();
  return child;
}

export async function notifyIntegration(): Promise<void> {
  try {
    await runCommand(["tmux", "refresh-client", "-S"]);
  } catch {
    // A detached or unavailable tmux client must not block external notifications.
  }

  try {
    const option = await runCommand(["tmux", "show-option", "-gqv", NOTIFY_COMMAND_OPTION]);
    const command = option.exitCode === 0 ? option.stdoutText.trim() : "";

    if (!command) {
      return;
    }

    dispatchNotificationCommand(command);
  } catch {
    // Notifications are optional and must not interrupt agent state updates.
  }
}
