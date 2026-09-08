#!/usr/bin/env bash

set -euo pipefail

# macOS GUI launchers commonly omit locale variables. tmux needs a UTF-8 locale
# to preserve the tab delimiters used by coding-agents-tmux's machine output.
export LANG="${LANG:-en_US.UTF-8}"
export LC_CTYPE="${LC_CTYPE:-en_US.UTF-8}"

CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$CURRENT_DIR/../.." && pwd)"
CLI="${CODING_AGENTS_TMUX_BIN:-$REPO_ROOT/bin/coding-agents-tmux}"
CLIENT="${CODING_AGENTS_TMUX_CLIENT:-auto}"
FOCUS_COMMAND="${CODING_AGENTS_TMUX_FOCUS_COMMAND:-}"
MODE="popup"
ARGS=()

for arg in "$@"; do
  if [ "$arg" = "--menu" ]; then
    MODE="menu"
  else
    ARGS+=("$arg")
  fi
done

if [ -n "$FOCUS_COMMAND" ]; then
  "${SHELL:-/bin/sh}" -c "$FOCUS_COMMAND"
fi

if [ "${#ARGS[@]}" -gt 0 ]; then
  exec "$CLI" "$MODE" --client "$CLIENT" "${ARGS[@]}"
else
  exec "$CLI" "$MODE" --client "$CLIENT"
fi
