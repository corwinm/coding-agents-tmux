import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { stdin as input, stdout as output } from "node:process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { promptForPopupSelection } from "./cli/popup.ts";
import { renderCompactPaneList, renderInspectResult, renderPaneTable, renderStatusSummary, renderStatusTone, renderSwitchChoices } from "./cli/render.ts";
import { attachRuntimeToPanes, buildServerMapTemplate, getRuntimeProviderHelpText } from "./core/opencode.ts";
import { discoverOpencodePanes, findDiscoveredPaneByTarget, getCurrentTmuxTarget, switchToPane } from "./core/tmux.ts";
import { runCommand, sleep } from "./runtime.ts";
import type { InspectResult, PaneFilterOptions, PaneRuntimeSummary, PaneTarget, RuntimeProviderOptions } from "./types.ts";

interface ListOptions extends PaneFilterOptions, RuntimeProviderOptions {
  compact?: boolean;
  json?: boolean;
  interval?: string;
  watch?: boolean;
}

interface InspectOptions extends RuntimeProviderOptions {
  json?: boolean;
}

interface SwitchOptions extends PaneFilterOptions, RuntimeProviderOptions {}

interface ServerMapTemplateOptions {
  basePort?: string;
  hostname?: string;
}

interface PopupOptions extends SwitchOptions {
  height?: string;
  printCommand?: boolean;
  title?: string;
  width?: string;
}

interface PopupUiOptions extends SwitchOptions {}

interface StatusOptions extends RuntimeProviderOptions {
  json?: boolean;
  summary?: boolean;
  style?: "plain" | "tmux";
  tone?: boolean;
}

interface TmuxConfigOptions extends RuntimeProviderOptions {
  key?: string;
  popupFilter?: "all" | "busy" | "waiting" | "running" | "active";
}

interface InstallTmuxOptions extends TmuxConfigOptions {
  file?: string;
}

function getWindowKey(sessionName: string, windowIndex: number): string {
  return `${sessionName}:${windowIndex}`;
}

function getPaneWindowKey(entry: PaneRuntimeSummary): string {
  return getWindowKey(entry.pane.sessionName, entry.pane.windowIndex);
}

function getWindowKeyFromTarget(target: string): string {
  const match = target.match(/^(.*):(\d+)\.\d+$/);

  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new Error(`Unexpected tmux target: ${target}`);
  }

  return getWindowKey(match[1], Number(match[2]));
}

function getStatusRepresentativePriority(entry: PaneRuntimeSummary): number {
  switch (entry.runtime.status) {
    case "waiting-question":
    case "waiting-input":
      return 5;
    case "running":
      return 4;
    case "new":
      return 3;
    case "idle":
      return 2;
    default:
      return 1;
  }
}

function pickWindowStatusRepresentative(entries: PaneRuntimeSummary[]): PaneRuntimeSummary | null {
  return entries.reduce<PaneRuntimeSummary | null>((best, entry) => {
    if (!best) {
      return entry;
    }

    const bestPriority = getStatusRepresentativePriority(best);
    const entryPriority = getStatusRepresentativePriority(entry);

    if (entryPriority !== bestPriority) {
      return entryPriority > bestPriority ? entry : best;
    }

    return entry.pane.target.localeCompare(best.pane.target) < 0 ? entry : best;
  }, null);
}

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CLI_PATH = join(REPO_ROOT, "bin", "opencode-tmux");

async function loadPaneRuntimeSummaries(options: RuntimeProviderOptions = {}) {
  const panes = await discoverOpencodePanes();
  return attachRuntimeToPanes(panes, options);
}

function parseWatchInterval(value: string | undefined): number {
  if (!value) {
    return 2;
  }

  const interval = Number(value);

  if (!Number.isFinite(interval) || interval <= 0) {
    throw new Error(`Invalid watch interval: ${value}`);
  }

  return interval;
}

function parsePort(value: string | undefined, label: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  return port;
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function tmuxDoubleQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function buildShellRunCommand(args: string[]): string {
  return `cd ${shellEscape(process.cwd())} && ${buildSelfCommand(args)}`;
}

function buildPopupScriptCommand(args: string[]): string {
  const scriptPath = join(REPO_ROOT, "scripts", "tmux-popup-switch.sh");
  return [scriptPath, ...args].map(shellEscape).join(" ");
}

function buildSelfCommand(args: string[]): string {
  return [CLI_PATH, ...args].map(shellEscape).join(" ");
}

async function runTmuxCommand(args: string[]): Promise<void> {
  const { stderrText, exitCode } = await runCommand(["tmux", ...args]);

  if (exitCode !== 0) {
    throw new Error(stderrText.trim() || `tmux command failed: ${args.join(" ")}`);
  }
}

function renderListOutput(panes: PaneRuntimeSummary[], options: ListOptions): string {
  if (options.compact) {
    return renderCompactPaneList(panes);
  }

  if (options.json) {
    return JSON.stringify(panes, null, 2);
  }

  return renderPaneTable(panes);
}

function clearScreen(): void {
  output.write("\u001Bc");
}

async function watchListCommand(options: ListOptions): Promise<void> {
  const intervalSeconds = parseWatchInterval(options.interval);

  if (!output.isTTY) {
    throw new Error("Watch mode requires a TTY");
  }

  for (;;) {
    const panesWithRuntime = filterPaneSummaries(await loadPaneRuntimeSummaries(options), options);
    clearScreen();
    console.log(`opencode-tmux list --watch (${new Date().toLocaleTimeString()})`);
    console.log(`refresh every ${intervalSeconds}s`);
    console.log();
    console.log(renderListOutput(panesWithRuntime, options));
    await sleep(intervalSeconds * 1000);
  }
}

function filterPaneSummaries(panes: PaneRuntimeSummary[], options: PaneFilterOptions): PaneRuntimeSummary[] {
  return panes.filter((entry) => {
    if (options.active && !entry.pane.isActive) {
      return false;
    }

    if (options.waiting && !["waiting-question", "waiting-input"].includes(entry.runtime.status)) {
      return false;
    }

    if (options.busy && !["running", "waiting-question", "waiting-input"].includes(entry.runtime.status)) {
      return false;
    }

    if (options.running && entry.runtime.status !== "running") {
      return false;
    }

    return true;
  });
}

async function runListCommand(options: ListOptions): Promise<void> {
  const panesWithRuntime = filterPaneSummaries(await loadPaneRuntimeSummaries(options), options);

  if (options.watch) {
    await watchListCommand(options);
    return;
  }

  console.log(renderListOutput(panesWithRuntime, options));
}

async function runInspectCommand(target: string, options: InspectOptions): Promise<void> {
  const panes = await discoverOpencodePanes();
  const pane = findDiscoveredPaneByTarget(panes, target as PaneTarget);

  if (!pane) {
    throw new Error(`No discovered opencode pane matches target ${target}`);
  }

  const summary = (await attachRuntimeToPanes([pane], options))[0];

  if (!summary) {
    throw new Error(`Failed to inspect target ${target}`);
  }

  const result: InspectResult = {
    target: summary.pane.target,
    summary,
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(renderInspectResult(result));
}

function requirePaneByTarget(panes: PaneRuntimeSummary[], target: string): PaneRuntimeSummary {
  const pane = panes.find((entry) => entry.pane.target === target);

  if (!pane) {
    throw new Error(`No discovered opencode pane matches target ${target}`);
  }

  return pane;
}

async function promptForPaneSelection(panes: PaneRuntimeSummary[]): Promise<PaneRuntimeSummary> {
  const useProcessTty = Boolean(input.isTTY && output.isTTY);
  const canUseDevTty = existsSync("/dev/tty");

  if (!useProcessTty && !canUseDevTty) {
    throw new Error("Interactive switch requires a TTY. Pass an explicit target instead.");
  }

  const promptInput = useProcessTty ? input : createReadStream("/dev/tty");
  const promptOutput = useProcessTty ? output : createWriteStream("/dev/tty");

  promptOutput.write(`${renderSwitchChoices(panes)}\n`);

  const rl = createInterface({ input: promptInput, output: promptOutput });

  try {
    const answer = (await rl.question("\nEnter selection number or target: ")).trim();

    if (!answer) {
      throw new Error("No selection provided");
    }

    const index = Number(answer);

    if (Number.isInteger(index) && index >= 1 && index <= panes.length) {
      const pane = panes[index - 1];

      if (!pane) {
        throw new Error(`Invalid selection: ${answer}`);
      }

      return pane;
    }

    return requirePaneByTarget(panes, answer);
  } finally {
    rl.close();

    if (!useProcessTty) {
      promptInput.destroy();
      promptOutput.end();
    }
  }
}

async function runSwitchFilteredCommand(target: string | undefined, options: SwitchOptions): Promise<void> {
  const panes = filterPaneSummaries(await loadPaneRuntimeSummaries(options), options);

  if (panes.length === 0) {
    throw new Error("No discovered opencode panes match the requested filters");
  }

  const pane = target ? requirePaneByTarget(panes, target) : await promptForPaneSelection(panes);

  await switchToPane(pane.pane);
}

async function runPopupUiCommand(options: PopupUiOptions): Promise<void> {
  const pane = await promptForPopupSelection({
    loadPanes: async () => filterPaneSummaries(await loadPaneRuntimeSummaries(options), options),
  });

  if (!pane) {
    process.exit(0);
  }

  await switchToPane(pane.pane);
  process.exit(0);
}

async function runPopupCommand(options: PopupOptions): Promise<void> {
  const switchArgs: string[] = ["popup-ui"];

  if (options.provider) {
    switchArgs.push("--provider", options.provider);
  }

  if (options.serverMap) {
    switchArgs.push("--server-map", options.serverMap);
  }

  if (options.active) {
    switchArgs.push("--active");
  }

  if (options.waiting) {
    switchArgs.push("--waiting");
  }

  if (options.busy) {
    switchArgs.push("--busy");
  }

  if (options.running) {
    switchArgs.push("--running");
  }

  const popupCommand = buildSelfCommand(switchArgs);

  if (options.printCommand) {
    console.log(popupCommand);
    return;
  }

  if (!process.env.TMUX) {
    throw new Error("Popup mode requires running inside tmux");
  }

  const tmuxArgs = [
    "display-popup",
    "-E",
    "-w",
    options.width ?? "100%",
    "-h",
    options.height ?? "100%",
    "-T",
    options.title ?? "OpenCode Sessions",
    popupCommand,
  ];

  await runTmuxCommand(tmuxArgs);
}

async function runServerMapTemplateCommand(options: ServerMapTemplateOptions): Promise<void> {
  const panes = await discoverOpencodePanes();
  const basePort = parsePort(options.basePort, "base port");
  const templateOptions: { basePort?: number; hostname?: string } = {};

  if (basePort !== undefined) {
    templateOptions.basePort = basePort;
  }

  if (options.hostname) {
    templateOptions.hostname = options.hostname;
  }

  const template = buildServerMapTemplate(panes.map((entry) => entry.pane), templateOptions);
  console.log(JSON.stringify(template, null, 2));
}

async function runStatusCommand(options: StatusOptions): Promise<void> {
  const panes = await loadPaneRuntimeSummaries(options);
  const renderOptions = options.style ? { style: options.style } : {};

  if (options.summary || !process.env.TMUX) {
    if (options.tone) {
      console.log(renderStatusTone(null, panes));
      return;
    }

    if (options.json) {
      const busy = panes.filter((entry) => entry.runtime.activity === "busy").length;
      const waiting = panes.filter((entry) => entry.runtime.status === "waiting-question" || entry.runtime.status === "waiting-input").length;
      console.log(JSON.stringify({ mode: "summary", total: panes.length, busy, waiting }, null, 2));
      return;
    }

    console.log(renderStatusSummary(null, panes, renderOptions));
    return;
  }

  const currentTarget = await getCurrentTmuxTarget();
  const currentWindowKey = getWindowKeyFromTarget(currentTarget);
  const currentWindowPanes = panes.filter((entry) => getPaneWindowKey(entry) === currentWindowKey);
  const current = panes.find((entry) => entry.pane.target === currentTarget) ?? pickWindowStatusRepresentative(currentWindowPanes);
  const scopedPanes = current ? [current, ...panes.filter((entry) => getPaneWindowKey(entry) !== currentWindowKey)] : panes;
  const currentRenderOptions = options.style ? { style: options.style, includeCurrentPlaceholder: true } : { includeCurrentPlaceholder: true };

  if (options.tone) {
    console.log(renderStatusTone(current, scopedPanes));
    return;
  }

  if (options.json) {
    console.log(JSON.stringify({ mode: "current", target: currentTarget, current, summary: renderStatusSummary(current, scopedPanes, currentRenderOptions) }, null, 2));
    return;
  }

  console.log(renderStatusSummary(current, scopedPanes, currentRenderOptions));
}

function getPopupFilterArgs(filter: TmuxConfigOptions["popupFilter"]): string[] {
  switch (filter) {
    case "busy":
      return ["--busy"];
    case "waiting":
      return ["--waiting"];
    case "running":
      return ["--running"];
    case "active":
      return ["--active"];
    default:
      return [];
  }
}

async function runTmuxConfigCommand(options: TmuxConfigOptions): Promise<void> {
  console.log(buildTmuxSnippet(options));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTmuxSnippet(options: TmuxConfigOptions): string {
  const switchArgs: string[] = [];
  const statusArgs = ["status", "--style", "tmux"];

  if (options.provider) {
    switchArgs.push("--provider", options.provider);
    statusArgs.push("--provider", options.provider);
  }

  if (options.serverMap) {
    switchArgs.push("--server-map", options.serverMap);
    statusArgs.push("--server-map", options.serverMap);
  }

  switchArgs.push(...getPopupFilterArgs(options.popupFilter));

  const switchCommand = buildPopupScriptCommand(switchArgs);
  const statusCommand = buildShellRunCommand(statusArgs);
  const key = options.key ?? "O";

  return [
    "# >>> opencode-tmux >>>",
    `bind-key ${key} display-popup -E -w 100% -h 100% -T ${tmuxDoubleQuote("OpenCode Sessions")} ${tmuxDoubleQuote(switchCommand)}`,
    `set -g status-right ${tmuxDoubleQuote(`#(${statusCommand})`)}`,
    "# <<< opencode-tmux <<<",
  ].join("\n");
}

function getTmuxConfigPath(file: string | undefined): string {
  if (file) {
    return file;
  }

  return join(homedir(), ".tmux.conf");
}

async function runInstallTmuxCommand(options: InstallTmuxOptions): Promise<void> {
  const filePath = getTmuxConfigPath(options.file);
  const snippet = buildTmuxSnippet(options);
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const startMarker = "# >>> opencode-tmux >>>";
  const endMarker = "# <<< opencode-tmux <<<";
  const blockPattern = new RegExp(`${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}`);

  const next = blockPattern.test(existing)
    ? existing.replace(blockPattern, snippet)
    : `${existing.trimEnd()}${existing.trimEnd() ? "\n\n" : ""}${snippet}\n`;

  writeFileSync(filePath, next, "utf8");
  console.log(`Updated ${filePath}`);
  console.log("Reload tmux with: tmux source-file ~/.tmux.conf");
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("opencode-tmux")
    .description("CLI tooling for discovering and navigating opencode sessions running in tmux")
    .showHelpAfterError();

  program.addHelpText("after", `\n${getRuntimeProviderHelpText()}`);

  program
    .command("list")
    .description("List likely opencode tmux panes")
    .option("--compact", "Print tab-separated tmux-friendly output")
    .option("--json", "Print machine-readable JSON")
    .option("--provider <provider>", "Runtime provider: auto, plugin, sqlite, or server", "auto")
    .option("--server-map <value>", "JSON object or file path mapping pane targets to server endpoints")
    .option("--watch", "Continuously refresh pane status")
    .option("--interval <seconds>", "Watch refresh interval in seconds", "2")
    .option("--active", "Only include active tmux panes")
    .option("--waiting", "Only include panes waiting for question or freeform input")
    .option("--busy", "Only include panes that are running or waiting for user response")
    .option("--running", "Only include panes with runtime status 'running'")
    .action(runListCommand);

  program
    .command("inspect")
    .description("Inspect one discovered opencode tmux pane")
    .argument("<target>", "Pane target in session:window.pane format")
    .option("--json", "Print machine-readable JSON")
    .option("--provider <provider>", "Runtime provider: auto, plugin, sqlite, or server", "auto")
    .option("--server-map <value>", "JSON object or file path mapping pane targets to server endpoints")
    .action(runInspectCommand);

  program
    .command("switch")
    .description("Switch tmux to one discovered opencode pane")
    .argument("[target]", "Pane target in session:window.pane format")
    .option("--provider <provider>", "Runtime provider: auto, plugin, sqlite, or server", "auto")
    .option("--server-map <value>", "JSON object or file path mapping pane targets to server endpoints")
    .option("--active", "Only allow active tmux panes as candidates")
    .option("--waiting", "Only allow panes waiting for question or freeform input as candidates")
    .option("--busy", "Only allow panes that are running or waiting for user response as candidates")
    .option("--running", "Only allow panes with runtime status 'running' as candidates")
    .action(runSwitchFilteredCommand);

  program
    .command("server-map-template")
    .description("Print a JSON template for pane target to opencode server endpoint mappings")
    .option("--base-port <port>", "Assign sequential ports starting from this base port")
    .option("--hostname <hostname>", "Hostname to use in generated endpoints", "127.0.0.1")
    .action(runServerMapTemplateCommand);

  program
    .command("popup")
    .description("Open a tmux popup chooser for switching between discovered opencode panes")
    .option("--provider <provider>", "Runtime provider: auto, plugin, sqlite, or server", "auto")
    .option("--server-map <value>", "JSON object or file path mapping pane targets to server endpoints")
    .option("--active", "Only include active tmux panes")
    .option("--waiting", "Only include panes waiting for question or freeform input")
    .option("--busy", "Only include panes that are running or waiting for user response")
    .option("--running", "Only include panes with runtime status 'running'")
    .option("--width <value>", "Popup width", "100%")
    .option("--height <value>", "Popup height", "100%")
    .option("--title <value>", "Popup title", "OpenCode Sessions")
    .option("--print-command", "Print the popup's inner switch command instead of opening tmux")
    .action(runPopupCommand);

  program
    .command("popup-ui")
    .description("Run the interactive popup selector in the current terminal")
    .option("--provider <provider>", "Runtime provider: auto, plugin, sqlite, or server", "auto")
    .option("--server-map <value>", "JSON object or file path mapping pane targets to server endpoints")
    .option("--active", "Only include active tmux panes")
    .option("--waiting", "Only include panes waiting for question or freeform input")
    .option("--busy", "Only include panes that are running or waiting for user response")
    .option("--running", "Only include panes with runtime status 'running'")
    .action(runPopupUiCommand);

  program
    .command("status")
    .description("Print a tmux-friendly status summary")
    .option("--json", "Print machine-readable JSON")
    .option("--summary", "Summarize all discovered opencode panes instead of the current tmux pane")
    .option("--tone", "Print only the current summary tone")
    .option("--style <style>", "Status output style: plain or tmux", "plain")
    .option("--provider <provider>", "Runtime provider: auto, plugin, sqlite, or server", "auto")
    .option("--server-map <value>", "JSON object or file path mapping pane targets to server endpoints")
    .action(runStatusCommand);

  program
    .command("tmux-config")
    .description("Print a tmux config snippet for popup and status-line integration")
    .option("--provider <provider>", "Runtime provider: auto, plugin, sqlite, or server", "auto")
    .option("--server-map <value>", "JSON object or file path mapping pane targets to server endpoints")
    .option("--key <key>", "Tmux key binding for popup chooser", "O")
    .option("--popup-filter <filter>", "Popup default filter: all, busy, waiting, running, or active", "all")
    .action(runTmuxConfigCommand);

  program
    .command("install-tmux")
    .description("Install or update an opencode-tmux snippet in a tmux config file")
    .option("--provider <provider>", "Runtime provider: auto, plugin, sqlite, or server", "auto")
    .option("--server-map <value>", "JSON object or file path mapping pane targets to server endpoints")
    .option("--key <key>", "Tmux key binding for popup chooser", "O")
    .option("--popup-filter <filter>", "Popup default filter: all, busy, waiting, running, or active", "all")
    .option("--file <path>", "Tmux config file to update")
    .action(runInstallTmuxCommand);

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`opencode-tmux: ${message}`);
  process.exit(1);
});
