# External launchers

`focus-and-popup.sh` lets window managers, status bars, launchers, and automation tools open a chooser in an attached tmux client. It opens the full popup by default; pass `--menu` for the compact native tmux menu.

It accepts the popup filters, including `--waiting`, and supports:

- `CODING_AGENTS_TMUX_BIN`: CLI path
- `CODING_AGENTS_TMUX_CLIENT`: tmux client name or `auto`, default `auto`
- `CODING_AGENTS_TMUX_FOCUS_COMMAND`: optional shell command run before opening the popup

For AeroSpace, terminal choice and workspace assignment remain user configuration. A small user-owned wrapper can provide the focus command:

```sh
#!/bin/sh
plugin_dir="${TMUX_PLUGIN_MANAGER_PATH:-$HOME/.tmux/plugins}/coding-agents-tmux"
export CODING_AGENTS_TMUX_FOCUS_COMMAND='aerospace workspace T'
exec "$plugin_dir/integrations/external/focus-and-popup.sh" "$@"
```

Then bind that wrapper in AeroSpace:

```toml
[mode.main.binding]
alt-o = 'exec-and-forget /path/to/user-wrapper'
alt-w = 'exec-and-forget /path/to/user-wrapper --waiting'
alt-m = 'exec-and-forget /path/to/user-wrapper --menu'
```

To jump directly to the first, second, or third discovered agent, create a similar wrapper around `focus-and-switch-index.sh`:

```sh
#!/bin/sh
plugin_dir="${TMUX_PLUGIN_MANAGER_PATH:-$HOME/.tmux/plugins}/coding-agents-tmux"
export CODING_AGENTS_TMUX_FOCUS_COMMAND='aerospace workspace T'
exec "$plugin_dir/integrations/external/focus-and-switch-index.sh" "$@"
```

Then bind number keys in AeroSpace (choose any modifiers you prefer):

```toml
[mode.main.binding]
alt-1 = 'exec-and-forget /path/to/user-index-wrapper 1'
alt-2 = 'exec-and-forget /path/to/user-index-wrapper 2'
alt-3 = 'exec-and-forget /path/to/user-index-wrapper 3'
```

Indexes are one-based and follow the CLI's stable pane-target order. Optional list filters can follow the index, for example `2 --waiting` or `1 --agent pi`. If an index is greater than the number of matching panes, the script exits without switching.

The generic launchers run the configured focus command, identify the most recently active attached tmux client, and open or switch there. They supply a UTF-8 locale when macOS launches them without locale variables so tmux preserves the CLI's field delimiters.
