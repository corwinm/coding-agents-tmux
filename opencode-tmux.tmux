#!/usr/bin/env bash

set -euo pipefail

CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

get_tmux_option() {
  local option="$1"
  local default_value="$2"
  local value
  value="$(tmux show-option -gqv "$option")"
  if [ -n "$value" ]; then
    printf '%s' "$value"
  else
    printf '%s' "$default_value"
  fi
}

shell_escape() {
  printf "'%s'" "${1//\'/\'\\\'\'}"
}

append_status_segment() {
  local option_name="$1"
  local segment="$2"
  local existing
  existing="$(tmux show-option -gqv "$option_name")"

  if [[ "$existing" == *"$segment"* ]]; then
    return
  fi

  if [ -n "$existing" ]; then
    tmux set-option -g "$option_name" "$existing $segment"
  else
    tmux set-option -g "$option_name" "$segment"
  fi
}

remove_status_segment() {
  local option_name="$1"
  local segment="$2"
  local existing updated
  existing="$(tmux show-option -gqv "$option_name")"

  if [ -z "$segment" ] || [[ "$existing" != *"$segment"* ]]; then
    return
  fi

  updated="${existing//$segment/}"
  updated="$(printf '%s' "$updated" | tr -s ' ')"
  updated="${updated# }"
  updated="${updated% }"
  tmux set-option -g "$option_name" "$updated"
}

normalize_status_option() {
  local position="$1"
  case "$position" in
    left)
      printf '%s' 'status-left'
      ;;
    right|"")
      printf '%s' 'status-right'
      ;;
    *)
      printf '%s' 'status-right'
      ;;
  esac
}

main() {
  if ! command -v bun >/dev/null 2>&1; then
    tmux display-message "opencode-tmux: bun is required; install bun and reload TPM"
    exit 0
  fi

  local key provider server_map popup_filter popup_width popup_height popup_title status_enabled status_style status_position status_option
  local previous_status_segment previous_status_option
  key="$(get_tmux_option '@opencode-tmux-key' 'O')"
  provider="$(get_tmux_option '@opencode-tmux-provider' 'auto')"
  server_map="$(get_tmux_option '@opencode-tmux-server-map' '')"
  popup_filter="$(get_tmux_option '@opencode-tmux-popup-filter' 'busy')"
  popup_width="$(get_tmux_option '@opencode-tmux-popup-width' '90%')"
  popup_height="$(get_tmux_option '@opencode-tmux-popup-height' '80%')"
  popup_title="$(get_tmux_option '@opencode-tmux-popup-title' 'OpenCode Sessions')"
  status_enabled="$(get_tmux_option '@opencode-tmux-status' 'off')"
  status_style="$(get_tmux_option '@opencode-tmux-status-style' 'tmux')"
  status_position="$(get_tmux_option '@opencode-tmux-status-position' 'right')"
  previous_status_segment="$(get_tmux_option '@opencode-tmux-status-segment' '')"
  previous_status_option="$(get_tmux_option '@opencode-tmux-status-option' 'status-right')"
  status_option="$(normalize_status_option "$status_position")"

  if [ ! -f "$CURRENT_DIR/src/cli.ts" ]; then
    tmux display-message "opencode-tmux: missing src/cli.ts in plugin directory"
    exit 0
  fi

  local popup_filter_arg=""
  case "$popup_filter" in
    busy|waiting|running|active)
      popup_filter_arg="--$popup_filter"
      ;;
    all|"")
      popup_filter_arg=""
      ;;
  esac

  local switch_command status_command popup_script
  popup_script="$CURRENT_DIR/scripts/tmux-popup-switch.sh"

  if [ ! -f "$popup_script" ]; then
    tmux display-message "opencode-tmux: missing scripts/tmux-popup-switch.sh in plugin directory"
    exit 0
  fi

  switch_command="$popup_script --provider '$provider'"
  status_command="cd '$CURRENT_DIR' && bun run '$CURRENT_DIR/src/cli.ts' status --style '$status_style' --provider '$provider'"

  if [ -n "$server_map" ]; then
    switch_command="$switch_command --server-map '$server_map'"
    status_command="$status_command --server-map '$server_map'"
  fi

  if [ -n "$popup_filter_arg" ]; then
    switch_command="$switch_command $popup_filter_arg"
  fi

  tmux bind-key "$key" display-popup -E -w "$popup_width" -h "$popup_height" -T "$popup_title" "$switch_command"

  if [ -n "$previous_status_segment" ]; then
    remove_status_segment "$previous_status_option" "$previous_status_segment"
  fi

  if [ "$status_enabled" = "on" ]; then
    local current_status_segment
    current_status_segment="#($status_command)"
    append_status_segment "$status_option" "$current_status_segment"
    tmux set-option -gq @opencode-tmux-status-segment "$current_status_segment"
    tmux set-option -gq @opencode-tmux-status-option "$status_option"
  else
    tmux set-option -gu @opencode-tmux-status-segment
    tmux set-option -gu @opencode-tmux-status-option
  fi
}

main "$@"
