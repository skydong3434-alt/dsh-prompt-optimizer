#!/usr/bin/env python3
"""apo_state —— dsh-adaptive-prompt-optimizer 控制平面最小解析与一致性检查。

由 personal-ai-brain 的 check_control_plane.py 裁剪而来（仅保留本项目需要的部分，
未复制任何 PAB 专属业务规则）。唯一被 unattended_runner.py 依赖的接口是
parse_state_block()；main() 是 Runner 第二层门禁（DEFAULT_GATES 使用）。

检查项（全部只读）：
  1. CURRENT_STATE.md 第一个代码块可解析，且含关键字段（project / current_phase /
     current_task / status / next_task / stop_reason / latest_commit）；
  2. current_task 非空时，tasks/ 下存在对应的任务文件（tasks/<id>-*.md 前缀匹配）；
  3. status 与 stop_reason 语义一致（stop_reason 含 BLOCKING 标记词时 status 不应是
     DONE 之类）；
  4. git HEAD 与 CURRENT_STATE.latest_commit 一致（不一致仅告警 INFO，不 FAIL——
     运行中状态会先于 commit 更新）。
退出码：0 = 全部 PASS（可含 INFO）；1 = 存在 FAIL。
"""

import re
import subprocess
import sys
from pathlib import Path

EXIT_OK = 0
EXIT_FAIL = 1


def parse_state_block(text):
    """解析 CURRENT_STATE.md 第一个代码块中的 key: value（继承自 PAB DEC-009 字段布局）。"""
    fields = {}
    inside = False
    for raw in text.split(chr(10)):
        line = raw.rstrip()
        if line.strip() == chr(96) * 3:
            if inside:
                break
            inside = True
            continue
        if inside and ":" in line and not line.lstrip().startswith("#"):
            key, _, value = line.partition(":")
            fields[key.strip()] = value.strip()
    return fields


REQUIRED_FIELDS = (
    "project", "current_phase", "current_task", "status", "next_task",
    "stop_reason", "latest_commit",
)


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    fails: list[str] = []
    infos: list[str] = []

    state_path = root / "CURRENT_STATE.md"
    if not state_path.is_file():
        print("[FAIL] CURRENT_STATE.md 不存在")
        return EXIT_FAIL
    state = parse_state_block(state_path.read_text(encoding="utf-8"))

    for field in REQUIRED_FIELDS:
        if field not in state:
            fails.append(f"CURRENT_STATE 缺字段 {field}")
    if fails:
        for f in fails:
            print(f"[FAIL] {f}")
        return EXIT_FAIL

    current_task = state["current_task"]
    if current_task:
        task_dir = root / "tasks"
        matches = list(task_dir.glob(f"{current_task}-*.md")) if task_dir.is_dir() else []
        if not matches:
            fails.append(f"current_task={current_task} 在 tasks/ 下无对应任务文件")

    stop_reason = state["stop_reason"].lower()
    blocking = any(m in stop_reason for m in (
        "blocking", "merge conflict", "schema breaking", "contract breaking",
        "architecture change", "irreversible", "transport exhausted",
        "retry exhausted", "test failure out of scope", "scope expanded",
    ))
    if blocking and state["status"].upper() in ("DONE", "PROJECT_COMPLETE"):
        fails.append(f"stop_reason 含 BLOCKING 标记词但 status={state['status']}")

    try:
        head = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=str(root), capture_output=True,
            text=True, timeout=10).stdout.strip()
        if head and state["latest_commit"] and head != state["latest_commit"]:
            infos.append(f"latest_commit 与 git HEAD 不一致（运行中先更新状态后提交属正常）")
    except Exception:  # noqa: BLE001
        infos.append("git HEAD 读取失败（跳过）")

    for i in infos:
        print(f"[INFO] {i}")
    if fails:
        for f in fails:
            print(f"[FAIL] {f}")
        print("结果: FAIL")
        return EXIT_FAIL
    print("结果: PASS（0 FAIL）")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())