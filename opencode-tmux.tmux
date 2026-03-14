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

replace_status_placeholder() {
  local option_name="$1"
  local segment="$2"
  shift 2
  local existing updated placeholder replaced=1
  existing="$(tmux show-option -gqv "$option_name")"
  updated="$existing"

  for placeholder in "$@"; do
    if [[ "$updated" == *"$placeholder"* ]]; then
      updated="${updated//$placeholder/$segment}"
      replaced=0
    fi
  done

  if [ "$replaced" -ne 0 ]; then
    return 1
  fi

  tmux set-option -g "$option_name" "$updated"
}

catppuccin_loaded() {
  [ -n "$(tmux show-option -gqv @catppuccin_status_left_separator)" ]
}

configure_catppuccin_status_module() {
  local text_segment="$1"
  local prefix="$2"
  local accent_color="$3"
  local waiting_color="$4"
  local idle_color="$5"
  local unknown_color="$6"
  local left_separator right_separator middle_separator status_fill connect_separator connect_style theme_crust theme_fg status_bg accent_format
  local middle_style right_style module

  if [ -z "$text_segment" ] || ! catppuccin_loaded; then
    tmux set-option -gu @catppuccin_opencode_icon
    tmux set-option -gu @catppuccin_opencode_color
    tmux set-option -gu @catppuccin_opencode_text
    tmux set-option -gu @catppuccin_status_opencode
    return
  fi

  tmux set-option -gq @catppuccin_opencode_icon "$prefix "
  accent_format="#{?#{==:#{E:@opencode-tmux-status-tone},waiting},$waiting_color,#{?#{==:#{E:@opencode-tmux-status-tone},idle},$idle_color,#{?#{==:#{E:@opencode-tmux-status-tone},unknown},$unknown_color,$accent_color}}}"
  tmux set-option -gq @catppuccin_opencode_color "$accent_format"
  tmux set-option -gq @catppuccin_opencode_text "$text_segment"

  left_separator="$(tmux show-option -gqv @catppuccin_status_left_separator)"
  right_separator="$(tmux show-option -gqv @catppuccin_status_right_separator)"
  middle_separator="$(tmux show-option -gqv @catppuccin_status_middle_separator)"
  status_fill="$(tmux show-option -gqv @catppuccin_status_fill)"
  connect_separator="$(tmux show-option -gqv @catppuccin_status_connect_separator)"
  theme_crust="$(tmux show-option -gqv @thm_crust)"
  theme_fg="$(tmux show-option -gqv @thm_fg)"
  status_bg="$(tmux show-option -gqv @_ctp_status_bg)"
  connect_style='#[bg=default]'

  if [ "$connect_separator" = 'yes' ]; then
    connect_style=''
  fi

  if [ "$status_fill" = 'icon' ]; then
    middle_style="#[fg=#{E:@catppuccin_opencode_color},bg=$status_bg]$middle_separator#[fg=$theme_fg] "
    right_style="#[fg=$status_bg]$connect_style$right_separator"
  else
    middle_style="#[fg=#{E:@catppuccin_opencode_color}]$middle_separator#[fg=$theme_crust]"
    right_style="#[fg=#{E:@catppuccin_opencode_color}]$connect_style$right_separator"
  fi

  module="#[fg=#{E:@catppuccin_opencode_color},nobold,nounderscore,noitalics]$connect_style$left_separator#[fg=$theme_crust,bg=#{E:@catppuccin_opencode_color}]${prefix} $middle_style#{E:@catppuccin_opencode_text}$right_style"
  tmux set-option -gq @catppuccin_status_opencode "$module"
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

normalize_binding_key() {
  local key="$1"
  case "$key" in
    ""|off|none|disabled)
      printf '%s' ''
      ;;
    *)
      printf '%s' "$key"
      ;;
  esac
}

normalize_status_mode() {
  local mode="$1"
  case "$mode" in
    append|manual|"")
      printf '%s' "${mode:-manual}"
      ;;
    *)
      printf '%s' 'manual'
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

unbind_key_if_set() {
  local key="$1"

  if [ -z "$key" ]; then
    return
  fi

  tmux unbind-key "$key" >/dev/null 2>&1 || true
}

store_bound_key() {
  local option_name="$1"
  local key="$2"

  if [ -n "$key" ]; then
    tmux set-option -gq "$option_name" "$key"
  else
    tmux set-option -gu "$option_name"
  fi
}

dependencies_installed() {
  local commander_dir="$CURRENT_DIR/node_modules/commander"
  local commander_manifest="$commander_dir/package.json"

  if [ ! -f "$commander_manifest" ]; then
    return 1
  fi

  if [ "$CURRENT_DIR/package.json" -nt "$commander_manifest" ]; then
    return 1
  fi

  if [ -f "$CURRENT_DIR/package-lock.json" ] && [ "$CURRENT_DIR/package-lock.json" -nt "$commander_manifest" ]; then
    return 1
  fi

  return 0
}

install_cli_dependencies() {
  local install_command

  if [ -f "$CURRENT_DIR/package-lock.json" ] && command -v npm >/dev/null 2>&1; then
    install_command="npm ci --omit=dev"
  elif command -v npm >/dev/null 2>&1; then
    install_command="npm install --omit=dev"
  else
    tmux display-message "opencode-tmux: npm is required to install CLI dependencies"
    return 1
  fi

  tmux display-message "opencode-tmux: installing CLI dependencies"

  if ! (cd "$CURRENT_DIR" && eval "$install_command" >/dev/null 2>&1); then
    tmux display-message "opencode-tmux: failed to install CLI dependencies"
    return 1
  fi

  tmux display-message "opencode-tmux: CLI dependencies ready"
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
  local menu_key popup_key waiting_menu_key waiting_popup_key provider server_map popup_filter popup_width popup_height popup_title status_enabled status_style status_position status_option status_interval status_mode install_plugin status_text_segment status_inline_segment status_tone_segment
  local status_prefix status_color_neutral status_color_busy status_color_waiting status_color_idle status_color_unknown
  local previous_status_segment previous_status_option previous_menu_key previous_popup_key previous_waiting_menu_key previous_waiting_popup_key
  menu_key="$(normalize_binding_key "$(get_tmux_option '@opencode-tmux-menu-key' 'O')")"
  popup_key="$(normalize_binding_key "$(get_tmux_option '@opencode-tmux-popup-key' 'P')")"
  waiting_menu_key="$(normalize_binding_key "$(get_tmux_option '@opencode-tmux-waiting-menu-key' 'W')")"
  waiting_popup_key="$(normalize_binding_key "$(get_tmux_option '@opencode-tmux-waiting-popup-key' 'C-w')")"
  provider="$(get_tmux_option '@opencode-tmux-provider' 'auto')"
  server_map="$(get_tmux_option '@opencode-tmux-server-map' '')"
  popup_filter="$(get_tmux_option '@opencode-tmux-popup-filter' 'all')"
  popup_width="$(get_tmux_option '@opencode-tmux-popup-width' '100%')"
  popup_height="$(get_tmux_option '@opencode-tmux-popup-height' '100%')"
  popup_title="$(get_tmux_option '@opencode-tmux-popup-title' 'OpenCode Sessions')"
  install_plugin="$(normalize_toggle "$(get_tmux_option '@opencode-tmux-install-opencode-plugin' 'on')")"
  status_enabled="$(get_tmux_option '@opencode-tmux-status' 'on')"
  status_style="$(get_tmux_option '@opencode-tmux-status-style' 'tmux')"
  status_position="$(get_tmux_option '@opencode-tmux-status-position' 'right')"
  status_mode="$(normalize_status_mode "$(get_tmux_option '@opencode-tmux-status-mode' 'manual')")"
  status_interval="$(get_tmux_option '@opencode-tmux-status-interval' '1')"
  status_prefix="$(get_tmux_option '@opencode-tmux-status-prefix' 'OC')"
  status_color_neutral="$(get_tmux_option '@opencode-tmux-status-color-neutral' 'colour252')"
  status_color_busy="$(get_tmux_option '@opencode-tmux-status-color-busy' 'colour220')"
  status_color_waiting="$(get_tmux_option '@opencode-tmux-status-color-waiting' 'colour196')"
  status_color_idle="$(get_tmux_option '@opencode-tmux-status-color-idle' 'colour70')"
  status_color_unknown="$(get_tmux_option '@opencode-tmux-status-color-unknown' 'colour244')"
  previous_status_segment="$(get_tmux_option '@opencode-tmux-status-segment' '')"
  previous_status_option="$(get_tmux_option '@opencode-tmux-status-option' 'status-right')"
  previous_menu_key="$(get_tmux_option '@opencode-tmux-bound-menu-key' '')"
  previous_popup_key="$(get_tmux_option '@opencode-tmux-bound-popup-key' '')"
  previous_waiting_menu_key="$(get_tmux_option '@opencode-tmux-bound-waiting-menu-key' '')"
  previous_waiting_popup_key="$(get_tmux_option '@opencode-tmux-bound-waiting-popup-key' '')"
  status_option="$(normalize_status_option "$status_position")"

  if [ ! -f "$CURRENT_DIR/bin/opencode-tmux" ]; then
    tmux display-message "opencode-tmux: missing bin/opencode-tmux in plugin directory"
    exit 0
  fi

  if ! dependencies_installed; then
    install_cli_dependencies || exit 0
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

  local switch_command waiting_switch_command status_command status_text_command status_inline_command status_tone_command popup_script menu_script bind_command waiting_bind_command
  popup_script="$CURRENT_DIR/scripts/tmux-popup-switch.sh"
  menu_script="$CURRENT_DIR/scripts/tmux-menu-switch.sh"

  if { [ -n "$popup_key" ] || [ -n "$waiting_popup_key" ]; } && [ ! -f "$popup_script" ]; then
    tmux display-message "opencode-tmux: missing scripts/tmux-popup-switch.sh in plugin directory"
    exit 0
  fi

  if { [ -n "$menu_key" ] || [ -n "$waiting_menu_key" ]; } && [ ! -f "$menu_script" ]; then
    tmux display-message "opencode-tmux: missing scripts/tmux-menu-switch.sh in plugin directory"
    exit 0
  fi

  switch_command="'$popup_script' --provider '$provider'"
  waiting_switch_command="'$popup_script' --provider '$provider' --waiting"
  status_command="cd '$CURRENT_DIR' && OPENCODE_TMUX_STATUS_PREFIX='$status_prefix' OPENCODE_TMUX_STATUS_COLOR_NEUTRAL='$status_color_neutral' OPENCODE_TMUX_STATUS_COLOR_BUSY='$status_color_busy' OPENCODE_TMUX_STATUS_COLOR_WAITING='$status_color_waiting' OPENCODE_TMUX_STATUS_COLOR_IDLE='$status_color_idle' OPENCODE_TMUX_STATUS_COLOR_UNKNOWN='$status_color_unknown' '$CURRENT_DIR/bin/opencode-tmux' status --style '$status_style' --provider '$provider'"
  status_text_command="cd '$CURRENT_DIR' && OPENCODE_TMUX_STATUS_PREFIX='$status_prefix' OPENCODE_TMUX_STATUS_SHOW_PREFIX='off' '$CURRENT_DIR/bin/opencode-tmux' status --style 'plain' --provider '$provider'"
  status_inline_command="cd '$CURRENT_DIR' && OPENCODE_TMUX_STATUS_PREFIX='$status_prefix' OPENCODE_TMUX_STATUS_SHOW_PREFIX='off' OPENCODE_TMUX_STATUS_COLOR_NEUTRAL='$status_color_neutral' OPENCODE_TMUX_STATUS_COLOR_BUSY='$status_color_busy' OPENCODE_TMUX_STATUS_COLOR_WAITING='$status_color_waiting' OPENCODE_TMUX_STATUS_COLOR_IDLE='$status_color_idle' OPENCODE_TMUX_STATUS_COLOR_UNKNOWN='$status_color_unknown' '$CURRENT_DIR/bin/opencode-tmux' status --style 'tmux' --provider '$provider'"
  status_tone_command="cd '$CURRENT_DIR' && '$CURRENT_DIR/bin/opencode-tmux' status --tone --provider '$provider'"
  bind_command="'$menu_script' --provider '$provider'"
  waiting_bind_command="'$menu_script' --provider '$provider' --waiting"

  if [ -n "$server_map" ]; then
    switch_command="$switch_command --server-map '$server_map'"
    waiting_switch_command="$waiting_switch_command --server-map '$server_map'"
    status_command="$status_command --server-map '$server_map'"
    status_text_command="$status_text_command --server-map '$server_map'"
    status_inline_command="$status_inline_command --server-map '$server_map'"
    status_tone_command="$status_tone_command --server-map '$server_map'"
    bind_command="$bind_command --server-map '$server_map'"
    waiting_bind_command="$waiting_bind_command --server-map '$server_map'"
  fi

  if [ -n "$popup_filter_arg" ]; then
    switch_command="$switch_command $popup_filter_arg"
    bind_command="$bind_command $popup_filter_arg"
  fi

  unbind_key_if_set "$previous_menu_key"
  unbind_key_if_set "$previous_popup_key"
  unbind_key_if_set "$previous_waiting_menu_key"
  unbind_key_if_set "$previous_waiting_popup_key"

  if [ -n "$menu_key" ]; then
    tmux bind-key "$menu_key" run-shell "$bind_command"
  fi

  if [ -n "$popup_key" ]; then
    tmux bind-key "$popup_key" display-popup -E -w "$popup_width" -h "$popup_height" -T "$popup_title" "$switch_command"
  fi

  if [ -n "$waiting_menu_key" ]; then
    tmux bind-key "$waiting_menu_key" run-shell "$waiting_bind_command"
  fi

  if [ -n "$waiting_popup_key" ]; then
    tmux bind-key "$waiting_popup_key" display-popup -E -w "$popup_width" -h "$popup_height" -T "$popup_title (Waiting)" "$waiting_switch_command"
  fi

  store_bound_key '@opencode-tmux-bound-menu-key' "$menu_key"
  store_bound_key '@opencode-tmux-bound-popup-key' "$popup_key"
  store_bound_key '@opencode-tmux-bound-waiting-menu-key' "$waiting_menu_key"
  store_bound_key '@opencode-tmux-bound-waiting-popup-key' "$waiting_popup_key"

  if [ -n "$previous_status_segment" ]; then
    remove_status_segment "$previous_status_option" "$previous_status_segment"
  fi

  if [ "$status_enabled" = "on" ]; then
    local current_status_segment
    current_status_segment="#($status_command)"
    status_text_segment="#($status_text_command)"
    status_inline_segment="#($status_inline_command)"
    status_tone_segment="#($status_tone_command)"
    tmux set-option -g status-interval "$status_interval"
    tmux set-option -gq @opencode-tmux-status-format "$current_status_segment"
    tmux set-option -gq @opencode-tmux-status-text "$status_text_segment"
    tmux set-option -gq @opencode-tmux-status-inline-format "$status_inline_segment"
    tmux set-option -gq @opencode-tmux-status-tone "$status_tone_segment"
    configure_catppuccin_status_module "$status_text_segment" "$status_prefix" "$status_color_busy" "$status_color_waiting" "$status_color_idle" "$status_color_unknown"

    if [ "$status_mode" = "append" ]; then
      append_status_segment "$status_option" "$current_status_segment"
      tmux set-option -gq @opencode-tmux-status-segment "$current_status_segment"
      tmux set-option -gq @opencode-tmux-status-option "$status_option"
    elif replace_status_placeholder "$status_option" "$current_status_segment" '#{E:@opencode-tmux-status-format}' '#{@opencode-tmux-status-format}'; then
      tmux set-option -gq @opencode-tmux-status-segment "$current_status_segment"
      tmux set-option -gq @opencode-tmux-status-option "$status_option"
    elif replace_status_placeholder "$status_option" "$status_text_segment" '#{E:@opencode-tmux-status-text}' '#{@opencode-tmux-status-text}'; then
      tmux set-option -gq @opencode-tmux-status-segment "$current_status_segment"
      tmux set-option -gq @opencode-tmux-status-option "$status_option"
    elif replace_status_placeholder "$status_option" "$status_inline_segment" '#{E:@opencode-tmux-status-inline-format}' '#{@opencode-tmux-status-inline-format}'; then
      tmux set-option -gq @opencode-tmux-status-segment "$current_status_segment"
      tmux set-option -gq @opencode-tmux-status-option "$status_option"
    elif [ "$status_option" = "status-right" ] && replace_status_placeholder 'status-left' "$current_status_segment" '#{E:@opencode-tmux-status-format}' '#{@opencode-tmux-status-format}'; then
      tmux set-option -gq @opencode-tmux-status-segment "$current_status_segment"
      tmux set-option -gq @opencode-tmux-status-option 'status-left'
    elif [ "$status_option" = "status-right" ] && replace_status_placeholder 'status-left' "$status_text_segment" '#{E:@opencode-tmux-status-text}' '#{@opencode-tmux-status-text}'; then
      tmux set-option -gq @opencode-tmux-status-segment "$current_status_segment"
      tmux set-option -gq @opencode-tmux-status-option 'status-left'
    elif [ "$status_option" = "status-right" ] && replace_status_placeholder 'status-left' "$status_inline_segment" '#{E:@opencode-tmux-status-inline-format}' '#{@opencode-tmux-status-inline-format}'; then
      tmux set-option -gq @opencode-tmux-status-segment "$current_status_segment"
      tmux set-option -gq @opencode-tmux-status-option 'status-left'
    elif [ "$status_option" = "status-left" ] && replace_status_placeholder 'status-right' "$current_status_segment" '#{E:@opencode-tmux-status-format}' '#{@opencode-tmux-status-format}'; then
      tmux set-option -gq @opencode-tmux-status-segment "$current_status_segment"
      tmux set-option -gq @opencode-tmux-status-option 'status-right'
    elif [ "$status_option" = "status-left" ] && replace_status_placeholder 'status-right' "$status_text_segment" '#{E:@opencode-tmux-status-text}' '#{@opencode-tmux-status-text}'; then
      tmux set-option -gq @opencode-tmux-status-segment "$current_status_segment"
      tmux set-option -gq @opencode-tmux-status-option 'status-right'
    elif [ "$status_option" = "status-left" ] && replace_status_placeholder 'status-right' "$status_inline_segment" '#{E:@opencode-tmux-status-inline-format}' '#{@opencode-tmux-status-inline-format}'; then
      tmux set-option -gq @opencode-tmux-status-segment "$current_status_segment"
      tmux set-option -gq @opencode-tmux-status-option 'status-right'
    else
      tmux set-option -gu @opencode-tmux-status-segment
      tmux set-option -gu @opencode-tmux-status-option
    fi
  else
    tmux set-option -gu @opencode-tmux-status-format
    tmux set-option -gu @opencode-tmux-status-text
    tmux set-option -gu @opencode-tmux-status-inline-format
    tmux set-option -gu @opencode-tmux-status-tone
    configure_catppuccin_status_module '' "$status_prefix" "$status_color_busy" "$status_color_waiting" "$status_color_idle" "$status_color_unknown"
    tmux set-option -gu @opencode-tmux-status-segment
    tmux set-option -gu @opencode-tmux-status-option
  fi
}

main "$@"
