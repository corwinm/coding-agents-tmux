#!/usr/bin/env bash

set -euo pipefail

CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$CURRENT_DIR/bin/opencode-tmux"

if [ ! -f "$CLI" ]; then
  tmux display-message "opencode-tmux: missing CLI at $CLI"
  exit 0
fi

shell_escape() {
  printf "'%s'" "${1//\'/\'\\\'\'}"
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

status_symbol() {
  local activity="$1"
  local status="$2"

  case "$status" in
    waiting-question)
      printf '%s' '?'
      ;;
    waiting-input)
      printf '%s' '?'
      ;;
    running)
      printf '%s' '*'
      ;;
    new)
      printf '%s' '+'
      ;;
    idle)
      printf '%s' ' '
      ;;
    *)
      if [ "$activity" = "busy" ]; then
        printf '%s' '*'
      elif [ "$activity" = "idle" ]; then
        printf '%s' ' '
      else
        printf '%s' '~'
      fi
      ;;
  esac
}

ARGS=("$@")
LIST_ARGS=(list --compact)
SWITCH_ARGS=(switch)
waiting_only="off"

for arg in "${ARGS[@]}"; do
  LIST_ARGS+=("$arg")
  SWITCH_ARGS+=("$arg")
  if [ "$arg" = "--waiting" ]; then
    waiting_only="on"
  fi
done

LINES=()
while IFS= read -r line; do
  LINES+=("$line")
done < <("$CLI" "${LIST_ARGS[@]}")

if [ "${#LINES[@]}" -eq 0 ] || [ -z "${LINES[0]}" ]; then
  tmux display-message "opencode-tmux: no matching panes"
  exit 0
fi

if [ "$waiting_only" = "on" ] && [ "${#LINES[@]}" -eq 1 ]; then
  IFS=$'\t' read -r target _ <<<"${LINES[0]}"
  "$CLI" switch "${ARGS[@]}" "$target"
  exit 0
fi

MENU_CMD=(tmux display-menu -T "OpenCode Sessions" -x C -y C)

target_width=0
session_width=0

for line in "${LINES[@]}"; do
  IFS=$'\t' read -r target _ _ _ _ session_title _ _ <<<"$line"

  if [ "${#target}" -gt "$target_width" ]; then
    target_width="${#target}"
  fi

  if [ "${#session_title}" -gt "$session_width" ]; then
    session_width="${#session_title}"
  fi
done

if [ "$target_width" -gt 40 ]; then
  target_width=40
fi

if [ "$session_width" -gt 40 ]; then
  session_width=40
fi

if [ "$target_width" -lt 12 ]; then
  target_width=12
fi

if [ "$session_width" -lt 12 ]; then
  session_width=12
fi

INDEX=1
for line in "${LINES[@]}"; do
  IFS=$'\t' read -r target activity status source active session_title pane_title current_path <<<"$line"
  symbol="$(status_symbol "$activity" "$status")"
  target_label="$(truncate_value "$target" "$target_width")"
  session_label="$(truncate_value "$session_title" "$session_width")"
  label=$(printf '%2d. [%s] %-*s | %s' "$INDEX" "$symbol" "$target_width" "$target_label" "$session_label")
  key=""
  if [ "$INDEX" -le 9 ]; then
    key="$INDEX"
  fi

  switch_command="cd $(shell_escape "$CURRENT_DIR") && $(shell_escape "$CLI") switch"
  for arg in "${ARGS[@]}"; do
    switch_command="$switch_command $(shell_escape "$arg")"
  done
  switch_command="$switch_command $(shell_escape "$target")"

  MENU_CMD+=("$label" "$key" "run-shell \"$switch_command\"")
  INDEX=$((INDEX + 1))
done

MENU_CMD+=("Cancel" "q" "display-message \"opencode-tmux: cancelled\"")

"${MENU_CMD[@]}"
