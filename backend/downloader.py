"""模组下载、依赖递归解析与任务队列管理

核心逻辑：
- 同一时间仅执行一个下载任务，其余任务进入队列排队（FIFO）
- 队列中的任务支持 暂停 / 继续 / 停止 / 删除 控制
- 根据目标 MC 版本与加载器，向 Modrinth 查询适配版本并下载
- 递归识别 required 强制前置依赖并自动下载（optional 可选依赖忽略）
- 使用 processed 集合去重，防止循环依赖死循环
- 下载后校验 sha512，损坏自动重试
- 不存在适配新版本的模组标记缺失，导出缺失清单文本
"""
import asyncio
import hashlib
import json
import time
from datetime import datetime
from pathlib import Path

from .modrinth_client import ModrinthClient, ModrinthError
from .curseforge_client import CurseForgeClient, CurseForgeError
from .scanner import compute_sha512
from .settings import Settings, get_settings

# 下载失败重试次数
DOWNLOAD_RETRIES = 3
# 日志条数上限，超出后裁剪旧日志
MAX_LOGS = 1500
# 网速计算的最小采样间隔（秒）
SPEED_SAMPLE_INTERVAL = 0.3


class TaskStopped(Exception):
    """任务被用户主动停止"""


def _format_speed(bytes_per_sec):
    """将字节/秒格式化为易读字符串"""
    if not bytes_per_sec or bytes_per_sec <= 0:
        return "0 B/s"
    units = ["B/s", "KB/s", "MB/s", "GB/s"]
    idx = 0
    speed = float(bytes_per_sec)
    while speed >= 1024 and idx < len(units) - 1:
        speed /= 1024
        idx += 1
    return f"{speed:.1f} {units[idx]}"


class TaskGate:
    """下载任务门控：暂停 / 继续 / 停止（协作式检查）

    下载循环在每个项目/文件边界调用 check()，
    暂停时挂起等待，停止时抛出 TaskStopped 中止任务。
    """

    def __init__(self):
        self._pause_event = asyncio.Event()
        self._pause_event.set()
        self._stop_flag = False

    def pause(self):
        self._pause_event.clear()

    def resume(self):
        self._pause_event.set()

    def stop(self):
        self._stop_flag = True
        self._pause_event.set()  # 唤醒可能正挂起的暂停等待

    async def check(self):
        """在每个检查点调用；暂停则等待，停止则抛异常"""
        if self._stop_flag:
            raise TaskStopped()
        if not self._pause_event.is_set():
            await self._pause_event.wait()
        if self._stop_flag:
            raise TaskStopped()


class TaskState:
    """单个下载任务的状态快照，供 /api/task_status 与 /api/queue 轮询返回"""

    def __init__(self, task_id, kind):
        self.task_id = task_id
        self.kind = kind  # "batch" / "single"
        self.status = "pending"  # pending / running / paused / stopped / completed / failed
        self.logs = []  # [{time, level, msg}]
        self.success = []  # [{project_id, name, filename}]
        self.failed = []  # [{project_id, name, reason}]
        self.missing = []  # [{project_id, name, mc_version, loader}]
        self.total = 0  # 待处理项目总数
        self.done = 0  # 已处理项目数
        self.current_file = ""  # 当前正在下载的文件名
        self.progress_done = 0  # 当前文件已下载字节
        self.progress_total = 0  # 当前文件总字节
        self.speed_text = "0 B/s"  # 当前下载瞬时网速
        self.skipped_count = 0  # 已存在且校验通过、跳过下载的数量
        self.mc_version = ""  # 目标游戏版本
        self.loader = ""  # 目标加载器
        self.save_dir = ""  # 保存目录
        self.source = ""  # 来源：批量=清单文件路径，单个=project_id
        self.subtask_index = 0  # 当前子任务（单个文件下载）序号
        self._speed_last_time = 0.0  # 网速采样：上次时间戳
        self._speed_last_bytes = 0  # 网速采样：上次已下载字节
        self.started_at = time.time()
        self.finished_at = None

    def add_log(self, msg, level="info"):
        """追加一条日志（自动限制条数）"""
        self.logs.append({
            "time": datetime.now().strftime("%H:%M:%S"),
            "level": level,
            "msg": msg,
        })
        if len(self.logs) > MAX_LOGS:
            self.logs = self.logs[-(MAX_LOGS // 2):]

    def add_success(self, pid, name, filename):
        self.success.append({"project_id": pid, "name": name, "filename": filename})

    def add_fail(self, pid, name, reason):
        self.failed.append({"project_id": pid, "name": name, "reason": reason})

    def add_missing(self, pid, name, mc, loader, reason=""):
        self.missing.append({
            "project_id": pid, "name": name,
            "mc_version": mc, "loader": loader, "reason": reason,
        })

    def add_skip(self, pid, name, filename):
        """记录已存在且校验通过、跳过下载的模组"""
        self.skipped_count += 1
        self.success.append({
            "project_id": pid, "name": name,
            "filename": filename, "skipped": True,
        })

    def set_current(self, filename):
        self.current_file = filename
        self.progress_done = 0
        self.progress_total = 0
        self.speed_text = "0 B/s"
        self.subtask_index += 1
        # 切换文件时重置网速采样基准
        self._speed_last_time = 0.0
        self._speed_last_bytes = 0

    def update_progress(self, done, total):
        """更新下载进度并计算瞬时网速"""
        self.progress_done = done
        self.progress_total = total
        now = time.monotonic()
        if self._speed_last_time == 0.0:
            self._speed_last_time = now
            self._speed_last_bytes = done
            return
        elapsed = now - self._speed_last_time
        if elapsed >= SPEED_SAMPLE_INTERVAL:
            delta = done - self._speed_last_bytes
            bps = delta / elapsed if elapsed > 0 else 0
            self.speed_text = _format_speed(bps)
            self._speed_last_time = now
            self._speed_last_bytes = done

    @classmethod
    def from_dict(cls, d):
        """从持久化快照重建任务状态（用于重启后恢复未完成任务）

        恢复后的任务统一置为 pending，由队列调度重新排队执行；
        .part 断点续传 + 已存在文件哈希校验保证不会重复下载。
        """
        st = cls(d.get("task_id") or "", d.get("kind") or "single")
        st.status = "pending"
        st.logs = d.get("logs") or []
        st.success = d.get("success") or []
        st.failed = d.get("failed") or []
        st.missing = d.get("missing") or []
        st.total = d.get("total") or 0
        st.done = d.get("done") or 0
        st.current_file = d.get("current_file") or ""
        st.progress_done = d.get("progress_done") or 0
        st.progress_total = d.get("progress_total") or 0
        st.speed_text = d.get("speed_text") or "0 B/s"
        st.skipped_count = d.get("skipped_count") or 0
        st.mc_version = d.get("mc_version") or ""
        st.loader = d.get("loader") or ""
        st.save_dir = d.get("save_dir") or ""
        st.source = d.get("source") or ""
        st.subtask_index = d.get("subtask_index") or 0
        st.started_at = d.get("started_at") or time.time()
        st.finished_at = d.get("finished_at")
        return st

    def to_dict(self, position=None, queue_size=None):
        """序列化任务状态（position/queue_size 由队列管理器填充；日志单独通过 /logs 缓存读取）"""
        duration = 0.0
        if self.started_at:
            duration = (self.finished_at or time.time()) - self.started_at
        return {
            "task_id": self.task_id,
            "kind": self.kind,
            "status": self.status,
            "mc_version": self.mc_version,
            "loader": self.loader,
            "save_dir": self.save_dir,
            "source": self.source,
            "position": position,
            "queue_size": queue_size,
            "total": self.total,
            "done": self.done,
            "current_file": self.current_file,
            "subtask_index": self.subtask_index,
            "progress_done": self.progress_done,
            "progress_total": self.progress_total,
            "speed_text": self.speed_text,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "duration": round(duration, 1),
            "success_count": len(self.success),
            "failed_count": len(self.failed),
            "missing_count": len(self.missing),
            "skipped_count": self.skipped_count,
            "success": self.success,
            "failed": self.failed,
            "missing": self.missing,
        }


class _TaskEntry:
    """任务队列条目：状态 + 门控 + 底层 asyncio 任务"""

    def __init__(self, tid, kind, run_factory, params=None):
        self.task_id = tid
        self.kind = kind
        self.run_factory = run_factory  # callable(gate) -> coroutine
        self.params = params or {}  # 重建 run_factory 所需的参数（断点恢复用）
        self.state = TaskState(tid, kind)
        self.gate = TaskGate()
        self.async_task = None  # asyncio.Task


class TaskManager:
    """全局下载任务队列管理器

    - 同一时间仅一个任务处于 running / paused，其余 pending 排队
    - 支持暂停 / 继续 / 停止 / 删除
    - 终态任务（completed/failed/stopped）移入历史，持久化到 cache/temp，
      日志缓存到 cache/logs，重启后可继续查看与结算
    """

    def __init__(self):
        self.tasks = {}  # task_id -> _TaskEntry（进行中/排队）
        self.queue = []  # 有序 task_id（仅进行中任务）
        self.history_map = {}  # task_id -> {"task_id", "state": dict, "logs": [...]}（终态任务）
        self.history_order = []  # 最近完成的在前
        self._counter = 0
        self._lock = asyncio.Lock()
        root = Path(__file__).resolve().parent.parent
        self._temp_dir = root / "cache" / "temp"
        self._logs_dir = root / "cache" / "logs"
        self.settings = get_settings()
        self._load_history()

    # ---------- 持久化 ----------

    def _load_history(self):
        try:
            path = self._temp_dir / "tasks.json"
            if path.is_file():
                data = json.loads(path.read_text(encoding="utf-8"))
                for h in (data.get("history") or []):
                    tid = h.get("task_id")
                    if tid and tid not in self.history_map:
                        self.history_map[tid] = h
                        self.history_order.append(tid)
        except (OSError, json.JSONDecodeError):
            pass

    def _persist(self):
        try:
            self._temp_dir.mkdir(parents=True, exist_ok=True)
            data = {"history": [self.history_map[tid] for tid in self.history_order]}
            (self._temp_dir / "tasks.json").write_text(
                json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError:
            pass

    def _persist_active(self):
        """持久化进行中任务（含重建参数），供重启后断点恢复

        写入 cache/temp/active.json；每次任务状态变化时调用。
        """
        try:
            self._temp_dir.mkdir(parents=True, exist_ok=True)
            data = {"tasks": [{
                "task_id": e.task_id,
                "kind": e.kind,
                "params": e.params,
                "state": {**e.state.to_dict(), "logs": e.state.logs},
            } for e in self.tasks.values()]}
            (self._temp_dir / "active.json").write_text(
                json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError:
            pass

    def _write_log_file(self, task_id, logs):
        try:
            self._logs_dir.mkdir(parents=True, exist_ok=True)
            (self._logs_dir / f"{task_id}.log").write_text(
                self.format_logs(logs), encoding="utf-8")
        except OSError:
            pass

    @staticmethod
    def format_logs(logs):
        lines = [f"[{lg.get('time', '')}] [{lg.get('level', 'info')}] {lg.get('msg', '')}"
                 for lg in (logs or [])]
        return "\n".join(lines) + ("\n" if lines else "")

    def get_logs(self, task_id):
        """读取任务日志：进行中任务读内存，终态任务读历史缓存"""
        entry = self.tasks.get(task_id)
        if entry:
            return entry.state.logs
        h = self.history_map.get(task_id)
        if h:
            return h.get("logs") or []
        return None

    # ---------- 创建 / 查询 ----------

    async def create(self, kind, run_factory, params=None):
        """创建任务并入队；若队列空闲则立即启动"""
        async with self._lock:
            self._counter += 1
            tid = f"task_{int(time.time())}_{self._counter}"
            entry = _TaskEntry(tid, kind, run_factory, params)
            self.tasks[tid] = entry
            self.queue.append(tid)
            self._advance()
            self._persist_active()
            return tid, entry.state

    async def resume_active(self, factory_builder):
        """重启后恢复上次未完成的任务（断点恢复）

        :param factory_builder: callable(kind, params, state) -> run_factory，
                                由调用方（api.py）根据 params 重建下载闭包
        :return: 恢复的任务数量
        """
        active_path = self._temp_dir / "active.json"
        if not active_path.is_file():
            return 0
        try:
            data = json.loads(active_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return 0
        async with self._lock:
            count = 0
            for a in (data.get("tasks") or []):
                tid = a.get("task_id")
                if not tid or tid in self.tasks:
                    continue
                kind = a.get("kind") or "single"
                params = a.get("params") or {}
                state = TaskState.from_dict(a.get("state") or {})
                state.add_log("[恢复] 检测到上次未完成的任务，已自动恢复排队执行", "warn")
                entry = _TaskEntry(tid, kind, factory_builder(kind, params, state), params)
                entry.state = state
                self.tasks[tid] = entry
                self.queue.append(tid)
                count += 1
            self._advance()
            self._persist_active()
            return count

    def get(self, task_id):
        return self.tasks.get(task_id)

    def latest(self):
        """获取最近创建的任务"""
        if not self.queue:
            return None
        return self.tasks.get(self.queue[-1])

    def list(self):
        """返回进行中队列全部任务的状态列表（按队列顺序）"""
        result = []
        size = len(self.queue)
        for i, tid in enumerate(self.queue):
            entry = self.tasks.get(tid)
            if not entry:
                continue
            result.append(entry.state.to_dict(position=i + 1, queue_size=size))
        return result

    def history(self):
        """返回终态任务历史列表（最近完成的在前）"""
        result = []
        for tid in self.history_order:
            h = self.history_map.get(tid)
            if h:
                result.append(dict(h["state"]))
        return result

    def clear_history(self):
        """清空终态任务历史及对应日志文件，返回清理条数"""
        removed = len(self.history_order)
        tids = list(self.history_order)
        self.history_map.clear()
        self.history_order.clear()
        self._persist()
        for tid in tids:
            try:
                (self._logs_dir / f"{tid}.log").unlink(missing_ok=True)
            except OSError:
                pass
        return removed

    # ---------- 队列调度 ----------

    def _current(self):
        """当前占用执行槽的任务列表（running / paused）"""
        return [self.tasks[tid] for tid in self.queue
                if tid in self.tasks and self.tasks[tid].state.status in ("running", "paused")]

    def _next_pending(self):
        for tid in self.queue:
            entry = self.tasks.get(tid)
            if entry and entry.state.status == "pending":
                return entry
        return None

    def _advance(self):
        """按设置的最大并发数，启动尽可能多的 pending 任务"""
        limit = self.settings.max_concurrency()
        while len(self._current()) < limit:
            nxt = self._next_pending()
            if not nxt:
                return
            self._start(nxt)

    def _start(self, entry):
        entry.state.status = "running"
        entry.state.started_at = time.time()
        entry.gate = TaskGate()
        entry.async_task = asyncio.create_task(self._run(entry))
        self._persist_active()

    async def _run(self, entry):
        """任务执行包装：捕获停止/取消/异常，统一收尾并推进队列"""
        try:
            await entry.run_factory(entry.gate)
        except TaskStopped:
            entry.state.status = "stopped"
            entry.state.finished_at = time.time()
        except asyncio.CancelledError:
            entry.state.status = "stopped"
            entry.state.finished_at = time.time()
        except Exception as e:
            entry.state.status = "failed"
            entry.state.finished_at = time.time()
            entry.state.add_log(f"[失败] 任务异常终止: {e}", "error")
        finally:
            entry.async_task = None
            self._finalize(entry)
            self._advance()

    def _finalize(self, entry):
        """任务进入终态：写日志缓存、移入历史并从活动任务表移除"""
        if entry.task_id not in self.tasks:
            return  # 任务已被删除
        if entry.task_id in self.queue:
            self.queue.remove(entry.task_id)
        self.history_map[entry.task_id] = {
            "task_id": entry.task_id,
            "state": entry.state.to_dict(),
            "logs": entry.state.logs,
        }
        if entry.task_id not in self.history_order:
            self.history_order.insert(0, entry.task_id)
        self._write_log_file(entry.task_id, entry.state.logs)
        self.tasks.pop(entry.task_id, None)
        self._persist()
        self._persist_active()

    def history_entry(self, task_id):
        """获取终态任务的历史记录 dict（含 state 与 logs）"""
        return self.history_map.get(task_id)

    # ---------- 用户控制 ----------

    def pause(self, task_id):
        """暂停任务（仅 running 可暂停）"""
        entry = self.tasks.get(task_id)
        if not entry or entry.state.status != "running":
            return False
        entry.gate.pause()
        entry.state.status = "paused"
        entry.state.add_log("[暂停] 任务已暂停，将在当前文件结束后挂起", "warn")
        self._persist_active()
        return True

    def resume(self, task_id):
        """继续执行被暂停的任务"""
        entry = self.tasks.get(task_id)
        if not entry or entry.state.status != "paused":
            return False
        entry.gate.resume()
        entry.state.status = "running"
        entry.state.add_log("[继续] 任务恢复执行", "success")
        self._persist_active()
        return True

    def stop(self, task_id):
        """停止任务（running / paused / pending 均可）

        停止后任务移入"已完成"历史，不再自动执行，需删除则通过 delete。
        """
        entry = self.tasks.get(task_id)
        if not entry:
            return False
        st = entry.state.status
        if st not in ("running", "paused", "pending"):
            return False
        entry.gate.stop()
        entry.state.status = "stopped"
        entry.state.finished_at = time.time()
        entry.state.add_log("[停止] 任务已被用户停止", "warn")
        if entry.async_task and not entry.async_task.done():
            entry.async_task.cancel()
        else:
            # 排队中（从未启动）的任务，直接收尾进历史
            self._finalize(entry)
        self._persist_active()
        return True

    def delete(self, task_id):
        """删除任务：进行中任务停止后移除；终态任务从历史移除"""
        entry = self.tasks.get(task_id)
        if entry:
            if entry.state.status in ("running", "paused"):
                entry.gate.stop()
                if entry.async_task and not entry.async_task.done():
                    entry.async_task.cancel()
            if task_id in self.queue:
                self.queue.remove(task_id)
            self.tasks.pop(task_id, None)
            self._persist()
            self._persist_active()
            return True
        if task_id in self.history_map:
            self.history_map.pop(task_id, None)
            if task_id in self.history_order:
                self.history_order.remove(task_id)
            self._persist()
            return True
        return False


# ==================== 下载核心逻辑 ====================

def _pick_best_version(versions, mc_version, loader):
    """从版本列表中挑选适配目标游戏版本与加载器的最佳版本

    Modrinth /project/{id}/version 默认按发布时间降序返回，
    因此首个同时满足 game_versions 与 loaders 的版本即为最新可用版本。

    :return: (version, reason) 找不到时 version 为 None，reason 说明原因
    """
    for v in versions or []:
        if mc_version in (v.get("game_versions") or []):
            if loader in (v.get("loaders") or []):
                return v, None
    versions = versions or []
    if not versions:
        return None, "未知错误（无版本信息）"
    has_mc = any(mc_version in (v.get("game_versions") or []) for v in versions)
    if not has_mc:
        return None, "无此游戏版本适配"
    return None, "无此加载器适配"


def _classify_error(e):
    """将异常归类为面向用户的失败原因"""
    s = str(e)
    low = s.lower()
    if any(k in low for k in (
            "下载中断", "请求", "网络", "超时", "timeout",
            "connect", "connection", "read error", "eof")):
        return "网络错误"
    if "哈希" in s or "sha" in low or "校验失败" in s or "校验" in s:
        return "文件校验失败"
    return "未知错误"


class MultiSourceError(Exception):
    """聚合多源错误：当 auto 模式下两个源都失败时抛出，含各源的信息"""


def _pick_primary_from_version(version):
    """从 version 字典中提取主文件信息（兼容 Modrinth 和 CurseForge 归一化结构）

    返回 dict: {filename, download_url, sha512(或None), sha1(或None), murmur2(或None)}
    """
    # Modrinth 版本的 files
    files = version.get("files") or []
    if files:
        primary = next((f for f in files if f.get("primary")), files[0])
        hashes = primary.get("hashes") or {}
        return {
            "filename": primary.get("filename"),
            "download_url": primary.get("url"),
            "sha512": hashes.get("sha512"),
            "sha1": hashes.get("sha1"),
            "murmur2": hashes.get("murmur2"),
        }
    # CurseForge 归一化版本（顶层直接有 filename/download_url/hashes）
    hashes = version.get("hashes") or {}
    return {
        "filename": version.get("filename"),
        "download_url": version.get("download_url"),
        "sha512": hashes.get("sha512"),
        "sha1": hashes.get("sha1"),
        "murmur2": hashes.get("murmur2"),
    }


def _best_hash_for_existing_check(pf):
    """选最可靠的哈希来做已存在文件校验（优先 sha512，其次 sha1，否则 murmur2）"""
    if pf.get("sha512"):
        return "sha512", pf["sha512"]
    if pf.get("sha1"):
        return "sha1", pf["sha1"]
    if pf.get("murmur2"):
        return "murmur2", pf["murmur2"]
    return None, None


def _compute_local_hash(dest_path, algo):
    """本地计算指定算法哈希（sha512 / sha1 / murmur2）"""
    try:
        if algo == "sha512":
            return compute_sha512(dest_path)
        if algo == "sha1":
            h = hashlib.sha1()
            with open(dest_path, "rb") as f:
                for chunk in iter(lambda: f.read(65536), b""):
                    h.update(chunk)
            return h.hexdigest()
        if algo == "murmur2":
            from .curseforge_client import compute_cf_murmur2
            return compute_cf_murmur2(dest_path)
    except OSError:
        return None
    return None


async def _resolve_and_download(mr_client, cf_client, project_id, mc_version, loader, save_dir,
                                processed, task_state, gate, depth=0, force_source=None):
    """递归解析并下载模组及其 required 依赖（多源版本）

    :param mr_client: ModrinthClient
    :param cf_client: CurseForgeClient
    :param force_source: None=按 settings.source 决定；modrinth=强制 Modrinth；
                         curseforge=强制 CurseForge；auto=依次尝试两个源
    """
    await gate.check()
    if project_id in processed:
        return
    processed.add(project_id)

    src_preference = (force_source or get_settings().get().get("source") or "auto").lower()

    indent = "  " * depth
    sources = []  # [(source_name, client, project_id_for_client)]
    # 先判断 project_id 是数字还是 slufigy 字符串：CF 项目 ID 总是纯数字
    if project_id and str(project_id).isdigit():
        if src_preference == "modrinth":
            # 数字 ID 也可能对应 Modrinth（但概率低）；仍按顺序尝试
            sources = [("modrinth", mr_client, project_id)]
        elif src_preference == "curseforge":
            sources = [("curseforge", cf_client, int(project_id))]
        else:  # auto
            # CF 数字 ID 先试 CurseForge，再用 modrinth 兜底
            sources = [
                ("curseforge", cf_client, int(project_id)),
                ("modrinth", mr_client, project_id),
            ]
    else:
        if src_preference == "curseforge":
            sources = [("curseforge", cf_client, project_id)]
        elif src_preference == "modrinth":
            sources = [("modrinth", mr_client, project_id)]
        else:  # auto
            sources = [
                ("modrinth", mr_client, project_id),
                ("curseforge", cf_client, project_id),
            ]

    project_name = project_id
    last_reasons = []
    resolved_any = False

    for src_idx, (src_name, cl, pid) in enumerate(sources):
        try:
            project = await cl.get_project(pid)
        except (ModrinthError, CurseForgeError) as e:
            last_reasons.append(f"[{src_name}] 获取项目失败: {e}")
            continue
        if not project:
            last_reasons.append(f"[{src_name}] 项目不存在 ({pid})")
            continue
        project_name = project.get("title") or project.get("slug") or project_id
        task_state.add_log(f"{indent}[处理] {project_name} ({src_name} · {pid})")

        # 获取版本列表（按 mc_version 过滤，loader 过滤留给 pick_best_version）
        try:
            versions = await cl.get_versions_by_project(pid, [mc_version], None)
        except (ModrinthError, CurseForgeError) as e:
            last_reasons.append(f"[{src_name}] 查询版本失败 {project_name}: {e}")
            continue

        version, miss_reason = _pick_best_version(versions, mc_version, loader)
        if not version:
            # 标记缺失（仅最后一个源）；否则继续下一个源
            if src_idx < len(sources) - 1:
                last_reasons.append(f"[{src_name}] {miss_reason}")
                continue
            task_state.add_log(f"{indent}[缺失] {miss_reason}: {project_name} ({src_name})", "warn")
            task_state.add_missing(project_id, project_name, mc_version, loader, miss_reason)
            return

        # 提取主文件
        pf = _pick_primary_from_version(version)
        if not pf or not pf.get("filename") or not pf.get("download_url"):
            if src_idx < len(sources) - 1:
                last_reasons.append(f"[{src_name}] 无可下载主文件")
                continue
            task_state.add_log(f"{indent}[缺失] 无可下载文件: {project_name} ({src_name})", "warn")
            task_state.add_missing(project_id, project_name, mc_version, loader)
            return

        filename = pf["filename"]
        url = pf["download_url"]
        dest = Path(save_dir) / filename
        task_state.set_current(filename)

        # 已存在文件哈希校验
        algo, expected = _best_hash_for_existing_check(pf)
        if dest.is_file() and algo and expected:
            task_state.add_log(f"{indent}[校验] 已存在 {filename}，计算本地 {algo}...", "info")
            local = _compute_local_hash(dest, algo)
            if local and str(local).lower() == str(expected).lower():
                task_state.add_log(f"{indent}[跳过] {filename} 已存在且校验通过，无需重新下载", "success")
                task_state.add_skip(project_id, project_name, filename)
                await _download_dependencies(mr_client, cf_client, version, src_name, mc_version, loader,
                                             save_dir, processed, task_state, gate, depth, force_source=src_name)
                resolved_any = True
                break
            else:
                task_state.add_log(
                    f"{indent}[覆盖] {filename} {algo} 不一致，删除旧文件重新下载", "warn")
                try:
                    dest.unlink()
                except OSError as e:
                    task_state.add_log(f"{indent}[警告] 删除旧文件失败: {e}", "warn")

        task_state.add_log(f"{indent}[下载] {filename} ({src_name})", "info")

        # 下载并校验，失败自动重试；单源失败不立刻下一个源，只有反复重试都失败才继续
        success = False
        last_err = ""
        for attempt in range(1, DOWNLOAD_RETRIES + 1):
            try:
                async def _prog(done, total):
                    task_state.update_progress(done, total)
                kwargs = {"expected_sha512": pf.get("sha512"),
                          "expected_sha1": pf.get("sha1"),
                          "expected_murmur2": pf.get("murmur2"),
                          "progress_cb": _prog}
                if src_name == "modrinth":
                    # Modrinth 签名只含 expected_sha512 + progress_cb
                    await cl.download_file(url, dest, pf.get("sha512"), _prog)
                else:
                    # CurseForge 签名：sha1, sha512, murmur2, progress_cb
                    await cl.download_file(url, dest, **kwargs)
                task_state.add_log(f"{indent}[成功] {filename}", "success")
                task_state.add_success(project_id, project_name, filename)
                success = True
                break
            except (ModrinthError, CurseForgeError, OSError) as e:
                last_err = str(e)
                task_state.add_log(
                    f"{indent}[重试 {attempt}/{DOWNLOAD_RETRIES}] {filename} ({src_name}): {last_err}", "warn")
                await asyncio.sleep(1.0 * attempt)

        if not success:
            reason = _classify_error(last_err)
            if src_idx < len(sources) - 1:
                last_reasons.append(f"[{src_name}] 下载失败: {last_err}")
                continue
            task_state.add_log(f"{indent}[失败] {filename}: {last_err}", "error")
            task_state.add_fail(project_id, project_name, reason)
            return

        # 递归下载依赖（以当前源为主，避免不同源依赖交叉造成混乱）
        await _download_dependencies(mr_client, cf_client, version, src_name, mc_version, loader,
                                     save_dir, processed, task_state, gate, depth,
                                     force_source=src_name)
        resolved_any = True
        break

    if not resolved_any:
        # 所有源都失败或无匹配
        joined = "; ".join(last_reasons) if last_reasons else "未知原因"
        task_state.add_log(f"{indent}[失败] 所有源解析或下载失败: {project_id} — {joined}", "error")
        task_state.add_fail(project_id, project_name, f"多源失败: {joined}")


async def _download_dependencies(mr_client, cf_client, version, src_name, mc_version, loader,
                                 save_dir, processed, task_state, gate, depth, force_source=None):
    """递归处理 version 的 required 强制前置依赖（多源版本）"""
    indent = "  " * depth
    for dep in version.get("dependencies") or []:
        await gate.check()
        if dep.get("dependency_type") != "required":
            continue
        dep_pid = dep.get("project_id") or dep.get("modId")
        if not dep_pid:
            continue
        if dep_pid in processed:
            continue
        task_state.add_log(f"{indent}  ↳ 前置依赖: {dep_pid} ({src_name}偏好)", "info")
        await _resolve_and_download(
            mr_client, cf_client, dep_pid, mc_version, loader, save_dir,
            processed, task_state, gate, depth + 1, force_source=force_source)


async def _export_missing(state, save_dir):
    """导出缺失模组清单文本"""
    if not state.missing:
        return
    missing_path = Path(save_dir) / "missing_mods.txt"
    try:
        with open(missing_path, "w", encoding="utf-8") as f:
            f.write(f"# ModList-Weaver 缺失模组清单\n")
            f.write(f"# 目标版本: {state.missing[0].get('mc_version','')} / "
                    f"{state.missing[0].get('loader','')}\n")
            f.write(f"# 共 {len(state.missing)} 个模组未找到适配版本\n")
            f.write("-" * 60 + "\n")
            for m in state.missing:
                f.write(f"{m['name']} | project_id={m['project_id']} | "
                        f"{m['mc_version']}/{m['loader']}\n")
        state.add_log(f"缺失清单已导出: {missing_path}", "info")
    except OSError as e:
        state.add_log(f"导出缺失清单失败: {e}", "error")


async def run_batch_download(mr_client, json_path, mc_version, loader, save_dir, task_state, gate,
                             project_ids=None, cf_client=None, global_source=None):
    """批量下载：读取 modlist，逐个解析下载（多源版本）

    :param mr_client: ModrinthClient
    :param cf_client:  CurseForgeClient（可 None）
    :param global_source: 可选，全局强制下载源（modrinth / curseforge / auto / None），
                          清单中每个 project 自带的 source 优先级更高
    """
    if cf_client is None:
        cf_client = CurseForgeClient()
    # 如果用户在 settings 里没有明确 source，允许接口传入的 global_source 覆盖默认值，
    # 真正优先级顺序：project.source > global_source > settings.source
    default_source = (global_source or "auto").lower() if global_source else None
    task_state.kind = "batch"
    task_state.mc_version = mc_version
    task_state.loader = loader
    task_state.save_dir = save_dir
    task_state.source = json_path
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        task_state.add_log(f"[失败] 读取清单文件失败: {e}", "error")
        task_state.status = "failed"
        task_state.finished_at = time.time()
        return

    projects = data.get("projects", []) if isinstance(data, dict) else []
    if project_ids:
        pset = set(project_ids)
        projects = [p for p in projects if (p or {}).get("project_id") in pset]
    task_state.total = len(projects)
    task_state.add_log(
        f"[开始] 批量下载共 {len(projects)} 个项目，目标 {mc_version}/{loader}", "info")

    save_path = Path(save_dir)
    try:
        save_path.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        task_state.add_log(f"[失败] 创建保存目录失败: {e}", "error")
        task_state.status = "failed"
        task_state.finished_at = time.time()
        return

    processed = set()
    for i, p in enumerate(projects):
        await gate.check()
        pid = (p or {}).get("project_id")
        force_source = (p or {}).get("source") or default_source
        task_state.done = i
        if not pid:
            continue
        await _resolve_and_download(
            mr_client, cf_client, pid, mc_version, loader, save_dir,
            processed, task_state, gate, force_source=force_source)

    task_state.done = task_state.total
    await _export_missing(task_state, save_dir)
    task_state.status = "completed"
    task_state.finished_at = time.time()
    task_state.add_log(
        f"[完成] 批量下载结束。成功 {len(task_state.success) - task_state.skipped_count}，"
        f"跳过 {task_state.skipped_count}，"
        f"失败 {len(task_state.failed)}，缺失 {len(task_state.missing)}", "info")


async def run_single_download(mr_client, project_id, mc_version, loader, save_dir, task_state, gate,
                              cf_client=None, force_source=None):
    """单模组下载：根据 project_id 下载单个模组及其前置依赖（多源版本）"""
    if cf_client is None:
        cf_client = CurseForgeClient()
    task_state.kind = "single"
    task_state.mc_version = mc_version
    task_state.loader = loader
    task_state.save_dir = save_dir
    task_state.source = project_id
    task_state.total = 1
    task_state.add_log(
        f"[开始] 单模组下载 {project_id}，目标 {mc_version}/{loader}", "info")

    save_path = Path(save_dir)
    try:
        save_path.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        task_state.add_log(f"[失败] 创建保存目录失败: {e}", "error")
        task_state.status = "failed"
        task_state.finished_at = time.time()
        return

    processed = set()
    await _resolve_and_download(
        mr_client, cf_client, project_id, mc_version, loader, save_dir,
        processed, task_state, gate, force_source=force_source)

    task_state.done = 1
    await _export_missing(task_state, save_dir)
    task_state.status = "completed"
    task_state.finished_at = time.time()
    task_state.add_log(
        f"[完成] 单模组下载结束。成功 {len(task_state.success) - task_state.skipped_count}，"
        f"跳过 {task_state.skipped_count}，"
        f"失败 {len(task_state.failed)}，缺失 {len(task_state.missing)}", "info")
