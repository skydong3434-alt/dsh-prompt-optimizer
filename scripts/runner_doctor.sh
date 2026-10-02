#!/usr/bin/env bash
# Personal AI Brain - Runner 环境体检（P00-T05.8）。
#
# 一条命令检查无人值守运行的环境前置条件：
#   ① dsh CLI（PATH 或 DSH App bundle）  ② pab-runner profile（含审批补丁层）
#   ③ python3                            ④ logs/runner 可写
#   ⑤ 单写者锁（是否有活持有者）          ⑥ git 工作区是否 clean
#
# 只读脚本：唯一副作用是 logs/runner 下的探针文件，随即删除。
# 退出码：0 = 全部 OK；1 = 存在 FAIL（唯一可接受的非 0 是 git dirty）。
#
# 可覆盖的环境变量（便于测试 / 多实例）：
#   PAB_RUNNER_LOGS          默认 <repo>/logs/runner
#   APO_RUNNER_PROFILE_DIR   默认 ~/.dsh/profiles/pab-runner
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS_DIR="${PAB_RUNNER_LOGS:-$ROOT/logs/runner}"
PROFILE_DIR="${APO_RUNNER_PROFILE_DIR:-$HOME/.dsh/profiles/headless}"
DSH_APP_BIN="/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js"

FAILS=0
ok()   { printf '  [OK]   %s\n' "$1"; }
fail() { printf '  [FAIL] %s\n' "$1"; FAILS=$((FAILS + 1)); }
note() { printf '         %s\n' "$1"; }

echo "Personal AI Brain - Runner doctor (P00-T05.8)"
echo "repo: $ROOT"
echo "logs: $LOGS_DIR"
echo

# ① dsh CLI：优先 PATH，否则用 App bundle 内的 bin.js（与 unattended_runner.resolve_dsh 一致）
dsh_path="$(command -v dsh 2>/dev/null || true)"
if [ -n "$dsh_path" ]; then
  ok "dsh CLI (PATH): $dsh_path"
elif [ -f "$DSH_APP_BIN" ]; then
  node_path="$(command -v node 2>/dev/null || true)"
  if [ -n "$node_path" ]; then
    ok "dsh CLI (App bundle): $DSH_APP_BIN"
    note "node: $node_path"
  else
    fail "dsh CLI: App bundle 存在但找不到 node"
  fi
else
  fail "dsh CLI: PATH 与应用包都没有"
fi

# ② pab-runner profile：补丁层关闭无人值守审批，缺失即无法 headless 运行
if [ ! -d "$PROFILE_DIR" ]; then
  fail "headless profile: 目录不存在 $PROFILE_DIR"
elif [ ! -f "$PROFILE_DIR/cordis.patch.yml" ]; then
  fail "headless profile: 缺少 cordis.patch.yml（审批补丁层）"
else
  ok "headless profile: $PROFILE_DIR"
fi

# ③ python3：Runner 自身与门禁的执行器
py_path="$(command -v python3 2>/dev/null || true)"
if [ -n "$py_path" ]; then
  ok "python3: $py_path ($(python3 --version 2>&1))"
else
  fail "python3: 不在 PATH"
fi

# ④ logs/runner 可写：账本 / 锁 / 事件流都落在这里
if mkdir -p "$LOGS_DIR" 2>/dev/null && probe="$LOGS_DIR/.doctor-write-probe.$$" && : >"$probe" 2>/dev/null; then
  rm -f "$probe"
  ok "logs/runner 可写: $LOGS_DIR"
else
  fail "logs/runner 不可写: $LOGS_DIR"
fi

# ⑤ 单写者锁：用 fcntl.flock 判定是否有活持有者。
#    残留锁文件（持有进程已死）不阻塞启动，属 OK；被非 Runner 进程占用才是 FAIL。
#    在 Runner 自己的轮次内运行时，锁由该 Runner 持有，属预期状态，不是环境故障。
lock_file="$LOGS_DIR/runner.lock"
if [ ! -e "$lock_file" ]; then
  ok "lock: free（无锁文件）"
else
  holder="$(tr -d '[:space:]' <"$lock_file" 2>/dev/null || true)"
  lock_held="no"
  if [ -n "$py_path" ]; then
    if python3 - "$lock_file" <<'PY'
import fcntl
import sys

handle = open(sys.argv[1], "a+")
try:
    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
except BlockingIOError:
    sys.exit(0)  # 有活持有者
sys.exit(1)      # 可获取 => 无活持有者
PY
    then
      lock_held="yes"
    fi
  fi
  if [ "$lock_held" = "yes" ]; then
    holder_cmd="$(ps -p "${holder:-0}" -o command= 2>/dev/null || true)"
    if printf '%s' "$holder_cmd" | grep -q "unattended_runner.py"; then
      ok "lock: 由运行中的 Runner 持有 (pid=${holder:-?}) —— 无人值守正在运行"
    else
      fail "lock: 被非 Runner 进程占用 (pid=${holder:-unknown})"
      note "holder: ${holder_cmd:-unknown}"
    fi
  else
    ok "lock: free（残留锁文件 pid=${holder:-unknown}，无活持有者，不阻塞启动）"
  fi
fi

# ⑥ git 工作区：dirty 说明上一轮尚未收尾，不应启动新一轮
if [ -z "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]; then
  ok "git: clean"
else
  fail "git: dirty（存在未提交改动）"
  note "$(git -C "$ROOT" status --short | head -5)"
fi

echo
if [ "$FAILS" -eq 0 ]; then
  echo "结果: OK（0 FAIL）"
  exit 0
fi
echo "结果: FAIL（$FAILS FAIL）"
exit 1
