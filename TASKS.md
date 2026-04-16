# coding-agents-tmux Tasks

## Milestone 1: Project Bootstrap

- Initialize a Node 24 + TypeScript project.
- Add a CLI entrypoint for `coding-agents-tmux`.
- Set up basic source structure for `core`, `providers`, and `cli` modules.
- Add linting, formatting, and a minimal test setup if appropriate.

## Milestone 2: Tmux Discovery

- Implement a tmux client wrapper for running `tmux` commands.
- Add pane enumeration across all sessions.
- Parse tmux metadata into typed models.
- Detect likely opencode panes using pane title, cwd, and related signals.
- Normalize pane ids into a stable target format such as `session:window.pane`.

## Milestone 3: CLI `list`

- Implement `coding-agents-tmux list`.
- Render a readable default table output.
- Add `--json` output.
- Include target id, title, cwd, and preliminary detection info.

## Milestone 4: SQLite State Provider

- Add an opencode SQLite access layer.
- Inspect the relevant session and part data needed for status classification.
- Implement normalized statuses:
  - `running`
  - `waiting-question`
  - `waiting-input`
  - `idle`
  - `unknown`
- Handle ambiguous mappings safely.

## Milestone 5: CLI `inspect`

- Implement `coding-agents-tmux inspect <target>`.
- Show the raw pane metadata used for detection.
- Show the mapped opencode session details.
- Show the raw signals used to produce the normalized status.
- Add `--json` support.

## Milestone 6: CLI `switch`

- Implement `coding-agents-tmux switch <target>`.
- Implement interactive `coding-agents-tmux switch` without a target.
- Reuse list data so the chooser includes status and labels.
- Support switching the current tmux client to the selected pane or window.

## Milestone 7: Provider Abstraction

- Refactor state lookup behind a provider interface.
- Keep SQLite as the default initial provider.
- Define the contract for future server-backed providers.
- Make provider selection configurable.

## Milestone 8: Watch Mode and Polish

- Add a `watch` or refresh mode for repeated status updates.
- Improve error messages for missing tmux sessions or unmapped panes.
- Add shell-friendly exit codes.
- Add sample usage to the README.

## Milestone 9: Long-Term Server Provider

- Add support for explicit opencode server ports.
- Map tmux panes to known opencode server endpoints.
- Read `/session/status` from the server.
- Subscribe to `/event` for higher-fidelity live state.
- Compare server-backed accuracy against SQLite-backed status.

## Milestone 10: Tmux-Native UI

- Add a tmux popup chooser powered by the shared core.
- Add a tmux status-line integration.
- Add tmux key binding examples.
- Ensure tmux-native UI reuses the same normalized status model as the CLI.

## Cross-Cutting Tasks

- Define shared TypeScript types for panes, sessions, providers, and statuses.
- Keep the default output concise and human-readable.
- Keep JSON output stable enough for later UI integrations.
- Add tests around parsing, status normalization, and mapping logic.
- Document known heuristics and failure modes.

## Recommended Build Order

1. Bootstrap project
2. Tmux discovery
3. `list`
4. SQLite provider
5. `inspect`
6. `switch`
7. provider abstraction
8. polish and watch mode
9. server provider
10. tmux-native UI
