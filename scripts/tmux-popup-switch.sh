#!/usr/bin/env bash

set -euo pipefail

CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$CURRENT_DIR"

CLI="$CURRENT_DIR/bin/opencode-tmux"

if [ ! -f "$CLI" ]; then
  printf 'opencode-tmux: missing CLI at %s\n' "$CLI" >&2
  exit 1
fi

ARGS=("$@")

run_cli() {
  "$CLI" "$@"
}

truncate_value() {
  local value="$1"
  local max_width="$2"

  if [ "${#value}" -le "$max_width" ]; then
    printf '%s' "$value"
    return
  fi

  if [ "$max_width" -le 3 ]; then
    printf '%s' "${value:0:max_width}"
    return
  fi

  printf '%s...' "${value:0:max_width-3}"
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

LINES=()
while IFS= read -r line; do
  LINES+=("$line")
done < <(run_cli "${LIST_ARGS[@]}")

if [ "${#LINES[@]}" -eq 0 ] || [ -z "${LINES[0]}" ]; then
  printf 'No matching opencode panes found.\n'
  printf 'Press Enter to close...'
  read -r _
  exit 0
fi

printf 'Select an opencode pane:\n\n'

printf '%-3s %-1s %-22s %-10s %-18s %-36s %s\n' '#' '*' 'TARGET' 'STATE' 'SESSION' 'TITLE' 'PATH'

INDEX=1
for line in "${LINES[@]}"; do
  IFS=$'\t' read -r target activity status source active session_title pane_title current_path <<<"$line"
  marker=' '
  if [ "$active" = "1" ]; then
    marker='*'
  fi
  if [ "$status" = "waiting-question" ] || [ "$status" = "waiting-input" ]; then
    state='waiting'
  elif [ "$status" = "running" ]; then
    state='busy'
  elif [ "$status" = "new" ]; then
    state='new'
  else
    state="$activity"
  fi

  printf '%-3s %-1s %-22s %-10s %-18s %-36s %s\n' \
    "$INDEX" \
    "$marker" \
    "$(truncate_value "$target" 22)" \
    "$(truncate_value "$state" 10)" \
    "$(truncate_value "$session_title" 18)" \
    "$(truncate_value "$pane_title" 36)" \
    "$(truncate_value "$current_path" 48)"
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
