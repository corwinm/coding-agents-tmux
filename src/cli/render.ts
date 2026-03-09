import type { InspectResult, PaneRuntimeSummary } from "../types";

type StatusStyle = "plain" | "tmux";

function getStatusIcon(current: PaneRuntimeSummary | null, panes: PaneRuntimeSummary[]): string {
  if (current) {
    if (current.runtime.status === "waiting-question") {
      return "?";
    }

    if (current.runtime.status === "waiting-input") {
      return ">";
    }

    if (current.runtime.activity === "busy") {
      return "*";
    }

    if (current.runtime.activity === "idle") {
      return "-";
    }

    return "~";
  }

  if (panes.length === 0) {
    return "-";
  }

  if (panes.some((entry) => entry.runtime.status === "waiting-question" || entry.runtime.status === "waiting-input")) {
    return "!";
  }

  if (panes.some((entry) => entry.runtime.activity === "busy")) {
    return "*";
  }

  if (panes.every((entry) => entry.runtime.activity === "idle")) {
    return "-";
  }

  return "~";
}

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

  const lines = ["Select an opencode pane:", ""];

  for (const [index, entry] of panes.entries()) {
    const marker = entry.pane.isActive ? "*" : " ";
    const sessionTitle = truncate(entry.runtime.session?.title ?? "(unmatched)", 28);
    const title = truncate(entry.pane.paneTitle || "(untitled)", 36);
    const path = truncate(entry.pane.currentPath, 32);
    lines.push(
      `${String(index + 1).padStart(2, " ")}. [${marker}] ${entry.pane.target}  ${entry.runtime.activity}/${entry.runtime.status}  ${sessionTitle}  ${title}  ${path}`,
    );
  }

  return lines.join("\n");
}

function formatStatusToken(label: string, tone: "neutral" | "busy" | "waiting" | "idle" | "unknown", style: StatusStyle): string {
  if (style === "plain") {
    return label;
  }

  const color =
    tone === "busy"
      ? "colour220"
      : tone === "waiting"
        ? "colour196"
        : tone === "idle"
          ? "colour70"
          : tone === "unknown"
            ? "colour244"
            : "colour252";

  return `#[fg=${color}]${label}#[default]`;
}

export function renderStatusSummary(
  current: PaneRuntimeSummary | null,
  panes: PaneRuntimeSummary[],
  options: { style?: StatusStyle } = {},
): string {
  const style = options.style ?? "plain";
  const icon = getStatusIcon(current, panes);

  if (current) {
    const activityTone =
      current.runtime.activity === "busy" ? (current.runtime.status.startsWith("waiting") ? "waiting" : "busy") : current.runtime.activity;

    return [
      formatStatusToken("OC", "neutral", style),
      formatStatusToken(icon, activityTone, style),
      formatStatusToken(current.runtime.activity, activityTone, style),
      formatStatusToken(current.runtime.status, activityTone, style),
    ].join(" ");
  }

  if (panes.length === 0) {
    return [formatStatusToken("OC", "neutral", style), formatStatusToken(icon, "unknown", style), formatStatusToken("none", "unknown", style)].join(" ");
  }

  const busy = panes.filter((entry) => entry.runtime.activity === "busy").length;
  const waiting = panes.filter((entry) => entry.runtime.status === "waiting-question" || entry.runtime.status === "waiting-input").length;

  if (busy === 0) {
    return [
      formatStatusToken("OC", "neutral", style),
      formatStatusToken(icon, "idle", style),
      formatStatusToken(String(panes.length), "idle", style),
      formatStatusToken("idle", "idle", style),
    ].join(" ");
  }

  if (waiting === 0) {
    return [
      formatStatusToken("OC", "neutral", style),
      formatStatusToken(icon, "busy", style),
      formatStatusToken(String(busy), "busy", style),
      formatStatusToken("busy", "busy", style),
    ].join(" ");
  }

  return [
    formatStatusToken("OC", "neutral", style),
    formatStatusToken(icon, "waiting", style),
    formatStatusToken(String(busy), "busy", style),
    formatStatusToken("busy", "busy", style),
    formatStatusToken(String(waiting), "waiting", style),
    formatStatusToken("waiting", "waiting", style),
  ].join(" ");
}
