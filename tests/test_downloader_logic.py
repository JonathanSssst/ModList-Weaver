"""下载器纯逻辑单元测试（版本选择、TaskGate、限速、哈希校验辅助函数）"""
import asyncio
import hashlib
import time
from pathlib import Path

import pytest

from backend.downloader import (
    _pick_best_version,
    _classify_error,
    _best_hash_for_existing_check,
    _compute_local_hash,
    TaskGate,
)
from backend.settings import RateLimiter, Settings, DEFAULT_SETTINGS, get_settings


# ============ 版本选择 ============

def test_pick_best_version_basic():
    """正常匹配：首个同时匹配版本 + loader 的条目返回"""
    versions = [
        {"game_versions": ["1.20.1", "1.21"], "loaders": ["forge"]},   # 匹配：有 1.21 + forge
        {"game_versions": ["1.21"], "loaders": ["fabric"]},
        {"game_versions": ["1.21"], "loaders": ["fabric", "forge"]},
    ]
    v, reason = _pick_best_version(versions, "1.21", "forge")
    assert v is not None
    assert reason is None
    # 第 0 项：game_versions 含 1.21 且 loaders 含 forge，因此直接匹配第一个
    assert v == versions[0]


def test_pick_best_version_empty():
    v, reason = _pick_best_version([], "1.21", "fabric")
    assert v is None
    assert "无版本信息" in reason


def test_pick_best_version_missing_mc():
    versions = [
        {"game_versions": ["1.20.1"], "loaders": ["fabric"]},
    ]
    v, reason = _pick_best_version(versions, "1.21", "fabric")
    assert v is None
    assert "游戏版本" in reason


def test_pick_best_version_missing_loader():
    versions = [
        {"game_versions": ["1.21"], "loaders": ["forge"]},
    ]
    v, reason = _pick_best_version(versions, "1.21", "fabric")
    assert v is None
    assert "加载器" in reason


# ============ 错误分类 ============

def test_classify_error_network():
    assert _classify_error(Exception("连接 timeout 错误")) == "网络错误"
    assert _classify_error(Exception("Connection reset")) == "网络错误"


def test_classify_error_hash():
    assert _classify_error(Exception("哈希 sha512 校验失败")) == "文件校验失败"
    assert _classify_error(Exception("文件校验失败")) == "文件校验失败"


def test_classify_error_unknown():
    assert _classify_error(Exception("什么都不匹配的奇怪错误")) == "未知错误"


# ============ 哈希优先级 ============

def test_best_hash_sha512_first():
    pf = {"sha512": "a", "sha1": "b", "murmur2": "c"}
    algo, val = _best_hash_for_existing_check(pf)
    assert algo == "sha512"
    assert val == "a"


def test_best_hash_fallback_sha1():
    pf = {"sha1": "b", "murmur2": "c"}
    algo, val = _best_hash_for_existing_check(pf)
    assert algo == "sha1"
    assert val == "b"


def test_best_hash_fallback_murmur2():
    pf = {"murmur2": "c"}
    algo, val = _best_hash_for_existing_check(pf)
    assert algo == "murmur2"
    assert val == "c"


def test_best_hash_none():
    algo, val = _best_hash_for_existing_check({})
    assert algo is None
    assert val is None


def test_compute_local_hash_sha512_and_sha1(tmp_path):
    f = tmp_path / "h.bin"
    data = b"abc test 123" * 31
    f.write_bytes(data)
    assert _compute_local_hash(f, "sha512") == hashlib.sha512(data).hexdigest()
    assert _compute_local_hash(f, "sha1") == hashlib.sha1(data).hexdigest()


# ============ TaskGate ============

@pytest.mark.asyncio
async def test_taskgate_started_as_pass():
    """初始状态 check() 立即通过"""
    g = TaskGate()
    await asyncio.wait_for(g.check(), timeout=1.0)  # 不抛异常


@pytest.mark.asyncio
async def test_taskgate_pause_blocks_then_resume_unblocks():
    """pause 阻塞 check，resume 放行"""
    g = TaskGate()
    g.pause()
    t0 = time.monotonic()
    async def _wakeup_later():
        await asyncio.sleep(0.15)
        g.resume()
    await asyncio.gather(
        asyncio.wait_for(g.check(), timeout=2.0),
        _wakeup_later(),
    )
    elapsed = time.monotonic() - t0
    assert elapsed >= 0.1


@pytest.mark.asyncio
async def test_taskgate_stop_raises():
    """stop 之后 check 抛 TaskStopped"""
    from backend.downloader import TaskStopped
    g = TaskGate()
    g.stop()
    with pytest.raises(TaskStopped):
        await g.check()


# ============ RateLimiter ============

@pytest.mark.asyncio
async def test_rate_limiter_zero_bypass():
    """0 表示不限速，立即返回"""
    r = RateLimiter(0)
    t0 = time.monotonic()
    await r.acquire(1024 * 1024 * 100)
    assert (time.monotonic() - t0) < 0.1


@pytest.mark.asyncio
async def test_rate_limiter_slow():
    """给 1MB/s 速率，请求 2MB 至少耗时约 1.5s+；我们测 500KB 至少 0.35s（留余量）"""
    r = RateLimiter(500 * 1024)  # 500KB/s
    t0 = time.monotonic()
    await r.acquire(500 * 1024)
    elapsed = time.monotonic() - t0
    assert elapsed >= 0.4


@pytest.mark.asyncio
async def test_rate_limiter_update_then_bypass():
    """限速可 update 为 0 解除"""
    r = RateLimiter(1024)  # 1KB/s
    await r.acquire(1)
    r.update(0)
    t0 = time.monotonic()
    await r.acquire(1024 * 1024 * 50)
    assert (time.monotonic() - t0) < 0.1
