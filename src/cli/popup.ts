import { stdin as input, stdout as output } from "node:process";

import type { PaneRuntimeSummary } from "../types.ts";

interface PopupSelectorOptions {
  loadPanes: () => Promise<PaneRuntimeSummary[]>;
}

const ansi = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[38;5;244m",
  rowBackground: "\u001b[48;5;236m",
  rowForeground: "\u001b[38;5;255m",
  rowIndicator: "\u001b[38;5;196m",
};

function truncate(value: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return "";
  }

  if (value.length <= maxWidth) {
    return value;
  }

  if (maxWidth <= 3) {
    return value.slice(0, maxWidth);
  }

  return `${value.slice(0, maxWidth - 3)}...`;
}

function pad(value: string, width: number): string {
  return truncate(value, width).padEnd(width, " ");
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function getPopupStateLabel(entry: PaneRuntimeSummary): string {
  if (entry.runtime.status === "waiting-question" || entry.runtime.status === "waiting-input") {
    return "waiting";
  }

  if (entry.runtime.status === "running") {
    return "busy";
  }

  if (entry.runtime.status === "new") {
    return "new";
  }

  return entry.runtime.activity;
}

function getSessionLabel(entry: PaneRuntimeSummary): string {
  return entry.runtime.session?.title ?? "(unmatched)";
}

function buildSearchText(entry: PaneRuntimeSummary): string {
  return [
    entry.pane.target,
    getPopupStateLabel(entry),
    getSessionLabel(entry),
    entry.pane.paneTitle || "(untitled)",
    entry.pane.currentPath,
  ]
    .join(" ")
    .toLowerCase();
}

function matchesQuery(entry: PaneRuntimeSummary, query: string): boolean {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length === 0) {
    return true;
  }

  const haystack = buildSearchText(entry);
  return tokens.every((token) => haystack.includes(token));
}

function filterPanes(panes: PaneRuntimeSummary[], query: string): PaneRuntimeSummary[] {
  return panes.filter((entry) => matchesQuery(entry, query));
}

function formatQueryLine(query: string, width: number, filteredCount: number, totalCount: number): { line: string; cursorColumn: number } {
  const prefix = "> ";
  const countLabel = `${filteredCount}/${totalCount}`;
  const minimumGap = 2;
  const anchorColumn = 40;
  const reservedWidth = prefix.length + countLabel.length + minimumGap;
  const maxQueryWidth = Math.max(0, width - reservedWidth);

  if (maxQueryWidth === 0) {
    return { line: truncate(`${prefix}${countLabel}`, width), cursorColumn: Math.max(1, Math.min(width, prefix.length + 1)) };
  }

  const visibleQuery =
    query.length <= maxQueryWidth
      ? query
      : maxQueryWidth <= 3
        ? query.slice(query.length - maxQueryWidth)
        : `...${query.slice(query.length - maxQueryWidth + 3)}`;

  const queryText = `${prefix}${visibleQuery}`;
  const anchoredCountStart = Math.min(anchorColumn, Math.max(queryText.length + minimumGap, width - countLabel.length));
  const farRightCountStart = Math.max(queryText.length + minimumGap, width - countLabel.length);
  const countStart = queryText.length <= anchorColumn - minimumGap ? anchoredCountStart : farRightCountStart;
  const gapWidth = Math.max(minimumGap, countStart - queryText.length);
  const line = `${queryText}${" ".repeat(gapWidth)}${countLabel}`;
  return { line: truncate(line, width), cursorColumn: Math.min(width, prefix.length + visibleQuery.length) + 1 };
}

function getIndexWidth(count: number): number {
  return Math.max(1, String(Math.max(1, count)).length);
}

function buildListLayout(width: number, indexWidth: number) {
  const markerWidth = 2;
  const stateWidth = 8;
  let targetWidth = clamp(Math.floor(width * 0.22), 14, 26);
  let sessionWidth = clamp(Math.floor(width * 0.18), 12, 20);
  const separatorsWidth = markerWidth + indexWidth + 8;
  let titleWidth = width - separatorsWidth - stateWidth - targetWidth - sessionWidth;

  while (titleWidth < 16 && targetWidth > 14) {
    targetWidth -= 1;
    titleWidth += 1;
  }

  while (titleWidth < 16 && sessionWidth > 12) {
    sessionWidth -= 1;
    titleWidth += 1;
  }

  titleWidth = Math.max(12, titleWidth);

  return {
    markerWidth,
    sessionWidth,
    stateWidth,
    targetWidth,
    titleWidth,
  };
}

function renderListHeader(width: number, indexWidth: number): string[] {
  const layout = buildListLayout(width, indexWidth);
  const header = [
    "  ",
    pad("#", indexWidth),
    "  ",
    pad("STATE", layout.stateWidth),
    "  ",
    pad("TARGET", layout.targetWidth),
    "  ",
    pad("SESSION", layout.sessionWidth),
    "  ",
    pad("TITLE", layout.titleWidth),
  ].join("");

  return [`${ansi.dim}${truncate(header, width)}${ansi.reset}`, `${ansi.dim}${"-".repeat(Math.min(width, header.length))}${ansi.reset}`];
}

function renderListRow(entry: PaneRuntimeSummary, rowIndex: number, selected: boolean, width: number, indexWidth: number): string {
  const layout = buildListLayout(width, indexWidth);
  const row = [
    selected ? "> " : "  ",
    pad(String(rowIndex), indexWidth),
    "  ",
    pad(getPopupStateLabel(entry), layout.stateWidth),
    "  ",
    pad(entry.pane.target, layout.targetWidth),
    "  ",
    pad(getSessionLabel(entry), layout.sessionWidth),
    "  ",
    pad(entry.pane.paneTitle || "(untitled)", layout.titleWidth),
  ].join("");

  const line = truncate(row, width).padEnd(width, " ");

  if (!selected) {
    return line;
  }

  return `${ansi.rowBackground}${ansi.rowIndicator}> ${ansi.rowForeground}${ansi.bold}${line.slice(2)}${ansi.reset}`;
}

function renderDetailLine(label: string, value: string, width: number): string {
  const prefix = `${label}: `;
  return truncate(`${prefix}${value}`, width);
}

function buildDetailLines(selectedPane: PaneRuntimeSummary | null, width: number): string[] {
  if (!selectedPane) {
    return ["Selected", truncate("No matching panes.", width)];
  }

  const state = `${getPopupStateLabel(selectedPane)} (${selectedPane.runtime.status})`;

  return [
    "Selected",
    renderDetailLine("Target", selectedPane.pane.target, width),
    renderDetailLine("State", state, width),
    renderDetailLine("Session", getSessionLabel(selectedPane), width),
    renderDetailLine("Title", selectedPane.pane.paneTitle || "(untitled)", width),
    renderDetailLine("Path", selectedPane.pane.currentPath, width),
  ];
}

function getSelectionIndex(panes: PaneRuntimeSummary[], selectedTarget: string | null): number {
  if (!selectedTarget) {
    return 0;
  }

  const index = panes.findIndex((entry) => entry.pane.target === selectedTarget);
  return index >= 0 ? index : 0;
}

function renderPopupScreen(
  panes: PaneRuntimeSummary[],
  query: string,
  selectedTarget: string | null,
  message: string,
  refreshing: boolean,
): void {
  const width = Math.max(40, output.columns ?? 80);
  const height = Math.max(12, output.rows ?? 24);
  const filtered = filterPanes(panes, query);
  const indexWidth = getIndexWidth(panes.length);
  const selectedIndex = getSelectionIndex(filtered, selectedTarget);
  const selectedPane = filtered[selectedIndex] ?? null;
  const statusLine = refreshing ? "Refreshing..." : message;
  const queryLine = formatQueryLine(query, width, filtered.length, panes.length);
  const headerLines = [
    queryLine.line,
    "",
    ...renderListHeader(width, indexWidth),
  ];
  if (statusLine) {
    headerLines.splice(1, 0, truncate(statusLine, width));
  }
  const detailLines = buildDetailLines(selectedPane, width);
  const listHeight = Math.max(4, height - headerLines.length - detailLines.length - 1);
  const windowStart = clamp(selectedIndex - Math.floor(listHeight / 2), 0, Math.max(0, filtered.length - listHeight));
  const visibleRows = filtered.slice(windowStart, windowStart + listHeight);
  const listLines = visibleRows.map((entry, index) => renderListRow(entry, windowStart + index + 1, entry.pane.target === selectedPane?.pane.target, width, indexWidth));

  while (listLines.length < listHeight) {
    listLines.push("");
  }

  const frame = [...headerLines, ...listLines, "", ...detailLines].join("\n");
  output.write(`\u001b[2J\u001b[H${frame}\u001b[1;${queryLine.cursorColumn}H`);
}

export async function promptForPopupSelection(options: PopupSelectorOptions): Promise<PaneRuntimeSummary | null> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Popup UI requires a TTY");
  }

  let panes = await options.loadPanes();
  let query = "";
  let message = panes.length === 0 ? "No matching panes right now. Press Esc to close or Ctrl-R to refresh." : "";
  let selectedTarget = panes[0]?.pane.target ?? null;
  let refreshing = false;
  let quickSelectPending = false;

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      if (input.isTTY) {
        input.setRawMode(false);
      }

      input.pause();
      input.removeListener("data", onData);
      output.removeListener("resize", onResize);
      output.write("\u001b[0m\u001b[?25h");
    };

    const settle = (result: PaneRuntimeSummary | null, error?: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();

      if (error) {
        reject(error);
        return;
      }

      resolve(result);
    };

    const syncSelection = () => {
      const filtered = filterPanes(panes, query);

      if (filtered.length === 0) {
        selectedTarget = null;
        return filtered;
      }

      if (!selectedTarget || !filtered.some((entry) => entry.pane.target === selectedTarget)) {
        selectedTarget = filtered[0]?.pane.target ?? null;
      }

      return filtered;
    };

    const render = () => {
      syncSelection();
      renderPopupScreen(panes, query, selectedTarget, message, refreshing);
    };

    const clearQuickSelect = () => {
      quickSelectPending = false;
    };

    const moveSelection = (delta: number) => {
      const filtered = syncSelection();

      if (filtered.length === 0) {
        return;
      }

      clearQuickSelect();

      const currentIndex = getSelectionIndex(filtered, selectedTarget);
      const nextIndex = clamp(currentIndex + delta, 0, filtered.length - 1);
      selectedTarget = filtered[nextIndex]?.pane.target ?? selectedTarget;
    };

    const refresh = async () => {
      if (refreshing) {
        return;
      }

      refreshing = true;
      message = "";
      render();

      try {
        panes = await options.loadPanes();
        if (panes.length === 0) {
          selectedTarget = null;
          message = "No matching panes right now. Press Esc to close or keep typing to retry later.";
        } else if (!panes.some((entry) => entry.pane.target === selectedTarget)) {
          selectedTarget = panes[0]?.pane.target ?? null;
          message = "";
        } else {
          message = "";
        }
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      } finally {
        refreshing = false;
        render();
      }
    };

    const onResize = () => {
      render();
    };

    const handleInput = (value: string) => {
      if (value === "\u0003") {
        settle(null);
        return;
      }

      if (quickSelectPending && value === "\u001b") {
        clearQuickSelect();
        message = "";
        render();
        return;
      }

      if (quickSelectPending && value === "\u0007") {
        clearQuickSelect();
        message = "";
        render();
        return;
      }

      if (value === "\u001b") {
        settle(null);
        return;
      }

      if (value === "\u0012") {
        clearQuickSelect();
        void refresh();
        return;
      }

      if (value === "\u0015") {
        clearQuickSelect();
        query = "";
        message = "";
        render();
        return;
      }

      if (value === "\u0017") {
        clearQuickSelect();
        query = query.replace(/\s*\S+\s*$/, "");
        message = "";
        render();
        return;
      }

      if (value === "\u0007") {
        quickSelectPending = true;
        message = "Quick select: press 1-9";
        render();
        return;
      }

      if (quickSelectPending) {
        const filtered = syncSelection();

        clearQuickSelect();

        if (value >= "1" && value <= "9") {
          const pane = filtered[Number(value) - 1] ?? null;

          if (!pane) {
            message = `No row ${value}`;
            render();
            return;
          }

          settle(pane);
          return;
        }

        if (value !== "\u001b") {
          message = "Quick select cancelled";
          render();
        }
      }

      if (value === "\r") {
        const filtered = syncSelection();
        const selectedPane = filtered[getSelectionIndex(filtered, selectedTarget)] ?? null;

        if (!selectedPane) {
          message = panes.length === 0 ? "No panes available to switch to." : "No filtered match to switch to.";
          render();
          return;
        }

        settle(selectedPane);
        return;
      }

      if (value === "\n") {
        moveSelection(1);
        message = "";
        render();
        return;
      }

      if (value === "\u000b") {
        moveSelection(-1);
        message = "";
        render();
        return;
      }

      if (value === "\u001b[A") {
        moveSelection(-1);
        message = "";
        render();
        return;
      }

      if (value === "\u001b[B") {
        moveSelection(1);
        message = "";
        render();
        return;
      }

      if (value === "\u001b[5~") {
        moveSelection(-8);
        message = "";
        render();
        return;
      }

      if (value === "\u001b[6~") {
        moveSelection(8);
        message = "";
        render();
        return;
      }

      if (value === "\u001b[H" || value === "\u001b[1~") {
        const filtered = syncSelection();
        selectedTarget = filtered[0]?.pane.target ?? selectedTarget;
        message = "";
        render();
        return;
      }

      if (value === "\u001b[F" || value === "\u001b[4~") {
        const filtered = syncSelection();
        selectedTarget = filtered.at(-1)?.pane.target ?? selectedTarget;
        message = "";
        render();
        return;
      }

      if (value === "\u007f") {
        clearQuickSelect();
        query = query.slice(0, -1);
        message = "";
        render();
        return;
      }

      if (value >= " ") {
        clearQuickSelect();
        query += value;
        message = "";
        render();
      }
    };

    const onData = (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let index = 0;

      while (index < text.length && !settled) {
        const rest = text.slice(index);

        if (rest.startsWith("\u001b[5~")) {
          handleInput("\u001b[5~");
          index += 4;
          continue;
        }

        if (rest.startsWith("\u001b[6~")) {
          handleInput("\u001b[6~");
          index += 4;
          continue;
        }

        if (rest.startsWith("\u001b[1~") || rest.startsWith("\u001b[4~")) {
          handleInput(rest.slice(0, 4));
          index += 4;
          continue;
        }

        if (rest.startsWith("\u001b[A") || rest.startsWith("\u001b[B") || rest.startsWith("\u001b[H") || rest.startsWith("\u001b[F")) {
          handleInput(rest.slice(0, 3));
          index += 3;
          continue;
        }

        handleInput(rest[0] ?? "");
        index += 1;
      }
    };

    try {
      input.setEncoding("utf8");
      input.setRawMode(true);
      input.resume();
      output.on("resize", onResize);
      input.on("data", onData);
      output.write("\u001b[?25h");
      render();
    } catch (error) {
      settle(null, error instanceof Error ? error : new Error(String(error)));
    }
  });
}
