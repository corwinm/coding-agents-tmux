# Kiro CLI support: research and implementation plan

## Goal

Add support for **Kiro CLI** sessions in `coding-agents-tmux` for:

- pane discovery
- switching and popup navigation
- status line summaries
- coarse runtime state based on tmux process/title detection
- best-effort waiting detection from pane preview text

The immediate product goal is simple: **if a tmux pane is running `kiro-cli`, show it as a Kiro pane**. Users should not have to create, name, or modify a Kiro custom agent just to use `coding-agents-tmux`.

## Short answer

**Yes, Kiro CLI support is feasible and should be detection-first.**

The v1 implementation should be intentionally lightweight:

- detect Kiro CLI tmux panes by command/title
- route Kiro panes through a Kiro-specific runtime handler
- classify detected Kiro panes as `idle` by default, because a live Kiro CLI process does not mean the agent is actively working
- use tmux pane preview as a conservative fallback for obvious question/approval prompts
- do **not** require Kiro agent configuration
- do **not** install Kiro hooks by default

Kiro CLI does have a hook system, but Kiro hooks are configured inside named agent JSON files. That makes hook-backed state an optional future enhancement, not a requirement for basic Kiro pane support.

## Progress tracker

### Current status

- [x] Research Kiro CLI docs and this repo architecture
- [x] Confirm local Kiro CLI availability and current command help shape
- [x] Write implementation plan
- [x] Add Kiro as a first-class `AgentKind`
- [x] Add Kiro pane detection
- [x] Add Kiro runtime module with command/preview fallback
- [x] Update CLI flags, filters, and help text
- [x] Add tests
- [x] Update README / user-facing docs
- [ ] Optional future: revisit hook-backed Kiro state if there is a clean global or all-agents install story

### Progress notes

- 2026-06-05: Wrote the initial Kiro CLI research and implementation plan.
- 2026-06-05: Added Kiro as a first-class agent kind, including tmux detection for `kiro`, `kiro-cli`, `kiro-cli-chat`, and `kiro-cli-term`-style commands.
- 2026-06-05: Added `src/core/kiro.ts` with preview fallback and command fallback. This intentionally does not require Kiro custom agent config.
- 2026-06-05: Updated agent filters/help to include `kiro`.
- 2026-06-05: Added Kiro tests and updated README with detection-only setup and fallback behavior.
- 2026-06-05: Deferred hook-backed Kiro state because requiring a named Kiro agent is not desirable for the default UX.
- 2026-06-05: Changed command-only Kiro panes to default to `idle` and added a lightweight pane-derived pseudo-session so list output does not show `(unmatched)` for successfully detected Kiro panes. The pseudo-session title prefers the current directory basename because Kiro does not appear to update tmux pane titles reliably.

## Detailed task list

### 0. Research and planning

- [x] Fetch Kiro CLI docs index from `https://kiro.dev/llms.txt`
- [x] Read Kiro CLI get-started docs
- [x] Read Kiro CLI command reference
- [x] Read Kiro CLI hooks docs
- [x] Read Kiro CLI custom agent configuration reference
- [x] Read Kiro CLI terminal UI docs
- [x] Read Kiro CLI configuration docs
- [x] Read Kiro CLI ACP docs for future integration possibilities
- [x] Inspect current repo integration points for OpenCode, Codex, Pi, and Claude
- [x] Decide on the primary Kiro integration strategy
- [x] Write this plan document

### 1. Runtime model and dispatch

- [x] Add `"kiro"` to `AgentKind` in `src/types.ts`
- [x] Add Kiro runtime source values in `RuntimeSource`:
  - `"kiro-preview"`
  - `"kiro-command"`
- [x] Add `"kiro"` to `RuntimeMatchInfo.provider`
- [x] Add a Kiro-specific runtime module: `src/core/kiro.ts`
- [x] Update `src/core/opencode.ts` dispatch so Kiro panes are handled explicitly and are not sent through OpenCode providers
- [x] Keep existing OpenCode, Codex, Pi, and Claude behavior unchanged

### 2. Kiro pane detection

- [x] Update `src/core/tmux.ts` to detect Kiro CLI panes
- [x] Detect likely command names:
  - `kiro-cli`
  - `kiro-cli-chat`
  - `kiro-cli-term`
  - `kiro`
- [x] Consider title hints:
  - `Kiro`
  - `Kiro CLI`
  - titles starting with `Kiro `
- [x] Ensure detection does not confuse the Kiro IDE Electron process with terminal Kiro CLI panes. In tmux, `pane_current_command` should usually reflect the terminal process or wrapper command, so command/title matching is enough for v1.
- [x] Add/update tests in `test/tmux.test.ts`
- [x] Add mixed-agent tests proving Kiro coexists with OpenCode, Codex, Pi, and Claude

### 3. Kiro runtime module

Create `src/core/kiro.ts` as a lightweight runtime module.

Responsibilities:

- classify preview text when Kiro appears to be waiting on user input
- fall back to command-backed `idle` when preview is inconclusive
- never require Kiro config files, Kiro hooks, or a named Kiro custom agent
- attach a lightweight pseudo-session from the tmux pane path/title so detected Kiro panes do not render as `(unmatched)`

Implemented runtime source mapping:

| Source         | Meaning                                                                      |
| -------------- | ---------------------------------------------------------------------------- |
| `kiro-preview` | The tmux pane preview contains an obvious question/approval prompt           |
| `kiro-command` | A Kiro CLI process is detected, with no stronger runtime signal; assume idle |

Default runtime mapping:

```ts
{
  activity: "idle",
  status: "idle",
  source: "kiro-command",
  match: {
    strategy: "exact",
    provider: "kiro",
    heuristic: false
  },
  session: {
    id: `kiro:${pane.target}`,
    directory: pane.currentPath,
    title: basename(pane.currentPath) || pane.paneTitle || "Kiro CLI",
    timeUpdated: Date.now()
  },
  detail: "detected kiro-cli process in tmux pane; assuming idle without stronger Kiro state"
}
```

Preview fallback should inspect the last visible pane lines and classify only conservative cases:

- `waiting-question` for visible numbered/bulleted choices or obvious approval prompts
- `waiting-input` for obvious direct questions
- otherwise no preview classification, so idle command fallback wins

### 4. CLI and UX updates

- [x] Update `src/cli.ts` agent validation and help text to include Kiro
- [x] Support `--agent kiro` on:
  - `list`
  - `switch`
  - `popup`
  - `popup-ui`
  - `status`
  - `tmux-config`
  - `install-tmux`
- [x] Verify mixed-agent render output includes Kiro
- [x] Do not add Kiro install commands in v1

### 5. Tests

- [x] Add `test/kiro.test.ts`
- [x] Add Kiro command fallback tests
- [x] Add Kiro preview fallback tests
- [x] Add Kiro tmux detection tests
- [x] Add CLI coverage for `--agent kiro`
- [x] Add render coverage for mixed OpenCode/Codex/Pi/Claude/Kiro outputs
- [x] Run the full test suite and typecheck

### 6. Documentation

- [x] Update `README.md` to mention Kiro support
- [x] Document that Kiro support is detection-only and does not require a named Kiro agent
- [x] Document fallback behavior and limitations
- [x] Update this plan with implementation progress

## Research summary

### 1. Current repo architecture

The codebase already supports multiple coding agents through agent-specific detection and runtime attachment.

Current models:

- **OpenCode**
  - pane detection in `src/core/tmux.ts`
  - richer state through bundled plugin files under `plugin-state`
  - optional sqlite/server provider fallback
- **Codex**
  - pane detection in `src/core/tmux.ts`
  - hook-backed state ingestion in `src/core/codex.ts`
  - state files under `codex-state`
  - command/preview fallback
- **Pi**
  - pane detection in `src/core/tmux.ts`
  - bundled TypeScript extension in `plugin/pi-tmux.ts`
  - state files under `pi-state`
  - command/preview fallback
- **Claude Code**
  - pane detection in `src/core/tmux.ts`
  - hook-backed state ingestion in `src/core/claude.ts`
  - state files under `claude-state`
  - command/preview fallback

For Kiro v1, the right model is closest to **Pi/Claude command + preview fallback**, without hook-backed state.

Important files edited:

- `src/types.ts`
- `src/core/tmux.ts`
- `src/core/opencode.ts`
- `src/core/kiro.ts`
- `src/cli.ts`
- `README.md`
- tests under `test/`

### 2. Kiro CLI command model

Docs say Kiro CLI starts chat sessions with:

```bash
kiro-cli
kiro-cli chat
kiro-cli chat "How do I list files in Linux?"
kiro-cli chat --resume
kiro-cli chat --resume-id <SESSION_ID>
kiro-cli chat --resume-picker
kiro-cli chat --agent my-agent "Help me with AWS CLI"
```

The local machine used for this research had:

```text
/Users/corwinm/.local/bin/kiro-cli
/usr/local/bin/kiro
```

and:

```text
kiro-cli 2.6.0
```

Local help showed additional real command names/wrappers:

```text
kiro-cli
kiro-cli-chat
kiro-cli-term
```

The Kiro command router docs say newer installations can also use:

```bash
kiro
```

with routing between IDE and CLI depending on user preference. For pane detection, include `kiro`, but prefer stronger matches from `kiro-cli`, `kiro-cli-chat`, or `kiro-cli-term`.

### 3. Kiro CLI authentication and headless mode

Kiro CLI supports interactive login:

```bash
kiro-cli login
```

For non-interactive/headless automation it supports API-key auth:

```bash
export KIRO_API_KEY=ksk_xxxxxxxx
kiro-cli chat --no-interactive "your prompt here"
```

Headless mode requires:

```bash
kiro-cli chat --no-interactive "your prompt here"
```

and can trust tools upfront:

```bash
kiro-cli chat --no-interactive --trust-all-tools "Write tests"
kiro-cli chat --no-interactive --trust-tools=read,grep "Find TODOs"
```

This is not required for tmux support, but is useful context if future work adds launcher or automation features.

### 4. Kiro CLI session management

Kiro CLI automatically saves sessions and supports:

```bash
kiro-cli chat --resume
kiro-cli chat --resume-picker
kiro-cli chat --resume-id <SESSION_ID>
kiro-cli chat --list-sessions
kiro-cli chat --delete-session <SESSION_ID>
```

Inside chat:

```text
/chat new
/chat resume
/session-id
/chat save <path>
/chat load <path>
```

The v1 tmux integration does not parse Kiro session storage. It only detects running Kiro panes.

### 5. Kiro custom agents and hooks

Kiro custom agents are JSON files under:

```text
~/.kiro/agents
.kiro/agents
```

The global path can be overridden with:

```bash
KIRO_HOME
```

Kiro hooks are configured inside those agent JSON files. Relevant documented hook events include:

- `agentSpawn`
- `userPromptSubmit`
- `preToolUse`
- `postToolUse`
- `stop`

Hooks receive JSON on stdin and can execute commands. This means hook-backed state would be technically possible.

However, because hook config is per-agent, requiring hooks would force users to name or modify a Kiro agent. That is not acceptable for the default UX. Hook-backed Kiro state is therefore deferred until there is a clean all-agents/global integration story or a clear opt-in user request.

### 6. Kiro tool permissions and approval UX

Kiro has tool permissions and can ask for user approval. Available built-in tools include:

- `read`
- `write`
- `shell`
- `aws`
- `report`

Kiro terminal UI approval prompts can appear when a tool is not trusted. The v1 implementation uses pane preview heuristics to catch obvious approval prompts and mark them as `waiting-question`.

### 7. ACP is interesting but not needed for v1

Kiro CLI supports ACP:

```bash
kiro-cli acp
kiro-cli acp --agent my-agent
```

The docs list methods including:

- `initialize`
- `session/new`
- `session/load`
- `session/prompt`
- `session/cancel`
- `session/set_mode`
- `session/set_model`

ACP could support a future direct client or launcher integration, but it is not necessary for this tmux extension's current discovery/switch/status workflow.

## Recommended v1 architecture

Implement Kiro support as a **detection-first runtime provider with preview fallback**.

The flow is:

1. tmux discovery finds a Kiro CLI pane
2. `attachRuntimeToPanes()` routes it to `attachRuntimeWithKiro()`
3. `attachRuntimeWithKiro()` captures a small pane preview and checks for obvious waiting prompts
4. if preview classification matches, render `kiro-preview`
5. otherwise show coarse command-backed idle status with `kiro-command`

## Acceptance criteria

Kiro v1 support is complete when:

- `coding-agents-tmux list` shows Kiro panes alongside other agents
- `coding-agents-tmux list --agent kiro` filters to Kiro panes
- `switch`, `popup`, waiting filters, and status summaries work with Kiro panes
- no Kiro custom agent config is required
- no Kiro hook install is required
- detected Kiro panes show a safe coarse status instead of disappearing
- preview fallback can identify obvious approval/question prompts
- tests and typecheck pass

## Useful commands for implementation and manual validation

Inspect Kiro CLI version:

```bash
kiro-cli --version
```

Inspect Kiro chat help:

```bash
kiro-cli chat --help
```

List Kiro panes:

```bash
coding-agents-tmux list --agent kiro
coding-agents-tmux list --agent kiro --json
```

Inspect one pane:

```bash
coding-agents-tmux inspect <session:window.pane> --json
```

Run tests:

```bash
npm test
npm run typecheck
npm run lint
```

## References

Kiro docs read for this plan:

- `https://kiro.dev/llms.txt`
- `https://kiro.dev/docs/cli.md`
- `https://kiro.dev/docs/cli/reference/cli-commands.md`
- `https://kiro.dev/docs/cli/hooks.md`
- `https://kiro.dev/docs/cli/custom-agents/configuration-reference.md`
- `https://kiro.dev/docs/cli/custom-agents/creating.md`
- `https://kiro.dev/docs/cli/chat/configuration.md`
- `https://kiro.dev/docs/cli/chat/permissions.md`
- `https://kiro.dev/docs/cli/chat/session-management.md`
- `https://kiro.dev/docs/cli/headless.md`
- `https://kiro.dev/docs/cli/authentication.md`
- `https://kiro.dev/docs/cli/terminal-ui.md`
- `https://kiro.dev/docs/cli/acp.md`
- `https://kiro.dev/docs/cli/reference/settings.md`
- `https://kiro.dev/docs/cli/reference/exit-codes.md`
