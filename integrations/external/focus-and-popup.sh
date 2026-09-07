#!/usr/bin/env bash

set -euo pipefail

CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$CURRENT_DIR/../.." && pwd)"
CLI="${CODING_AGENTS_TMUX_BIN:-$REPO_ROOT/bin/coding-agents-tmux}"
CLIENT="${CODING_AGENTS_TMUX_CLIENT:-auto}"
FOCUS_COMMAND="${CODING_AGENTS_TMUX_FOCUS_COMMAND:-}"

if [ -n "$FOCUS_COMMAND" ]; then
  "${SHELL:-/bin/sh}" -c "$FOCUS_COMMAND"
fi

exec "$CLI" popup --client "$CLIENT" "$@"
