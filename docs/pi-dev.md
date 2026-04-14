# Pi.dev support: research and implementation plan

## Issue

GitHub issue: `#2` — **Add support for Pi.dev**

Issue notes:

- Add support for <https://pi.dev>
- Pi has no built-in permissions or plan mode
- The implementation should be **minimal first**, but **extensible**

## Progress tracker

### Current status

- [x] Research the existing repo architecture
- [x] Research Pi docs, extension model, and session/runtime options
- [x] Write an implementation plan
- [x] Refactor runtime dispatch to support Pi as a first-class agent
- [x] Add Pi pane detection
- [x] Add bundled Pi extension state publisher
- [x] Add Pi runtime reader and attachment logic
- [x] Add preview / command fallback
- [x] Add tmux install flow for the Pi extension
- [x] Update CLI, filters, and user-facing labels
- [x] Add tests
- [x] Update README / usage docs

### Detailed task list

#### 0. Research and planning

- [x] Read the GitHub issue
- [x] Inspect current OpenCode and Codex integration points
- [x] Read Pi docs for extensions, sessions, tmux, JSON/RPC modes, and examples
- [x] Decide on the primary Pi integration strategy
- [x] Write this plan document

#### 1. Runtime model and dispatch refactor

- [x] Add `"pi"` to `AgentKind` in `src/types.ts`
- [x] Add Pi-specific runtime source/provider values in `src/types.ts`
- [x] Refactor `attachRuntimeToPanes()` routing so Pi is not treated as OpenCode
- [x] Introduce a Pi-specific runtime module, likely `src/core/pi.ts`
- [x] Keep existing OpenCode and Codex behavior unchanged

#### 2. Pi pane detection

- [x] Add Pi command-based detection in `src/core/tmux.ts`
- [x] Add optional Pi title-based supporting heuristics
- [x] Extend agent filtering so `--agent pi` is supported
- [x] Add/update detection tests in `test/tmux.test.ts`

#### 3. Bundled Pi extension

- [x] Create a bundled Pi extension file under `plugin/`
- [x] Resolve `TMUX_PANE` to tmux target from inside the extension
- [x] Persist normalized Pi state files under an `opencode-tmux` state directory
- [x] Map Pi lifecycle events to minimal normalized states
- [x] Add conservative best-effort waiting-input detection

#### 4. Pi runtime state reader

- [x] Read Pi state files from disk
- [x] Match by exact target first
- [x] Match by exact pane id second
- [x] Allow cwd fallback only when unambiguous
- [x] Convert matched state into `RuntimeInfo`

#### 5. Pi fallback behavior

- [x] Add preview-based Pi runtime classification
- [x] Add command-only fallback when preview is inconclusive
- [x] Ensure unmatched Pi panes still show up with safe coarse status

#### 6. tmux plugin integration

- [x] Add install/update logic for the bundled Pi extension in `opencode-tmux.tmux`
- [x] Add a tmux option for enabling/disabling Pi extension installation
- [x] Surface a helpful message telling users to restart Pi sessions after install
- [x] Decide on the final install path under `~/.pi/agent/extensions/`

#### 7. CLI and UX updates

- [x] Update `src/cli.ts` agent validation and help text to include Pi
- [x] Update render/help text to avoid OpenCode-only wording where mixed agents are shown
- [x] Update popup/menu/status titles to use agent-neutral wording where appropriate
- [x] Verify `list`, `inspect`, `switch`, `popup`, and `status` work for Pi panes

#### 8. Tests

- [x] Add `test/pi.test.ts`
- [x] Add Pi runtime attachment tests
- [x] Add Pi fallback tests
- [x] Add CLI coverage for `--agent pi`
- [x] Add render coverage for mixed OpenCode/Codex/Pi outputs
- [x] Run the full test suite and fix regressions

#### 9. Documentation

- [x] Update `README.md` to mention Pi support
- [x] Document the bundled Pi extension installation behavior
- [x] Document any new tmux option(s)
- [x] Document fallback behavior and limitations

### Progress notes

Use this section to record implementation progress as work lands.

- 2026-04-14: Researched the repo and Pi docs; wrote the initial Pi support plan and task list.
- 2026-04-14: Completed task group 1. Pi is now a first-class internal agent kind, runtime dispatch has an explicit Pi path, `src/core/pi.ts` exists as the new Pi runtime module entry point, and the full test suite passed.
- 2026-04-14: Completed task group 2. Pi panes are now detected from tmux command/title signals, `--agent pi` is supported by CLI filtering, and test coverage was added in `test/tmux.test.ts`, `test/render.test.ts`, and `test/cli.test.ts`.
- 2026-04-14: Completed task group 3. Added the bundled Pi extension at `plugin/pi-tmux.ts`; it resolves `TMUX_PANE`, writes normalized state files under `~/.local/state/opencode-tmux/pi-state` (or `OPENCODE_TMUX_PI_STATE_DIR`), tracks `session_start`/`agent_start`/`turn_start`/`agent_end`, and does conservative waiting-input detection.
- 2026-04-14: Completed task group 4. `src/core/pi.ts` now reads Pi state files from disk, matches them by target, pane id, and safe cwd fallback, and converts matched state into normalized `RuntimeInfo` with Pi-specific provider/source metadata.
- 2026-04-14: Completed task group 5. Pi now has preview-based waiting-input classification plus a coarse `pi-command` fallback, and focused runtime coverage was added in `test/pi.test.ts`.
- 2026-04-14: Completed task group 6. `opencode-tmux.tmux` now installs the bundled Pi extension from `plugin/pi-tmux.ts` into `~/.pi/agent/extensions/opencode-tmux/index.ts` (or `PI_CODING_AGENT_DIR`), controlled by `@opencode-tmux-install-pi-extension`, and prompts the user to restart Pi sessions when the installed link changes.
- 2026-04-14: Completed task group 7. CLI agent help/validation now includes Pi, mixed-agent popup/menu defaults use `Coding Agent Sessions`, and Pi panes are verified in the core CLI flows.
- 2026-04-14: Completed task group 8. Added `test/pi.test.ts` for Pi state matching and fallback behavior, expanded CLI and render coverage for Pi and mixed-agent cases, and re-ran the full test suite plus `tsc --noEmit` cleanly.
- 2026-04-14: Completed task group 9. Updated `README.md` with Pi support details, the bundled Pi extension install path and state directory, the new `@opencode-tmux-install-pi-extension` option, and Pi fallback behavior/limitations.

## Research summary

### 1. Current repo architecture

The codebase already has two distinct support paths:

- **OpenCode**
  - pane detection in `src/core/tmux.ts`
  - runtime state in `src/core/opencode.ts`
  - richer local state via bundled OpenCode plugin in `plugin/opencode-tmux.ts`
- **Codex**
  - pane detection in `src/core/tmux.ts`
  - runtime state in `src/core/opencode.ts`
  - optional higher-fidelity local state via Codex hooks in `src/core/codex.ts`

Important current constraint:

- `src/types.ts` limits `AgentKind` to `"opencode" | "codex"`
- `src/core/opencode.ts` currently routes runtime handling as:
  - Codex panes → Codex-specific logic
  - everything else → OpenCode provider logic

That means Pi support is not just “add another detection string”; it needs a small runtime-dispatch refactor so Pi does not get shoved through OpenCode-specific providers.

### 2. What Pi itself provides

From the Pi docs and examples:

- CLI binary is `pi`
  - verified via `pi --help`
  - package bin is `pi` in Pi `package.json`
- Pi supports **extensions** written in TypeScript
  - docs: `README.md`, `docs/extensions.md`
- Extensions are auto-discovered from:
  - `~/.pi/agent/extensions/`
  - `.pi/extensions/`
- Extensions can subscribe to lifecycle events including:
  - `session_start`
  - `agent_start` / `agent_end`
  - `turn_start` / `turn_end`
  - `tool_call`
  - `tool_result`
  - `message_*`
- Extensions can persist state and interact with UI
  - `pi.appendEntry()`
  - `ctx.ui.setStatus()`
  - `ctx.ui.setTitle()`
- Pi sessions are stored locally as JSONL files under:
  - `~/.pi/agent/sessions/...`
  - docs: `docs/session.md`

Relevant docs/examples reviewed:

- Pi main docs:
  - `/Users/corwin/.vite-plus/packages/@mariozechner/pi-coding-agent/lib/node_modules/@mariozechner/pi-coding-agent/README.md`
- Extension API:
  - `.../docs/extensions.md`
- Session format:
  - `.../docs/session.md`
- tmux notes:
  - `.../docs/tmux.md`
- Examples:
  - `.../examples/extensions/notify.ts`
  - `.../examples/extensions/status-line.ts`
  - `.../examples/extensions/permission-gate.ts`
  - `.../examples/extensions/plan-mode/README.md`
  - `.../examples/extensions/titlebar-spinner.ts`

### 3. What Pi does _not_ provide by default

Pi’s own README explicitly says it skips features like subagents and **plan mode** by default.

The examples confirm that both of the following are extension-driven patterns, not core built-ins:

- **permissions / approval gates**
  - example: `examples/extensions/permission-gate.ts`
- **plan mode**
  - example: `examples/extensions/plan-mode/`

That matches the GitHub issue statement. For `opencode-tmux`, this means:

- we should **not** design v1 around permission-specific states
- we should **not** assume a stable plan-mode UI exists in every Pi session
- we should aim for a status model that works even if Pi is running “stock”

### 4. Viable state sources for Pi

There are three realistic state sources, in order of desirability:

#### A. Bundled Pi extension state files — **recommended primary source**

This is the closest match to the existing OpenCode plugin and Codex hooks approach.

Why it fits well:

- Pi extensions are first-class and auto-discovered
- extension events expose the exact session/turn lifecycle we care about
- extension code can see `TMUX_PANE`, resolve the tmux target, and write normalized state files
- it gives us reliable pane ↔ state mapping without scraping session history or assuming special launch flags

#### B. Pane preview heuristics — **recommended fallback**

Like current Codex support, we can inspect visible tmux pane content when extension state is missing.

This should stay intentionally coarse in v1.

#### C. Pi session JSONL parsing — **possible future fallback, not recommended for v1 primary**

Pi session files contain useful metadata (cwd, session name, messages), but they are a weak primary runtime source because:

- they do not map cleanly to tmux pane identity
- multiple Pi panes in the same cwd would be ambiguous
- they are better for metadata than real-time runtime state

#### D. JSON mode / RPC mode — **not a good default integration point**

Pi supports JSON and RPC modes, but they require Pi to be launched in a special way. That is not suitable as the default support path for ordinary tmux sessions.

## Recommendation

Implement Pi support as a **third agent path** with:

1. **Pi pane detection**
2. **Pi-specific runtime attachment**
3. **bundled Pi extension state** as the main source of truth
4. **preview/command fallback** when extension state is unavailable

This matches the repo’s existing support philosophy:

- OpenCode: plugin-first
- Codex: hook/preview hybrid
- Pi: extension-first with lightweight heuristics

## Proposed scope for v1

### Supported in v1

- discover Pi panes in tmux
- include Pi panes in:
  - `list`
  - `inspect`
  - `switch`
  - `popup`
  - `status`
- classify Pi panes into a minimal runtime model:
  - `new`
  - `running`
  - `idle`
  - `waiting-input` (best effort only)
  - `unknown`
- install a bundled Pi extension automatically from the tmux plugin
- fall back gracefully when the extension is not installed or Pi sessions have not been restarted yet

### Explicitly _not_ promised in v1

- permission-specific status
- plan-mode-specific status
- robust multi-choice question detection
- parsing arbitrary third-party Pi extensions
- deep Pi session tree inspection/debug UI

## Proposed runtime model for Pi

### State mapping

Pi v1 should use these semantics:

- `new`
  - just started / session initialized
- `running`
  - Pi is actively processing a user request or executing tools
- `idle`
  - Pi is open and ready for the next prompt
- `waiting-input`
  - Pi appears to have ended on a direct question or explicit request for user input
- `unknown`
  - pane was detected as Pi, but runtime state is not confidently known

### Why no `waiting-question` in v1

OpenCode and Codex have stronger question-specific structures today. Pi does not expose a universal built-in multiple-choice workflow in the same way.

Since permissions and plan mode are extension-driven in Pi, `waiting-question` would be too speculative as a default cross-session status.

We can add it later if the bundled Pi extension starts publishing that distinction.

## Implementation plan

### Phase 1: refactor runtime dispatch to support a third agent

#### Files

- `src/types.ts`
- `src/core/opencode.ts`
- likely new: `src/core/pi.ts`

#### Changes

- widen `AgentKind` to include `"pi"`
- add Pi-specific runtime source values, likely something like:
  - `pi-extension`
  - `pi-preview`
  - `pi-command`
- add Pi-specific runtime provider/match value, likely `provider: "pi"`
- stop treating “non-codex” as synonymous with OpenCode
- route discovered panes by agent kind:
  - OpenCode → existing OpenCode provider flow
  - Codex → existing Codex flow
  - Pi → new Pi flow

#### Notes

This is the key extensibility change. Without it, Pi support will keep leaking OpenCode assumptions everywhere.

### Phase 2: detect Pi panes

#### Files

- `src/core/tmux.ts`
- tests in `test/tmux.test.ts`, `test/render.test.ts`, `test/cli.test.ts`

#### Changes

Add Pi detection heuristics alongside OpenCode and Codex.

Recommended initial signals:

- `pane_current_command == "pi"`
- `pane_current_command` starts with `pi-` if Pi ever ships platform-specific wrappers
- optional title hints if present
  - `π - ...`
  - `pi - ...`

Recommended confidence strategy:

- command match → medium/high confidence primary signal
- title hint → supporting signal, not required

#### Why command-first

Unlike OpenCode, Pi already has a distinct CLI binary name. That makes pane discovery much cheaper and less heuristic-heavy.

### Phase 3: add bundled Pi extension state

#### New file

Suggested new bundled extension file, e.g.:

- `plugin/pi/opencode-tmux-pi.ts`
- or `plugin/pi-tmux.ts`

#### Extension responsibilities

On Pi lifecycle events, write normalized JSON state files under a dedicated state dir, for example:

- `~/.local/state/opencode-tmux/pi-state`

State shape should mirror the existing normalized patterns already used in this repo:

```json
{
  "version": 1,
  "paneId": "%12",
  "target": "work:3.1",
  "directory": "/path/to/project",
  "title": "session name or cwd basename",
  "activity": "busy",
  "status": "running",
  "detail": "Pi is processing a user request",
  "updatedAt": 1710000000000,
  "sourceEventType": "turn_start",
  "sessionFile": "optional"
}
```

#### Suggested event mapping

- `session_start`
  - status: `new`
  - activity: `idle`
- `agent_start` or `turn_start`
  - status: `running`
  - activity: `busy`
- `agent_end`
  - status: `idle` by default
  - optionally upgrade to `waiting-input` if the last assistant message clearly asks the user a direct question
- `session_shutdown`
  - optional cleanup or final persist

#### Best-effort waiting detection

Keep this intentionally simple in v1:

- only classify `waiting-input` on strong textual clues from the last assistant message
- examples:
  - message ends in `?`
  - phrases like `would you like`, `do you want`, `should I`, `please confirm`

Do **not** attempt to detect permission requests or plan-mode prompts specially in v1.

### Phase 4: read Pi extension state in `opencode-tmux`

#### New file

- `src/core/pi.ts`

#### Responsibilities

- locate Pi state dir
- read and normalize Pi state files
- match by:
  1. exact tmux target
  2. exact pane id
  3. cautious cwd fallback only if unambiguous
- classify into `RuntimeInfo`

#### Matching rules

Use the same conservative posture as the rest of the repo:

- exact target wins
- pane id next
- cwd fallback only when safe and unambiguous
- otherwise leave state as `unknown`

### Phase 5: add preview and command fallback

#### File

- `src/core/pi.ts`

#### Behavior

If no Pi extension state matches:

1. try pane preview heuristics
2. if preview is inconclusive, fall back to:
   - `status: running`
   - `activity: busy`
   - `source: pi-command`
   - detail like `detected pi process in tmux pane`

#### Why this fallback is acceptable

For Pi, `pi` staying as the foreground pane command is at least enough to prove “this is a Pi pane”. The extension is what upgrades that from discovery to reliable runtime state.

### Phase 6: tmux plugin install flow for Pi extension

#### Files

- `opencode-tmux.tmux`
- maybe helper scripts if needed
- `README.md`

#### Changes

Add a Pi install step similar in spirit to:

- OpenCode plugin install
- Codex hook install

Suggested tmux option:

- `@opencode-tmux-install-pi-extension 'on' | 'off'`

Suggested install target:

- `~/.pi/agent/extensions/opencode-tmux.ts`
  - or a namespaced subdirectory under `~/.pi/agent/extensions/`

#### Notes

Because Pi auto-discovers extensions from `~/.pi/agent/extensions/`, this is simpler than the Codex hooks flow.

The tmux plugin should:

- install/update the extension file
- tell the user to restart Pi sessions so the extension is loaded

### Phase 7: user-facing strings and filters

#### Files

- `src/cli.ts`
- `src/cli/render.ts`
- `opencode-tmux.tmux`
- `scripts/tmux-menu-switch.sh`
- `README.md`

#### Changes

Update agent filters and text that currently assume only OpenCode/Codex:

- `--agent all|opencode|codex` → `--agent all|opencode|codex|pi`
- help text and validation logic

Also revisit OpenCode-branded UI strings that now represent mixed agents:

- popup titles
- menu titles
- docs examples

Suggested default wording:

- `Coding Agent Sessions`

### Phase 8: tests

#### New tests

Add `test/pi.test.ts` covering:

- Pi extension state matching by target/pane id/cwd
- runtime classification from extension state
- preview fallback
- command fallback
- waiting-input best-effort classification

#### Update existing tests

- `test/tmux.test.ts` for pane detection
- `test/cli.test.ts` for `--agent pi` and mixed-agent outputs
- `test/render.test.ts` for render stability with Pi panes

## Design decisions to keep this extensible

### 1. Use a dedicated `src/core/pi.ts`

Do not keep stuffing more agent-specific logic into `src/core/opencode.ts`.

Even if `attachRuntimeToPanes()` stays there for now, Pi-specific parsing/state logic should live in its own module.

### 2. Prefer extension state over session parsing

Pi’s extension API is a better long-term contract than reverse-engineering session JSONL files for runtime status.

Session files are still useful later for metadata fallback, but should not be the core of v1.

### 3. Keep Pi status intentionally coarse

The issue explicitly says minimal support is the right starting point. The fastest way to overcomplicate this is to chase every possible Pi UI mode.

### 4. Make waiting detection additive

Start with:

- `new`
- `running`
- `idle`
- `waiting-input` best effort

Then add richer distinctions only when we have a stronger signal source.

## Alternatives considered

### Parse Pi session files as the main source

Rejected for v1 primary because pane/session mapping is too ambiguous.

### Require Pi JSON or RPC mode

Rejected as default because normal tmux Pi usage should work without special launch modes.

### Preview-only Pi support

Possible, but weaker than necessary. Pi already has an extension system that gives us a much better integration point.

## Proposed milestone order

1. Refactor runtime dispatch for 3 agents
2. Add Pi pane detection
3. Add bundled Pi extension
4. Add Pi state reader and runtime attachment
5. Add preview/command fallback
6. Wire tmux install flow
7. Update CLI/help/docs strings
8. Add tests

## Acceptance criteria for v1

- Pi panes are discoverable in `list`, `switch`, `popup`, and `status`
- `--agent pi` works everywhere `--agent` is supported
- tmux plugin can install the bundled Pi extension automatically
- restarted Pi sessions produce stable pane-specific state
- Pi status line output works even if state is only coarse
- no OpenCode or Codex regressions

## Follow-up ideas after v1

- richer Pi debug output in `inspect --debug`
- optional session-file metadata fallback for titles/session names
- optional use of terminal title as a secondary hint source
- optional support for third-party Pi permission/plan extensions when their state shape is known
- eventually rename `src/core/opencode.ts` to something agent-neutral if the file keeps growing into a router
