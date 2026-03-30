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

export interface InspectResult {
  target: PaneTarget;
  summary: PaneRuntimeSummary;
}

export interface PaneFilterOptions {
  active?: boolean;
  busy?: boolean;
  waiting?: boolean;
  running?: boolean;
}

export type RuntimeProviderName = "auto" | "plugin" | "sqlite" | "server";

export interface RuntimeProviderOptions {
  provider?: RuntimeProviderName;
  serverMap?: string;
}
