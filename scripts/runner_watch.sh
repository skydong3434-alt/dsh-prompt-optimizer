#!/usr/bin/env bash
# 实时跟随 Runner 事件流（P00-T05.5）。Ctrl-C 退出。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$ROOT/logs/runner"
mkdir -p "$LOGS"
newest="$(ls -1t "$LOGS"/*.jsonl 2>/dev/null | head -1)"
if [ -z "$newest" ]; then
  newest="$LOGS/$(date '+%Y-%m-%d').jsonl"
  touch "$newest"
fi
echo "watching $newest （Ctrl-C 退出）"
tail -f "$newest"
