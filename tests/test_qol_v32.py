"""V3.2 新增功能测试：打开源页面、存储统计与清理"""
import json
from pathlib import Path

from fastapi.testclient import TestClient

from backend import api as api_mod


def test_project_page_modrinth_url():
    with TestClient(api_mod.app) as c:
        r = c.get("/api/project_page", params={"project_id": "sodium", "source": "modrinth"})
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "modrinth"
    assert body["url"] == "https://modrinth.com/project/sodium"


def test_project_page_guess_source_no_network():
    """未指定 source 时按 project_id 形态猜测：非纯数字 → Modrinth，纯数字走 CurseForge"""
    with TestClient(api_mod.app) as c:
        r = c.get("/api/project_page", params={"project_id": "sodium"})
    assert r.json()["url"] == "https://modrinth.com/project/sodium"
    assert r.json()["source"] == "modrinth"


def test_clear_cache_invalid_what():
    with TestClient(api_mod.app) as c:
        r = c.post("/api/clear_cache", json={"what": "nonsense"})
    assert r.status_code == 400


def test_storage_info_and_clear():
    tm = api_mod.task_manager
    # 造一条历史 + 一个日志文件 + 一个导入临时文件
    tm.history_map["t_fake"] = {
        "task_id": "t_fake",
        "state": {"task_id": "t_fake", "kind": "single", "status": "completed",
                  "success_count": 1, "failed_count": 0},
        "logs": [],
    }
    if "t_fake" not in tm.history_order:
        tm.history_order.insert(0, "t_fake")
    tm._persist()

    logs_dir = tm._logs_dir
    logs_dir.mkdir(parents=True, exist_ok=True)
    logf = logs_dir / "t_fake.log"
    logf.write_text("hello", encoding="utf-8")

    dropped = tm._temp_dir / "dropped"
    dropped.mkdir(parents=True, exist_ok=True)
    dropf = dropped / "x.json"
    dropf.write_text("{}", encoding="utf-8")

    try:
        with TestClient(api_mod.app) as c:
            info = c.get("/api/storage_info").json()
            assert info["history_count"] >= 1
            assert info["logs_bytes"] > 0
            assert info["dropped_bytes"] > 0
            assert info["total_bytes"] > 0

            r = c.post("/api/clear_cache", json={"what": "logs"})
            assert r.status_code == 200
            assert not logf.is_file()

            r = c.post("/api/clear_cache", json={"what": "dropped"})
            assert r.status_code == 200
            assert not dropf.is_file()

            r = c.post("/api/clear_cache", json={"what": "history"})
            assert r.status_code == 200
            assert r.json()["removed"] >= 1

            info2 = c.get("/api/storage_info").json()
            assert info2["history_count"] == 0

        # tasks.json 持久化同步清空
        data = json.loads((tm._temp_dir / "tasks.json").read_text(encoding="utf-8"))
        assert all(h.get("task_id") != "t_fake" for h in data.get("history", []))
    finally:
        tm.history_map.pop("t_fake", None)
        if "t_fake" in tm.history_order:
            tm.history_order.remove("t_fake")
        tm._persist()
        for f in (logs_dir / "t_fake.log", dropped / "x.json"):
            try:
                f.unlink()
            except OSError:
                pass
