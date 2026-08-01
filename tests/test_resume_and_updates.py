"""V3.1 新增功能测试：任务断点恢复、软件版本比较、更新检测与清单导入"""
import asyncio
import json
from pathlib import Path

import pytest

from backend.downloader import TaskManager, TaskState
from backend.api import _parse_version


# ============ 版本号比较 ============

def test_parse_version():
    assert _parse_version("v3.1.0") == (3, 1, 0)
    assert _parse_version("3.0.1") == (3, 0, 1)
    assert _parse_version("2.5") == (2, 5, 0)
    assert _parse_version("v3") == (3, 0, 0)
    assert _parse_version("10.20.30") == (10, 20, 30)
    assert _parse_version("abc") == (0, 0, 0)


# ============ 任务状态快照往返 ============

def test_task_state_from_dict_roundtrip():
    s = TaskState("t1", "batch")
    s.mc_version = "1.21"
    s.loader = "fabric"
    s.save_dir = "C:/x"
    s.status = "running"
    s.add_log("hello")
    s.add_success("p1", "n", "f.jar")
    s.failed = [{"project_id": "p2", "name": "n2", "reason": "r"}]
    s.total = 5
    s.done = 2
    s.skipped_count = 1
    d = {**s.to_dict(), "logs": s.logs}

    s2 = TaskState.from_dict(d)
    # 恢复后统一置为 pending，由队列调度重新执行
    assert s2.status == "pending"
    assert s2.mc_version == "1.21"
    assert s2.loader == "fabric"
    assert s2.save_dir == "C:/x"
    assert s2.logs == s.logs
    assert s2.success == s.success
    assert s2.failed == s.failed
    assert s2.total == 5
    assert s2.done == 2
    assert s2.skipped_count == 1


# ============ 断点恢复：active.json 持久化 + resume_active ============

def _active_path():
    return Path(__file__).resolve().parent.parent / "cache" / "temp" / "active.json"


@pytest.mark.asyncio
async def test_resume_active_restores_task(tmp_path):
    active = _active_path()
    backup = None
    if active.is_file():
        backup = active.read_text(encoding="utf-8")
        active.unlink()

    hold = asyncio.Event()

    async def _factory(gate):
        await hold.wait()

    def _builder(kind, params, state):
        async def _f(gate):
            await hold.wait()
        return _f

    tm = TaskManager()
    try:
        tid, state = await tm.create(
            "single", _factory,
            params={"project_id": "x1", "mc_version": "1.21",
                    "loader": "fabric", "save_dir": str(tmp_path), "source": "auto"})
        state.mc_version = "1.21"
        state.loader = "fabric"
        state.save_dir = str(tmp_path)
        state.add_log("原始日志")
        tm._persist_active()

        assert active.is_file()
        data = json.loads(active.read_text(encoding="utf-8"))
        entry = next(t for t in data["tasks"] if t["task_id"] == tid)
        assert entry["params"]["project_id"] == "x1"
        assert entry["params"]["source"] == "auto"

        # 模拟重启：新建 TaskManager 并恢复
        tm2 = TaskManager()
        count = await tm2.resume_active(_builder)
        assert count >= 1
        # 让恢复出的任务实际进入执行（阻塞在 hold.wait），再执行后续断言
        await asyncio.sleep(0.05)
        restored = tm2.tasks.get(tid)
        assert restored is not None
        # 恢复后自动重新排队执行（断点恢复），因此会立即进入运行态
        assert restored.state.status in ("running", "pending")
        assert restored.state.mc_version == "1.21"
        assert restored.state.loader == "fabric"
        assert restored.state.save_dir == str(tmp_path)
        assert any("恢复" in (lg.get("msg") or "") for lg in restored.state.logs)

        # 停止恢复出的任务，active.json 中应移除
        tm2.stop(tid)
        await asyncio.sleep(0.1)
        data2 = json.loads(active.read_text(encoding="utf-8"))
        assert all(t["task_id"] != tid for t in data2["tasks"])
    finally:
        tm.stop(tid)
        await asyncio.sleep(0.05)
        if backup is None:
            if active.is_file():
                active.unlink()
        else:
            active.write_text(backup, encoding="utf-8")


# ============ 更新检测 / 清单导入（TestClient） ============

def test_check_updates_reports_new_version(monkeypatch):
    from fastapi.testclient import TestClient
    from backend import api as api_mod

    class FakeMr:
        async def get_versions_by_project(self, pid, gv, ldr):
            return [{
                "id": "newv1",
                "name": "2.0",
                "version_number": "2.0",
                "game_versions": ["1.21", "1.20.1"],
                "loaders": ["fabric"],
                "changelog": "修复若干问题",
                "files": [{"primary": True, "filename": "a.jar",
                           "url": "http://cdn/a.jar", "hashes": {"sha512": "aa"}}],
            }]

    monkeypatch.setattr(api_mod, "client", FakeMr())
    with TestClient(api_mod.app) as c:
        r = c.post("/api/check_updates", json={
            "mods": [{"project_id": "abc", "version_id": "old",
                      "version_number": "1.0", "source": "modrinth", "name": "M"}],
        })
    assert r.status_code == 200
    body = r.json()
    assert body["checked"] == 1
    assert body["update_count"] == 1
    upd = body["updates"][0]
    assert upd["project_id"] == "abc"
    assert upd["current_version"] == "1.0"
    assert upd["latest_version"] == "2.0"
    assert upd["latest_version_id"] == "newv1"


def test_check_updates_up_to_date(monkeypatch):
    from fastapi.testclient import TestClient
    from backend import api as api_mod

    class FakeMr:
        async def get_versions_by_project(self, pid, gv, ldr):
            return [{"id": "same", "version_number": "1.0", "name": "1.0"}]

    monkeypatch.setattr(api_mod, "client", FakeMr())
    with TestClient(api_mod.app) as c:
        r = c.post("/api/check_updates", json={
            "mods": [{"project_id": "abc", "version_id": "same",
                      "version_number": "1.0", "source": "modrinth", "name": "M"}],
        })
    body = r.json()
    assert body["update_count"] == 0


def test_import_modlist_valid_and_invalid():
    from fastapi.testclient import TestClient
    from backend import api as api_mod

    with TestClient(api_mod.app) as c:
        r = c.post("/api/import_modlist", json={
            "filename": "my list.json",
            "content": '{"projects": [{"project_id": "p1"}]}',
        })
        assert r.status_code == 200
        p = Path(r.json()["path"])
        assert p.is_file()
        assert json.loads(p.read_text(encoding="utf-8"))["projects"][0]["project_id"] == "p1"
        try:
            p.unlink()
        except OSError:
            pass

        bad = c.post("/api/import_modlist", json={"content": "{not json"})
        assert bad.status_code == 400
