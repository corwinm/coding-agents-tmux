import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const STATE_DIR = process.env.OPENCODE_TMUX_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode-tmux", "plugin-state")

let tmuxRefreshTimer: ReturnType<typeof setTimeout> | null = null

function scheduleTmuxStatusRefresh() {
  if (!process.env.TMUX || tmuxRefreshTimer) {
    return
  }

  tmuxRefreshTimer = setTimeout(() => {
    tmuxRefreshTimer = null
    spawnSync("tmux", ["refresh-client", "-S"], { stdio: "ignore" })
  }, 150)
}

function getNestedValue(payload: unknown, path: string[]): unknown {
  let current: unknown = payload

  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !(key in current)) {
      return undefined
    }

    current = (current as Record<string, unknown>)[key]
  }

  return current
}

function getStringCandidate(payload: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    const value = getNestedValue(payload, path)
    if (typeof value === "string" && value.trim()) {
      return value.trim()
    }
  }

  return null
}

function getStatusCandidate(payload: unknown): string | null {
  return getStringCandidate(payload, [
    ["status"],
    ["session", "status"],
    ["state", "status"],
    ["properties", "status", "type"],
    ["properties", "part", "state", "status"],
  ])
}

function getToolCandidate(payload: unknown): string | null {
  return getStringCandidate(payload, [
    ["tool"],
    ["session", "tool"],
    ["state", "tool"],
    ["properties", "part", "tool"],
  ])
}

function getOptionCount(payload: unknown): number | null {
  const candidates = [
    ["question", "options"],
    ["questions", "0", "options"],
    ["session", "question", "options"],
    ["session", "questions", "0", "options"],
    ["input", "questions", "0", "options"],
    ["state", "input", "questions", "0", "options"],
    ["session", "input", "questions", "0", "options"],
    ["properties", "questions", "0", "options"],
    ["properties", "part", "state", "input", "questions", "0", "options"],
  ]

  for (const path of candidates) {
    const value = getNestedValue(payload, path)
    if (Array.isArray(value)) {
      return value.length
    }
  }

  return null
}

function getBooleanCandidate(payload: unknown, paths: string[][]): boolean | null {
  for (const path of paths) {
    const value = getNestedValue(payload, path)
    if (typeof value === "boolean") {
      return value
    }
  }

  return null
}

function getNumberCandidate(payload: unknown, paths: string[][]): number | null {
  for (const path of paths) {
    const value = getNestedValue(payload, path)
    if (typeof value === "number") {
      return value
    }
  }

  return null
}

function normalizeEnvValue(value: string | undefined) {
  if (!value) {
    return null
  }

  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function runTmuxCommand(args: string[]) {
  return spawnSync("tmux", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
}

function resolveTmuxPaneTarget(paneId: string | null) {
  if (!paneId) {
    return null
  }

  const result = runTmuxCommand(["display-message", "-p", "-t", paneId, "#{session_name}:#{window_index}.#{pane_index}"])

  if (result.status !== 0) {
    return null
  }

  const target = result.stdout.trim()
  return target ? target : null
}

function toFileName(input: { directory: string; paneId: string | null }) {
  if (input.paneId) {
    return `pane-${Buffer.from(input.paneId).toString("hex")}.json`
  }

  return `cwd-${Buffer.from(input.directory).toString("hex")}.json`
}

function isWaitingStatus(status: string | null) {
  return status === "waiting-question" || status === "waiting-input"
}

function isQuestionLikeEvent(input: { status: string | null; tool: string | null; optionCount: number | null }) {
  if (isWaitingStatus(input.status)) {
    return true
  }

  if (input.tool === "question") {
    return true
  }

  return input.optionCount !== null
}

function getWaitingStatus(input: { status: string | null; tool: string | null; optionCount: number | null }) {
  if (input.status === "waiting-question") {
    return "waiting-question" as const
  }

  if (input.status === "waiting-input") {
    return "waiting-input" as const
  }

  if (input.optionCount !== null) {
    return input.optionCount > 0 ? ("waiting-question" as const) : ("waiting-input" as const)
  }

  if (isQuestionLikeEvent({ status: input.status, tool: input.tool, optionCount: input.optionCount })) {
    return "waiting-input" as const
  }

  return null
}

function shouldPreserveWaitingStatus(input: {
  currentStatus: string
  eventType: string
  status: string | null
  busy: boolean | null
}) {
  if (!isWaitingStatus(input.currentStatus)) {
    return false
  }

  if (input.eventType === "permission.replied" || input.eventType === "question.replied") {
    return false
  }

  if (input.status === "idle" || input.busy === false) {
    return false
  }

  return input.status === "running" || input.status === "busy" || input.busy === true || input.eventType === "session.status"
}

export const OpencodeTmuxPlugin = async ({ directory, project, client }) => {
  const paneId = normalizeEnvValue(process.env.TMUX_PANE)
  const state = {
    version: 2,
    paneId,
    target: resolveTmuxPaneTarget(paneId),
    sessionId: null as string | null,
    directory,
    title: project?.name ?? directory.split("/").filter(Boolean).pop() ?? "OpenCode session",
    activity: "idle" as "busy" | "idle" | "unknown",
    status: "new" as "running" | "waiting-question" | "waiting-input" | "idle" | "new" | "unknown",
    detail: "plugin initialized; awaiting first session event",
    updatedAt: Date.now(),
    sourceEventType: "plugin.init",
  }

  async function persist() {
    const target = resolveTmuxPaneTarget(state.paneId)

    if (target) {
      state.target = target
    }

    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(join(STATE_DIR, toFileName({ directory: state.directory, paneId: state.paneId })), JSON.stringify(state, null, 2))
  }

  function applyDerivedStatus(event: { type: string; [key: string]: unknown }) {
    const sessionId = getStringCandidate(event, [["session", "id"], ["sessionID"], ["sessionId"], ["id"], ["properties", "sessionID"], ["properties", "info", "id"], ["properties", "part", "sessionID"]])
    const sessionTitle = getStringCandidate(event, [["session", "title"], ["title"], ["properties", "info", "title"]])
    const sessionDirectory = getStringCandidate(event, [["session", "directory"], ["directory"], ["properties", "info", "directory"], ["properties", "info", "path", "cwd"]])
    const status = getStatusCandidate(event)
    const tool = getToolCandidate(event)
    const busy = getBooleanCandidate(event, [["busy"], ["session", "busy"], ["state", "busy"]])
    const optionCount = getOptionCount(event)
    const updatedAt = getNumberCandidate(event, [["timeUpdated"], ["session", "timeUpdated"], ["timestamp"], ["properties", "info", "time", "updated"], ["properties", "part", "state", "time", "start"], ["properties", "part", "state", "time", "end"]])

    if (sessionId) {
      state.sessionId = sessionId
    }

    if (sessionTitle) {
      state.title = sessionTitle
    }

    if (sessionDirectory) {
      state.directory = sessionDirectory
    }

    state.updatedAt = updatedAt ?? Date.now()
    state.sourceEventType = event.type

    if (event.type === "session.idle") {
      state.activity = "idle"
      state.status = "idle"
      state.detail = "session.idle event"
      return
    }

    if (event.type === "session.error") {
      state.activity = "unknown"
      state.status = "unknown"
      state.detail = "session.error event"
      return
    }

    const waitingStatus = getWaitingStatus({ status, tool, optionCount })

    if (event.type === "permission.asked") {
      state.activity = "busy"
      state.status = waitingStatus ?? "waiting-input"
      state.detail = "permission.asked event"
      return
    }

    if (event.type === "permission.replied" || event.type === "question.replied") {
      state.activity = "busy"
      state.status = "running"
      state.detail = `${event.type} event`
      return
    }

    if (waitingStatus) {
      state.activity = "busy"
      state.status = waitingStatus
      state.detail = `${event.type} waiting event`
      return
    }

    if (status === "idle" || busy === false) {
      state.activity = "idle"
      state.status = "idle"
      state.detail = `${event.type} idle event`
      return
    }

    if (status === "running" || status === "busy" || busy === true || event.type === "session.status") {
      if (shouldPreserveWaitingStatus({ currentStatus: state.status, eventType: event.type, status, busy })) {
        state.activity = "busy"
        state.detail = `${event.type} kept prior waiting state`
        return
      }

      state.activity = "busy"
      state.status = "running"
      state.detail = `${event.type} running event`
      return
    }
  }

  await client.app.log({
    body: {
      service: "opencode-tmux-plugin",
      level: "info",
      message: "plugin initialized",
      extra: { directory, paneId: state.paneId, stateDir: STATE_DIR, target: state.target },
    },
  })

  await persist()
  scheduleTmuxStatusRefresh()

  return {
    event: async ({ event }) => {
      applyDerivedStatus(event)
      await persist()
      scheduleTmuxStatusRefresh()
    },
  }
}
