# External launchers

`focus-and-popup.sh` lets window managers, status bars, launchers, and automation tools open the existing chooser in an attached tmux client.

It accepts the popup filters, including `--waiting`, and supports:

- `CODING_AGENTS_TMUX_BIN`: CLI path
- `CODING_AGENTS_TMUX_CLIENT`: tmux client name or `auto`, default `auto`
- `CODING_AGENTS_TMUX_FOCUS_COMMAND`: optional shell command run before opening the popup

For AeroSpace, it is usually cleaner to let the binding focus the configured terminal workspace:

```toml
[mode.main.binding]
alt-o = [
  'workspace T',
  'exec-and-forget /path/to/coding-agents-tmux/integrations/external/focus-and-popup.sh'
]

alt-w = [
  'workspace T',
  'exec-and-forget /path/to/coding-agents-tmux/integrations/external/focus-and-popup.sh --waiting'
]
```

This deliberately leaves terminal placement and focus policy to AeroSpace. The launcher only identifies the most recently active attached tmux client and opens the chooser there.
