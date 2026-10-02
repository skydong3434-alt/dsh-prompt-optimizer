#!/usr/bin/env python3
"""Unattended runner - core (P00-T05.1).

The supervisor that sits outside any agent session. It decides what to run next
by reading the project's own control layer, keeps single-writer discipline, and
keeps a ledger that can be audited afterwards.

Boundary (AGENTS.md 13.1 / task contract): the runner only starts agents,
verifies their evidence, keeps score and decides continue-or-stop. It never
writes business code, never judges design quality, never touches the vault,
never edits CURRENT_STATE, never commits and never resolves conflicts.

T05.1 covers: single-writer lock, ledger, next-task resolution, blocking-gate
classification and --dry-run. Spawning agents arrives in T05.2.
"""

import argparse
import fcntl
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import apo_state as ccp  # noqa: E402  (APO 控制平面解析,parse_state_block)

N = chr(10)
EXIT_OK = 0
EXIT_LOCKED = 3
EXIT_STOPPED = 4
EXIT_GATE = 5
DEFAULT_MAX_ROUNDS = 20
DEFAULT_ROUND_TIMEOUT = 3600          # 60 minutes
DEFAULT_MAX_ATTEMPTS = 3
TRANSPORT_RETRY_SAME_REQUEST = 1

# AGENTS.md 13.1 A 类（BLOCKING HUMAN GATE）→ 命中即停
BLOCKING_STATUS_MARKERS = ("BLOCKED", "RECOVERY_REQUIRED")
BLOCKING_STOP_REASONS = (
    "blocking human gate",
    "merge conflict",
    "schema breaking",
    "contract breaking",
    "architecture change",
    "irreversible",
    "transport exhausted",
    "retry exhausted",
    "test failure out of scope",
    "scope expanded",
)


DSH_APP_BIN = ("/Applications/DSH Desktop.app/Contents/Resources/app"
              "/node_modules/@deepseek-ai/dsh/lib/bin.js")
DEFAULT_PROFILE = "headless"
TRANSPORT_MARKER = "[TRANSPORT]"
KILL_GRACE_SECONDS = 20
# 无人值守必须显式关闭交互式审批（否则审批在 headless 下无人回答 → 直接失败）
CHILD_PERMISSION_MODE = "danger-full-access"

START_PROMPT = """你是 Personal AI Brain 项目的一轮无人值守执行 Agent。

请严格按 AGENTS.md 的开工协议与收尾协议执行 CURRENT_STATE.next_task 指向的那个 Task：
1. 读 AGENTS.md、CURRENT_STATE.md、ROADMAP.md 与该 Task 文件全文；
2. 只改该 Task 的 Allowed Files；Forbidden Files 一律不碰；
3. 跑该 Task 的 Tests（含 Real Acceptance 若有）；然后跑
   python3 -m pytest tests/ -q
   python3 scripts/check_control_plane.py
   python3 scripts/check_write_boundaries.py
   全部必须 PASS；
4. 按收尾协议更新 CURRENT_STATE / CHANGELOG / ROADMAP / tasks README；
5. 一个 Task = 一个内容提交 + 一个仅 CURRENT_STATE 的状态同步提交；
6. **禁止**：**未经当前 Task 明确要求就安装 launchd**（P13 Automation 这类以 launchd 交付物的 Task
   在其 Allowed Files 明确覆盖时可安装/加载，其它情况一律禁止）、自动升格正式
   20-Knowledge/40-Memory/50-SOP、force push、reset --hard、删除真实数据、自行解决 merge conflict；
7. 完成后把 CURRENT_STATE.current_task 置空、next_task 指向下一个 Task；
8. 若命中 BLOCKING HUMAN GATE，停下并把 stop_reason 写入 CURRENT_STATE，不要硬做。

这是无人值守执行：没有人会回答你的提问。需要人工裁决时，写到 CURRENT_STATE.stop_reason 后结束本轮。"""


def now_iso():
    return datetime.now(timezone.utc).astimezone().replace(microsecond=0).isoformat()


class Locked(Exception):
    def __init__(self, holder_pid, lock_path, state_path, current_path):
        super().__init__("Runner already active")
        self.holder_pid = holder_pid
        self.lock_path = lock_path
        self.state_path = state_path
        self.current_path = current_path


class RunnerLock:
    """fcntl.flock 独占；第二个 Runner 不等待，立即失败。"""

    def __init__(self, logs_dir):
        self.logs_dir = Path(logs_dir)
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        self.path = self.logs_dir / "runner.lock"
        self.handle = None

    def acquire(self):
        self.handle = open(self.path, "a+")
        try:
            fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            holder = ""
            try:
                self.handle.seek(0)
                holder = self.handle.read().strip()
            except Exception:  # noqa: BLE001
                pass
            self.handle.close()
            self.handle = None
            raise Locked(holder or "unknown", self.path,
                         self.logs_dir / "state.json", self.logs_dir / "current.json")
        self.handle.seek(0)
        self.handle.truncate()
        self.handle.write(str(os.getpid()))
        self.handle.flush()
        return self

    def release(self):
        if self.handle is not None:
            try:
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
            finally:
                self.handle.close()
                self.handle = None


class Ledger:
    """state.json / current.json / YYYY-MM-DD.jsonl —— 全部在 logs/runner/（不入 Git）。"""

    def __init__(self, logs_dir):
        self.logs_dir = Path(logs_dir)
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        self.state_path = self.logs_dir / "state.json"
        self.current_path = self.logs_dir / "current.json"
        self.stopped_path = self.logs_dir / "STOPPED.md"
        self.events_path = self.logs_dir / (datetime.now().strftime("%Y-%m-%d") + ".jsonl")

    @staticmethod
    def _atomic_write(path, payload):
        path = Path(path)
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-")
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
        os.replace(tmp, path)

    def event(self, kind, **fields):
        record = {"ts": now_iso(), "kind": kind}
        record.update(fields)
        with open(self.events_path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + N)
        return record

    def save_state(self, state):
        self._atomic_write(self.state_path, json.dumps(state, ensure_ascii=False, indent=1, sort_keys=True) + N)

    def load_state(self):
        if not self.state_path.is_file():
            return {}
        try:
            return json.loads(self.state_path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            return {}

    def save_current(self, payload):
        self._atomic_write(self.current_path, json.dumps(payload, ensure_ascii=False, indent=1, sort_keys=True) + N)

    def write_stopped(self, report):
        self._atomic_write(self.stopped_path, report)


def attempt_record(round_no, phase, task, attempt, session_id=None, pid=None, start_time=None,
                   end_time=None, duration=None, exit_code=None, turn_end_reason=None,
                   gate_results=None, git_before=None, git_after=None,
                   latest_commit_before=None, latest_commit_after=None, next_task=None,
                   decision=None, stop_reason=None):
    """每个 attempt 至少记录这 23 个字段（用户 2026-09-30 验收要求）。"""
    return {
        "timestamp": now_iso(), "round": round_no, "phase": phase, "task": task, "attempt": attempt,
        "agent_session_id": session_id, "pid": pid, "start_time": start_time, "end_time": end_time,
        "duration": duration, "exit_code": exit_code, "turn_end_reason": turn_end_reason,
        "gate_results": gate_results or {}, "git_before": git_before, "git_after": git_after,
        "latest_commit_before": latest_commit_before, "latest_commit_after": latest_commit_after,
        "next_task": next_task, "decision": decision, "stop_reason": stop_reason,
    }


def read_control_state(root):
    """复用 check_control_plane 的解析器（不造第二份真值，DEC-015）。"""
    path = Path(root) / "CURRENT_STATE.md"
    if not path.is_file():
        return {}
    return ccp.parse_state_block(path.read_text(encoding="utf-8"))


def classify_blocking(state):
    """返回 BLOCKING 原因；None 表示可以继续（NON-BLOCKING 不阻断，AGENTS 13.1）。"""
    status = str(state.get("status") or "")
    for marker in BLOCKING_STATUS_MARKERS:
        if status.startswith(marker):
            return "status=" + status
    review = str(state.get("human_review") or "")
    if review.startswith("BLOCKING"):
        return "human_review=" + review
    stop_reason = str(state.get("stop_reason") or "").lower()
    for marker in BLOCKING_STOP_REASONS:
        if marker in stop_reason:
            return "stop_reason=" + stop_reason
    return None


def resolve_next(root, state, stop_file=None):
    """决定下一轮动作：run / stopped / idle。

    stop_file 必须跟随调用方的 logs 目录（**实测踩坑**：曾因只看仓库默认路径，
    导致测试放在 --logs-dir 的 STOP 未被识别，进而真的拉起了真实 Agent）。
    """
    stop_file = Path(stop_file) if stop_file else (Path(root) / "logs" / "runner" / "STOP")
    if stop_file.exists():
        return {"action": "stopped", "reason": "user STOP file present (" + str(stop_file) + ")"}
    blocking = classify_blocking(state)
    if blocking:
        return {"action": "stopped", "reason": blocking}
    task = str(state.get("current_task") or "").strip()
    if task:
        return {"action": "run", "task": task, "resume": True}
    nxt = str(state.get("next_task") or "").strip()
    if not nxt or nxt.startswith("（无）") or nxt.startswith("("):
        return {"action": "idle", "reason": "next_task 为空或未指向具体 Task"}
    token = nxt.split()[0].strip()
    if not token.startswith("P") or "-T" not in token:
        return {"action": "idle", "reason": "next_task 未指向具体 Task: " + nxt}
    task_file = Path(root) / "tasks" / (token + ".md")
    if not task_file.is_file():
        return {"action": "create_task", "task": token,
                "reason": "task 文件不存在，需要一轮 Agent 创建: " + str(task_file)}
    return {"action": "run", "task": token, "resume": False}


def open_attempt(state):
    """上次未闭合的 attempt（crash 恢复入口）。"""
    attempt = state.get("open_attempt")
    return attempt if isinstance(attempt, dict) else None


def render_report(root, state, plan, rounds_done, stop_reason, next_action=None):
    lines = [
        "# Unattended Runner stopped",
        "",
        "- stop_reason: " + str(stop_reason),
        "- phase: " + str(state.get("current_phase") or "?"),
        "- task: " + str(state.get("current_task") or "(none)"),
        "- rounds_done: " + str(rounds_done),
        "- logs: " + str(Path(root) / "logs" / "runner"),
        "",
        "## What you need to do",
        "",
        next_action or "检查 logs/runner/ 后决定是否继续；删除 logs/runner/STOP 可恢复自动执行。",
    ]
    return N.join(lines) + N


def dry_run(root, state, plan):
    print("== unattended runner dry-run ==")
    print("project_root: " + str(root))
    print("current_phase: " + str(state.get("current_phase")))
    print("current_task: " + (str(state.get("current_task")) or "(empty)"))
    print("status: " + str(state.get("status")))
    print("human_review: " + str(state.get("human_review") or "(none)"))
    print("auto_continue: " + str(state.get("auto_continue")))
    print("next_task: " + str(state.get("next_task")))
    print("decision: " + plan["action"] + (" —— " + plan["reason"] if plan.get("reason") else ""))
    if plan.get("task"):
        print("task_id: " + plan["task"])
    print("would_spawn: " + ("yes" if plan["action"] in ("run", "create_task") else "no"))
    return EXIT_OK


DEFAULT_GATES = [
    ["npm", "test"],
    ["python3", "scripts/apo_state.py"],
]


def git_head(root):
    out = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(root), capture_output=True, text=True)
    return out.stdout.strip() if out.returncode == 0 else None


def git_dirty(root):
    out = subprocess.run(["git", "status", "--porcelain"], cwd=str(root), capture_output=True, text=True)
    return out.stdout.strip() if out.returncode == 0 else None


def run_gates(root, gates, timeout=900, log_path=None):
    """三层证据的第 ② 层：仓库自身的机器门禁（权威，不采信 Agent 自述）。"""
    results, ok = {}, True
    for argv in gates:
        name = " ".join(argv)
        try:
            proc = subprocess.run(argv, cwd=str(root), capture_output=True, text=True, timeout=timeout)
            passed = proc.returncode == 0
            tail = (proc.stdout.strip().splitlines() or [""])[-1][:200]
            entry = {"exit": proc.returncode, "ok": passed, "tail": tail}
        except subprocess.TimeoutExpired:
            passed, entry = False, {"exit": None, "ok": False, "tail": "gate timeout"}
        results[name] = entry
        ok = ok and passed
    if log_path:
        with open(log_path, "a", encoding="utf-8") as handle:
            handle.write("--- gates ---" + N + json.dumps(results, ensure_ascii=False, indent=1) + N)
    return {"ok": ok, "results": results}


def decide_after_attempt(attempt, gates, head_before, head_after):
    """三层证据合并成一个决定；返回 (decision, stop_reason) —— decision ∈ success/retry/stop。"""
    if attempt.get("timed_out"):
        return "retry", "attempt timeout"
    if attempt.get("transport_exhausted"):
        return "stop", "transport exhausted"
    if attempt.get("exit_code") != 0:
        return "retry", "agent exit=" + str(attempt.get("exit_code"))
    if attempt.get("turn_end_reason") != "completed":
        return "retry", "turn_end_reason=" + str(attempt.get("turn_end_reason"))
    if not gates.get("ok"):
        failed = [k for k, v in gates.get("results", {}).items() if not v.get("ok")]
        return "retry", "gate failed: " + "; ".join(failed)
    if head_before and head_after and head_before == head_after:
        return "retry", "no progress: HEAD 未推进（Agent 声称完成但未提交）"
    return "success", None


STOP_REQUESTED = {"flag": False, "signal": None}


def _signal_handler(signum, _frame):
    """SIGTERM/SIGINT：只置 flag —— **不粗暴截断当前轮**，由循环在安全边界退出。"""
    STOP_REQUESTED["flag"] = True
    STOP_REQUESTED["signal"] = signum


def install_signal_handlers():
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _signal_handler)
        except Exception:  # noqa: BLE001
            pass


def notify(title, message, notify_cmd=None):
    """macOS 通知；**只在真正停止时调用**。notify_cmd 供测试注入。"""
    if notify_cmd:
        argv = [notify_cmd, title, message]
    else:
        argv = ["osascript", "-e",
                'display notification "' + message.replace('"', "'")
                + '" with title "' + title.replace('"', "'") + '" sound name "Basso"']
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=30)
        return {"ok": proc.returncode == 0, "argv": argv[:2], "stderr": proc.stderr.strip()[:200]}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "argv": argv[:2], "stderr": str(exc)[:200]}


def notify_stop(root, ledger, state, stop_reason, phase, task, attempt, rounds_done, notify_cmd=None):
    logs = Path(root) / "logs" / "runner"
    report = render_report(root, state, {"action": "stopped"}, rounds_done, stop_reason,
                           next_action="查看 " + str(logs) + "；处理后可删除 " + str(logs / "STOP")
                           + " 再启动 Runner。")
    ledger.write_stopped(report)
    message = ("stop_reason=" + str(stop_reason) + "｜phase=" + str(phase) + "｜task=" + str(task)
               + "｜attempt=" + str(attempt) + "｜日志: " + str(logs))
    result = notify("Personal AI Brain 已停止（需你处理）", message, notify_cmd)
    ledger.event("notify", stop_reason=stop_reason, task=task, attempt=attempt, **result)
    return result


def reconcile(root, ledger, state):
    """crash 恢复：上次未闭合的 attempt 一律**不计成功**，并与 git/CURRENT_STATE 三方对账。"""
    previous = ledger.load_state()
    open_attempt = previous.get("open_attempt")
    if not isinstance(open_attempt, dict):
        return {"crashed": False, "reason": "no open attempt"}
    head_now = git_head(root)
    head_before = open_attempt.get("latest_commit_before")
    dirty = git_dirty(root)
    verdict = {
        "crashed": True, "previous_task": open_attempt.get("task"),
        "previous_round": open_attempt.get("round"), "head_before": head_before,
        "head_now": head_now, "dirty": bool(dirty),
        "head_advanced": bool(head_before and head_now and head_before != head_now),
    }
    ledger.event("crashed_attempt", **verdict)
    if dirty:
        verdict["reason"] = "工作区有未提交改动：不自动 commit、不覆盖，交给下一轮 Agent 收尾"
    elif verdict["head_advanced"]:
        verdict["reason"] = "HEAD 已推进但未闭合：按仍待复核处理，不当作已成功"
    else:
        verdict["reason"] = "HEAD 未推进：该 attempt 无产出"
    return verdict


def resolve_dsh():
    """优先 PATH 中的 dsh，否则用 App bundle 内的 CLI（不依赖用户 shell 配置）。"""
    found = shutil.which("dsh")
    if found:
        return [found]
    if Path(DSH_APP_BIN).is_file():
        node = shutil.which("node") or "/usr/local/bin/node"
        return [node, DSH_APP_BIN]
    raise RunnerError("找不到 dsh CLI（PATH 与应用包都没有）")


class RunnerError(RuntimeError):
    pass


def parse_run_events(stdout):
    """解析 headless 的 NDJSON 事件流。"""
    events, session_id, turn_end_reason, final_text = [], None, None, None
    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except Exception:  # noqa: BLE001
            continue
        events.append(obj)
        if obj.get("type") == "session" and obj.get("sessionId"):
            session_id = obj["sessionId"]
        if obj.get("type") == "status" and obj.get("phase") == "turn_end":
            reason = obj.get("reason") or {}
            turn_end_reason = reason.get("kind") or json.dumps(reason, ensure_ascii=False)
        if obj.get("type") == "final":
            final_text = obj.get("text")
    return events, session_id, turn_end_reason, final_text


def count_transport_failures(stdout, stderr):
    """只统计诊断行里的传输失败，而不是 Agent 散文里的同名字符串。

    实测踩坑：Task B 写的运维手册正文里出现了 [TRANSPORT] 字样，
    旧实现按"出现次数"计数 → 把成功的一轮误判为 transport exhausted 并停止。
    无人值守最怕这种自伤式误停，所以判定收窄到"以标记开头的诊断行"。
    """
    count = 0
    for stream in (stderr, stdout):
        for line in (stream or "").splitlines():
            stripped = line.strip()
            if stripped.startswith(TRANSPORT_MARKER) and len(stripped) < 300:
                count += 1
    return count


REQUIRED_PATH_DIRS = ["~/.local/bin", "/usr/local/bin", "/opt/homebrew/bin",
                     "/usr/bin", "/bin", "/usr/sbin", "/sbin"]


def child_env(base=None):
    """给被拉起的 Agent 一个可用的环境。

    **实测踩坑**：launchd 的 PATH 很窄，而 DSH headless 需要按名字找到 node/worker；
    否则它**静默 exit 0、零输出**，看起来像"什么都没做"（曾让 3 次 attempt 白跑）。
    """
    env = dict(os.environ if base is None else base)
    home = env.get("HOME") or str(Path.home())
    parts = [p for p in (env.get("PATH") or "").split(":") if p]
    for wanted in REQUIRED_PATH_DIRS:
        resolved = str(Path(wanted).expanduser()) if wanted.startswith("~") else wanted
        if resolved not in parts:
            parts.append(resolved)
    env["PATH"] = ":".join(parts)
    env["HOME"] = home
    if not env.get("TMPDIR"):
        env["TMPDIR"] = "/tmp"
    env["DSH_PERMISSION_MODE"] = CHILD_PERMISSION_MODE
    return env


def spawn_agent(root, command, prompt, timeout, log_path, env=None):
    """起一轮 Agent；超时按进程组 SIGTERM → 宽限 → SIGKILL。返回 attempt 结论。"""
    started = time.time()
    started_iso = now_iso()
    log_path = Path(log_path)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    argv = list(command) + ["headless", "--json", prompt]
    if env is None:
        env = child_env()
    proc = subprocess.Popen(argv, cwd=str(root), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, start_new_session=True, env=env)
    timed_out = False
    stop_requested = False
    deadline = time.time() + timeout
    while True:
        if STOP_REQUESTED["flag"]:
            stop_requested = True
            break
        remaining = deadline - time.time()
        if remaining <= 0:
            timed_out = True
            break
        try:
            proc.communicate(timeout=min(5, remaining))
            break
        except subprocess.TimeoutExpired:
            continue
    if timed_out or stop_requested:
        # 优雅停止：先 SIGTERM 让当前轮收尾，宽限后再 SIGKILL（超时同理）
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except Exception:  # noqa: BLE001
            pass
        try:
            out, err = proc.communicate(timeout=KILL_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception:  # noqa: BLE001
                pass
            out, err = proc.communicate()
    else:
        out, err = proc.communicate()
    duration = round(time.time() - started, 1)
    with open(log_path, "a", encoding="utf-8") as handle:
        handle.write("=== attempt pid=" + str(proc.pid) + " exit=" + str(proc.returncode)
                     + " timed_out=" + str(timed_out) + " ts=" + started_iso + " ===" + N)
        handle.write("--- stdout ---" + N + (out or "") + N + "--- stderr ---" + N + (err or "") + N)
    events, session_id, turn_end_reason, final_text = parse_run_events(out or "")
    transport = count_transport_failures(out or "", err or "")
    return {
        "pid": proc.pid, "exit_code": proc.returncode, "timed_out": timed_out,
        "duration": duration, "start_time": started_iso, "end_time": now_iso(),
        "agent_session_id": session_id, "turn_end_reason": turn_end_reason,
        "final_text": final_text, "events": len(events),
        "transport_failures": transport, "transport_exhausted": transport >= 2,
        "stop_requested": stop_requested, "log": str(log_path),
    }


def finish(root, ledger, state, stop_reason, rounds_done, args, phase=None, task=None, attempt=0,
           notify_cmd=None):
    ledger.save_state({"rounds_done": rounds_done, "stop_reason": stop_reason,
                       "open_attempt": None, "finished_at": now_iso()})
    ledger.save_current({"ts": now_iso(), "phase": phase or state.get("current_phase"),
                         "task": task, "round": rounds_done, "attempt": attempt,
                         "stop_reason": stop_reason})
    notify_stop(root, ledger, state, stop_reason, phase or state.get("current_phase"), task, attempt,
                rounds_done, notify_cmd)
    print("STOP: " + str(stop_reason))
    return EXIT_STOPPED


def run_loop(root, logs_dir, args, command, state):
    """T05.4/T05.5/T05.6 主循环：拉起 → 复核 → 记账 → 决定继续/停止。"""
    ledger = Ledger(logs_dir)
    recon = reconcile(root, ledger, state)
    ledger.event("reconcile", **recon)
    if recon["crashed"]:
        print("resume: 上次未闭合 attempt -> " + str(recon.get("reason")))
    rounds_done = 0
    for rnd in range(1, args.max_rounds + 1):
        if STOP_REQUESTED["flag"]:
            return finish(root, ledger, state, "graceful stop (signal "
                          + str(STOP_REQUESTED["signal"]) + ")", rounds_done, args, None, None, 0,
                          args.notify_cmd)
        state = read_control_state(root)
        plan = resolve_next(root, state, logs_dir / "STOP")
        if plan["action"] in ("stopped", "idle"):
            reason = plan.get("reason") or plan["action"]
            return finish(root, ledger, state, reason, rounds_done, args, state.get("current_phase"),
                          None, 0, args.notify_cmd)
        task = plan["task"]
        phase = state.get("current_phase")
        prompt = (START_PROMPT + N + "本轮目标 Task：" + task
                  + N + "（若该 Task 文件不存在，请先按 ROADMAP 创建它，再执行。）")
        ledger.save_current({"ts": now_iso(), "phase": phase, "task": task, "round": rnd,
                             "attempt": 0, "state": "spawning"})
        reason = None
        for attempt in range(1, args.max_attempts + 1):
            head_before = git_head(root)
            open_record = attempt_record(rnd, phase, task, attempt, latest_commit_before=head_before,
                                        next_task=state.get("next_task"), decision="running")
            ledger.save_state({"round": rnd, "open_attempt": open_record, "rounds_done": rounds_done})
            ledger.event("attempt_start", round=rnd, task=task, attempt=attempt, head_before=head_before)
            attempt_result = spawn_agent(root, command, prompt, args.round_timeout,
                                        logs_dir / "attempts.log")
            ledger.event("attempt_end", round=rnd, task=task, attempt=attempt,
                         **{k: v for k, v in attempt_result.items() if k != "events"})
            if attempt_result.get("stop_requested"):
                record = attempt_record(rnd, phase, task, attempt,
                                        session_id=attempt_result["agent_session_id"],
                                        pid=attempt_result["pid"],
                                        start_time=attempt_result["start_time"],
                                        end_time=attempt_result["end_time"],
                                        duration=attempt_result["duration"],
                                        exit_code=attempt_result["exit_code"],
                                        turn_end_reason=attempt_result["turn_end_reason"],
                                        git_before=head_before, latest_commit_before=head_before,
                                        next_task=state.get("next_task"),
                                        decision="aborted", stop_reason="graceful stop")
                ledger.event("attempt_record", **record)
                return finish(root, ledger, state, "graceful stop (signal "
                              + str(STOP_REQUESTED["signal"]) + ") during round " + str(rnd),
                              rounds_done, args, phase, task, attempt, args.notify_cmd)
            gates = run_gates(root, args.gates, log_path=logs_dir / "gates.log")
            head_after = git_head(root)
            decision, reason = decide_after_attempt(attempt_result, gates, head_before, head_after)
            record = attempt_record(rnd, phase, task, attempt,
                                    session_id=attempt_result["agent_session_id"],
                                    pid=attempt_result["pid"],
                                    start_time=attempt_result["start_time"],
                                    end_time=attempt_result["end_time"],
                                    duration=attempt_result["duration"],
                                    exit_code=attempt_result["exit_code"],
                                    turn_end_reason=attempt_result["turn_end_reason"],
                                    gate_results=gates["results"],
                                    git_before=head_before, git_after=head_after,
                                    latest_commit_before=head_before,
                                    latest_commit_after=head_after,
                                    next_task=read_control_state(root).get("next_task"),
                                    decision=decision, stop_reason=reason)
            ledger.event("attempt_record", **record)
            ledger.save_state({"round": rnd, "rounds_done": rounds_done, "open_attempt": None
                              if decision == "success" else open_record})
            if decision == "success":
                rounds_done += 1
                print("round " + str(rnd) + " SUCCESS: " + task + " -> "
                      + str(record["next_task"]))
                break
            if decision == "stop":
                return finish(root, ledger, state, reason, rounds_done, args, phase, task, attempt,
                              args.notify_cmd)
            print("round " + str(rnd) + " attempt " + str(attempt) + " retry: " + str(reason))
        else:
            return finish(root, ledger, state, "retry exhausted: " + str(reason), rounds_done, args,
                          phase, task, args.max_attempts, args.notify_cmd)
    return finish(root, ledger, state, "max_rounds reached (" + str(args.max_rounds) + ")",
                  rounds_done, args, None, None, 0, args.notify_cmd)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", default=str(HERE.parent))
    parser.add_argument("--logs-dir", default=None)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--dsh-cmd", default=None, help="覆盖 dsh 命令（测试注入用）")
    parser.add_argument("--dsh-profile", default=DEFAULT_PROFILE)
    parser.add_argument("--spawn", action="store_true", help="T05.2: 起一轮 Agent 并记录")
    parser.add_argument("--run", action="store_true", help="T05.4+: 进入轮次循环")
    parser.add_argument("--gate", action="append", default=None,
                        help="覆盖门禁命令（可重复；默认三层真实门禁）")
    parser.add_argument("--reconcile-only", action="store_true")
    parser.add_argument("--notify-cmd", default=None)
    parser.add_argument("--prompt", default=None)
    parser.add_argument("--max-rounds", type=int, default=DEFAULT_MAX_ROUNDS)
    parser.add_argument("--round-timeout", type=int, default=DEFAULT_ROUND_TIMEOUT)
    parser.add_argument("--max-attempts", type=int, default=DEFAULT_MAX_ATTEMPTS)
    parser.add_argument("--stop-file", default=None)
    args = parser.parse_args(argv)

    root = Path(args.project_root).resolve()
    logs_dir = Path(args.logs_dir) if args.logs_dir else (root / "logs" / "runner")
    state = read_control_state(root)
    plan = resolve_next(root, state, logs_dir / "STOP")

    if args.stop_file:
        Path(args.stop_file).write_text("stop requested" + N, encoding="utf-8")

    if args.dry_run:
        return dry_run(root, state, plan)

    lock = RunnerLock(logs_dir)
    try:
        lock.acquire()
    except Locked as exc:
        print("Runner already active")
        print("lock holder PID: " + str(exc.holder_pid))
        print("state: " + str(exc.state_path))
        print("current: " + str(exc.current_path))
        return EXIT_LOCKED

    ledger = Ledger(logs_dir)
    try:
        ledger.event("start", pid=os.getpid(), plan=plan, phase=state.get("current_phase"),
                     task=state.get("current_task") or None)
        ledger.save_current({"ts": now_iso(), "phase": state.get("current_phase"),
                             "task": state.get("current_task") or None, "round": 0,
                             "plan": plan, "pid": os.getpid()})
        if plan["action"] in ("stopped", "idle") and not args.run:
            # 统一走 finish()：写 STOPPED.md + 发通知 + 打印（**实测踩坑**：
            # 曾因这里自行拼一套收尾，导致用户 STOP 不通知、stdout 无输出）
            reason = plan.get("reason") or plan["action"]
            ledger.event("stop", reason=reason)
            return finish(Path(args.project_root).resolve(), ledger, state, reason, 0, args,
                          state.get("current_phase"), None, 0, args.notify_cmd)
        ledger.event("planned", action=plan["action"], task=plan.get("task"))
        install_signal_handlers()
        args.gates = [g.split() for g in args.gate] if args.gate else DEFAULT_GATES
        if args.reconcile_only:
            recon = reconcile(Path(args.project_root).resolve(), ledger, state)
            print(json.dumps(recon, ensure_ascii=False, indent=1))
            return EXIT_OK
        if args.run:
            command = [args.dsh_cmd] if args.dsh_cmd else resolve_dsh()
            return run_loop(Path(args.project_root).resolve(), logs_dir, args, command, state)
        if not args.spawn:
            print("plan: " + json.dumps(plan, ensure_ascii=False))
            return EXIT_OK
        # ---- T05.2：起一轮 Agent（round loop / gate / retry 在 T05.3+）----
        command = ([args.dsh_cmd] if args.dsh_cmd else resolve_dsh())
        if args.dsh_cmd is None and args.dsh_profile:
            command = command  # profile 通过 headless 的默认 profile 生效（见 --dsh-profile 说明）
        prompt = args.prompt or START_PROMPT
        log_path = logs_dir / "attempts.log"
        attempt = spawn_agent(root, command, prompt, args.round_timeout, log_path)
        ledger.event("attempt", round=1, task=plan.get("task"), **{k: v for k, v in attempt.items()
                                                                   if k != "events"})
        record = attempt_record(1, state.get("current_phase"), plan.get("task"), 1,
                                session_id=attempt["agent_session_id"], pid=attempt["pid"],
                                start_time=attempt["start_time"], end_time=attempt["end_time"],
                                duration=attempt["duration"], exit_code=attempt["exit_code"],
                                turn_end_reason=attempt["turn_end_reason"],
                                latest_commit_before=None, latest_commit_after=None,
                                next_task=state.get("next_task"), decision="spawned")
        ledger.save_state({"round": 1, "open_attempt": record})
        print(json.dumps({k: v for k, v in attempt.items() if k != "events"},
                         ensure_ascii=False, indent=1))
        return EXIT_OK
    finally:
        ledger.event("exit", pid=os.getpid())
        lock.release()


if __name__ == "__main__":
    sys.exit(main())
