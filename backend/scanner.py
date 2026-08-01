"""模组文件夹扫描、Jar 元数据解析、哈希计算与多平台反查

关键点：
- 使用 zipfile 纯 Python 读取 jar 内部 fabric.mod.json / mods.toml，无需 Java 环境
- 计算 sha512 后调用 Modrinth version_files 接口批量反查 project_id
- Modrinth 未匹配时，回退 CurseForge murmur2 指纹反查
- 无法识别的模组标记 matched=False，前端标灰展示
"""
import hashlib
import json
import zipfile
from pathlib import Path

from .modrinth_client import ModrinthClient


def compute_sha512(file_path):
    """计算文件 sha512 哈希（分块读取，避免大文件占用过多内存）"""
    sha = hashlib.sha512()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            sha.update(chunk)
    return sha.hexdigest()


def _parse_mods_toml(text):
    """解析 Forge / NeoForge 的 mods.toml 文本

    优先使用 Python 3.11+ 内置 tomllib，否则回退到针对 [[mods]] 段的简易解析。
    """
    try:
        import tomllib
        return tomllib.loads(text)
    except ImportError:
        pass

    # 回退：仅解析 [[mods]] 段的 key = "value" 行
    result = {"mods": []}
    current = None
    for raw_line in text.splitlines():
        line = raw_line.split("#")[0].strip()
        if not line:
            continue
        if line == "[[mods]]":
            current = {}
            result["mods"].append(current)
        elif line.startswith("[") and line.endswith("]"):
            current = None
        elif "=" in line and current is not None:
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            current[key] = val
    return result


def parse_jar_metadata(jar_path):
    """解析 jar 内部元数据

    读取顺序：
      1. fabric.mod.json  -> Fabric / Quilt
      2. META-INF/mods.toml -> Forge / NeoForge
      3. META-INF/MANIFEST.MF -> 兜底（仅取 Implementation-Version）

    :return: dict(mod_id, name, version, loader, raw, error)
    """
    info = {"mod_id": None, "name": None, "version": None, "loader": None, "raw": {}}
    try:
        with zipfile.ZipFile(jar_path) as zf:
            names = zf.namelist()
            if "fabric.mod.json" in names:
                # Fabric 模组元数据
                data = json.loads(zf.read("fabric.mod.json"))
                info["loader"] = "fabric"
                info["mod_id"] = data.get("id")
                info["name"] = data.get("name") or data.get("id")
                info["version"] = data.get("version")
                info["raw"] = data
            elif "META-INF/mods.toml" in names:
                # Forge / NeoForge 模组元数据
                toml_text = zf.read("META-INF/mods.toml").decode("utf-8", errors="ignore")
                parsed = _parse_mods_toml(toml_text)
                info["loader"] = "forge"
                info["raw"] = parsed
                mods = parsed.get("mods", [])
                if mods:
                    first = mods[0]
                    info["mod_id"] = first.get("modId")
                    info["name"] = first.get("displayName") or first.get("modId")
                    info["version"] = first.get("version")
            elif "META-INF/MANIFEST.MF" in names:
                # 兜底：从 MANIFEST 读取版本
                manifest = zf.read("META-INF/MANIFEST.MF").decode("utf-8", errors="ignore")
                info["loader"] = "unknown"
                for line in manifest.splitlines():
                    if "Implementation-Version" in line:
                        info["version"] = line.split(":", 1)[-1].strip()
                    if "Implementation-Title" in line:
                        info["name"] = line.split(":", 1)[-1].strip()
            else:
                info["loader"] = "unknown"
    except (zipfile.BadZipFile, KeyError, json.JSONDecodeError, OSError) as e:
        info["error"] = str(e)
        info["loader"] = "unknown"
    return info


async def scan_mods(folder, client, cf_client=None, log_cb=None):
    """扫描 mods 目录，解析元数据并通过多平台哈希反查 project_id

    匹配顺序（符合 settings.source=auto 行为）：
      1. 先尝试 Modrinth（sha512）
      2. 未匹配的再尝试 CurseForge（murmur2）——当传入 cf_client 时启用

    :param folder: mods 目录路径
    :param client: ModrinClient 实例
    :param cf_client: 可选 CurseForgeClient 实例
    :param log_cb: 可选异步日志回调 async cb(msg)
    :return: 模组信息列表
    """
    folder_path = Path(folder)
    if not folder_path.is_dir():
        raise FileNotFoundError(f"目录不存在或不是文件夹: {folder}")

    jar_files = sorted(folder_path.glob("*.jar"))
    if not jar_files:
        return []

    results = []
    for jar in jar_files:
        meta = parse_jar_metadata(jar)
        sha512 = compute_sha512(jar)
        murmur2 = None
        if cf_client is not None:
            from .curseforge_client import compute_cf_murmur2
            try:
                murmur2 = compute_cf_murmur2(jar)
            except OSError:
                murmur2 = None
        results.append({
            "filename": jar.name,
            "path": str(jar),
            "sha512": sha512,
            "murmur2": murmur2,
            "size": jar.stat().st_size,
            "metadata": meta,
            "matched": False,
            "source": None,          # "modrinth" / "curseforge"
            "project_id": None,
            "version_id": None,
            "version_name": None,
            "version_number": None,
            "game_versions": [],
            "loaders": [],
        })
        if log_cb:
            await log_cb(f"扫描文件: {jar.name}")

    # 第 1 步：Modrinth sha512 批量反查
    hashes = [r["sha512"] for r in results]
    if log_cb:
        await log_cb(f"正在向 Modrinth 反查 {len(hashes)} 个 sha512 哈希...")
    mapping = {}
    try:
        mapping = await client.get_files_by_hashes(hashes, "sha512")
    except Exception as e:
        if log_cb:
            await log_cb(f"Modrinth 哈希反查失败: {e}")
    matched_ids = set()
    for r in results:
        hit = mapping.get(r["sha512"])
        if hit:
            r["matched"] = True
            r["source"] = "modrinth"
            r["project_id"] = hit.get("project_id")
            r["version_id"] = hit.get("id")
            r["version_name"] = hit.get("name")
            r["version_number"] = hit.get("version_number")
            r["game_versions"] = hit.get("game_versions", [])
            r["loaders"] = hit.get("loaders", [])
            matched_ids.add(id(r))

    # 第 2 步：CurseForge murmur2 反查（仅未匹配的）
    if cf_client is not None:
        cf_candidates = [(r["murmur2"], r) for r in results if id(r) not in matched_ids and r["murmur2"]]
        if cf_candidates:
            cf_fp_list = [m for m, _ in cf_candidates]
            if log_cb:
                await log_cb(f"正在向 CurseForge 反查 {len(cf_fp_list)} 个 murmur2 指纹...")
            try:
                cf_map = await cf_client.get_files_by_fingerprints(cf_fp_list)
            except Exception as e:
                if log_cb:
                    await log_cb(f"CurseForge 指纹反查失败: {e}")
                cf_map = {}
            for murmur2, r in cf_candidates:
                hit = cf_map.get(murmur2)
                if hit:
                    r["matched"] = True
                    r["source"] = "curseforge"
                    r["project_id"] = hit.get("project_id")
                    r["version_id"] = hit.get("version_id")
                    r["version_name"] = hit.get("name")
                    r["version_number"] = hit.get("version_number")
                    r["game_versions"] = hit.get("game_versions", [])
                    r["loaders"] = hit.get("loaders", [])

    return results
