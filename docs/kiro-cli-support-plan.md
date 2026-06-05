# Kiro CLI support: research and implementation plan

## Goal

Add support for **Kiro CLI** sessions in `coding-agents-tmux` for:

- pane discovery
- switching and popup navigation
- status line summaries
- coarse runtime state when no integration is installed
- higher-fidelity runtime state through Kiro CLI hooks when users opt in

The main research question for this doc was:

- can Kiro CLI support the same general pattern this repo already uses for Codex and Claude Code, where lifecycle/tool events call back into `coding-agents-tmux` and publish normalized local state?

## Short answer

**Yes.** Kiro CLI is a good fit for this repo.

The minimum viable path is very small:

- detect Kiro CLI tmux panes by command/title
- route Kiro panes through a Kiro-specific runtime handler
- use preview and command fallback when no richer state exists

The higher-fidelity path is also feasible:

- Kiro CLI has hook events for agent lifecycle, user prompts, tool use, and stop events
- hooks receive JSON on stdin
- hooks can execute local commands
- hook payloads include enough data to map turns to cwd/session and classify running/idle/waiting states

The main difference from Claude and Codex is installation shape:

- Codex has a global hook config under `~/.codex`
- Claude Code has global/user settings under `~/.claude/settings.json`
- Kiro CLI hooks are configured **inside agent configuration files** under `~/.kiro/agents` or `.kiro/agents`

Because of that, Kiro support should avoid silently modifying a user's default agent. The safest v1 install surface is to generate a hook template and optionally merge into a named agent only when explicitly requested.

## Progress tracker

### Current status

- [x] Research Kiro CLI docs and this repo architecture
- [x] Confirm local Kiro CLI availability and current command help shape
- [x] Write implementation plan
- [ ] Add Kiro as a first-class `AgentKind`
- [ ] Add Kiro pane detection
- [ ] Add Kiro runtime module with command/preview fallback
- [ ] Add Kiro hook state ingestion
- [ ] Add Kiro hook template generation
- [ ] Add optional named-agent install flow
- [ ] Update tmux plugin auto-install option handling
- [ ] Update CLI flags, filters, and help text
- [ ] Add tests
- [ ] Update README / user-facing docs

### Detailed task list

#### 0. Research and planning

- [x] Fetch Kiro CLI docs index from `https://kiro.dev/llms.txt`
- [x] Read Kiro CLI get-started docs
- [x] Read Kiro CLI command reference
- [x] Read Kiro CLI hooks docs
- [x] Read Kiro CLI custom agent configuration reference
- [x] Read Kiro CLI terminal UI docs
- [x] Read Kiro CLI configuration docs
- [x] Read Kiro CLI ACP docs for future integration possibilities
- [x] Inspect current repo integration points for OpenCode, Codex, Pi, and Claude
- [x] Decide on the recommended Kiro integration strategy
- [x] Write this plan document

#### 1. Runtime model and dispatch

- [ ] Add `"kiro"` to `AgentKind` in `src/types.ts`
- [ ] Add Kiro runtime source values in `RuntimeSource`:
  - `"kiro-hook"`
  - `"kiro-preview"`
  - `"kiro-command"`
- [ ] Add `"kiro"` to `RuntimeMatchInfo.provider`
- [ ] Add a Kiro-specific runtime module, likely `src/core/kiro.ts`
- [ ] Update `src/core/opencode.ts` dispatch so Kiro panes are handled explicitly and are not sent through OpenCode providers
- [ ] Keep existing OpenCode, Codex, Pi, and Claude behavior unchanged

#### 2. Kiro pane detection

- [ ] Update `src/core/tmux.ts` to detect Kiro CLI panes
- [ ] Detect likely command names:
  - `kiro-cli`
  - `kiro-cli-chat`
  - `kiro-cli-term`
  - `kiro`
- [ ] Consider title hints:
  - `Kiro`
  - `Kiro CLI`
  - titles starting with `Kiro `
- [ ] Ensure detection does not confuse the Kiro IDE Electron process with terminal Kiro CLI panes. In tmux, `pane_current_command` should usually reflect the terminal process or wrapper command, so command/title matching is enough for v1.
- [ ] Add/update tests in `test/tmux.test.ts`
- [ ] Add mixed-agent tests proving Kiro coexists with OpenCode, Codex, Pi, and Claude

#### 3. Kiro runtime state module

Create `src/core/kiro.ts`, similar in shape to `src/core/claude.ts` and `src/core/pi.ts`.

Core responsibilities:

- persist hook events into normalized state files
- read state files from disk
- build an index by pane id, target, and directory
- match panes safely:
  1. exact tmux target
  2. exact pane id
  3. cwd fallback only when there is exactly one matching state for that cwd
- classify matched state into `RuntimeInfo`
- classify preview text when no hook state is available
- fall back to command-backed `running` when preview is inconclusive

Recommended Kiro state directory:

```text
~/.local/state/coding-agents-tmux/kiro-state
```

Recommended env override:

```bash
CODING_AGENTS_TMUX_KIRO_STATE_DIR
```

Recommended state file shape:

```ts
interface KiroStateFile {
  activity?: RuntimeInfo["activity"];
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
}
```

Recommended public functions:

```ts
export function getKiroHome(): string;
export function getKiroStateDir(): string;
export function getKiroAgentsDir(scope?: "global" | "workspace"): string;
export function buildKiroHooksTemplate(command: string): string;
export async function persistKiroHookState(rawInput: string): Promise<void>;
export function installKiroIntegration(options: InstallKiroOptions): KiroInstallResult;
export async function attachRuntimeWithKiro(panes: DiscoveredPane[]): Promise<PaneRuntimeSummary[]>;
```

`getKiroHome()` should honor Kiro's documented global home override:

```bash
KIRO_HOME
```

If unset, use:

```text
~/.kiro
```

#### 4. Kiro hook event ingestion

Kiro hook docs say hooks receive JSON on stdin.

Known documented fields include:

```json
{
  "hook_event_name": "agentSpawn",
  "cwd": "/current/working/directory",
  "session_id": "abc123-def456-789"
}
```

Tool-related hooks add fields such as:

```json
{
  "hook_event_name": "preToolUse",
  "cwd": "/current/working/directory",
  "session_id": "abc123-def456-789",
  "tool_name": "read",
  "tool_input": {}
}
```

`postToolUse` can also include:

```json
{
  "tool_response": {}
}
```

`stop` includes:

```json
{
  "hook_event_name": "stop",
  "cwd": "/current/working/directory",
  "session_id": "conversation-uuid",
  "assistant_response": "The assistant's last response text..."
}
```

Recommended TypeScript payload type:

```ts
interface KiroHookPayload {
  assistant_response?: string | null;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  session_id?: string;
  tool_input?: unknown;
  tool_name?: string;
  tool_response?: unknown;
}
```

Recommended event classification:

| Kiro event         | Status            | Activity         | Detail                              |
| ------------------ | ----------------- | ---------------- | ----------------------------------- |
| `agentSpawn`       | `new`             | `idle`           | `Kiro session started`              |
| `userPromptSubmit` | `running`         | `busy`           | `Kiro is handling a user prompt`    |
| `preToolUse`       | `running`         | `busy`           | `Kiro is running <tool>`            |
| `postToolUse`      | `running`         | `busy`           | `Kiro is processing <tool> output`  |
| `stop`             | `idle` or waiting | `idle` or `busy` | classify from `assistant_response`  |
| unknown            | `unknown`         | `unknown`        | `Unhandled Kiro hook event: <name>` |

Important casing note:

- Kiro docs show lower-camel event names: `agentSpawn`, `userPromptSubmit`, `preToolUse`, `postToolUse`, `stop`
- Existing Codex/Claude code handles upper/pascal-case event names for those tools
- Kiro code should use Kiro's documented exact casing, and can optionally normalize defensively with a lowercase map

#### 5. Waiting-state classification

Use the existing conservative text heuristic patterns from Codex/Claude/Pi as a starting point.

For `stop`, inspect `assistant_response`:

- classify as `waiting-question` if it appears to be a structured choice prompt
- classify as `waiting-input` if it appears to ask for freeform confirmation/input
- otherwise classify as `idle`

Recommended waiting-question signals:

- at least two numbered/bulleted choice lines
- text contains words like:
  - `choose`
  - `select`
  - `option`
  - `which option`
  - `confirm`

Recommended waiting-input signals:

- message ends with `?`
- text contains phrases like:
  - `would you like`
  - `do you want`
  - `should i`
  - `can you`
  - `could you`
  - `please provide`
  - `please confirm`
  - `what would you like`

Preview fallback should use a similar heuristic over the last 8-12 non-empty pane lines.

#### 6. Hook template generation

Add a CLI command:

```bash
coding-agents-tmux kiro-hooks-template
```

It should print a JSON snippet suitable for merging into a Kiro agent config:

```json
{
  "hooks": {
    "agentSpawn": [
      {
        "command": "/path/to/coding-agents-tmux kiro-hook-state"
      }
    ],
    "userPromptSubmit": [
      {
        "command": "/path/to/coding-agents-tmux kiro-hook-state"
      }
    ],
    "preToolUse": [
      {
        "matcher": "*",
        "command": "/path/to/coding-agents-tmux kiro-hook-state"
      }
    ],
    "postToolUse": [
      {
        "matcher": "*",
        "command": "/path/to/coding-agents-tmux kiro-hook-state"
      }
    ],
    "stop": [
      {
        "command": "/path/to/coding-agents-tmux kiro-hook-state"
      }
    ]
  }
}
```

Kiro hook docs include an optional `timeout_ms` field. v1 can omit it and use Kiro's default timeout, documented as 30 seconds. If a timeout is added later, keep the hook ingest command fast and avoid making Kiro waits longer than necessary.

#### 7. Hook state CLI command

Add a CLI command:

```bash
coding-agents-tmux kiro-hook-state
```

Behavior:

- read JSON from stdin
- error if stdin is empty
- call `persistKiroHookState(rawInput)`
- write no stdout on success
- return non-zero only for malformed payloads or unexpected write failures

This follows the existing Codex/Claude pattern.

#### 8. Optional install command

Add a CLI command:

```bash
coding-agents-tmux install-kiro
```

Because Kiro hooks live in agent config files, the install command should be conservative.

Recommended v1 behavior:

```bash
coding-agents-tmux install-kiro --agent <agent-name>
```

- require `--agent` unless `--create-agent` is provided
- find the agent config in the current workspace first, then global `KIRO_HOME`
- merge managed hooks into that one agent config
- preserve all unrelated agent config fields
- preserve unrelated user hooks
- replace only previously managed `coding-agents-tmux` Kiro hook groups

Optional flags:

```bash
--agent <name>          Merge hooks into an existing agent config
--scope global          Use ~/.kiro/agents, or $KIRO_HOME/agents
--scope workspace       Use .kiro/agents
--create-agent <name>   Create a managed agent if it does not exist
--set-default           Run or instruct user to run `kiro-cli agent set-default <name>`
--print                 Print the merged config instead of writing
```

Safer initial implementation:

- implement `kiro-hooks-template` first
- implement `install-kiro --agent <name>` second
- defer `--create-agent` and `--set-default` until users ask for them

Important user-facing caveat:

- do **not** silently modify `kiro_default`
- do **not** silently change the user's default Kiro agent
- do **not** install Kiro hooks into every agent by default

#### 9. tmux plugin auto-install integration

Update `coding-agents-tmux.tmux` after `install-kiro` exists.

Add tmux option:

```tmux
set -g @coding-agents-tmux-install-kiro-hooks 'off'
```

Recommendation: default this to `off` because Kiro requires an agent selection and silent modification is risky.

Support explicit auto-install selector value:

```tmux
set -g @coding-agents-tmux-auto-install 'opencode,pi,codex,claude,kiro'
```

However, because Kiro requires an agent name, one of these should be true before attempting install:

```tmux
set -g @coding-agents-tmux-kiro-agent 'my-agent'
```

or:

```tmux
set -g @coding-agents-tmux-install-kiro-hooks 'off'
```

Recommended tmux behavior:

- if Kiro auto-install is requested but `@coding-agents-tmux-kiro-agent` is empty, show a message and skip install
- if configured, run:

```bash
coding-agents-tmux install-kiro --agent "$agent"
```

User message after install:

```text
coding-agents-tmux: Kiro hooks installed for agent <name>; restart Kiro sessions using that agent
```

#### 10. CLI and UX updates

Update `src/cli.ts`:

- agent filter validation includes `kiro`
- help text says `opencode, codex, pi, claude, or kiro`
- `TmuxConfigOptions.agent` includes `"kiro"`
- commands added:
  - `kiro-hooks-template`
  - `kiro-hook-state`
  - `install-kiro`

Update `src/core/opencode.ts` help text:

- add Kiro hook state section:

```text
Kiro hook state:
  Default path: ~/.local/state/coding-agents-tmux/kiro-state
  Override with CODING_AGENTS_TMUX_KIRO_STATE_DIR.
  Generate agent hooks with: coding-agents-tmux kiro-hooks-template
  Install hooks into a named Kiro agent with: coding-agents-tmux install-kiro --agent <name>
```

Update render tests and snapshots where agent names are expected.

#### 11. Tests

Add `test/kiro.test.ts` covering:

- `getKiroStateDir()` honors `CODING_AGENTS_TMUX_KIRO_STATE_DIR`
- state files are read from preferred state dir
- hook payloads persist normalized state
- `agentSpawn` maps to `new`
- `userPromptSubmit` maps to `running`
- `preToolUse` maps to `running`
- `postToolUse` maps to `running`
- `stop` maps to `idle` when no question is present
- `stop` maps to `waiting-input` for question-like `assistant_response`
- `stop` maps to `waiting-question` for multiple-choice-like `assistant_response`
- exact target match wins
- exact pane id match works
- cwd fallback works only when unambiguous
- preview fallback detects waiting-input/waiting-question
- command fallback returns `kiro-command` / `running`
- hook template contains all expected Kiro hook events
- install merge preserves existing agent config fields and unrelated hooks
- install merge replaces previous managed hook groups

Update existing tests:

- `test/tmux.test.ts`: Kiro pane detection
- `test/cli.test.ts`: `--agent kiro`, command help, CLI commands
- `test/render.test.ts`: mixed-agent render output includes Kiro
- `test/tmux-plugin-rename.test.ts`: auto-install selector supports/handles `kiro` if tmux install support is added

Run:

```bash
npm test
npm run typecheck
npm run lint
```

#### 12. Documentation

Update `README.md`:

- mention Kiro support in the supported-agent summary
- document coarse Kiro detection
- document optional Kiro hook integration
- document Kiro state path:

```text
~/.local/state/coding-agents-tmux/kiro-state
```

- document env override:

```bash
CODING_AGENTS_TMUX_KIRO_STATE_DIR
```

- document hook template/install commands:

```bash
coding-agents-tmux kiro-hooks-template
coding-agents-tmux install-kiro --agent <name>
```

- document tmux options only after implemented:

```tmux
set -g @coding-agents-tmux-kiro-agent 'my-agent'
set -g @coding-agents-tmux-install-kiro-hooks 'on'
```

Troubleshooting entry:

```text
Kiro still always looks busy: confirm your Kiro agent config contains the managed `kiro-hook-state` hooks and restart the Kiro session using that agent.
```

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

The most relevant pattern for Kiro is **Claude/Codex-style hook-backed state**, with Pi/Claude-style runtime fallback.

Important files to edit:

- `src/types.ts`
- `src/core/tmux.ts`
- `src/core/opencode.ts`
- `src/core/kiro.ts` (new)
- `src/cli.ts`
- `coding-agents-tmux.tmux` (only once install flow exists)
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

with routing between IDE and CLI depending on user preference. For pane detection, include `kiro`, but avoid assuming it is always CLI outside tmux.

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

For this repo, hook payload `session_id` should be preferred as the stable session id in `SessionMatch`.

### 5. Kiro CLI config paths

Kiro CLI docs define three relevant scopes:

- global config under:

```text
~/.kiro/
```

- project config under:

```text
.kiro/
```

- agent configs under:

```text
~/.kiro/agents
.kiro/agents
```

The global path can be overridden with:

```bash
KIRO_HOME
```

Kiro settings are stored at:

```text
~/.kiro/settings/cli.json
```

This matters for `install-kiro` because named agents may be global or workspace-local.

### 6. Kiro custom agents and hook configuration

Kiro custom agents are JSON files. The filename without `.json` is the agent name unless `name` is explicitly set.

They can live at:

```text
.kiro/agents/<name>.json
~/.kiro/agents/<name>.json
```

Kiro resolves local agents before global agents when there is a name conflict.

Relevant agent config fields:

- `name`
- `description`
- `prompt`
- `tools`
- `allowedTools`
- `toolsSettings`
- `resources`
- `hooks`
- `model`
- `welcomeMessage`

Hook config lives inside the agent JSON:

```json
{
  "hooks": {
    "agentSpawn": [
      {
        "command": "git status"
      }
    ],
    "userPromptSubmit": [
      {
        "command": "ls -la"
      }
    ],
    "preToolUse": [
      {
        "matcher": "execute_bash",
        "command": "echo pre tool"
      }
    ],
    "postToolUse": [
      {
        "matcher": "fs_write",
        "command": "cargo fmt --all"
      }
    ],
    "stop": [
      {
        "command": "npm test"
      }
    ]
  }
}
```

Kiro docs say hook matchers can use either canonical tool names or aliases:

- `fs_read` or `read`
- `fs_write` or `write`
- `execute_bash` or `shell`
- `use_aws` or `aws`
- `@git`
- `@git/status`
- `*`
- `@builtin`

For this integration, use matcher `"*"` for `preToolUse` and `postToolUse` so any tool activity updates tmux state.

### 7. Kiro hook behavior and exit codes

Kiro hook docs specify:

- exit code `0`: hook succeeded
- exit code `2`: for `preToolUse`, block tool execution and return stderr to the LLM
- other exit codes: hook failed, stderr shown as warning, tool usually allowed except for explicit block behavior

Therefore `kiro-hook-state` must be fast and reliable. It should avoid writing stdout and avoid failing for harmless missing optional fields.

Stop hooks have special behavior: they can return JSON like:

```json
{ "decision": "block", "reason": "You haven't run the tests yet." }
```

This repo's hook must **not** do that. It should write no stdout so Kiro stops normally.

### 8. Kiro tool permissions and approval UX

Kiro has tool permissions and can ask for user approval. Available built-in tools include:

- `read`
- `write`
- `shell`
- `aws`
- `report`

Kiro terminal UI approval prompts can appear when a tool is not trusted. The docs describe queued approval UI with Yes, Trust, and No options.

Potential tmux-state implication:

- When Kiro is awaiting tool approval, hook events alone may not expose a distinct `permissionRequest` event in the docs read for this plan.
- If no distinct approval hook event exists, preview fallback is important for catching obvious permission/approval prompts.
- If future Kiro versions document a permission hook event, add it to `buildKiroHooksTemplate()` and classify it as `waiting-question`.

### 9. Kiro Terminal UI details useful for preview fallback

Kiro Terminal UI is the default chat interface. It shows:

- tool progress
- approval prompts
- overlay panels
- queued messages
- markdown output
- activity tray
- terminal title/progress indicators

The UI may ask for approvals with notification bars and selectable Yes/Trust/No options. Pane preview detection should therefore look for terms like:

- `approval`
- `allow`
- `deny`
- `trust`
- `yes`
- `no`
- `permission`

But keep heuristics conservative to avoid false positives in ordinary assistant output.

### 10. ACP is interesting but not needed for v1

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

Kiro-specific ACP methods include:

- `_kiro.dev/commands/execute`
- `_kiro.dev/commands/options`
- `_kiro.dev/commands/available`

ACP could support a future direct client or launcher integration, but it is not necessary for this tmux extension's current discovery/switch/status workflow.

## Recommended v1 architecture

Implement Kiro support as a **hook-backed runtime provider with safe fallback**, not as an ACP client and not as a global auto-installed modification.

The flow should be:

1. tmux discovery finds a Kiro CLI pane
2. `attachRuntimeToPanes()` routes it to `attachRuntimeWithKiro()`
3. `attachRuntimeWithKiro()` checks local Kiro state files
4. if matched state exists, render that state
5. otherwise capture pane preview and classify obvious waiting states
6. otherwise show coarse command-backed running status

When hooks are installed for a Kiro agent:

1. Kiro runs lifecycle/tool hooks
2. each hook executes `coding-agents-tmux kiro-hook-state`
3. the CLI reads JSON from stdin
4. it writes a normalized state file
5. tmux UI reads that state file

## Proposed normalized status mapping

| Repo status        | Meaning for Kiro                                                   |
| ------------------ | ------------------------------------------------------------------ |
| `new`              | Kiro agent/session just spawned                                    |
| `running`          | Kiro is processing prompt or tool activity                         |
| `waiting-question` | Kiro appears blocked on a structured choice or permission decision |
| `waiting-input`    | Kiro appears blocked on freeform user input                        |
| `idle`             | Kiro completed a turn and is waiting for the next prompt           |
| `unknown`          | State exists but cannot be interpreted                             |

## Risks and constraints

### 1. Hook install is per-agent

This is the biggest product/UX difference from Codex and Claude.

Risk:

- users may expect `@coding-agents-tmux-auto-install 'kiro'` to globally enable all Kiro sessions

Mitigation:

- document that Kiro hooks must be installed into a named Kiro agent
- keep default Kiro hook auto-install off
- require `@coding-agents-tmux-kiro-agent` before tmux-managed Kiro install
- provide `kiro-hooks-template` for manual control

### 2. Built-in `kiro_default` may not be writable or may not be desirable to modify

The local `kiro-cli agent list` from research showed built-in agents:

- `kiro_default`
- `kiro_help`
- `kiro_planner`

Built-in agents may not correspond to regular JSON files. Even if a default agent can be changed, this integration should not mutate built-ins by default.

Mitigation:

- install only into named custom agents
- optionally create a new managed custom agent later

### 3. Permission waiting may need preview fallback

The Kiro hook docs read for this plan did not show a first-class `permissionRequest` event like Claude Code has.

Mitigation:

- use preview fallback to detect obvious approval prompts
- keep hook state as the source of truth for running/idle
- revisit Kiro docs as they evolve

### 4. `kiro` command can route to IDE or CLI

The `kiro` command router may launch the IDE or CLI based on user preference.

Mitigation:

- detection inside tmux can still include `kiro`, because a tmux pane running `kiro` is likely terminal-driven
- prefer stronger matches from `kiro-cli`, `kiro-cli-chat`, or `kiro-cli-term`

### 5. Session storage internals are not needed

Kiro has saved sessions, but this integration should not rely on undocumented session file locations for v1.

Mitigation:

- use hook `session_id` and cwd
- avoid parsing Kiro session stores

## Implementation notes

### Managed hook marker

Kiro hook objects do not have a documented `statusMessage` field like Codex/Claude hook formats in this repo. To identify managed hooks during merge, use the command string and/or add a harmless wrapper marker in the command.

Preferred simple approach:

- a hook group is managed if any hook command contains:

```text
coding-agents-tmux kiro-hook-state
```

This is consistent with existing tests for Claude/Codex that match the managed command string.

If Kiro tolerates extra hook fields, a future version can add metadata, but v1 should stick to documented fields:

- `command`
- `matcher`
- optional `timeout_ms`

### Shell escaping

Use existing `buildSelfCommand(["kiro-hook-state"])` in `src/cli.ts`. It already shell-escapes the repo CLI path and arguments.

### Resolving tmux target from hook process

Like Codex/Claude, use `TMUX_PANE`:

1. read `process.env.TMUX_PANE`
2. call:

```bash
tmux display-message -p -t "$TMUX_PANE" '#{session_name}:#{window_index}.#{pane_index}'
```

3. store both `paneId` and resolved `target`

If target resolution fails, keep `target: null` and rely on pane id or cwd fallback.

### File naming

Reuse the Codex/Claude convention:

- if pane id exists:

```text
pane-<hex encoded pane id>.json
```

- otherwise:

```text
cwd-<hex encoded cwd>.json
```

### Runtime detail strings

Suggested details:

- `Kiro session started`
- `Kiro is handling a user prompt`
- `Kiro is running read`
- `Kiro is processing read output`
- `Kiro is idle between turns`
- `Kiro is waiting for user input`
- `Kiro is waiting for a multiple-choice response`
- `Kiro appears to be waiting for user input`
- `detected kiro-cli process in tmux pane`

## Acceptance criteria

Kiro support is complete when:

- `coding-agents-tmux list` shows Kiro panes alongside other agents
- `coding-agents-tmux list --agent kiro` filters to Kiro panes
- `switch`, `popup`, waiting filters, and status summaries work with Kiro panes
- without hooks, Kiro panes show a safe coarse status instead of disappearing
- with hooks, Kiro panes show `new`, `running`, `idle`, and waiting states from state files
- hook state matching prefers target/pane id over cwd
- ambiguous cwd matches do not guess
- `kiro-hooks-template` prints valid Kiro agent hook JSON
- `kiro-hook-state` ingests documented Kiro hook payloads
- optional install flow does not modify built-in/default agents unless explicitly requested
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

List Kiro agents:

```bash
kiro-cli agent list
```

Validate an agent config:

```bash
kiro-cli agent validate --path /path/to/agent.json
```

Run Kiro with a named agent:

```bash
kiro-cli chat --agent <agent-name>
```

Generate hook template:

```bash
coding-agents-tmux kiro-hooks-template
```

Install into named agent, if implemented:

```bash
coding-agents-tmux install-kiro --agent <agent-name>
```

Inspect detected panes:

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
