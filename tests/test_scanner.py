"""scanner 核心逻辑单元测试：纯函数部分无网络依赖"""
import hashlib
import os
import tempfile
from pathlib import Path

import pytest

from backend.scanner import compute_sha512, parse_jar_metadata, _parse_mods_toml


def _write_file(path, size=1024, content=None):
    """写一个任意文件到磁盘，内容可控"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if content is not None:
        path.write_bytes(content if isinstance(content, bytes) else content.encode("utf-8"))
    else:
        path.write_bytes(os.urandom(size))
    return path


def test_compute_sha512_matches_hashlib(tmp_path):
    """sha512 对任意内容文件计算结果必须等于 hashlib 实现"""
    f = tmp_path / "a.bin"
    data = b"hello ModList-Weaver V3.0" * 73
    f.write_bytes(data)
    expected = hashlib.sha512(data).hexdigest()
    assert compute_sha512(f) == expected


def test_compute_sha512_empty_file(tmp_path):
    """空文件 sha512 = hashlib.sha512(b'').hexdigest()"""
    f = tmp_path / "empty"
    f.write_bytes(b"")
    assert compute_sha512(f) == hashlib.sha512(b"").hexdigest()


def test_parse_mods_toml_valid():
    """_parse_mods_toml 回退简易解析能提取 [[mods]] 段"""
    text = """
# 注释
[[mods]]
modId = "examplemod"
displayName = "Example Mod"
version = "1.0.0"
[[mods]]
modId = "second"
displayName = "Second"
version = "2.0"
"""
    parsed = _parse_mods_toml(text)
    mods = parsed.get("mods") or []
    assert len(mods) == 2
    assert mods[0]["modId"] == "examplemod"
    assert mods[0]["displayName"] == "Example Mod"
    assert mods[1]["modId"] == "second"
    assert mods[1]["version"] == "2.0"


def test_parse_mods_toml_quotes():
    """mods.toml 值的 '...' 和 "..." 引号都要剥掉"""
    text = '''[[mods]]
modId = 'with_single'
displayName = "with double"
'''
    mods = (_parse_mods_toml(text).get("mods") or [])
    assert mods[0]["modId"] == "with_single"
    assert mods[0]["displayName"] == "with double"


def test_parse_jar_metadata_not_zip(tmp_path):
    """非 zip 文件不会崩，返回 loader=unknown + error 字段"""
    f = tmp_path / "broken.jar"
    f.write_bytes(b"definitely not a zip file" * 10)
    info = parse_jar_metadata(f)
    assert info.get("loader") == "unknown"
    assert "error" in info
