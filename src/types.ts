export type PaneTarget = `${string}:${number}.${number}`;

export type AgentKind = "opencode" | "codex" | "pi" | "claude" | "kiro" | "copilot";

export interface TmuxPane {
  sessionName: string;
  windowIndex: number;
  paneIndex: number;
  paneId: string;
  paneTitle: string;
  currentCommand: string;
  currentPath: string;
  isActive: boolean;
  tty: string;
  target: PaneTarget;
}

export type DetectionConfidence = "high" | "medium" | "low";

export interface PaneDetection {
  agent: AgentKind | null;
  confidence: DetectionConfidence;
  reasons: string[];
}

export interface DiscoveredPane {
  pane: TmuxPane;
  detection: PaneDetection;
}

export type RuntimeStatus =
  | "running"
  | "waiting-question"
  | "waiting-input"
  | "idle"
  | "new"
  | "unknown";
export type RuntimeActivity = "busy" | "idle" | "unknown";

export interface SessionMatch {
  id: string;
  directory: string;
  title: string;
  timeUpdated: number;
}

export type RuntimeSource =
  | "codex-hook"
  | "codex-preview"
  | "plugin-exact"
  | "plugin-descendant"
  | "server-explicit"
  | "sqlite-exact"
  | "sqlite-descendant-running"
  | "sqlite-descendant-recent"
  | "sqlite-descendant-only"
  | "codex-command"
  | "pi-extension"
  | "pi-preview"
  | "pi-command"
  | "claude-hook"
  | "claude-preview"
  | "claude-command"
  | "kiro-preview"
  | "kiro-command"
  | "copilot-command"
  | "unmapped";

export interface RuntimeMatchInfo {
  strategy:
    | "target-map"
    | "exact"
    | "descendant-running"
    | "descendant-recent"
    | "descendant-only"
    | "unmapped";
  provider:
    | "plugin"
    | "server"
    | "sqlite"
    | "codex"
    | "pi"
    | "claude"
    | "kiro"
    | "copilot"
    | "none";
  heuristic: boolean;
}

export interface RuntimeInfo {
  activity: RuntimeActivity;
  status: RuntimeStatus;
  source: RuntimeSource;
  match: RuntimeMatchInfo;
  session: SessionMatch | null;
  detail: string;
}

export interface PaneRuntimeSummary extends DiscoveredPane {
  runtime: RuntimeInfo;
}

export interface CodexStateDebugMatch {
  filePath: string;
  matchKind: "target" | "pane-id" | "directory";
  state: {
    activity?: RuntimeActivity;
    detail?: string;
    directory?: string;
    paneId?: string | null;
    sessionId?: string;
    sourceEventType?: string;
    status?: RuntimeStatus;
    target?: string | null;
    title?: string;
    updatedAt?: number;
    version?: number;
  };
}

export interface CodexPreviewDebug {
  lines: string[];
  captureError: string | null;
  classification: Pick<RuntimeInfo, "activity" | "detail" | "status"> | null;
}

export interface CodexRuntimeDebug {
  stateDir: string;
  busyGraceMs: number;
  matchedState: CodexStateDebugMatch | null;
  candidateStates: CodexStateDebugMatch[];
  hookRuntime: RuntimeInfo | null;
  previewRuntime: RuntimeInfo | null;
  recentBusyHook: boolean;
  preferPreview: boolean;
  preview: CodexPreviewDebug;
}

export interface OpenCodeRuntimeDebug {
  detected: { generation: 1 | 2; version: string } | null;
  detectionError: string | null;
  plugin: {
    stateDir: string;
    matchedState: {
      filePath: string;
      matchKind: "target" | "pane-id" | "directory";
      state: Record<string, unknown>;
    } | null;
    candidateStates: Array<{ filePath: string; state: Record<string, unknown> }>;
    installation: {
      configRoot: string;
      status: "current" | "stale" | "missing";
      expectedLayout: "v1-flat" | "v2-directory";
      entrypoint: string;
      source: string | null;
      stale: Array<{
        entrypoint: string;
        source: string | null;
        layout: "v1-flat" | "v2-directory" | "unrelated-flat";
      }>;
      diagnostics: string[];
    };
  };
  sqlite: {
    path: string;
    source: "env" | "debug-paths" | "legacy";
    schema: "v1" | "v2" | "mixed" | "unknown" | "missing";
    tables: string[];
    error: string | null;
  };
  server: {
    configuredGeneration: "v1" | "v2" | null;
    detectedGeneration: "v1" | "v2" | null;
    endpoint: string | null;
    sessionId: string | null;
    version: string | null;
    error: string | null;
  };
}

export interface InspectDebugInfo {
  codex: CodexRuntimeDebug | null;
  opencode: OpenCodeRuntimeDebug | null;
}

export interface InspectResult {
  target: PaneTarget;
  summary: PaneRuntimeSummary;
  debug?: InspectDebugInfo;
}

export interface PaneFilterOptions {
  active?: boolean;
  agent?: AgentKind | "all";
  busy?: boolean;
  waiting?: boolean;
  running?: boolean;
}

export type RuntimeProviderName = "auto" | "plugin" | "sqlite" | "server";

export interface RuntimeProviderOptions {
  provider?: RuntimeProviderName;
  serverMap?: string;
}
