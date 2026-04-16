# coding-agents-tmux Plan

## Goal

Build a TypeScript tool that runs on Node 24 and helps track and navigate terminal coding-agent sessions running inside `tmux`.

The first version should be a standalone CLI. Later versions should add tmux-native UI surfaces while reusing the same core logic.

## Product Goals

- Show all relevant opencode tmux panes and windows.
- Let the user switch quickly to an existing opencode tmux target.
- Show whether an opencode instance is:
  - actively running
  - waiting for a multiple-choice answer
  - waiting for freeform input
  - idle or unknown
- Support both a CLI workflow and, later, a tmux-native workflow.

## Guiding Approach

- Start with a CLI-first architecture.
- Keep tmux integration and opencode state detection in reusable modules.
- Prefer a stable internal data model so future UI layers can consume the same output.
- Use TypeScript with Node 24 from the start because this is expected to become a longer-lived tool.

## Recommended Architecture

### Core Modules

#### `core/tmux`

Responsibilities:

- Enumerate tmux sessions, windows, and panes.
- Detect likely opencode panes.
- Normalize pane targets into ids like `session:window.pane`.
- Expose switch helpers for jumping to a pane or window.

Likely tmux signals:

- `pane_title`
- `pane_tty`
- `pane_current_path`
- `session_name`
- `window_index`
- `pane_index`

#### `core/opencode`

Responsibilities:

- Resolve opencode runtime state for a discovered pane.
- Hide the implementation details of the backing provider.

Provider plan:

- Phase 1: SQLite-backed provider using the local opencode database.
- Phase 2: Server-backed provider using explicit ports and event streaming.

#### `core/model`

Responsibilities:

- Define the app-level status model used by all interfaces.
- Normalize raw tmux and opencode data into a shared shape.

Suggested normalized states:

- `running`
- `waiting-question`
- `waiting-input`
- `idle`
- `unknown`

#### `cli`

Responsibilities:

- Parse commands and flags.
- Render human-readable tables and JSON output.
- Call shared core services.

## Phased Delivery

### Phase 1: CLI POC

Build a standalone CLI with these commands:

- `coding-agents-tmux list`
- `coding-agents-tmux list --json`
- `coding-agents-tmux switch`
- `coding-agents-tmux switch <target>`
- `coding-agents-tmux inspect <target>`

Initial behavior:

- Discover candidate opencode panes from tmux.
- Resolve best-effort state from the local opencode SQLite database.
- Show a compact status table.
- Allow direct switching to a chosen target.

### Phase 2: Improve State Fidelity

Add a provider abstraction so state can come from more than one source.

Target improvements:

- Better pane-to-opencode-session mapping.
- Optional explicit launch conventions.
- Stronger state detection with fewer heuristics.
- Optional watch mode for near-real-time refresh.

### Phase 3: Tmux-Native UX

Add tmux-facing UI surfaces that reuse the CLI core.

Targets:

- tmux popup chooser
- tmux status-line segment
- tmux key binding wrapper

The tmux-native layer should depend on the same discovery and status pipeline as the standalone CLI.

## State Detection Strategy

### Phase 1 Source of Truth

Use the local SQLite database at the opencode data path.

Expected classifications:

- `running`: session is busy and not blocked on a question tool
- `waiting-question`: active question tool with one or more options
- `waiting-input`: active question tool with zero options
- `idle`: session is idle
- `unknown`: unable to map pane to session or insufficient signal

Why SQLite first:

- Easy to inspect locally.
- No launch-time coordination required.
- Good enough for a proof of concept.

### Long-Term Source of Truth

Move toward the built-in opencode server and event stream.

Preferred long-term model:

- launch opencode instances with explicit ports
- map pane to server endpoint
- consume `/session/status`
- subscribe to `/event`

Why this is better:

- more real-time
- less polling
- clearer session ownership
- fewer mapping ambiguities

## UX Principles

- Make the CLI useful both inside and outside tmux.
- Provide readable output by default and structured JSON for automation.
- Make `switch` fast and ergonomic.
- Treat ambiguous mappings as `unknown` instead of guessing too aggressively.

## Risks and Constraints

### Main Technical Risk

Pane-to-session mapping is likely the hardest problem in the first version.

Known issues:

- `pane_current_command` may not reliably identify opencode.
- tmux pane metadata may not be enough on its own.
- multiple opencode sessions may exist for similar directories.

### Mitigations

- use pane title, cwd, tty, and tmux target together
- support an `inspect` command for debugging mappings
- add JSON output early
- plan for an explicit provider model instead of hard-coding SQLite forever

## Initial Recommendation

Build the first release as a Node 24 CLI with a clean split between:

- tmux discovery
- opencode state providers
- normalized status modeling
- CLI rendering and switching

That structure will make it straightforward to add popup and status-line integrations later without rewriting the core.
