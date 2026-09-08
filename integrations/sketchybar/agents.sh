#!/usr/bin/env bash

set -euo pipefail

# SketchyBar's launchd service may not inherit a locale. tmux needs UTF-8 to
# preserve the tab delimiters consumed by coding-agents-tmux.
export LANG="${LANG:-en_US.UTF-8}"
export LC_CTYPE="${LC_CTYPE:-en_US.UTF-8}"

CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$CURRENT_DIR/../.." && pwd)"
CLI="${CODING_AGENTS_TMUX_BIN:-$REPO_ROOT/bin/coding-agents-tmux}"
SKETCHYBAR="${SKETCHYBAR_BIN:-sketchybar}"
ITEM_NAME="${NAME:-coding-agents}"
PROVIDER="${CODING_AGENTS_TMUX_PROVIDER:-plugin}"

status_json="$("$CLI" status --summary --json --provider "$PROVIDER")"
parsed="$({ STATUS_JSON="$status_json" node -e '
const status = JSON.parse(process.env.STATUS_JSON ?? "{}");
process.stdout.write((status.tone ?? "unknown") + "\t" + (status.summary ?? ""));
'; })"
tone="${parsed%%$'\t'*}"
summary="${parsed#*$'\t'}"

case "$tone" in
waiting)
  color="${CODING_AGENTS_TMUX_COLOR_WAITING:-0xffff9e64}"
  ;;
busy)
  color="${CODING_AGENTS_TMUX_COLOR_BUSY:-0xff7aa2f7}"
  ;;
idle)
  color="${CODING_AGENTS_TMUX_COLOR_IDLE:-0xff9ece6a}"
  ;;
*)
  color="${CODING_AGENTS_TMUX_COLOR_UNKNOWN:-0xffa9b1d6}"
  ;;
esac

"$SKETCHYBAR" --set "$ITEM_NAME" label="$summary" label.color="$color"
