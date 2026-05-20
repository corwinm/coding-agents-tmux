# Migration guide: `opencode-tmux` → `coding-agents-tmux`

This project was renamed from **`opencode-tmux`** to **`coding-agents-tmux`**.

The current release removes the old public aliases. Existing users should update configs and scripts to the new names before upgrading.

## Current public names

- **repo / product name:** `coding-agents-tmux`
- **CLI:** `coding-agents-tmux`
- **tmux options:** `@coding-agents-tmux-*`
- **env vars:** `CODING_AGENTS_TMUX_*`
- **Catppuccin status module export:** `@catppuccin_status_agents`
- **state root:** `~/.local/state/coding-agents-tmux/`
- **tmux plugin dir:** `~/.tmux/plugins/coding-agents-tmux`
- **Pi extension dir:** `~/.pi/agent/extensions/coding-agents-tmux/`
- **bundled OpenCode plugin symlink:** `~/.config/opencode/plugins/coding-agents-tmux.ts`

## Removed legacy aliases

The following legacy aliases are no longer installed or read by the current release:

- old CLI name
- old tmux option prefix
- old env var prefix
- old Catppuccin status module export
- old state root
- old tmux entrypoint filename
- old Pi extension path
- old OpenCode plugin symlink

## Recommended migration

### 1. Update your tmux plugin reference

```tmux
set -g @plugin 'corwinm/coding-agents-tmux'
```

### 2. Update tmux option names

Use the `@coding-agents-tmux-*` prefix:

```tmux
set -g @coding-agents-tmux-provider 'plugin'
set -g @coding-agents-tmux-menu-key 'O'
set -g @coding-agents-tmux-popup-key 'P'
set -g @coding-agents-tmux-status 'on'
```

### 3. Update CLI invocations and scripts

```bash
coding-agents-tmux list
./bin/coding-agents-tmux status --provider plugin
```

### 4. Update env vars if you set them explicitly

```bash
export CODING_AGENTS_TMUX_STATE_DIR=/tmp/opencode-state
export CODING_AGENTS_TMUX_PI_STATE_DIR=/tmp/pi-state
export CODING_AGENTS_TMUX_SERVER_MAP='{"work:1.0":"http://127.0.0.1:4096"}'
```

### 5. Update Catppuccin manual-mode status usage

```tmux
set -g @coding-agents-tmux-status-mode 'manual'
set -ag status-right "#{E:@catppuccin_status_agents}"
```

### 6. Move any manually managed state or integration paths

If you manually created state files, plugin links, or Pi extension links under the old name, move or recreate them under the current paths listed above.
