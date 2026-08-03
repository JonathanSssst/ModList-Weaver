"""V3.3 新增功能测试：本地 mods 目录管理 + 一键更新

覆盖：
- /api/manage_mod：启用 / 禁用 / 删除（含路径穿越防护）
- /api/manage_scan：包含 .jar.disabled 禁用文件
- /api/download_updates：创建 update 类型任务
- scan_mods include_disabled：真实扫描逻辑
- _cleanup_old_file：更新收尾（删除旧文件 / 保持禁用状态）
"""
import zipfile
from pathlib import Path

import pytest

from backend.scanner import scan_mods
from backend.downloader import TaskState, _cleanup_old_file


def _make_fabric_jar(path):
    """生成一个带 fabric.mod.json 元数据的假模组 jar"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("fabric.mod.json", '{"id":"demo","name":"Demo","version":"1.0"}')
        zf.writestr("demo.class", b"\xca\xfe\xba\xbe")
    return path


# ============ /api/manage_mod 启用 / 禁用 / 删除 ============

def test_manage_mod_enable_disable_delete(tmp_path):
    from fastapi.testclient import TestClient
    from backend import api as api_mod

    jar = _make_fabric_jar(tmp_path / "my_mod.jar")
    with TestClient(api_mod.app) as c:
        r = c.post("/api/manage_mod", json={
            "folder": str(tmp_path), "filename": "my_mod.jar", "action": "disable"})
        assert r.status_code == 200
        assert not jar.is_file()
        assert (tmp_path / "my_mod.jar.disabled").is_file()

        r = c.post("/api/manage_mod", json={
            "folder": str(tmp_path), "filename": "my_mod.jar.disabled", "action": "enable"})
        assert r.status_code == 200
        assert jar.is_file()
        assert not (tmp_path / "my_mod.jar.disabled").exists()

        r = c.post("/api/manage_mod", json={
            "folder": str(tmp_path), "filename": "my_mod.jar", "action": "delete"})
        assert r.status_code == 200
        assert not jar.exists()


def test_manage_mod_rejects_bad_input(tmp_path):
    from fastapi.testclient import TestClient
    from backend import api as api_mod

    _make_fabric_jar(tmp_path / "ok.jar")
    with TestClient(api_mod.app) as c:
        # 路径穿越：../evil.jar 只取文件名 evil.jar，文件不存在 → 404，且不会写错位置
        r = c.post("/api/manage_mod", json={
            "folder": str(tmp_path), "filename": "../evil.jar", "action": "delete"})
        assert r.status_code == 404
        assert not (tmp_path.parent / "evil.jar").exists()

        # 非法 action
        r = c.post("/api/manage_mod", json={
            "folder": str(tmp_path), "filename": "ok.jar", "action": "rename"})
        assert r.status_code == 400

        # 非 jar 文件
        r = c.post("/api/manage_mod", json={
            "folder": str(tmp_path), "filename": "readme.txt", "action": "delete"})
        assert r.status_code == 400

        # 不存在的目录
        r = c.post("/api/manage_mod", json={
            "folder": str(tmp_path / "nope"), "filename": "ok.jar", "action": "delete"})
        assert r.status_code == 400


# ============ /api/manage_scan 包含禁用文件 ============

def test_manage_scan_includes_disabled(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from backend import api as api_mod

    async def fake_scan(folder, client, cf_client=None, log_cb=None, include_disabled=False, progress_cb=None):
        assert include_disabled is True
        return [
            {"filename": "a.jar", "path": str(tmp_path / "a.jar"), "disabled": False,
             "matched": True, "project_id": "p1", "source": "modrinth",
             "metadata": {"loader": "fabric"}, "size": 1, "sha512": "", "murmur2": ""},
            {"filename": "b.jar.disabled", "path": str(tmp_path / "b.jar.disabled"), "disabled": True,
             "matched": True, "project_id": "p2", "source": "curseforge",
             "metadata": {"loader": "forge"}, "size": 1, "sha512": "", "murmur2": ""},
        ]

    monkeypatch.setattr(api_mod, "scan_mods", fake_scan)
    with TestClient(api_mod.app) as c:
        r = c.post("/api/manage_scan", json={"folder": str(tmp_path)})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 2
    disabled = [m for m in body["mods"] if m["disabled"]]
    assert len(disabled) == 1
    assert disabled[0]["filename"] == "b.jar.disabled"


# ============ scan_mods include_disabled 真实逻辑 ============

@pytest.mark.asyncio
async def test_scan_mods_include_disabled(tmp_path):
    _make_fabric_jar(tmp_path / "a.jar")
    _make_fabric_jar(tmp_path / "b.jar.disabled")

    class FakeMr:
        async def get_files_by_hashes(self, hashes, algorithm="sha512"):
            return {}

    results = await scan_mods(tmp_path, FakeMr(), include_disabled=True)
    filenames = [r["filename"] for r in results]
    assert "a.jar" in filenames
    assert "b.jar.disabled" in filenames
    by_name = {r["filename"]: r for r in results}
    assert by_name["b.jar.disabled"]["disabled"] is True
    assert by_name["a.jar"]["disabled"] is False
    # 已启用在前，禁用在后
    assert results[0]["filename"] == "a.jar"
    assert results[-1]["filename"] == "b.jar.disabled"

    # 不含 include_disabled 时不应出现 .disabled 文件
    results2 = await scan_mods(tmp_path, FakeMr())
    assert all(not r["filename"].endswith(".disabled") for r in results2)


# ============ /api/download_updates 创建更新任务 ============

def test_download_updates_creates_task(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from backend import api as api_mod

    created = {}

    class FakeTM:
        async def create(self, kind, factory, params=None):
            created["kind"] = kind
            created["params"] = params
            return "task_upd_1", type("S", (), {"status": "pending"})()

    monkeypatch.setattr(api_mod, "task_manager", FakeTM())
    with TestClient(api_mod.app) as c:
        r = c.post("/api/download_updates", json={
            "updates": [{"project_id": "p1", "name": "M", "source": "modrinth",
                         "old_filename": "old.jar"}],
            "mc_version": "1.21", "loader": "fabric", "save_dir": str(tmp_path),
        })
    assert r.status_code == 200
    assert r.json()["task_id"] == "task_upd_1"
    assert created["kind"] == "update"
    assert created["params"]["mc_version"] == "1.21"
    assert created["params"]["updates"][0]["old_filename"] == "old.jar"

    # 空 updates → 400
    with TestClient(api_mod.app) as c:
        r = c.post("/api/download_updates", json={
            "updates": [], "mc_version": "1.21", "loader": "fabric", "save_dir": str(tmp_path),
        })
    assert r.status_code == 400

    # 缺少 mc_version → 400
    with TestClient(api_mod.app) as c:
        r = c.post("/api/download_updates", json={
            "updates": [{"project_id": "p1"}], "mc_version": "", "loader": "fabric",
            "save_dir": str(tmp_path),
        })
    assert r.status_code == 400


# ============ _cleanup_old_file：更新收尾 ============

def test_cleanup_old_file_removes_old(tmp_path):
    st = TaskState("t", "update")
    old = tmp_path / "old.jar"
    old.write_bytes(b"old")
    dest = tmp_path / "new.jar"
    dest.write_bytes(b"new")
    _cleanup_old_file(tmp_path, "old.jar", dest, st)
    assert not old.exists()
    assert dest.exists()


def test_cleanup_old_file_keeps_disabled_state(tmp_path):
    st = TaskState("t", "update")
    old = tmp_path / "old.jar.disabled"
    old.write_bytes(b"old")
    dest = tmp_path / "new.jar"
    dest.write_bytes(b"new")
    _cleanup_old_file(tmp_path, "old.jar.disabled", dest, st)
    # 旧文件被删除
    assert not old.exists()
    # 新文件被改名保持禁用状态
    assert not dest.exists()
    assert (tmp_path / "new.jar.disabled").is_file()


def test_cleanup_old_file_noop_without_old_filename(tmp_path):
    st = TaskState("t", "update")
    dest = tmp_path / "new.jar"
    dest.write_bytes(b"new")
    _cleanup_old_file(tmp_path, "", dest, st)
    assert dest.exists()
