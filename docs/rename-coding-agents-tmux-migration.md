# Migration guide: `opencode-tmux` → `coding-agents-tmux`

This release renames the project from **`opencode-tmux`** to **`coding-agents-tmux`**.

The goal is to make the public name match the current scope of the project:

- `opencode`
- `codex`
- `pi`
- mixed-agent discovery, switching, popup navigation, and status summaries in tmux

## What changed

The new preferred public names are:

- **repo / product name:** `coding-agents-tmux`
- **CLI:** `coding-agents-tmux`
- **tmux options:** `@coding-agents-tmux-*`
- **env vars:** `CODING_AGENTS_TMUX_*`
- **state root:** `~/.local/state/coding-agents-tmux/`
- **tmux plugin dir:** `~/.tmux/plugins/coding-agents-tmux`
- **Pi extension dir:** `~/.pi/agent/extensions/coding-agents-tmux/`
- **bundled OpenCode plugin symlink:** `~/.config/opencode/plugins/coding-agents-tmux.ts`

## What still works for now

The old names are still supported in this transition release:

- `opencode-tmux` CLI
- `@opencode-tmux-*` tmux options
- `OPENCODE_TMUX_*` env vars
- legacy state under `~/.local/state/opencode-tmux/`
- legacy tmux entrypoint `opencode-tmux.tmux`
- legacy Pi extension path `~/.pi/agent/extensions/opencode-tmux/`
- legacy OpenCode plugin symlink `~/.config/opencode/plugins/opencode-tmux.ts`

These are **temporary compatibility aliases**, not the long-term preferred interface.

## Compatibility guarantees in this release

This release is designed so that existing users can upgrade without their setup breaking immediately.

Current behavior:

- runtime readers accept both old and new state roots
- the tmux plugin accepts both old and new tmux option names
- the CLI/runtime accept both old and new env var names
- the old CLI wrapper forwards to the new CLI
- the new tmux/plugin install flow creates new preferred paths and keeps legacy compatibility links in place

## Recommended migration

### 1. Update your tmux plugin reference

Preferred TPM entry:

```tmux
set -g @plugin 'corwinm/coding-agents-tmux'
```

If you already had the plugin installed before the rename, update your TPM entry to the new repo slug so your local config matches the current docs and release notes.

### 2. Update your tmux option names

Before:

```tmux
set -g @opencode-tmux-provider 'plugin'
set -g @opencode-tmux-menu-key 'O'
set -g @opencode-tmux-popup-key 'P'
set -g @opencode-tmux-status 'on'
```

After:

```tmux
set -g @coding-agents-tmux-provider 'plugin'
set -g @coding-agents-tmux-menu-key 'O'
set -g @coding-agents-tmux-popup-key 'P'
set -g @coding-agents-tmux-status 'on'
```

### 3. Update CLI invocations and scripts

Before:

```bash
opencode-tmux list
./bin/opencode-tmux status --provider plugin
```

After:

```bash
coding-agents-tmux list
./bin/coding-agents-tmux status --provider plugin
```

### 4. Update env vars if you set them explicitly

Examples:

Before:

```bash
export OPENCODE_TMUX_STATE_DIR=/tmp/opencode-state
export OPENCODE_TMUX_PI_STATE_DIR=/tmp/pi-state
export OPENCODE_TMUX_SERVER_MAP='{"work:1.0":"http://127.0.0.1:4096"}'
```

After:

```bash
export CODING_AGENTS_TMUX_STATE_DIR=/tmp/opencode-state
export CODING_AGENTS_TMUX_PI_STATE_DIR=/tmp/pi-state
export CODING_AGENTS_TMUX_SERVER_MAP='{"work:1.0":"http://127.0.0.1:4096"}'
```

### 5. Reload tmux and restart agent sessions if needed

After changing plugin config or bundled integration paths:

```tmux
prefix + I
```

Or:

```bash
tmux source-file ~/.tmux.conf
```

Then restart any running `opencode`, `codex`, or `pi` sessions if you need them to pick up newly installed plugin or extension links.

## Path migration notes

### State directories

Preferred new root:

```text
~/.local/state/coding-agents-tmux/
```

Legacy root still read during the transition:

```text
~/.local/state/opencode-tmux/
```

### OpenCode plugin symlink

Preferred path:

```text
~/.config/opencode/plugins/coding-agents-tmux.ts
```

Legacy compatibility path also created for now:

```text
~/.config/opencode/plugins/opencode-tmux.ts
```

### Pi extension path

Preferred path:

```text
~/.pi/agent/extensions/coding-agents-tmux/index.ts
```

Legacy compatibility path also created for now:

```text
~/.pi/agent/extensions/opencode-tmux/index.ts
```

## Deprecation plan

Legacy names are being kept only to make the rename less disruptive.

The intent is:

1. prefer new names immediately
2. keep old names working during the transition window
3. remove old aliases in a later cleanup or major release

This means you should treat the following as deprecated now:

- `opencode-tmux`
- `@opencode-tmux-*`
- `OPENCODE_TMUX_*`
- legacy install paths that still include `opencode-tmux`

## Release notes summary

### Highlights

- renamed the package and public product name to `coding-agents-tmux`
- added `coding-agents-tmux` as the primary CLI wrapper
- added `coding-agents-tmux.tmux` as the new public tmux entrypoint
- added `@coding-agents-tmux-*` tmux option aliases
- added `CODING_AGENTS_TMUX_*` env var aliases
- switched generated tmux config snippets to the new name
- updated install paths to prefer `coding-agents-tmux`
- kept old names as temporary compatibility aliases

### Upgrade impact

- low for existing users in the short term
- recommended follow-up is to rename config, scripts, and env vars to the new names soon

## Quick copy-paste migration example

```tmux
set -g @plugin 'corwinm/coding-agents-tmux'
set -g @coding-agents-tmux-provider 'plugin'
set -g @coding-agents-tmux-menu-key 'O'
set -g @coding-agents-tmux-popup-key 'P'
set -g @coding-agents-tmux-waiting-menu-key 'W'
set -g @coding-agents-tmux-waiting-popup-key 'C-w'
set -g @coding-agents-tmux-status 'on'
set -g @coding-agents-tmux-status-style 'tmux'
set -g @coding-agents-tmux-status-position 'right'
set -g @coding-agents-tmux-status-interval '0'
```

## Questions you may still have

### Do I need to rename everything immediately?

No. The old names still work in this release.

### Should I keep using the old names?

No. They are still supported only to ease the transition.

### Will the old names stay forever?

No. The project intends to remove them in a later cleanup release after users have had time to migrate.
