#!/usr/bin/env bash

set -euo pipefail

CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$CURRENT_DIR"

CLI="$CURRENT_DIR/src/cli.ts"

if [ ! -f "$CLI" ]; then
  printf 'opencode-tmux: missing CLI at %s\n' "$CLI" >&2
  exit 1
fi

ARGS=("$@")

run_cli() {
  bun run "$CLI" "$@"
}

if [ "$#" -gt 0 ] && [[ "$1" != -* ]]; then
  run_cli "$@"
  exit $?
fi

LIST_ARGS=(list --compact)
SWITCH_ARGS=(switch)

for arg in "${ARGS[@]}"; do
  LIST_ARGS+=("$arg")
  SWITCH_ARGS+=("$arg")
done

mapfile -t LINES < <(run_cli "${LIST_ARGS[@]}")

if [ "${#LINES[@]}" -eq 0 ] || [ -z "${LINES[0]}" ]; then
  printf 'No matching opencode panes found.\n'
  printf 'Press Enter to close...'
  read -r _
  exit 0
fi

printf 'Select an opencode pane:\n\n'

INDEX=1
for line in "${LINES[@]}"; do
  IFS=$'\t' read -r target activity status source active session_title pane_title current_path <<<"$line"
  marker=' '
  if [ "$active" = "1" ]; then
    marker='*'
  fi
  printf '%2d. [%s] %s  %s/%s  %s  %s\n' "$INDEX" "$marker" "$target" "$activity" "$status" "$session_title" "$pane_title"
  printf '    %s\n' "$current_path"
  INDEX=$((INDEX + 1))
done

printf '\nEnter selection number or target: '
read -r SELECTION

if [ -z "$SELECTION" ]; then
  exit 0
fi

TARGET="$SELECTION"

if [[ "$SELECTION" =~ ^[0-9]+$ ]]; then
  CHOICE_INDEX=$((SELECTION - 1))
  if [ "$CHOICE_INDEX" -lt 0 ] || [ "$CHOICE_INDEX" -ge "${#LINES[@]}" ]; then
    printf 'Invalid selection: %s\n' "$SELECTION"
    printf 'Press Enter to close...'
    read -r _
    exit 1
  fi
  IFS=$'\t' read -r TARGET _ <<<"${LINES[$CHOICE_INDEX]}"
fi

run_cli "${SWITCH_ARGS[@]}" "$TARGET"
