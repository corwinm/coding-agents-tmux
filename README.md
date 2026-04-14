# opencode-tmux

`tmux` integration for terminal coding agent sessions.

Install it with TPM to:

- open a chooser of active coding agent panes
- jump straight to panes waiting on your answer
- show the current pane state plus background session summary in the status line
- use plugin-backed runtime state instead of relying only on sqlite heuristics

Today the strongest runtime support is still for `opencode`, and the repo now also detects `codex` and `pi` panes for discovery, switching, popup navigation, and status summaries.

## Install

Add the plugin to `~/.tmux.conf`:

```tmux
set -g @plugin 'corwinm/opencode-tmux'
```

Recommended settings:

```tmux
set -g @opencode-tmux-provider 'plugin'
set -g @opencode-tmux-menu-key 'O'
set -g @opencode-tmux-popup-key 'P'
set -g @opencode-tmux-waiting-menu-key 'W'
set -g @opencode-tmux-waiting-popup-key 'C-w'
set -g @opencode-tmux-status 'on'
set -g @opencode-tmux-status-style 'tmux'
set -g @opencode-tmux-status-position 'right'
set -g @opencode-tmux-status-interval '0'
```

Those defaults favor the bundled plugin provider and event-driven status redraws so tmux stops polling Node in the background.

To match your tmux theme, you can also override the status colors:

```tmux
set -g @opencode-tmux-status-color-neutral 'default'
set -g @opencode-tmux-status-color-idle 'colour244'
set -g @opencode-tmux-status-color-busy 'colour81'
set -g @opencode-tmux-status-color-waiting 'colour214'
set -g @opencode-tmux-status-color-unknown 'colour240'
```

Using `default` is a good way to let the segment inherit your existing tmux theme colors.

Then install or reload TPM:

```tmux
prefix + I
```

Requirements:

- Node 24+ must be installed
- npm 10+ must be installed
- TPM will install CLI dependencies automatically on first load with `npm ci --omit=dev`
- `opencode` sessions must be restarted after first install so the bundled plugin is loaded
- `codex` sessions must be restarted after first install so newly installed hooks are loaded
- `pi` sessions must be restarted after first install so the bundled extension is loaded

## What TPM Sets Up

By default, the TPM plugin also installs the bundled `opencode` plugin by creating this symlink:

```text
~/.config/opencode/plugins/opencode-tmux.ts
```

That plugin publishes normalized session state files under:

```text
~/.local/state/opencode-tmux/plugin-state
```

On first install, the tmux plugin also bootstraps the CLI runtime dependencies inside:

```text
~/.tmux/plugins/opencode-tmux/node_modules
```

It also installs or updates the bundled Pi extension under:

```text
~/.pi/agent/extensions/opencode-tmux/index.ts
```

That extension publishes normalized Pi state files under:

```text
~/.local/state/opencode-tmux/pi-state
```

It also installs or updates Codex hook integration under:

```text
~/.codex/config.toml
~/.codex/hooks.json
```

You can disable the automatic symlink step with:

```tmux
set -g @opencode-tmux-install-opencode-plugin 'off'
```

You can disable the automatic Pi extension setup with:

```tmux
set -g @opencode-tmux-install-pi-extension 'off'
```

You can disable the automatic Codex hook setup with:

```tmux
set -g @opencode-tmux-install-codex-hooks 'off'
```

## Usage

Default key bindings:

- `prefix + O` opens the main menu chooser
- `prefix + P` opens the main popup chooser
- `prefix + W` jumps to the only waiting session, or opens a waiting-only menu if there are multiple
- `prefix + C-w` opens the waiting-only popup chooser

Launcher behavior:

- `menu` uses a tmux menu and is the most reliable option
- `popup` opens a popup chooser if you prefer a larger interactive view

Inside the popup you can do more than pick a row number:

- type to filter the list by target, session, title, state, or path
- use the up and down arrows or `Ctrl-J` / `Ctrl-K` to move through the matching panes
- use `Ctrl-G` then `1` through `9` to immediately open the matching visible row
- press `Enter` to switch to the selected pane
- press `Esc` to close the popup or `Ctrl-R` to refresh the live pane list

You can configure each binding independently:

```tmux
set -g @opencode-tmux-menu-key 'O'
set -g @opencode-tmux-popup-key 'P'
set -g @opencode-tmux-waiting-menu-key 'W'
set -g @opencode-tmux-waiting-popup-key 'C-w'
```

Set any of them to `off` to disable that binding.

## Status Line

When enabled, the status line shows two views at once:

- the current pane state
- a compact summary of the remaining `opencode` panes

Example output:

```text
󰚩 |  idle |   
󰚩 |  busy | 
󰚩 |  new | none
```

You can also replace the default icon with your own label or a different Nerd Font icon:

```tmux
set -g @opencode-tmux-status-prefix '󰚩'
```

This means:

- `󰚩 |  idle |   ` means the focused pane is idle and the background panes are waiting, busy, and idle in target order
- `󰚩 |  busy | ` means the focused pane is busy and more than eight background panes are shown in compact symbol mode
- `󰚩 |  new | none` means the focused pane is newly started and there are no other detected `opencode` panes

If your active pane is not an `opencode` pane, the status line uses the strongest detected `opencode` pane in the current tmux window. `opencode` panes in other windows are counted as background work.

Background pane symbols are shown in a stable target order:

- `` waiting
- `` busy
- `` idle
- `` new
- `` unknown

By default the status line adds spaces between background pane symbols for readability. If there are more than eight background panes, it automatically switches to a compact no-space form.

Enable or tune the status line with:

```tmux
set -g @opencode-tmux-status 'on'
set -g @opencode-tmux-status-style 'tmux'
set -g @opencode-tmux-status-position 'right'
set -g @opencode-tmux-status-interval '0'
```

By default the plugin now uses manual mode so your theme can place the segment itself.

With the bundled plugin provider, `0` makes the status line event-driven: `opencode` session events and tmux navigation hooks trigger redraws, instead of polling on a timer. If you switch to the `sqlite` or `server` provider, set a positive interval if you still want periodic background refreshes.

For Catppuccin, use the native module the plugin exports:

```tmux
set -g @opencode-tmux-status 'on'
set -g @opencode-tmux-status-mode 'manual'

set -g status-right "#{E:@catppuccin_status_session}"
set -ag status-right "#{E:@catppuccin_status_directory}"
set -ag status-right "#{E:@catppuccin_status_opencode}"
```

For other themes, use the tone-aware inline export if you want the summary colors to follow busy/waiting/idle/unknown automatically:

```tmux
set -g @opencode-tmux-status 'on'
set -g @opencode-tmux-status-mode 'manual'

set -ag status-right " #{@opencode-tmux-status-inline-format}"
```

If you want to fully control the wrapper yourself, use the plain text export instead:

```tmux
set -ag status-right " #[fg=colour81]󰚩 #[default]#{@opencode-tmux-status-text}"
```

`manual` mode is the default. `#{E:@catppuccin_status_opencode}` gives Catppuccin users a native-looking module, `#{@opencode-tmux-status-inline-format}` gives other themes a tone-aware inline segment, and `#{@opencode-tmux-status-text}` gives a plain live summary text export for fully custom wrappers. `append` mode restores the old behavior and appends automatically.

When using the Catppuccin module, the segment reuses your configured `@opencode-tmux-status-color-*` palette: busy stays on the busy color, waiting turns to the waiting color, idle turns to the idle color, and no detected panes falls back to the unknown color.

## Configuration

Available tmux options:

- `@opencode-tmux-menu-key` main menu chooser key, default `O`
- `@opencode-tmux-popup-key` main popup chooser key, default `P`
- `@opencode-tmux-waiting-menu-key` waiting-only menu chooser key, default `W`
- `@opencode-tmux-waiting-popup-key` waiting-only popup chooser key, default `C-w`
- `@opencode-tmux-install-opencode-plugin` `on` or `off`, default `on`
- `@opencode-tmux-install-pi-extension` `on` or `off`, default `on`
- `@opencode-tmux-install-codex-hooks` `on` or `off`, default `on`
- `@opencode-tmux-provider` `auto`, `plugin`, `sqlite`, or `server`, default `plugin`
- `@opencode-tmux-server-map` JSON object or JSON file path for explicit server endpoints
- `@opencode-tmux-popup-filter` one of `all`, `busy`, `waiting`, `running`, `active`
- `@opencode-tmux-popup-width` popup width, default `100%`
- `@opencode-tmux-popup-height` popup height, default `100%`
- `@opencode-tmux-popup-title` popup title, default `Coding Agent Sessions`
- `@opencode-tmux-status` `on` or `off`, default `on`
- `@opencode-tmux-status-style` `plain` or `tmux`, default `tmux`
- `@opencode-tmux-status-mode` `append` or `manual`, default `manual`
- `@opencode-tmux-status-position` `right` or `left`, default `right`
- `@opencode-tmux-status-interval` tmux `status-interval`, default `0`
- `@opencode-tmux-status-prefix` label shown before the status summary, default `󰚩`
- `@opencode-tmux-status-color-neutral` tmux color for the prefix and separators, default `colour252`
- `@opencode-tmux-status-color-idle` tmux color for idle state, default `colour70`
- `@opencode-tmux-status-color-busy` tmux color for busy state, default `colour220`
- `@opencode-tmux-status-color-waiting` tmux color for waiting state, default `colour196`
- `@opencode-tmux-status-color-unknown` tmux color for unknown/none state, default `colour244`

## Providers

Recommended provider:

- `plugin` for the best waiting/running/idle detection in normal local `opencode` sessions, and the default tmux integration provider

Provider modes:

- `auto` uses plugin state when available, then server endpoints, then sqlite
- `plugin` uses only plugin state files
- `sqlite` uses the local `opencode` sqlite database
- `server` uses explicit `opencode serve` endpoints from `@opencode-tmux-server-map`

Example:

```tmux
set -g @opencode-tmux-provider 'plugin'
```

## Pi

`pi` panes are detected from the live tmux pane command and common title patterns, so they show up in `list`, `switch`, `popup`, and `status` alongside `opencode` and `codex` panes.

Use `--agent opencode`, `--agent codex`, `--agent pi`, or `--agent all` on `list`, `switch`, `popup`, `popup-ui`, and `status` when you want to narrow mixed tmux environments.

For the best Pi runtime fidelity, let the tmux plugin install the bundled Pi extension automatically. It is linked into:

```text
~/.pi/agent/extensions/opencode-tmux/index.ts
```

That extension publishes pane-aware Pi state under:

```text
~/.local/state/opencode-tmux/pi-state
```

Pi runtime support is intentionally minimal and extensible:

- with the bundled Pi extension loaded, Pi panes can report `new`, `running`, `idle`, and best-effort `waiting-input`
- without the extension, `opencode-tmux` falls back to pane preview heuristics when possible
- if preview is inconclusive, Pi falls back to a coarse `running` state when a `pi` process is still detected in the tmux pane
- Pi has no built-in permission or plan mode integration here yet, so those states are not modeled specially

After first install or update, restart Pi sessions in tmux so they load the bundled extension.

## Codex

`codex` panes are detected from the live tmux pane command, so they now show up in `list`, `switch`, `popup`, and `status` alongside `opencode` panes.

Use `--agent opencode`, `--agent codex`, `--agent pi`, or `--agent all` on `list`, `switch`, `popup`, `popup-ui`, and `status` when you want to narrow mixed tmux environments.

Default Codex runtime support is intentionally coarse:

- if a tmux pane is running a `codex` process, it is classified as `running`
- waiting, question, and idle distinctions are still `opencode`-specific until a stronger Codex-local state source is added

To enable higher-fidelity Codex state with Codex hooks:

1. Let the tmux plugin install the global Codex config automatically, or run it manually:

```bash
./bin/opencode-tmux install-codex
```

2. Optionally generate an additional repo-local hooks file:

```bash
mkdir -p .codex
./bin/opencode-tmux codex-hooks-template > .codex/hooks.json
```

3. Restart `codex` sessions in tmux so they begin publishing hook-backed state.

With hooks enabled, `opencode-tmux` can mark Codex panes as `idle` or `waiting-input` between turns instead of showing every Codex pane as continuously `running`.

## Troubleshooting

- `prefix + O` or `prefix + P` does nothing: make sure `node` and `npm` are installed and reload tmux
- first TPM load feels slow: the plugin may be running `npm ci --omit=dev` to bootstrap dependencies
- new panes show stale state: restart the `opencode` session so it reloads the plugin
- waiting detection seems wrong: use the `plugin` provider and confirm the bundled plugin symlink exists at `~/.config/opencode/plugins/opencode-tmux.ts`
- Pi still looks busy or unknown: confirm the bundled extension exists at `~/.pi/agent/extensions/opencode-tmux/index.ts` and restart the Pi session so it loads the extension
- Codex still always looks busy: confirm `~/.codex/config.toml` has `codex_hooks = true`, `~/.codex/hooks.json` exists, and restart the Codex session
- status looks stale with `sqlite` or `server`: set `@opencode-tmux-status-interval` to a positive value because event-driven refreshes are centered on the bundled plugin provider
- TPM install changed but tmux still looks old: run `prefix + I` or `tmux source-file ~/.tmux.conf`

## Local Development Sync

If you edit this repo outside `~/.tmux/plugins/opencode-tmux`, tmux will still be using the TPM-installed copy until you sync it.

Useful commands:

```bash
npm run sync-tmux
npm run sync-tmux -- --reload
npm run sync-tmux -- --bootstrap --reload
```

- `sync-tmux` copies this checkout into `~/.tmux/plugins/opencode-tmux`
- `--reload` runs `tmux source-file ~/.tmux.conf` after syncing
- `--bootstrap` reinstalls production dependencies in the synced plugin copy when `package.json` changed

## CLI

The repository also includes a CLI for debugging and manual inspection.

Useful commands:

```bash
./bin/opencode-tmux list --provider plugin
./bin/opencode-tmux list --agent codex
./bin/opencode-tmux list --agent pi
./bin/opencode-tmux list --provider plugin --waiting
./bin/opencode-tmux inspect <target> --provider plugin
./bin/opencode-tmux status --provider plugin --style tmux
./bin/opencode-tmux tmux-config --provider plugin
```
