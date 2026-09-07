import { runCommand } from "../runtime.ts";

export const NOTIFY_COMMAND_OPTION = "@coding-agents-tmux-notify-command";

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

    await runCommand([process.env.SHELL ?? "/bin/sh", "-c", command]);
  } catch {
    // Notifications are optional and must not interrupt agent state updates.
  }
}
