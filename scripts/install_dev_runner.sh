#!/usr/bin/env bash
# 渲染 / 安装 / 卸载 Unattended Runner 的 LaunchAgent（P00-T05.7）。
# plist 由本脚本从 scripts/dev_runner.plist.template 渲染；安装与卸载都是显式手工操作。
#
#   --render     只渲染（默认）
#   --install    渲染 + bootout 旧 job + bootstrap + verify
#   --verify     校验「已安装 plist 是否仍指向当前 repo root」（非 0 退出 = 已漂移）
#   --status     launchctl print 摘要
#   --kickstart  手动启动一轮
#   --uninstall  bootout + 删除 plist
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.apo.devrunner"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TEMPLATE="$ROOT/scripts/dev_runner.plist.template"
# APO：launchd 专用日志目录（与 Runner 自身账本 logs/runner/ 分离，互不覆盖）
LOGS="$ROOT/logs/runner/launchd"
MAX_ROUNDS="${APO_MAX_ROUNDS:-20}"
ROUND_TIMEOUT="${APO_ROUND_TIMEOUT:-3600}"
AT_LOAD="${APO_RUN_AT_LOAD:-false}"

MODE="${1:---render}"
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --at-load) AT_LOAD="true" ;;
    --max-rounds=*) MAX_ROUNDS="${1#*=}" ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

PYTHON="$(command -v python3)"
DSH_APP_BIN="${APO_DSH_APP_BIN:-/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js}"

# 行为验证一个 node 是否真的能跑 DSH CLI。
# 依据：2026-09-30 实机 —— 不满足 DSH engines（^22.19.0 || >=24.0.0）的 node 会让
# `dsh headless` 静默 exit 0、零输出，Runner 读到 turn_end_reason=None 并 retry exhausted。
# 与其解析版本号，不如直接问 CLI 能不能打印 usage（这是同一个失败模式的最短判据）。
node_works() {
  local node="$1"
  [ -n "${node}" ] && [ -x "${node}" ] || return 1
  local out
  out="$("${node}" "${DSH_APP_BIN}" headless --help 2>/dev/null | head -1)"
  [ -n "${out}" ]
}

resolve_node() {
  local candidates=() seen="" cand dir extra
  cand="$(command -v node 2>/dev/null || true)"; candidates+=("${cand}")
  candidates+=("${HOME}/.local/bin/node")
  # 额外的 node 目录（冒号分隔）：nvm / 非标准安装位置可显式指定
  if [ -n "${APO_NODE_DIRS:-}" ]; then
    IFS=':' read -r -a extra <<<"${APO_NODE_DIRS}"
    for dir in "${extra[@]}"; do
      [ -n "${dir}" ] && candidates+=("${dir%/}/node")
    done
  fi
  candidates+=("/opt/homebrew/bin/node" "/usr/local/bin/node")
  for cand in "${candidates[@]}"; do
    [ -n "${cand}" ] || continue
    dir="$(cd "$(dirname "${cand}")" 2>/dev/null && pwd)" || continue
    cand="${dir}/$(basename "${cand}")"
    case ":${seen}:" in *":${cand}:"*) continue ;; esac
    seen="${seen}:${cand}"
    if node_works "${cand}"; then
      echo "${cand}"
      return 0
    fi
    if [ -x "${cand}" ]; then
      echo "  skip node ${cand}（$("${cand}" --version 2>/dev/null || echo '版本未知')）：dsh headless --help 无输出，判定不兼容" >&2
    fi
  done
  return 1
}

render() {
  local node_bin node_dir
  if ! node_bin="$(resolve_node)"; then
    echo "render: FAIL — 找不到可用的 node（DSH CLI 要求 engines ^22.19.0 || >=24.0.0）" >&2
    echo "        已尝试：$(command -v node 2>/dev/null || echo '(PATH 无 node)') ${HOME}/.local/bin/node /opt/homebrew/bin/node /usr/local/bin/node" >&2
    echo "        LaunchAgent 不能靠不兼容的 node 运行：拒绝渲染（否则 launchd 下会静默 exit 0）" >&2
    return 1
  fi
  node_dir="$(dirname "${node_bin}")"
  mkdir -p "$LOGS" "$HOME/Library/LaunchAgents"
  sed -e "s|@@LABEL@@|$LABEL|g" \
      -e "s|@@PYTHON@@|$PYTHON|g" \
      -e "s|@@ROOT@@|$ROOT|g" \
      -e "s|@@HOME@@|$HOME|g" \
      -e "s|@@LOGS@@|$LOGS|g" \
      -e "s|@@NODE_DIR@@|${node_dir}|g" \
      -e "s|@@MAX_ROUNDS@@|$MAX_ROUNDS|g" \
      -e "s|@@ROUND_TIMEOUT@@|$ROUND_TIMEOUT|g" \
      -e "s|@@AT_LOAD@@|$AT_LOAD|g" \
      "$TEMPLATE" > "$PLIST"
  plutil -lint "$PLIST" >/dev/null && echo "rendered: $PLIST (plutil lint OK)"
  echo "  node: ${node_bin} ($("${node_bin}" --version 2>/dev/null || echo '?'))，PATH 前置 ${node_dir}"
}

# 判定「已安装的 plist 是否仍指向当前 repo root」。
# 仓库迁移（如 ~/Desktop → ~/Projects）后旧渲染结果会静默漂移，表现为 launchd 下
# dsh 静默 exit 0、Runner 读到 turn_end_reason=None 并 retry exhausted —— 这个检查让漂移可机器检出。
verify() {
  if [ ! -f "$PLIST" ]; then
    echo "verify: FAIL — 未安装 LaunchAgent（${PLIST} 不存在）"
    echo "修复: bash scripts/install_dev_runner.sh --install"
    return 1
  fi
  python3 - "$PLIST" "$ROOT" "$DSH_APP_BIN" <<'PY'
import os
import subprocess
import plistlib
import re
import sys

plist_path, root = sys.argv[1], os.path.realpath(sys.argv[2])
try:
    with open(plist_path, "rb") as handle:
        data = plistlib.load(handle)
except Exception as exc:  # noqa: BLE001
    print("verify: FAIL — 无法解析 plist: " + str(exc))
    raise SystemExit(1)

argv = [a for a in (data.get("ProgramArguments") or []) if isinstance(a, str)]
candidates = []
for item in argv:
    candidates.extend(re.findall(r"/[^\s\"'<>]+", item))
for key in ("WorkingDirectory", "StandardOutPath", "StandardErrorPath"):
    value = data.get(key)
    if isinstance(value, str):
        candidates.append(value)

repo_like = sorted({c for c in candidates
                    if c.startswith("/") and c.startswith(root + "/")})
stale = [c for c in candidates
         if c.startswith("/") and "dsh-adaptive-prompt-optimizer" in c
         and not (c == root or c.startswith(root + "/"))]
workdir = str(data.get("WorkingDirectory") or "")
wrapper_ok = ("/bin/bash" in argv and "-lc" in argv
              and any("exec " in a and "unattended_runner.py" in a for a in argv))
dsh_bin = sys.argv[3] if len(sys.argv) > 3 else ""

# node 前置：不兼容的 node 会让 dsh 静默 exit 0；这里做行为验证而不是版本号比较。
# APO 模板的 PATH 前置形如 export PATH="<node_dir>:<home>/.local/bin:..."（显式全量列表）。
node_dir = None
for item in argv:
    marker = 'export PATH="'
    if marker in item:
        node_dir = item.split(marker, 1)[1].split(":", 1)[0]
        break
node_note = None
node_problem = None
if not node_dir:
    node_problem = ("ProgramArguments 缺少 `export PATH=\"<node_dir>:$PATH\"` 前置"
                    "（不兼容的 node 会让 dsh 静默 exit 0）")
elif not os.path.isdir(node_dir):
    node_problem = "前置的 node 目录不存在: " + node_dir
else:
    node_bin = os.path.join(node_dir, "node")
    usage = ""
    version = "?"
    try:
        version = subprocess.run([node_bin, "--version"], capture_output=True, text=True,
                                 timeout=30).stdout.strip() or "?"
        if dsh_bin and os.path.isfile(dsh_bin):
            usage = subprocess.run([node_bin, dsh_bin, "headless", "--help"],
                                   capture_output=True, text=True, timeout=60).stdout.strip()
    except Exception:  # noqa: BLE001
        usage = ""
    if usage:
        node_note = node_bin + " (" + version + ") — dsh CLI 行为验证 OK"
    else:
        node_problem = ("前置 node 跑不出 dsh usage（" + node_bin + " " + version
                        + "）：launchd 下会静默 exit 0")

problems = []
if stale:
    problems.append("旧/外部 repo 路径: " + "、".join(stale))
if workdir != root:
    problems.append("WorkingDirectory 必须是 repo root（" + root + "），实际: " + (workdir or "(空)"))
if not os.path.isdir(workdir):
    problems.append("WorkingDirectory 不存在: " + (workdir or "(空)"))
if not wrapper_ok:
    problems.append("ProgramArguments 必须是 /bin/bash -lc \"exec …\"（launchd 不能直接 spawn python）")
if not any("--project-root" in a for a in argv):
    problems.append("ProgramArguments 缺少 --project-root")
if not repo_like:
    problems.append("plist 里找不到任何 repo 路径（渲染占位符可能没被替换）")
if node_problem:
    problems.append(node_problem)

label = data.get("Label")
if problems:
    print("verify: FAIL — 已安装的 LaunchAgent 与当前 repo root 不一致")
    for p in problems:
        print("  - " + p)
    print("  期望 repo root: " + root)
    print("  已安装 plist:   " + plist_path)
    print("  实际 repo 路径: " + ("、".join(repo_like) or "(无)"))
    print("  修复: bash scripts/install_dev_runner.sh --install")
    raise SystemExit(1)

print("verify: OK — label=" + str(label) + " 指向当前 repo root")
for c in repo_like:
    print("  " + c)
print("  WorkingDirectory=" + workdir + "，wrapper=/bin/bash -lc exec")
print("  node=" + str(node_note))
PY
}

case "$MODE" in
  --render) render ;;
  --install)
    render
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "installed (RunAtLoad=$AT_LOAD)；用 --kickstart 启动一轮"
    verify ;;
  --verify) verify ;;
  --uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "uninstalled" ;;
  --status) launchctl print "gui/$(id -u)/$LABEL" 2>&1 | sed -n "1,18p" ;;
  --kickstart) launchctl kickstart -p "gui/$(id -u)/$LABEL" ;;
  *) echo "unknown mode: $MODE" >&2; exit 2 ;;
esac
