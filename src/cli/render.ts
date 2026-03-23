import type { InspectResult, PaneRuntimeSummary } from "../types.ts";

type StatusStyle = "plain" | "tmux";

type StatusTone = "neutral" | "busy" | "waiting" | "idle" | "unknown";

const statusToneColors: Record<StatusTone, string> = {
  neutral: process.env.OPENCODE_TMUX_STATUS_COLOR_NEUTRAL ?? "colour252",
  busy: process.env.OPENCODE_TMUX_STATUS_COLOR_BUSY ?? "colour220",
  waiting: process.env.OPENCODE_TMUX_STATUS_COLOR_WAITING ?? "colour196",
  idle: process.env.OPENCODE_TMUX_STATUS_COLOR_IDLE ?? "colour70",
  unknown: process.env.OPENCODE_TMUX_STATUS_COLOR_UNKNOWN ?? "colour244",
};

const statusPrefix = process.env.OPENCODE_TMUX_STATUS_PREFIX ?? "󰚩";
const statusShowPrefix = !["0", "false", "no", "off"].includes((process.env.OPENCODE_TMUX_STATUS_SHOW_PREFIX ?? "on").toLowerCase());

const columns = ["TARGET", "ACTIVE", "ACT", "STATUS", "SRC", "CONF", "SESSION", "TITLE", "PATH", "SIGNALS"] as const;

function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}

function truncate(value: string, maxWidth: number): string {
  if (value.length <= maxWidth) {
    return value;
  }

  if (maxWidth <= 1) {
    return value.slice(0, maxWidth);
  }

  return `${value.slice(0, maxWidth - 1)}...`;
}

export function renderPaneTable(panes: PaneRuntimeSummary[]): string {
  if (panes.length === 0) {
    return "No likely opencode tmux panes found.";
  }

  const rows = panes.map((entry) => ({
    target: entry.pane.target,
    active: entry.pane.isActive ? "*" : "",
    activity: entry.runtime.activity,
    status: entry.runtime.status,
    source: entry.runtime.source.replace("sqlite-", "sql-"),
    confidence: entry.detection.confidence,
    sessionTitle: truncate(entry.runtime.session?.title ?? "(unmatched)", 34),
    title: truncate(entry.pane.paneTitle || "(untitled)", 40),
    path: truncate(entry.pane.currentPath, 48),
    signals: truncate(entry.detection.reasons.join(", "), 40),
  }));

  const widths = {
    target: Math.max(columns[0].length, ...rows.map((row) => row.target.length)),
    active: columns[1].length,
    activity: Math.max(columns[2].length, ...rows.map((row) => row.activity.length)),
    status: Math.max(columns[3].length, ...rows.map((row) => row.status.length)),
    source: Math.max(columns[4].length, ...rows.map((row) => row.source.length)),
    confidence: Math.max(columns[5].length, ...rows.map((row) => row.confidence.length)),
    sessionTitle: Math.max(columns[6].length, ...rows.map((row) => row.sessionTitle.length)),
    title: Math.max(columns[7].length, ...rows.map((row) => row.title.length)),
    path: Math.max(columns[8].length, ...rows.map((row) => row.path.length)),
    signals: Math.max(columns[9].length, ...rows.map((row) => row.signals.length)),
  };

  const lines = [
    [
      pad(columns[0], widths.target),
      pad(columns[1], widths.active),
      pad(columns[2], widths.activity),
      pad(columns[3], widths.status),
      pad(columns[4], widths.source),
      pad(columns[5], widths.confidence),
      pad(columns[6], widths.sessionTitle),
      pad(columns[7], widths.title),
      pad(columns[8], widths.path),
      pad(columns[9], widths.signals),
    ].join("  "),
  ];

  for (const row of rows) {
    lines.push(
      [
        pad(row.target, widths.target),
        pad(row.active, widths.active),
        pad(row.activity, widths.activity),
        pad(row.status, widths.status),
        pad(row.source, widths.source),
        pad(row.confidence, widths.confidence),
        pad(row.sessionTitle, widths.sessionTitle),
        pad(row.title, widths.title),
        pad(row.path, widths.path),
        pad(row.signals, widths.signals),
      ].join("  "),
    );
  }

  return lines.join("\n");
}

export function renderCompactPaneList(panes: PaneRuntimeSummary[]): string {
  if (panes.length === 0) {
    return "";
  }

  return panes
    .map((entry) => {
      const sessionTitle = entry.runtime.session?.title ?? "(unmatched)";
      const title = entry.pane.paneTitle || "(untitled)";

      return [
        entry.pane.target,
        entry.runtime.activity,
        entry.runtime.status,
        entry.runtime.source,
        entry.pane.isActive ? "1" : "0",
        sessionTitle,
        title,
        entry.pane.currentPath,
      ].join("\t");
    })
    .join("\n");
}

function formatBoolean(value: boolean): string {
  return value ? "yes" : "no";
}

export function renderInspectResult(result: InspectResult): string {
  const { pane, detection, runtime } = result.summary;

  const lines = [
    `Target: ${result.target}`,
    "",
    "Pane",
    `  Session: ${pane.sessionName}`,
    `  Window: ${pane.windowIndex}`,
    `  Pane: ${pane.paneIndex}`,
    `  Pane ID: ${pane.paneId}`,
    `  Title: ${pane.paneTitle || "(untitled)"}`,
    `  Command: ${pane.currentCommand}`,
    `  Path: ${pane.currentPath}`,
    `  Active: ${formatBoolean(pane.isActive)}`,
    `  TTY: ${pane.tty}`,
    "",
    "Detection",
    `  Is OpenCode: ${formatBoolean(detection.isOpencode)}`,
    `  Confidence: ${detection.confidence}`,
    `  Signals: ${detection.reasons.length > 0 ? detection.reasons.join(", ") : "none"}`,
    "",
    "Runtime",
    `  Activity: ${runtime.activity}`,
    `  Status: ${runtime.status}`,
    `  Source: ${runtime.source}`,
    `  Match Strategy: ${runtime.match.strategy}`,
    `  Match Provider: ${runtime.match.provider}`,
    `  Match Heuristic: ${formatBoolean(runtime.match.heuristic)}`,
    `  Detail: ${runtime.detail}`,
  ];

  if (runtime.session) {
    lines.push(
      `  Session ID: ${runtime.session.id}`,
      `  Session Directory: ${runtime.session.directory}`,
      `  Session Title: ${runtime.session.title}`,
      `  Session Updated: ${new Date(runtime.session.timeUpdated).toISOString()}`,
    );
  } else {
    lines.push("  Session: none");
  }

  return lines.join("\n");
}

export function renderSwitchChoices(panes: PaneRuntimeSummary[]): string {
  if (panes.length === 0) {
    return "No likely opencode tmux panes found.";
  }

  const rows = panes.map((entry, index) => {
    return {
      index: String(index + 1),
      active: entry.pane.isActive ? "*" : "",
      target: entry.pane.target,
      status: getPaneStatusSymbol(entry),
      sessionTitle: truncate(entry.runtime.session?.title ?? "(unmatched)", 18),
      title: truncate(entry.pane.paneTitle || "(untitled)", 36),
      path: truncate(entry.pane.currentPath, 40),
    };
  });

  const widths = {
    index: Math.max(1, ...rows.map((row) => row.index.length)),
    active: 1,
    target: Math.max("TARGET".length, ...rows.map((row) => row.target.length)),
    status: Math.max("S".length, ...rows.map((row) => row.status.length)),
    sessionTitle: Math.max("SESSION".length, ...rows.map((row) => row.sessionTitle.length)),
    title: Math.max("TITLE".length, ...rows.map((row) => row.title.length)),
  };

  const lines = ["Select an opencode pane:", "", [pad("#", widths.index), pad("*", widths.active), pad("TARGET", widths.target), pad("S", widths.status), pad("SESSION", widths.sessionTitle), pad("TITLE", widths.title), "PATH"].join("  ")];

  for (const row of rows) {
    lines.push([pad(row.index, widths.index), pad(row.active, widths.active), pad(row.target, widths.target), pad(row.status, widths.status), pad(row.sessionTitle, widths.sessionTitle), pad(row.title, widths.title), row.path].join("  "));
  }

  return lines.join("\n");
}

function formatStatusToken(label: string, tone: StatusTone, style: StatusStyle, options: { bold?: boolean } = {}): string {
  if (style === "plain") {
    return label;
  }

  const color = statusToneColors[tone];

  if (options.bold) {
    return `#[bold,fg=${color}]${label}#[nobold]#[default]`;
  }

  return `#[fg=${color}]${label}#[default]`;
}

function getActivityTone(entry: PaneRuntimeSummary): "busy" | "waiting" | "idle" | "unknown" {
  if (entry.runtime.activity === "busy") {
    return entry.runtime.status.startsWith("waiting") ? "waiting" : "busy";
  }

  return entry.runtime.activity;
}

export function getPaneStatusLabel(entry: PaneRuntimeSummary): string {
  if (entry.runtime.status === "new") {
    return "new";
  }

  if (entry.runtime.status === "waiting-question" || entry.runtime.status === "waiting-input") {
    return "waiting";
  }

  if (entry.runtime.status === "running") {
    return "busy";
  }

  return entry.runtime.activity;
}

function getCurrentSymbol(entry: PaneRuntimeSummary): string {
  return getPaneStatusSymbol(entry);
}

function isWaitingEntry(entry: PaneRuntimeSummary): boolean {
  return entry.runtime.status === "waiting-question" || entry.runtime.status === "waiting-input";
}

function getBackgroundEntryTone(entry: PaneRuntimeSummary): StatusTone {
  if (isWaitingEntry(entry)) {
    return "waiting";
  }

  if (entry.runtime.status === "running") {
    return "busy";
  }

  if (entry.runtime.status === "idle") {
    return "idle";
  }

  if (entry.runtime.status === "new") {
    return entry.runtime.activity === "idle" ? "idle" : "neutral";
  }

  return entry.runtime.activity === "busy" ? "busy" : entry.runtime.activity;
}

export function getPaneStatusSymbol(entry: PaneRuntimeSummary): string {
  if (isWaitingEntry(entry)) {
    return "";
  }

  if (entry.runtime.status === "running") {
    return "";
  }

  if (entry.runtime.status === "idle") {
    return "";
  }

  if (entry.runtime.status === "new") {
    return "";
  }

  return "";
}

export function renderStatusTone(current: PaneRuntimeSummary | null, panes: PaneRuntimeSummary[]): StatusTone {
  const backgroundPanes = current ? panes.filter((entry) => entry.pane.target !== current.pane.target) : panes;

  if ((current && isWaitingEntry(current)) || backgroundPanes.some(isWaitingEntry)) {
    return "waiting";
  }

  if (current) {
    return getActivityTone(current);
  }

  if (panes.some((entry) => entry.runtime.activity === "busy")) {
    return "busy";
  }

  if (panes.some((entry) => entry.runtime.activity === "idle")) {
    return "idle";
  }

  return "unknown";
}

function renderBackgroundSummary(panes: PaneRuntimeSummary[], style: StatusStyle): string[] {
  if (panes.length === 0) {
    return [formatStatusToken("none", "unknown", style)];
  }

  const separator = panes.length > 8 ? "" : " ";
  const orderedPanes = [...panes].sort((left, right) => left.pane.target.localeCompare(right.pane.target));
  const summary = orderedPanes
    .map((entry) => formatStatusToken(getPaneStatusSymbol(entry), getBackgroundEntryTone(entry), style, { bold: true }))
    .join(separator);

  return [summary];
}

function renderCurrentSummary(current: PaneRuntimeSummary | null, style: StatusStyle): string[] {
  if (!current) {
    return [formatStatusToken("none", "unknown", style)];
  }

  const activityTone = getActivityTone(current);
  const label = `${getCurrentSymbol(current)} ${getPaneStatusLabel(current)}`;

  return [formatStatusToken(label, activityTone, style)];
}

export function renderStatusSummary(
  current: PaneRuntimeSummary | null,
  panes: PaneRuntimeSummary[],
  options: { includeCurrentPlaceholder?: boolean; style?: StatusStyle } = {},
): string {
  const style = options.style ?? "plain";

  if (current) {
    const backgroundPanes = panes.filter((entry) => entry.pane.target !== current.pane.target);
    const parts = [...renderCurrentSummary(current, style), formatStatusToken("|", "neutral", style), ...renderBackgroundSummary(backgroundPanes, style)];

    if (statusShowPrefix) {
      return [formatStatusToken(statusPrefix, "neutral", style), formatStatusToken("|", "neutral", style), ...parts].join(" ");
    }

    return parts.join(" ");
  }

  if (options.includeCurrentPlaceholder) {
    const parts = [...renderCurrentSummary(null, style), formatStatusToken("|", "neutral", style), ...renderBackgroundSummary(panes, style)];

    if (statusShowPrefix) {
      return [formatStatusToken(statusPrefix, "neutral", style), formatStatusToken("|", "neutral", style), ...parts].join(" ");
    }

    return parts.join(" ");
  }

  if (statusShowPrefix) {
    return [formatStatusToken(statusPrefix, "neutral", style), formatStatusToken("|", "neutral", style), ...renderBackgroundSummary(panes, style)].join(" ");
  }

  return renderBackgroundSummary(panes, style).join(" ");
}
