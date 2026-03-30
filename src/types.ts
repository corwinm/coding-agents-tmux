export type PaneTarget = `${string}:${number}.${number}`;

export type AgentKind = "opencode" | "codex";

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
  | "unmapped";

export interface RuntimeMatchInfo {
  strategy:
    | "target-map"
    | "exact"
    | "descendant-running"
    | "descendant-recent"
    | "descendant-only"
    | "unmapped";
  provider: "plugin" | "server" | "sqlite" | "codex" | "none";
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

export interface InspectDebugInfo {
  codex: CodexRuntimeDebug | null;
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
