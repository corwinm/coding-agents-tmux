# opencode-tmux

CLI-first tooling for discovering `opencode` instances running in `tmux`.

## Current Status

The repository now has an initial Bun + TypeScript CLI scaffold and a working `list` command for discovering likely opencode panes.

The CLI now uses `commander` for command parsing so future subcommands can be added cleanly.

## Run

```bash
bun run src/cli.ts list
bun run src/cli.ts list --compact
bun run src/cli.ts popup
bun run src/cli.ts popup --busy
bun run src/cli.ts status
bun run src/cli.ts status --style tmux
bun run src/cli.ts status --summary
bun run src/cli.ts tmux-config
bun run src/cli.ts install-tmux
bun run src/cli.ts server-map-template
bun run src/cli.ts server-map-template --base-port 4096
bun run src/cli.ts list --provider sqlite
bun run src/cli.ts list --provider server --server-map '{"opencode-tmux:1.2":"http://127.0.0.1:4096"}'
bun run src/cli.ts list --watch
bun run src/cli.ts list --watch --interval 1
bun run src/cli.ts list --busy
bun run src/cli.ts list --waiting
bun run src/cli.ts list --running
bun run src/cli.ts list --active
bun run src/cli.ts list --json
bun run src/cli.ts inspect opencode-tmux:1.2
bun run src/cli.ts switch
bun run src/cli.ts switch --busy
bun run src/cli.ts switch --waiting
bun run src/cli.ts switch --running
bun run src/cli.ts switch opencode-tmux:1.2
```

## Scope So Far

- Bun + TypeScript project scaffold
- tmux pane discovery
- heuristic detection of likely opencode panes
- SQLite-backed runtime status detection for matched sessions
- conservative descendant-session heuristics when cwd is broader than the actual project
- `inspect <target>` for debugging pane and session mapping
- interactive `switch` chooser when no target is provided
- `switch <target>` for direct tmux navigation
- `popup` to open a tmux-native chooser backed by the CLI switch command
- `status` for tmux status-line text based on the current pane or overall summary
- `tmux-config` to generate a ready-to-paste tmux integration snippet
- `install-tmux` to update `.tmux.conf` with a managed opencode-tmux block
- optional tmux-colored status output with `status --style tmux`
- `--active`, `--busy`, `--waiting`, and `--running` filters for `list` and `switch`
- `list --compact` for tmux-friendly tab-separated output
- runtime provider selection: `auto`, `sqlite`, or explicit `server` endpoints via `--server-map`
- `server-map-template` to generate explicit pane-to-endpoint mappings
- `server-map-template --base-port 4096` to prefill sequential local ports
- validated current behavior: headless `opencode serve` may return empty `{}` from `/session/status` until a session is actively attached, so `auto` falls back to sqlite
- `list --watch` with configurable refresh interval
- higher-level runtime activity labels (`busy`, `idle`, `unknown`) alongside detailed statuses
- matched session title shown in list output
- structured runtime match metadata in JSON output for future tmux-native consumers
- human-readable and JSON output

## Next Up

- better pane-to-session mapping when cwd is not an exact match

## Tmux Popup

Inside tmux:

```bash
bun run src/cli.ts popup
bun run src/cli.ts popup --busy
```

Example tmux binding:

```tmux
bind-key O run-shell 'cd /Users/corwin/Documents/GitHub/opencode-tmux && bun run src/cli.ts popup --busy'
```

Or generate a ready-to-paste snippet:

```bash
bun run src/cli.ts tmux-config
```

## Tmux Status Line

Example tmux status-right usage:

```tmux
set -g status-right '#(cd /Users/corwin/Documents/GitHub/opencode-tmux && bun run src/cli.ts status)'
```

For tmux color formatting:

```tmux
set -g status-right '#(cd /Users/corwin/Documents/GitHub/opencode-tmux && bun run src/cli.ts status --style tmux)'
```

Current status output also includes simple symbols:

- `!` waiting for user response
- `*` busy/running
- `-` idle/none
- `~` unknown

To always show a global summary instead of the current pane context:

```tmux
set -g status-right '#(cd /Users/corwin/Documents/GitHub/opencode-tmux && bun run src/cli.ts status --summary)'
```

## Tmux Config Generator

Generate a snippet with a popup binding and status line:

```bash
bun run src/cli.ts tmux-config
```

Customize the popup filter or key binding:

```bash
bun run src/cli.ts tmux-config --popup-filter waiting --key W
```

## Tmux Installer

Write or update a managed `opencode-tmux` block in `~/.tmux.conf`:

```bash
bun run src/cli.ts install-tmux
tmux source-file ~/.tmux.conf
```

Target a different tmux config file if needed:

```bash
bun run src/cli.ts install-tmux --file ~/.config/tmux/tmux.conf
```
