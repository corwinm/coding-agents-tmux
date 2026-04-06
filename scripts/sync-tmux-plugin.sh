#!/usr/bin/env bash

set -euo pipefail

CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${OPENCODE_TMUX_PLUGIN_DIR:-$HOME/.tmux/plugins/opencode-tmux}"
TMUX_CONF="${OPENCODE_TMUX_TMUX_CONF:-$HOME/.tmux.conf}"
RELOAD=0
BOOTSTRAP=0

usage() {
  printf 'Usage: %s [--target <dir>] [--reload] [--bootstrap]\n' "${0##*/}"
  printf '\n'
  printf 'Sync this checkout into the tmux plugin install used by TPM.\n'
  printf '\n'
  printf 'Options:\n'
  printf '  --target <dir>   Override target plugin directory\n'
  printf '  --reload         Reload tmux after syncing\n'
  printf '  --bootstrap      Reinstall production npm deps in the target dir\n'
  printf '  -h, --help       Show this help\n'
}

run_bootstrap() {
  if ! command -v npm >/dev/null 2>&1; then
    printf 'opencode-tmux: npm is required for --bootstrap\n' >&2
    exit 1
  fi

  if [ -f "$TARGET_DIR/package-lock.json" ]; then
    npm ci --omit=dev --prefix "$TARGET_DIR"
  else
    npm install --omit=dev --prefix "$TARGET_DIR"
  fi
}

reload_tmux() {
  local plugin_entrypoint="$TARGET_DIR/opencode-tmux.tmux"

  if ! command -v tmux >/dev/null 2>&1; then
    printf 'opencode-tmux: tmux is not installed; skipping reload\n'
    return
  fi

  if ! tmux ls >/dev/null 2>&1; then
    printf 'opencode-tmux: no tmux server is running; skipping reload\n'
    return
  fi

  if [ ! -f "$TMUX_CONF" ]; then
    printf 'opencode-tmux: tmux config not found at %s; skipping reload\n' "$TMUX_CONF"
    return
  fi

  tmux source-file "$TMUX_CONF"

  if [ -f "$plugin_entrypoint" ]; then
    tmux run-shell "$plugin_entrypoint"
  fi

  printf 'Reloaded tmux from %s\n' "$TMUX_CONF"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
  --target)
    shift
    if [ "$#" -eq 0 ]; then
      printf 'opencode-tmux: --target requires a value\n' >&2
      exit 1
    fi
    TARGET_DIR="$1"
    ;;
  --reload)
    RELOAD=1
    ;;
  --bootstrap)
    BOOTSTRAP=1
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    printf 'opencode-tmux: unknown argument: %s\n' "$1" >&2
    usage >&2
    exit 1
    ;;
  esac
  shift
done

if ! command -v rsync >/dev/null 2>&1; then
  printf 'opencode-tmux: rsync is required to sync the plugin checkout\n' >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"

rsync -a --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude '.DS_Store' \
  "$CURRENT_DIR/" "$TARGET_DIR/"

printf 'Synced %s -> %s\n' "$CURRENT_DIR" "$TARGET_DIR"

if [ "$BOOTSTRAP" -eq 1 ]; then
  run_bootstrap
fi

if [ "$RELOAD" -eq 1 ]; then
  reload_tmux
else
  printf "Next: run \`tmux source-file %s\` if you changed tmux bindings or plugin bootstrap logic.\n" "$TMUX_CONF"
fi
