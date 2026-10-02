#!/usr/bin/env bash
# Runner 一屏状态（P00-T05.5）。只读，不改任何东西。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$ROOT/logs/runner"

echo "== Unattended Runner status =="
echo "repo: $ROOT"
echo "branch: $(git -C "$ROOT" branch --show-current 2>/dev/null)"
echo "head: $(git -C "$ROOT" log --oneline -1 2>/dev/null)"
echo "worktree: $(if [ -z "$(git -C "$ROOT" status --porcelain)" ]; then echo clean; else echo DIRTY; fi)"

echo
echo "== lock =="
if [ -f "$LOGS/runner.lock" ]; then
  pid="$(cat "$LOGS/runner.lock" 2>/dev/null)"
  if kill -0 "$pid" 2>/dev/null; then echo "held by live pid=$pid"; else echo "stale lock file (pid=$pid 不存活)"; fi
else
  echo "no lock file"
fi

echo
echo "== STOP flag =="
[ -f "$LOGS/STOP" ] && echo "present: $LOGS/STOP（下一轮不会启动）" || echo "absent"

echo
echo "== current.json =="
[ -f "$LOGS/current.json" ] && cat "$LOGS/current.json" || echo "(无)"

echo
echo "== state.json =="
[ -f "$LOGS/state.json" ] && cat "$LOGS/state.json" || echo "(无)"

echo
echo "== 最近事件（20）=="
newest="$(ls -1t "$LOGS"/*.jsonl 2>/dev/null | head -1)"
[ -n "$newest" ] && tail -20 "$newest" || echo "(无事件)"

echo
echo "== 最近 commit =="
git -C "$ROOT" log --oneline -3 2>/dev/null

echo
echo "== STOPPED.md（若有）=="
[ -f "$LOGS/STOPPED.md" ] && head -20 "$LOGS/STOPPED.md" || echo "(无)"
