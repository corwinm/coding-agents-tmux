#!/usr/bin/env bash

set -euo pipefail

tmux refresh-client -S >/dev/null 2>&1 || true
notify_command="$(tmux show-option -gqv '@coding-agents-tmux-notify-command' 2>/dev/null || true)"

if [ -n "$notify_command" ]; then
  "${SHELL:-/bin/sh}" -c "$notify_command" >/dev/null 2>&1 || true
fi
