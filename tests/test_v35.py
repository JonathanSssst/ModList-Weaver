"""V3.5 新增功能测试：模组迁移 + 详情页反依赖分析

覆盖：
- /api/migrate_mods：创建 migrate 类型任务（入队）
- /api/migrate_mods：参数校验（空 mods / 缺 mc_version / 缺 save_dir）
- /api/reverse_deps：在给定清单中查找依赖当前模组的项目
- run_migrate_download：真实下载流程（复用 _resolve_and_download / _export_missing）
"""
from pathlib import Path

import pytest

from backend.downloader import TaskGate, TaskState, run_migrate_download


class _Gate(TaskGate):
    pass


class _FakeMr:
    """可配制的 Modrinth 客户端假体"""

    def __init__(self, projects=None, versions=None, missing=None):
        self.projects = projects or {}
        self.versions = versions or {}
        self.missing_projects = set(missing or [])
        self.downloaded = []

    async def get_project(self, pid):
        if pid in self.missing_projects:
            return None
        return self.projects.get(pid)

    async def get_versions_by_project(self, pid, game_versions=None, loader=None):
        return self.versions.get(pid, [])

    async def download_file(self, url, dest, sha512=None, progress_cb=None):
        Path(dest).write_bytes(b"jar-content")
        self.downloaded.append(str(dest))


def _mr_version(version_number="1.0", game_versions=("1.21",), loaders=("fabric",),
               deps=(), filename="demo-1.0.jar"):
    return {
        "id": f"v_{version_number}",
        "name": version_number,
        "version_number": version_number,
        "game_versions": list(game_versions),
        "loaders": list(loaders),
        "date_published": "2026-01-01T00:00:00Z",
        "changelog": "",
        "dependencies": list(deps),
        "files": [{
            "filename": filename,
            "url": f"https://cdn.example/{filename}",
            "size": 123,
            "primary": True,
            "hashes": {"sha512": "fake-sha512"},
        }],
    }


# ============ /api/migrate_mods 创建任务 ============

def test_migrate_mods_creates_task(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from backend import api as api_mod

    created = {}

    class FakeTM:
        async def create(self, kind, factory, params=None):
            created["kind"] = kind
            created["params"] = params
            return "task_mig_1", type("S", (), {"status": "pending"})()

    monkeypatch.setattr(api_mod, "task_manager", FakeTM())
    with TestClient(api_mod.app) as c:
        r = c.post("/api/migrate_mods", json={
            "mods": [{"project_id": "sodium", "name": "Sodium", "source": "modrinth"}],
            "mc_version": "1.21", "loader": "fabric", "save_dir": str(tmp_path),
        })
    assert r.status_code == 200
    assert r.json()["task_id"] == "task_mig_1"
    assert created["kind"] == "migrate"
    assert created["params"]["mc_version"] == "1.21"
    assert created["params"]["projects"][0]["project_id"] == "sodium"


def test_migrate_mods_validation(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from backend import api as api_mod

    monkeypatch.setattr(api_mod, "task_manager", object())  # 不应被调用
    with TestClient(api_mod.app) as c:
        # 空 mods / 仅无 project_id 的条目 → 400
        r = c.post("/api/migrate_mods", json={
            "mods": [], "mc_version": "1.21", "loader": "fabric", "save_dir": str(tmp_path)})
        assert r.status_code == 400
        r = c.post("/api/migrate_mods", json={
            "mods": [{"name": "NoId"}], "mc_version": "1.21", "loader": "fabric",
            "save_dir": str(tmp_path)})
        assert r.status_code == 400
        # 缺 mc_version
        r = c.post("/api/migrate_mods", json={
            "mods": [{"project_id": "p1"}], "mc_version": "", "loader": "fabric",
            "save_dir": str(tmp_path)})
        assert r.status_code == 400
        # 缺 save_dir
        r = c.post("/api/migrate_mods", json={
            "mods": [{"project_id": "p1"}], "mc_version": "1.21", "loader": "fabric",
            "save_dir": ""})
        assert r.status_code == 400


# ============ /api/reverse_deps 反依赖分析 ============

def test_reverse_deps_finds_dependents(monkeypatch):
    from fastapi.testclient import TestClient
    from backend import api as api_mod

    class FakeMr:
        def __init__(self):
            self.calls = []

        async def get_versions_by_project(self, pid, game_versions=None, loader=None):
            self.calls.append(pid)
            deps = {
                "sodium": [{"project_id": "iris", "dependency_type": "required"}],
                "irrelevant": [{"project_id": "other", "dependency_type": "required"}],
            }
            dep = deps.get(pid, [])
            return [{"dependencies": dep, "files": []}]

    fake = FakeMr()
    monkeypatch.setattr(api_mod, "client", fake)
    with TestClient(api_mod.app) as c:
        r = c.post("/api/reverse_deps", json={
            "project_id": "iris",
            "mods": [
                {"project_id": "sodium", "name": "Sodium", "source": "modrinth"},
                {"project_id": "irrelevant", "name": "X", "source": "modrinth"},
                {"project_id": "iris", "name": "Iris", "source": "modrinth"},
            ],
        })
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert body["results"][0]["project_id"] == "sodium"
    assert body["results"][0]["dependency_type"] == "required"
    # 自身 iris 未参与查询
    assert "iris" not in fake.calls


def test_reverse_deps_empty_and_self_only(monkeypatch):
    from fastapi.testclient import TestClient
    from backend import api as api_mod

    calls = []

    class FakeMr:
        async def get_versions_by_project(self, pid, game_versions=None, loader=None):
            calls.append(pid)
            return [{"dependencies": [{"project_id": "iris", "dependency_type": "required"}], "files": []}]

    monkeypatch.setattr(api_mod, "client", FakeMr())
    with TestClient(api_mod.app) as c:
        # 空清单 → 直接返回空结果，不发请求
        r = c.post("/api/reverse_deps", json={"project_id": "iris", "mods": []})
        assert r.status_code == 200
        assert r.json()["total"] == 0
        assert calls == []

        # 只有目标自身 → 跳过，不发请求
        r = c.post("/api/reverse_deps", json={
            "project_id": "iris",
            "mods": [{"project_id": "iris", "name": "Iris", "source": "modrinth"}],
        })
        assert r.status_code == 200
        assert r.json()["total"] == 0
        assert calls == []


# ============ run_migrate_download 真实下载流程 ============

@pytest.mark.asyncio
async def test_run_migrate_download_success(tmp_path):
    save_dir = tmp_path / "mods"
    mr = _FakeMr(
        projects={"sodium": {"title": "Sodium", "slug": "sodium"}},
        versions={"sodium": [_mr_version()]},
    )
    st = TaskState("t1", "migrate")
    await run_migrate_download(
        mr, None, [{"project_id": "sodium", "name": "Sodium", "source": "modrinth"}],
        "1.21", "fabric", str(save_dir), st, _Gate())

    assert st.status == "completed"
    assert len(st.success) == 1
    assert st.success[0]["filename"] == "demo-1.0.jar"
    assert (save_dir / "demo-1.0.jar").is_file()
    assert st.kind == "migrate"
    assert st.source == "模组迁移"


@pytest.mark.asyncio
async def test_run_migrate_download_missing_export(tmp_path):
    save_dir = tmp_path / "mods"
    # 项目存在但没有 1.21 版本 → 标记缺失并导出 missing_mods.txt
    mr = _FakeMr(
        projects={"foo": {"title": "Foo"}},
        versions={"foo": [_mr_version(game_versions=("1.20",))]},
    )
    st = TaskState("t2", "migrate")
    await run_migrate_download(
        mr, None, [{"project_id": "foo", "name": "Foo", "source": "modrinth"}],
        "1.21", "fabric", str(save_dir), st, _Gate())

    assert st.status == "completed"
    assert len(st.missing) == 1
    assert st.missing[0]["project_id"] == "foo"
    missing_file = save_dir / "missing_mods.txt"
    assert missing_file.is_file()
    assert "foo" in missing_file.read_text(encoding="utf-8")
