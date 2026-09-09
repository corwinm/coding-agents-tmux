#!/usr/bin/env bash

set -euo pipefail

# macOS GUI launchers commonly omit locale variables. Keep list output and tmux
# client handling consistent with the popup launcher.
export LANG="${LANG:-en_US.UTF-8}"
export LC_CTYPE="${LC_CTYPE:-en_US.UTF-8}"

CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$CURRENT_DIR/../.." && pwd)"
CLI="${CODING_AGENTS_TMUX_BIN:-$REPO_ROOT/bin/coding-agents-tmux}"
CLIENT="${CODING_AGENTS_TMUX_CLIENT:-auto}"
FOCUS_COMMAND="${CODING_AGENTS_TMUX_FOCUS_COMMAND:-}"
INDEX="${1:-}"

if [[ ! "$INDEX" =~ ^[1-9][0-9]*$ ]]; then
  printf 'usage: %s <index> [list filters]\n' "$0" >&2
  exit 2
fi
shift

if [ -n "$FOCUS_COMMAND" ]; then
  "${SHELL:-/bin/sh}" -c "$FOCUS_COMMAND"
fi

target="$("$CLI" list --json "$@" | node -e '
const fs = require("node:fs");
const index = Number(process.argv[1]);
const panes = JSON.parse(fs.readFileSync(0, "utf8"));
const pane = panes[index - 1];
if (!pane) {
  console.error("coding-agents-tmux: agent index " + index + " is out of range (found " + panes.length + ")");
  process.exit(1);
}
process.stdout.write(pane.pane.target);
' "$INDEX")"

exec "$CLI" switch "$target" --client "$CLIENT" "$@"
