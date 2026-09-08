# External launchers

`focus-and-popup.sh` lets window managers, status bars, launchers, and automation tools open a chooser in an attached tmux client. It opens the full popup by default; pass `--menu` for the compact native tmux menu.

It accepts the popup filters, including `--waiting`, and supports:

- `CODING_AGENTS_TMUX_BIN`: CLI path
- `CODING_AGENTS_TMUX_CLIENT`: tmux client name or `auto`, default `auto`
- `CODING_AGENTS_TMUX_FOCUS_COMMAND`: optional shell command run before opening the popup

For AeroSpace, terminal choice and workspace assignment remain user configuration. A small user-owned wrapper can provide the focus command:

```sh
#!/bin/sh
export CODING_AGENTS_TMUX_FOCUS_COMMAND='aerospace workspace T'
exec /path/to/coding-agents-tmux/integrations/external/focus-and-popup.sh "$@"
```

Then bind that wrapper in AeroSpace:

```toml
[mode.main.binding]
alt-o = 'exec-and-forget /path/to/user-wrapper'
alt-w = 'exec-and-forget /path/to/user-wrapper --waiting'
alt-m = 'exec-and-forget /path/to/user-wrapper --menu'
```

The generic launcher only runs the configured focus command, identifies the most recently active attached tmux client, and opens the chooser there. It supplies a UTF-8 locale when macOS launches it without locale variables so tmux preserves the CLI's field delimiters.
