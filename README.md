# coding-agents-tmux

`tmux` integration for terminal coding agent sessions.

It helps you:

- open a chooser of active coding agent panes
- jump straight to panes waiting on your answer
- show the current pane state plus a background session summary in the status line
- use local plugin and hook state instead of relying only on sqlite or pane heuristics

Today the strongest runtime support is still for `opencode`, and the project also supports `codex`, `pi`, `claude`, and `kiro` panes for discovery, switching, popup navigation, and status summaries.

![coding-agents-tmux demo](docs/assets/coding-agents-tmux-demo.gif)

## Install

Add the plugin to `~/.tmux.conf`:

```tmux
set -g @plugin 'corwinm/coding-agents-tmux'
```

Recommended settings:

```tmux
set -g @coding-agents-tmux-provider 'plugin'
set -g @coding-agents-tmux-auto-install 'opencode,pi,codex,claude'
set -g @coding-agents-tmux-menu-key 'O'
set -g @coding-agents-tmux-popup-key 'P'
set -g @coding-agents-tmux-waiting-menu-key 'W'
set -g @coding-agents-tmux-waiting-popup-key 'C-w'
set -g @coding-agents-tmux-status 'on'
set -g @coding-agents-tmux-status-style 'tmux'
set -g @coding-agents-tmux-status-position 'right'
set -g @coding-agents-tmux-status-interval '0'
```

Those settings favor the bundled plugin provider, explicitly enable tmux-managed installs for the bundled OpenCode plugin plus the Pi extension and Codex/Claude hooks, and use event-driven status redraws so tmux stops polling Node in the background.

To match your tmux theme, you can also override the status colors:

```tmux
set -g @coding-agents-tmux-status-color-neutral 'default'
set -g @coding-agents-tmux-status-color-idle 'colour244'
set -g @coding-agents-tmux-status-color-busy 'colour81'
set -g @coding-agents-tmux-status-color-waiting 'colour214'
set -g @coding-agents-tmux-status-color-unknown 'colour240'
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
- `claude` sessions must be restarted after Claude hook installation so new hooks are loaded

## What TPM sets up

With the recommended settings above, the tmux plugin manages the bundled `opencode` plugin, the Pi extension, and the Codex and Claude hook installs for you.

It installs the bundled `opencode` plugin at:

```text
~/.config/opencode/plugins/coding-agents-tmux.ts
```

That plugin publishes normalized session state files under:

```text
~/.local/state/coding-agents-tmux/plugin-state
```

On first install, the tmux plugin also bootstraps the CLI runtime dependencies inside:

```text
~/.tmux/plugins/coding-agents-tmux/node_modules
```

It also installs or updates the bundled Pi extension under:

```text
~/.pi/agent/extensions/coding-agents-tmux/index.ts
```

That extension publishes normalized Pi state files under:

```text
~/.local/state/coding-agents-tmux/pi-state
```

It also installs or updates Codex hook integration under:

```text
~/.codex/config.toml
~/.codex/hooks.json
```

With the recommended `@coding-agents-tmux-auto-install 'opencode,pi,codex,claude'` setting, it also installs or updates Claude Code hook integration under:

```text
~/.claude/settings.json
```

You can disable the automatic symlink step with:

```tmux
set -g @coding-agents-tmux-install-opencode-plugin 'off'
```

You can disable the automatic Pi extension setup with:

```tmux
set -g @coding-agents-tmux-install-pi-extension 'off'
```

You can disable the automatic Codex hook setup with:

```tmux
set -g @coding-agents-tmux-install-codex-hooks 'off'
```

You can disable the automatic Claude Code hook setup with:

```tmux
set -g @coding-agents-tmux-install-claude-hooks 'off'
```

You can also control all tmux-managed installs together:

```tmux
set -g @coding-agents-tmux-auto-install 'auto'
set -g @coding-agents-tmux-auto-install 'off'
set -g @coding-agents-tmux-auto-install 'opencode,pi,codex,claude'
```

The explicit `opencode,pi,codex,claude` list is the recommended README setting because it makes the intended managed installs obvious in your tmux config. When `@coding-agents-tmux-auto-install` is set, it takes precedence over the individual install toggles.

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
set -g @coding-agents-tmux-menu-key 'O'
set -g @coding-agents-tmux-popup-key 'P'
set -g @coding-agents-tmux-waiting-menu-key 'W'
set -g @coding-agents-tmux-waiting-popup-key 'C-w'
```

Set any of them to `off` to disable that binding.

## Status line

When enabled, the status line shows two views at once:

- the current pane state
- a compact summary of the remaining detected coding-agent panes

Example output:

```text
󰚩 |  idle |   
󰚩 |  busy | 
󰚩 |  new | none
```

You can also replace the default icon with your own label or a different Nerd Font icon:

```tmux
set -g @coding-agents-tmux-status-prefix '󰚩'
```

This means:

- `󰚩 |  idle |   ` means the focused pane is idle and the background panes are waiting, busy, and idle in target order
- `󰚩 |  busy | ` means the focused pane is busy and more than eight background panes are shown in compact symbol mode
- `󰚩 |  new | none` means the focused pane is newly started and there are no other detected coding-agent panes

If your active pane is not a detected coding-agent pane, the status line uses the strongest detected coding-agent pane in the current tmux window. Other panes are counted as background work.

Background pane symbols are shown in a stable target order:

- `` waiting
- `` busy
- `` idle
- `` new
- `` unknown

By default the status line adds spaces between background pane symbols for readability. If there are more than eight background panes, it automatically switches to a compact no-space form.

Enable or tune the status line with:

```tmux
set -g @coding-agents-tmux-status 'on'
set -g @coding-agents-tmux-status-style 'tmux'
set -g @coding-agents-tmux-status-position 'right'
set -g @coding-agents-tmux-status-interval '0'
```

By default the plugin uses manual mode so your theme can place the segment itself.

With the bundled plugin provider, `0` makes the status line event-driven: session events and tmux navigation hooks trigger redraws instead of polling on a timer. If you switch to the `sqlite` or `server` provider, set a positive interval if you still want periodic background refreshes.

For Catppuccin, use the renamed module export:

```tmux
set -g @coding-agents-tmux-status 'on'
set -g @coding-agents-tmux-status-mode 'manual'

set -g status-right "#{E:@catppuccin_status_session}"
set -ag status-right "#{E:@catppuccin_status_directory}"
set -ag status-right "#{E:@catppuccin_status_agents}"
```

For other themes, use the tone-aware inline export:

```tmux
set -g @coding-agents-tmux-status 'on'
set -g @coding-agents-tmux-status-mode 'manual'

set -ag status-right " #{@coding-agents-tmux-status-inline-format}"
```

If you want to fully control the wrapper yourself, use the plain text export instead:

```tmux
set -ag status-right " #[fg=colour81]󰚩 #[default]#{@coding-agents-tmux-status-text}"
```

`manual` mode is the default. `#{E:@catppuccin_status_agents}` gives Catppuccin users a native-looking module, `#{@coding-agents-tmux-status-inline-format}` gives other themes a tone-aware inline segment, and `#{@coding-agents-tmux-status-text}` gives a plain live summary text export for fully custom wrappers. `append` mode restores the old behavior and appends automatically.

## Configuration

Available tmux options:

- `@coding-agents-tmux-menu-key` main menu chooser key, default `O`
- `@coding-agents-tmux-popup-key` main popup chooser key, default `P`
- `@coding-agents-tmux-waiting-menu-key` waiting-only menu chooser key, default `W`
- `@coding-agents-tmux-waiting-popup-key` waiting-only popup chooser key, default `C-w`
- `@coding-agents-tmux-install-opencode-plugin` `on` or `off`, default `on`
- `@coding-agents-tmux-install-pi-extension` `on` or `off`, default `on`
- `@coding-agents-tmux-install-codex-hooks` `on` or `off`, default `on`
- `@coding-agents-tmux-install-claude-hooks` `on` or `off`, default `off`
- `@coding-agents-tmux-auto-install` `auto`, `off`, or a comma-separated list like `opencode,pi,codex,claude`; when set, it overrides the individual install toggles
- `@coding-agents-tmux-provider` `auto`, `plugin`, `sqlite`, or `server`, default `plugin`
- `@coding-agents-tmux-server-map` JSON object or JSON file path for explicit server endpoints
- `@coding-agents-tmux-popup-filter` one of `all`, `busy`, `waiting`, `running`, `active`
- `@coding-agents-tmux-popup-width` popup width, default `100%`
- `@coding-agents-tmux-popup-height` popup height, default `100%`
- `@coding-agents-tmux-popup-title` popup title, default `Coding Agent Sessions`
- `@coding-agents-tmux-status` `on` or `off`, default `on`
- `@coding-agents-tmux-status-style` `plain` or `tmux`, default `tmux`
- `@coding-agents-tmux-status-mode` `append` or `manual`, default `manual`
- `@coding-agents-tmux-status-position` `right` or `left`, default `right`
- `@coding-agents-tmux-status-interval` tmux `status-interval`, default `0`
- `@coding-agents-tmux-status-prefix` label shown before the status summary, default `󰚩`
- `@coding-agents-tmux-status-color-neutral` tmux color for the prefix and separators, default `colour252`
- `@coding-agents-tmux-status-color-idle` tmux color for idle state, default `colour70`
- `@coding-agents-tmux-status-color-busy` tmux color for busy state, default `colour220`
- `@coding-agents-tmux-status-color-waiting` tmux color for waiting state, default `colour196`
- `@coding-agents-tmux-status-color-unknown` tmux color for unknown/none state, default `colour244`

## Providers

Recommended provider:

- `plugin` for the best waiting/running/idle detection in normal local `opencode` sessions, and the default tmux integration provider

Provider modes:

- `auto` uses plugin state when available, then server endpoints, then sqlite
- `plugin` uses only plugin state files
- `sqlite` uses the local `opencode` sqlite database
- `server` uses explicit `opencode serve` endpoints from `@coding-agents-tmux-server-map`

Example:

```tmux
set -g @coding-agents-tmux-provider 'plugin'
```

## Pi

`pi` panes are detected from the live tmux pane command and common title patterns, so they show up in `list`, `switch`, `popup`, and `status` alongside `opencode`, `codex`, `claude`, and `kiro` panes.

Use `--agent opencode`, `--agent codex`, `--agent pi`, `--agent claude`, `--agent kiro`, or `--agent all` on `list`, `switch`, `popup`, `popup-ui`, and `status` when you want to narrow mixed tmux environments.

For the best Pi runtime fidelity, let the tmux plugin install the bundled Pi extension automatically. It is linked into:

```text
~/.pi/agent/extensions/coding-agents-tmux/index.ts
```

That extension publishes pane-aware Pi state under:

```text
~/.local/state/coding-agents-tmux/pi-state
```

Pi runtime support is intentionally minimal and extensible:

- with the bundled Pi extension loaded, Pi panes can report `new`, `running`, `idle`, and best-effort `waiting-input`
- without the extension, `coding-agents-tmux` falls back to pane preview heuristics when possible
- if preview is inconclusive, Pi falls back to a coarse `running` state when a `pi` process is still detected in the tmux pane
- Pi has no built-in permission or plan mode integration here yet, so those states are not modeled specially

After first install or update, restart Pi sessions in tmux so they load the bundled extension.

## Codex

`codex` panes are detected from the live tmux pane command, so they show up in `list`, `switch`, `popup`, and `status` alongside `opencode`, `pi`, `claude`, and `kiro` panes.

Use `--agent opencode`, `--agent codex`, `--agent pi`, `--agent claude`, `--agent kiro`, or `--agent all` on `list`, `switch`, `popup`, `popup-ui`, and `status` when you want to narrow mixed tmux environments.

Default Codex runtime support is intentionally coarse:

- if a tmux pane is running a `codex` process, it is classified as `running`
- waiting, question, and idle distinctions are still `opencode`-specific until a stronger Codex-local state source is added

To enable higher-fidelity Codex state with Codex hooks:

1. Let the tmux plugin install the global Codex config automatically, or run it manually:

```bash
./bin/coding-agents-tmux install-codex
```

2. Optionally generate an additional repo-local hooks file:

```bash
mkdir -p .codex
./bin/coding-agents-tmux codex-hooks-template > .codex/hooks.json
```

3. Restart `codex` sessions in tmux so they begin publishing hook-backed state.

With hooks enabled, `coding-agents-tmux` can mark Codex panes as `idle` or `waiting-input` between turns instead of showing every Codex pane as continuously `running`.

## Claude Code

`claude` panes are detected from the live tmux pane command and common title patterns, so they show up in `list`, `switch`, `popup`, and `status` alongside `opencode`, `codex`, `pi`, and `kiro` panes.

Default Claude Code runtime support is intentionally coarse:

- if a tmux pane is running a `claude` process, it is classified as `running`
- waiting, question, and idle distinctions become higher fidelity when Claude hooks are installed

To enable higher-fidelity Claude Code state with hooks:

1. Install or update the global Claude hook config manually:

```bash
./bin/coding-agents-tmux install-claude
```

2. Or let the tmux plugin manage it by setting either:

```tmux
set -g @coding-agents-tmux-install-claude-hooks 'on'
```

or the shared selector:

```tmux
set -g @coding-agents-tmux-auto-install 'opencode,pi,codex,claude'
```

3. Optionally inspect the managed hook template before merging it into project or user Claude settings:

```bash
./bin/coding-agents-tmux claude-hooks-template
```

4. Restart `claude` sessions in tmux so they begin publishing hook-backed state.

With hooks enabled, `coding-agents-tmux` can mark Claude panes as `idle`, `waiting-question`, or `waiting-input` between turns instead of showing every Claude pane as continuously `running`.

## Kiro CLI

`kiro` panes are detected from live tmux pane commands such as `kiro-cli`, `kiro-cli-chat`, `kiro-cli-term`, and `kiro`, plus common title patterns. They show up in `list`, `switch`, `popup`, and `status` alongside the other supported coding agents.

Kiro runtime support is intentionally simple and does not require any Kiro agent configuration:

- if a tmux pane is running a Kiro CLI process, it is classified as `idle` unless preview text shows an obvious waiting prompt
- pane preview heuristics can detect obvious question or approval prompts as waiting states
- no Kiro hooks are installed or required; Kiro support is based on tmux process/title detection and preview fallback only
- the session column uses a lightweight pane-derived label, usually the current directory basename

This means any `kiro-cli` pane can be discovered and switched to without naming or modifying a Kiro custom agent.

## Troubleshooting

- `prefix + O` or `prefix + P` does nothing: make sure `node` and `npm` are installed and reload tmux
- first TPM load feels slow: the plugin may be running `npm ci --omit=dev` to bootstrap dependencies
- new panes show stale state: restart the `opencode` session so it reloads the plugin
- waiting detection seems wrong: use the `plugin` provider and confirm the bundled plugin symlink exists at `~/.config/opencode/plugins/coding-agents-tmux.ts`
- Pi still looks busy or unknown: confirm the bundled extension exists at `~/.pi/agent/extensions/coding-agents-tmux/index.ts` and restart the Pi session so it loads the extension
- Codex still always looks busy: confirm `~/.codex/config.toml` has `hooks = true` under `[features]`, `~/.codex/hooks.json` exists, and restart the Codex session
- Claude still always looks busy: confirm `~/.claude/settings.json` contains the managed `claude-hook-state` hook command and restart the Claude Code session
- status looks stale with `sqlite` or `server`: set `@coding-agents-tmux-status-interval` to a positive value because event-driven refreshes are centered on the bundled plugin provider
- TPM install changed but tmux still looks old: run `prefix + I` or `tmux source-file ~/.tmux.conf`

## Local development sync

If you edit this repo outside `~/.tmux/plugins/coding-agents-tmux`, tmux will still be using the TPM-installed copy until you sync it.

Useful commands:

```bash
npm run sync-tmux
npm run sync-tmux -- --reload
npm run sync-tmux -- --bootstrap --reload
```

- `sync-tmux` copies this checkout into `~/.tmux/plugins/coding-agents-tmux`
- `--reload` runs `tmux source-file ~/.tmux.conf` after syncing
- `--bootstrap` reinstalls production dependencies in the synced plugin copy when `package.json` changed

## CLI

The repository also includes a CLI for debugging and manual inspection.

Useful commands:

```bash
./bin/coding-agents-tmux list --provider plugin
./bin/coding-agents-tmux list --agent codex
./bin/coding-agents-tmux list --agent pi
./bin/coding-agents-tmux list --agent claude
./bin/coding-agents-tmux list --agent kiro
./bin/coding-agents-tmux list --provider plugin --waiting
./bin/coding-agents-tmux inspect <target> --provider plugin
./bin/coding-agents-tmux status --provider plugin --style tmux
./bin/coding-agents-tmux tmux-config --provider plugin
```
