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

normalize_launcher() {
  local launcher="$1"
  case "$launcher" in
    popup|menu|"")
      printf '%s' "${launcher:-menu}"
      ;;
    *)
      printf '%s' 'menu'
      ;;
  esac
}

normalize_toggle() {
  local value="$1"
  case "$value" in
    on|off)
      printf '%s' "$value"
      ;;
    true|yes|1)
      printf '%s' 'on'
      ;;
    false|no|0)
      printf '%s' 'off'
      ;;
    *)
      printf '%s' 'off'
      ;;
  esac
}

normalize_runner() {
  local value="$1"
  case "$value" in
    node|bun|"")
      printf '%s' "${value:-node}"
      ;;
    auto)
      printf '%s' 'node'
      ;;
    *)
      printf '%s' 'node'
      ;;
  esac
}

install_opencode_plugin() {
  local plugin_source="$CURRENT_DIR/plugin/opencode-tmux.ts"
  local config_root plugin_dir plugin_target

  if [ ! -f "$plugin_source" ]; then
    tmux display-message "opencode-tmux: missing plugin/opencode-tmux.ts in plugin directory"
    return
  fi

  config_root="${XDG_CONFIG_HOME:-$HOME/.config}"
  plugin_dir="$config_root/opencode/plugins"
  plugin_target="$plugin_dir/opencode-tmux.ts"

  mkdir -p "$plugin_dir"
  ln -sfn "$plugin_source" "$plugin_target"
  tmux set-option -gq @opencode-tmux-plugin-path "$plugin_target"
}

main() {
  local key waiting_key provider server_map popup_filter popup_width popup_height popup_title status_enabled status_style status_position status_option status_interval launcher install_plugin runner
  local status_prefix status_color_neutral status_color_busy status_color_waiting status_color_idle status_color_unknown
  local previous_status_segment previous_status_option
  key="$(get_tmux_option '@opencode-tmux-key' 'O')"
  waiting_key="$(get_tmux_option '@opencode-tmux-waiting-key' 'W')"
  provider="$(get_tmux_option '@opencode-tmux-provider' 'auto')"
  server_map="$(get_tmux_option '@opencode-tmux-server-map' '')"
  popup_filter="$(get_tmux_option '@opencode-tmux-popup-filter' 'all')"
  popup_width="$(get_tmux_option '@opencode-tmux-popup-width' '90%')"
  popup_height="$(get_tmux_option '@opencode-tmux-popup-height' '80%')"
  popup_title="$(get_tmux_option '@opencode-tmux-popup-title' 'OpenCode Sessions')"
  launcher="$(normalize_launcher "$(get_tmux_option '@opencode-tmux-launcher' 'menu')")"
  install_plugin="$(normalize_toggle "$(get_tmux_option '@opencode-tmux-install-opencode-plugin' 'on')")"
  runner="$(normalize_runner "$(get_tmux_option '@opencode-tmux-runner' 'node')")"
  status_enabled="$(get_tmux_option '@opencode-tmux-status' 'on')"
  status_style="$(get_tmux_option '@opencode-tmux-status-style' 'tmux')"
  status_position="$(get_tmux_option '@opencode-tmux-status-position' 'right')"
  status_interval="$(get_tmux_option '@opencode-tmux-status-interval' '1')"
  status_prefix="$(get_tmux_option '@opencode-tmux-status-prefix' 'OC')"
  status_color_neutral="$(get_tmux_option '@opencode-tmux-status-color-neutral' 'colour252')"
  status_color_busy="$(get_tmux_option '@opencode-tmux-status-color-busy' 'colour220')"
  status_color_waiting="$(get_tmux_option '@opencode-tmux-status-color-waiting' 'colour196')"
  status_color_idle="$(get_tmux_option '@opencode-tmux-status-color-idle' 'colour70')"
  status_color_unknown="$(get_tmux_option '@opencode-tmux-status-color-unknown' 'colour244')"
  previous_status_segment="$(get_tmux_option '@opencode-tmux-status-segment' '')"
  previous_status_option="$(get_tmux_option '@opencode-tmux-status-option' 'status-right')"
  status_option="$(normalize_status_option "$status_position")"

  if [ ! -f "$CURRENT_DIR/bin/opencode-tmux" ]; then
    tmux display-message "opencode-tmux: missing bin/opencode-tmux in plugin directory"
    exit 0
  fi

  if [ "$install_plugin" = "on" ]; then
    install_opencode_plugin
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

  local switch_command waiting_switch_command status_command popup_script menu_script bind_command waiting_bind_command
  popup_script="$CURRENT_DIR/scripts/tmux-popup-switch.sh"
  menu_script="$CURRENT_DIR/scripts/tmux-menu-switch.sh"

  if [ ! -f "$popup_script" ]; then
    tmux display-message "opencode-tmux: missing scripts/tmux-popup-switch.sh in plugin directory"
    exit 0
  fi

  if [ ! -f "$menu_script" ]; then
    tmux display-message "opencode-tmux: missing scripts/tmux-menu-switch.sh in plugin directory"
    exit 0
  fi

  switch_command="OPENCODE_TMUX_RUNNER='$runner' '$popup_script' --provider '$provider'"
  waiting_switch_command="OPENCODE_TMUX_RUNNER='$runner' '$popup_script' --provider '$provider' --waiting"
  status_command="cd '$CURRENT_DIR' && OPENCODE_TMUX_RUNNER='$runner' OPENCODE_TMUX_STATUS_PREFIX='$status_prefix' OPENCODE_TMUX_STATUS_COLOR_NEUTRAL='$status_color_neutral' OPENCODE_TMUX_STATUS_COLOR_BUSY='$status_color_busy' OPENCODE_TMUX_STATUS_COLOR_WAITING='$status_color_waiting' OPENCODE_TMUX_STATUS_COLOR_IDLE='$status_color_idle' OPENCODE_TMUX_STATUS_COLOR_UNKNOWN='$status_color_unknown' '$CURRENT_DIR/bin/opencode-tmux' status --style '$status_style' --provider '$provider'"
  bind_command="OPENCODE_TMUX_RUNNER='$runner' '$menu_script' --provider '$provider'"
  waiting_bind_command="OPENCODE_TMUX_RUNNER='$runner' '$menu_script' --provider '$provider' --waiting"

  if [ -n "$server_map" ]; then
    switch_command="$switch_command --server-map '$server_map'"
    waiting_switch_command="$waiting_switch_command --server-map '$server_map'"
    status_command="$status_command --server-map '$server_map'"
    bind_command="$bind_command --server-map '$server_map'"
    waiting_bind_command="$waiting_bind_command --server-map '$server_map'"
  fi

  if [ -n "$popup_filter_arg" ]; then
    switch_command="$switch_command $popup_filter_arg"
    bind_command="$bind_command $popup_filter_arg"
  fi

  if [ "$launcher" = "popup" ]; then
    tmux bind-key "$key" display-popup -E -w "$popup_width" -h "$popup_height" -T "$popup_title" "$switch_command"
    tmux bind-key "$waiting_key" display-popup -E -w "$popup_width" -h "$popup_height" -T "$popup_title (Waiting)" "$waiting_switch_command"
  else
    tmux bind-key "$key" run-shell "$bind_command"
    tmux bind-key "$waiting_key" run-shell "$waiting_bind_command"
  fi

  if [ -n "$previous_status_segment" ]; then
    remove_status_segment "$previous_status_option" "$previous_status_segment"
  fi

  if [ "$status_enabled" = "on" ]; then
    local current_status_segment
    current_status_segment="#($status_command)"
    tmux set-option -g status-interval "$status_interval"
    append_status_segment "$status_option" "$current_status_segment"
    tmux set-option -gq @opencode-tmux-status-segment "$current_status_segment"
    tmux set-option -gq @opencode-tmux-status-option "$status_option"
  else
    tmux set-option -gu @opencode-tmux-status-segment
    tmux set-option -gu @opencode-tmux-status-option
  fi
}

main "$@"
