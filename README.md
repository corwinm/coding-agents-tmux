# opencode-tmux

`tmux` integration for `opencode` sessions.

Install it with TPM to:

- open a chooser of active `opencode` panes
- jump straight to panes waiting on your answer
- show the current pane state plus background session summary in the status line
- use plugin-backed runtime state instead of relying only on sqlite heuristics

## Install

Add the plugin to `~/.tmux.conf`:

```tmux
set -g @plugin 'corwinm/opencode-tmux'
```

Recommended settings:

```tmux
set -g @opencode-tmux-provider 'plugin'
set -g @opencode-tmux-key 'O'
set -g @opencode-tmux-waiting-key 'W'
set -g @opencode-tmux-launcher 'menu'
set -g @opencode-tmux-status 'on'
set -g @opencode-tmux-status-style 'tmux'
set -g @opencode-tmux-status-position 'right'
set -g @opencode-tmux-status-interval '1'
```

Then install or reload TPM:

```tmux
prefix + I
```

Requirements:

- `bun` must be installed
- `opencode` sessions must be restarted after first install so the bundled plugin is loaded

## What TPM Sets Up

By default, the TPM plugin also installs the bundled `opencode` plugin by creating this symlink:

```text
~/.config/opencode/plugins/opencode-tmux.ts
```

That plugin publishes normalized session state files under:

```text
~/.local/state/opencode-tmux/plugin-state
```

You can disable the automatic symlink step with:

```tmux
set -g @opencode-tmux-install-opencode-plugin 'off'
```

## Usage

Default key bindings:

- `prefix + O` opens the main session chooser
- `prefix + W` jumps to the only waiting session, or opens a waiting-only chooser if there are multiple

Default launcher behavior:

- `menu` uses a tmux menu and is the most reliable option
- `popup` opens a popup chooser if you prefer a larger interactive view

Set the launcher explicitly with:

```tmux
set -g @opencode-tmux-launcher 'menu'
```

or:

```tmux
set -g @opencode-tmux-launcher 'popup'
```

## Status Line

When enabled, the status line shows two views at once:

- the current pane state
- a compact summary of the remaining `opencode` panes

Example output:

```text
OC | idle | 3 idle
OC | busy | 1 wait
OC | new | none
```

This means:

- `OC | idle | 3 idle` means the focused pane is idle and three background panes are idle
- `OC | busy | 1 wait` means the focused pane is busy and one background pane is waiting for input
- `OC | new | none` means the focused pane is newly started and there are no other detected `opencode` panes

Background summary priority is:

- `wait` first
- then `idle`
- then `busy`

So if any background pane is waiting on you, the status line surfaces that instead of less actionable busy work.

Enable or tune the status line with:

```tmux
set -g @opencode-tmux-status 'on'
set -g @opencode-tmux-status-style 'tmux'
set -g @opencode-tmux-status-position 'right'
set -g @opencode-tmux-status-interval '1'
```

## Configuration

Available tmux options:

- `@opencode-tmux-key` main chooser key, default `O`
- `@opencode-tmux-waiting-key` waiting-only key, default `W`
- `@opencode-tmux-launcher` `menu` or `popup`, default `menu`
- `@opencode-tmux-install-opencode-plugin` `on` or `off`, default `on`
- `@opencode-tmux-provider` `auto`, `plugin`, `sqlite`, or `server`
- `@opencode-tmux-server-map` JSON object or JSON file path for explicit server endpoints
- `@opencode-tmux-popup-filter` one of `all`, `busy`, `waiting`, `running`, `active`
- `@opencode-tmux-popup-width` popup width, default `90%`
- `@opencode-tmux-popup-height` popup height, default `80%`
- `@opencode-tmux-popup-title` popup title, default `OpenCode Sessions`
- `@opencode-tmux-status` `on` or `off`, default `on`
- `@opencode-tmux-status-style` `plain` or `tmux`, default `tmux`
- `@opencode-tmux-status-position` `right` or `left`, default `right`
- `@opencode-tmux-status-interval` tmux `status-interval`, default `1`

## Providers

Recommended provider:

- `plugin` for the best waiting/running/idle detection in normal local `opencode` sessions

Provider modes:

- `auto` uses plugin state when available, then server endpoints, then sqlite
- `plugin` uses only plugin state files
- `sqlite` uses the local `opencode` sqlite database
- `server` uses explicit `opencode serve` endpoints from `@opencode-tmux-server-map`

Example:

```tmux
set -g @opencode-tmux-provider 'plugin'
```

## Troubleshooting

- `prefix + O` does nothing: make sure `bun` is installed and reload tmux
- new panes show stale state: restart the `opencode` session so it reloads the plugin
- waiting detection seems wrong: use the `plugin` provider and confirm the bundled plugin symlink exists at `~/.config/opencode/plugins/opencode-tmux.ts`
- TPM install changed but tmux still looks old: run `prefix + I` or `tmux source-file ~/.tmux.conf`

## CLI

The repository also includes a CLI for debugging and manual inspection.

Useful commands:

```bash
bun run src/cli.ts list --provider plugin
bun run src/cli.ts list --provider plugin --waiting
bun run src/cli.ts inspect <target> --provider plugin
bun run src/cli.ts status --provider plugin --style tmux
bun run src/cli.ts tmux-config --provider plugin
```
