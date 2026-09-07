# SketchyBar integration

This integration renders the global coding-agent summary in SketchyBar. It can run alongside the tmux status segment or replace it.

## Configure

Copy or source the relevant lines from `sketchybarrc.example`, replacing `/path/to/coding-agents-tmux` with this plugin's absolute path.

Then configure the generic notification command in `~/.tmux.conf`:

```tmux
set -g @coding-agents-tmux-notify-command 'sketchybar --trigger coding_agents_changed'
```

Reload tmux and SketchyBar. Agent state changes and tmux pane lifecycle events will trigger an update without polling.

The renderer supports these optional environment variables:

- `CODING_AGENTS_TMUX_BIN`: CLI path
- `CODING_AGENTS_TMUX_PROVIDER`: runtime provider, default `plugin`
- `SKETCHYBAR_BIN`: SketchyBar executable, default `sketchybar`
- `CODING_AGENTS_TMUX_COLOR_WAITING`
- `CODING_AGENTS_TMUX_COLOR_BUSY`
- `CODING_AGENTS_TMUX_COLOR_IDLE`
- `CODING_AGENTS_TMUX_COLOR_UNKNOWN`

The click action uses the generic external launcher. Set `CODING_AGENTS_TMUX_FOCUS_COMMAND` when the launcher itself should focus the terminal, or let an AeroSpace binding focus the terminal before invoking it.
