"""CurseForge Core + Minecraft 公开 API 客户端（公共 API，无需 Token）

说明：CurseForge 不提供匿名的公共官方 REST，本客户端使用社区长期维护的第三方镜像：
- 项目搜索 / 详情 / 版本 / 依赖  ->  `https://api.curse.tools/v1/tools/cf`（镜像，无需 API Key）
- 原始官方也可通过个人 API Key 调用 `https://api.curseforge.com/v1`，走 CF 自己的直链

接口返回结构做了归一化（flatten），与 ModrinthClient 保持兼容字段，方便上层共享业务逻辑：
- project:  id / slug / title / description / body / icon_url / authors / categories /
            loaders / game_versions / downloads / followers / project_type / license
- version:  id / name / version_number / game_versions / loaders / date_published / changelog /
            filename / filesize / download_url / hashes(murmal2 sha1 sha512 md5) / dependencies[]
- search response: hits[{id, slug, title, ...}], total, offset, limit

作者：V3.0 新增
"""
import asyncio
import hashlib
import time
from pathlib import Path
from typing import Optional

import httpx

from .settings import get_settings

USER_AGENT = "ModList-Weaver/3.0 (Minecraft mod migration desktop tool, CurseForge fallback source)"

# 镜像基址：curse.tools 是长期运行的社区 CF 镜像（直连，无须 API Key）
# 官方文档推荐 drop-in 地址为 https://api.curse.tools/v1/cf，但该前缀下
# /fingerprints 返回 405；基址 /v1 下所有接口（含 fingerprints）均可用，故用之。
CURSETOOLS_BASE = "https://api.curse.tools/v1"
# 分类常量：mods 类别 = 6（CurseForge Core）
CF_CLASS_MODS = 6
CF_CLASS_RESOURCEPACK = 12
CF_CLASS_SHADER = 6552
# 文件 Hash 枚举 CurseForge: murmur2=1, sha1=2, md5=3, sha512未在老枚举中，但新版也传 sha1
CF_HASH_MURMUR2 = 1
CF_HASH_SHA1 = 2
# 请求节流：镜像不限，但保持礼貌
MIN_REQUEST_INTERVAL = 0.25


class CurseForgeError(Exception):
    """CurseForge / CurseTools API 业务异常"""


class CurseForgeClient:
    """异步 CurseForge 客户端（走 curse.tools 公共镜像）

    对外字段保持与 ModrinthClient 相同的方法签名与返回结构，使得上层 downloader / scanner / api
    可以复用同一套逻辑，仅通过 `source` 区分来源。
    """

    def __init__(self):
        headers = {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
        }
        self._client = httpx.AsyncClient(headers=headers, timeout=30.0, follow_redirects=True)
        self._last_request_time = 0.0
        self._lock = asyncio.Lock()

    async def close(self):
        await self._client.aclose()

    async def _throttle(self):
        async with self._lock:
            now = time.monotonic()
            elapsed = now - self._last_request_time
            if elapsed < MIN_REQUEST_INTERVAL:
                await asyncio.sleep(MIN_REQUEST_INTERVAL - elapsed)
            self._last_request_time = time.monotonic()

    async def _request(self, method, path, **kwargs):
        """通用请求封装：重试、错误归一化"""
        max_retries = 4
        last_error = None
        for attempt in range(max_retries):
            await self._throttle()
            try:
                resp = await self._client.request(method, f"{CURSETOOLS_BASE}{path}", **kwargs)
            except (httpx.RequestError, httpx.TimeoutException) as e:
                last_error = e
                await asyncio.sleep(1.0 * (attempt + 1))
                continue
            if resp.status_code == 429:
                retry_after = float(resp.headers.get("Retry-After", "3"))
                await asyncio.sleep(max(retry_after, 2.0))
                continue
            if resp.status_code == 404:
                return None
            if resp.status_code >= 500:
                await asyncio.sleep(1.0 * (attempt + 1))
                continue
            if resp.status_code >= 400:
                raise CurseForgeError(f"HTTP {resp.status_code}: {resp.text[:300]}")
            if resp.status_code == 204 or not resp.text:
                return None
            try:
                body = resp.json()
            except ValueError as e:
                raise CurseForgeError(f"响应非 JSON: {resp.text[:200]}") from e
            # curse.tools 统一包裹 data / pagination
            data = body.get("data") if isinstance(body, dict) else body
            return data
        raise CurseForgeError(
            f"请求 {path} 失败，超过最大重试次数: {last_error or '服务端持续错误'}")

    # -------- 归一化工具 --------

    @staticmethod
    def _map_loader(cf_loader_type: int):
        """CurseForge ModLoaderType 枚举: 0=Any, 1=Forge, 2=Cauldron, 3=LiteLoader, 4=Fabric,
        5=Quilt, 6=NeoForge, 7=Forge(旧兼容)。返回我们使用的小写标识。"""
        mapping = {0: None, 1: "forge", 4: "fabric", 5: "quilt", 6: "neoforge"}
        return mapping.get(int(cf_loader_type or 0))

    @staticmethod
    def _loader_to_cf(loader: str) -> Optional[int]:
        mapping = {"forge": 1, "fabric": 4, "quilt": 5, "neoforge": 6}
        return mapping.get(loader.lower()) if loader else None

    def _normalize_project(self, item):
        """将 CF 返回的项目结构转成与 Modrinth 兼容字段"""
        if not item:
            return None
        links = item.get("links") or {}
        cats = [c.get("name") for c in (item.get("categories") or []) if isinstance(c, dict)]
        authors = [
            {"name": a.get("name"), "avatar_url": a.get("avatarUrl"), "role": "author"}
            for a in (item.get("authors") or []) if isinstance(a, dict)
        ]
        # 版本 -> loader 列表，CurseForge 需要通过 latestFilesIndexes 取 set
        loader_set = set()
        versions_set = set()
        for fi in (item.get("latestFilesIndexes") or []):
            gv = fi.get("gameVersion")
            if gv:
                versions_set.add(gv)
            lt = fi.get("modLoader")
            if lt is not None:
                mapped = self._map_loader(lt)
                if mapped:
                    loader_set.add(mapped)
        # 如果 latestFilesIndexes 没有 loader 信息，从 categories 猜
        if not loader_set:
            lower = " ".join(cats).lower()
            if "fabric" in lower:
                loader_set.add("fabric")
            if "forge" in lower:
                loader_set.add("forge")
            if "quilt" in lower:
                loader_set.add("quilt")
        return {
            "id": item.get("id"),
            "project_id": item.get("id"),
            "slug": item.get("slug"),
            "title": item.get("name"),
            "description": item.get("summary") or "",
            "body": item.get("description") or "",
            "icon_url": (item.get("logo") or {}).get("thumbnailUrl") or (item.get("logo") or {}).get("url") if isinstance(item.get("logo"), dict) else None,
            "authors": authors,
            "categories": cats,
            "loaders": sorted(loader_set),
            "game_versions": sorted(versions_set),
            "downloads": item.get("downloadCount") or 0,
            "followers": item.get("thumbsUpCount") or 0,
            "project_type": "mod",
            "license": "UNKNOWN",
            "source_url": links.get("sourceUrl"),
            "team": None,
            "source": "curseforge",
        }

    def _normalize_version(self, v):
        if not v:
            return None
        files = v.get("files") or []
        primary = next((f for f in files if f.get("isPrimary")), files[0] if files else None)
        if not primary:
            return None
        hashes_raw = primary.get("hashes") or []
        hashes = {}
        for h in hashes_raw:
            algo = h.get("algo")
            val = h.get("value")
            if algo and val:
                # CurseForge algo names: 1=murmur2, 2=sha1, 3=md5
                if algo == 1:
                    hashes["murmur2"] = val
                elif algo == 2:
                    hashes["sha1"] = val
                elif algo == 3:
                    hashes["md5"] = val
                elif isinstance(algo, str):
                    hashes[algo.lower()] = val
        deps = []
        for dep in (v.get("dependencies") or []):
            dep_type = dep.get("relationType")
            # 关系类型: 1=embeddedLibrary,2=optional,3=required,4=tool,5=incompatible,6=include
            dt = "required" if dep_type == 3 else (
                "optional" if dep_type == 2 else (
                    "incompatible" if dep_type == 5 else "embedded"
                )
            )
            deps.append({
                "modId": dep.get("modId"),
                "project_id": dep.get("modId"),
                "dependency_type": dt,
            })
        return {
            "id": v.get("id"),
            "version_id": v.get("id"),
            "name": v.get("displayName") or v.get("fileDate"),
            "version_number": v.get("fileFingerprint") or v.get("id"),
            "game_versions": sorted(set(v.get("gameVersions") or [])),
            "loaders": sorted(filter(None, {self._map_loader(v.get("modLoader") or 0)})),
            "date_published": v.get("fileDate"),
            "changelog": "",
            "filename": primary.get("fileName"),
            "filesize": primary.get("fileLength") or 0,
            "download_url": primary.get("downloadUrl"),
            "hashes": hashes,
            "dependencies": deps,
            "project_id": v.get("modId"),
            "source": "curseforge",
        }

    # -------- 查询接口 --------

    async def search_mods(self, query, game_version=None, loader=None, limit=10, offset=0,
                          project_type=None):
        """搜索模组，返回结构与 Modrinth.search_mods 一致：{hits, limit, offset, total_hits}"""
        gameId = 432  # Minecraft
        classId = CF_CLASS_MODS
        params = {
            "gameId": gameId,
            "classId": classId,
            "searchFilter": query or "",
            "sortField": 2,  # 按下载量
            "sortOrder": "desc",
            "pageSize": min(max(1, int(limit or 10)), 50),
            "index": int(offset or 0),
        }
        if game_version:
            params["gameVersion"] = game_version
        if loader:
            cf = self._loader_to_cf(loader)
            if cf:
                params["modLoaderType"] = cf
        data = await self._request("GET", "/mods/search", params=params) or {}
        raw_hits = data if isinstance(data, list) else data.get("data") or []
        hits = [self._normalize_project(h) for h in raw_hits if isinstance(h, dict)]
        pagination = data.get("pagination") if isinstance(data, dict) else None
        return {
            "hits": hits,
            "offset": int(offset or 0),
            "limit": int(limit or 10),
            "total_hits": (pagination or {}).get("totalCount") or len(hits),
        }

    async def get_project(self, mod_id):
        """按 id 获取 CurseForge 项目详情（统一结构）"""
        data = await self._request("GET", f"/mods/{mod_id}")
        return self._normalize_project(data)

    async def get_team(self, team_id):
        """CurseForge 不使用 team 概念，返回空列表保持接口兼容"""
        return []

    async def get_versions_by_project(self, mod_id, game_versions=None, loaders=None):
        """获取某项目所有可用版本。支持按游戏版本/加载器过滤。"""
        data = await self._request("GET", f"/mods/{mod_id}/files") or []
        raw = data if isinstance(data, list) else []
        normalized = [self._normalize_version(v) for v in raw]
        normalized = [v for v in normalized if v]
        if game_versions:
            gset = set(game_versions)
            normalized = [v for v in normalized if any(g in v["game_versions"] for g in gset)]
        if loaders:
            lset = {l.lower() for l in loaders}
            normalized = [v for v in normalized if any(l in v["loaders"] for l in lset)]
        # 按 date_published 降序（保持与 Modrinth 一致，最新在前）
        normalized.sort(key=lambda v: v.get("date_published") or "", reverse=True)
        return normalized

    async def get_version(self, file_id):
        data = await self._request("GET", f"/mods/files/{file_id}")
        return self._normalize_version(data)

    async def get_files_by_fingerprints(self, murmur2_list):
        """按 murmur2 hash 批量反查文件信息（CurseForge 官方标准指纹）

        入参：[murmur2_hash_str, ...]
        返回：{hash: normalized_version, ...}
        """
        if not murmur2_list:
            return {}
        payload = {"fingerprints": [int(h) for h in murmur2_list if h and str(h).isdigit()]}
        data = await self._request("POST", "/fingerprints", json=payload) or {}
        matches = {}
        for m in (data.get("exactMatches") or []):
            file_info = m.get("file") or {}
            fp = file_info.get("fileFingerprint") or m.get("fileFingerprint")
            norm = self._normalize_version(file_info)
            if norm and fp is not None:
                matches[str(fp)] = norm
        return matches

    async def get_mc_versions(self):
        """获取 Minecraft 官方版本列表。复用 Mojang 清单，与 Modrinth 实现一致，
        保持双客户端可用。"""
        from .modrinth_client import MC_VERSION_MANIFEST
        try:
            resp = await self._client.get(MC_VERSION_MANIFEST)
        except httpx.RequestError as e:
            raise CurseForgeError(f"获取 MC 版本清单失败: {e}") from e
        if resp.status_code >= 400:
            raise CurseForgeError(f"获取 MC 版本清单失败 HTTP {resp.status_code}")
        data = resp.json() or {}
        return [{"id": v.get("id"), "type": v.get("type")} for v in data.get("versions", [])]

    # -------- 下载 --------

    async def download_file(self, url, dest_path, expected_sha1=None, expected_sha512=None,
                            expected_murmur2=None, progress_cb=None):
        """流式下载，与 ModrinthClient.download_file 行为一致：
        - .part 临时文件 + Range 续传
        - 哈希校验：优先 sha512，其次 sha1，其次 murmur2
        - 限速通过 settings.rate_limiter()

        由于 CurseForge 提供的 hashes 种类与 Modrinth 不同（主要有 sha1/murmur2），
        本方法接受多种 hash 参数。
        """
        dest_path = Path(dest_path)
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        part_path = dest_path.with_suffix(dest_path.suffix + ".part")
        sha1_ctx = hashlib.sha1() if expected_sha1 else None
        sha512_ctx = hashlib.sha512() if expected_sha512 else None
        # murmur2 需要单独的实现，我们只在下载完整个文件后一次性计算（简单起见）
        all_bytes = bytearray() if expected_murmur2 else None

        existing_bytes = 0
        if part_path.is_file():
            existing_bytes = part_path.stat().st_size

        # 复用 ModrinthClient 一样的 Range 探测 + 续传逻辑（此处复制以避免循环导入，
        # 后续可抽独立 mixin，但保持模块独立更易维护）
        total_server = await self._probe_range_support(url) if existing_bytes > 0 else 0
        resume = existing_bytes > 0 and total_server > 0 and existing_bytes < total_server

        if existing_bytes > 0 and total_server > 0 and existing_bytes >= total_server:
            resume = False
            existing_bytes = 0
            try:
                part_path.unlink()
            except OSError:
                pass

        if resume:
            try:
                with open(part_path, "rb") as f:
                    while True:
                        block = f.read(1024 * 1024)
                        if not block:
                            break
                        if sha1_ctx:
                            sha1_ctx.update(block)
                        if sha512_ctx:
                            sha512_ctx.update(block)
                        if all_bytes is not None:
                            all_bytes.extend(block)
            except OSError:
                resume = False
                existing_bytes = 0
                part_path.unlink(missing_ok=True)
                sha1_ctx = hashlib.sha1() if expected_sha1 else None
                sha512_ctx = hashlib.sha512() if expected_sha512 else None
                all_bytes = bytearray() if expected_murmur2 else None

        downloaded = existing_bytes
        total_size = total_server if resume else 0
        headers = {"Range": f"bytes={existing_bytes}-"} if resume else {}

        try:
            async with self._client.stream("GET", url, headers=headers) as resp:
                if resp.status_code >= 400:
                    if resume and resp.status_code in (416, 413, 417):
                        part_path.unlink(missing_ok=True)
                        return await self.download_file(url, dest_path, expected_sha1,
                                                        expected_sha512, expected_murmur2, progress_cb)
                    raise CurseForgeError(f"下载失败 HTTP {resp.status_code}: {url}")
                if not total_size:
                    total_size = int(resp.headers.get("content-length", 0))
                    if resume:
                        cr = resp.headers.get("Content-Range", "")
                        if cr and "/" in cr:
                            t = cr.split("/", 1)[-1].strip()
                            if t.isdigit():
                                total_size = int(t)
                            else:
                                total_size += existing_bytes
                        else:
                            total_size += existing_bytes

                write_mode = "ab" if resume and resp.status_code == 206 else "wb"
                if write_mode == "wb" and part_path.is_file():
                    try:
                        part_path.unlink()
                    except OSError:
                        pass
                downloaded = 0 if write_mode == "wb" else existing_bytes
                if write_mode == "wb":
                    sha1_ctx = hashlib.sha1() if expected_sha1 else None
                    sha512_ctx = hashlib.sha512() if expected_sha512 else None
                    all_bytes = bytearray() if expected_murmur2 else None

                with open(part_path, write_mode) as f:
                    async for chunk in resp.aiter_bytes(chunk_size=65536):
                        f.write(chunk)
                        if sha1_ctx:
                            sha1_ctx.update(chunk)
                        if sha512_ctx:
                            sha512_ctx.update(chunk)
                        if all_bytes is not None:
                            all_bytes.extend(chunk)
                        downloaded += len(chunk)
                        await get_settings().rate_limiter().acquire(len(chunk))
                        if progress_cb:
                            await progress_cb(downloaded, total_size)
        except (httpx.HTTPError, OSError) as e:
            raise CurseForgeError(f"下载中断: {url} ({e})") from e

        # 哈希校验
        if expected_sha512 and sha512_ctx:
            actual = sha512_ctx.hexdigest()
            if actual.lower() != str(expected_sha512).lower():
                part_path.unlink(missing_ok=True)
                raise CurseForgeError(f"SHA512 校验失败")
        if expected_sha1 and sha1_ctx:
            actual = sha1_ctx.hexdigest()
            if actual.lower() != str(expected_sha1).lower():
                part_path.unlink(missing_ok=True)
                raise CurseForgeError(f"SHA1 校验失败")
        if expected_murmur2 and all_bytes is not None:
            actual = str(_murmur2_java(bytes(all_bytes)))
            if actual != str(expected_murmur2):
                part_path.unlink(missing_ok=True)
                raise CurseForgeError(f"murmur2 校验失败")

        try:
            if dest_path.is_file():
                dest_path.unlink()
            part_path.rename(dest_path)
        except OSError as e:
            part_path.unlink(missing_ok=True)
            raise CurseForgeError(f"重命名下载结果失败: {e}") from e
        return downloaded

    async def _probe_range_support(self, url):
        try:
            resp = await self._client.request(
                "GET", url, headers={"Range": "bytes=0-0"}, timeout=10.0)
        except (httpx.HTTPError, OSError):
            return 0
        if resp.status_code == 206:
            cr = resp.headers.get("Content-Range", "")
            if cr and "/" in cr:
                t = cr.split("/", 1)[-1].strip()
                if t.isdigit():
                    return int(t)
            accept = resp.headers.get("Accept-Ranges", "")
            if "bytes" in accept.lower():
                cl = resp.headers.get("Content-Length", "")
                if cl.isdigit():
                    return int(cl)
        return 0


# ============================================================
# CurseForge murmur2 hash (Java 兼容实现，用于文件指纹匹配)
# CurseForge 使用的是 murmur2 32bit 变体：去除 0x9e3779b9 seed，并对尾部 \r\n 空格做白化
# 参考 CurseForge 官方文档与 community 实现
# ============================================================

def _murmur2_java(data: bytes, seed: int = 1) -> int:
    """CurseForge/Java 兼容的 MurmurHash2 (32-bit)。

    - 跳过 whitespace (\r \n \t 空格)
    - 处理方式与原版 CurseForge Client 保持一致
    """
    # Step 1: 白名单字节
    stripped = bytearray()
    for b in data:
        if b not in (0x09, 0x0A, 0x0D, 0x20):
            stripped.append(b)
    data = bytes(stripped)
    length = len(data)
    m = 0x5BD1E995
    r = 24
    h = seed ^ length
    idx = 0
    while length >= 4:
        k = (data[idx] | (data[idx + 1] << 8) |
             (data[idx + 2] << 16) | (data[idx + 3] << 24))
        k = (k * m) & 0xFFFFFFFF
        k ^= k >> r
        k = (k * m) & 0xFFFFFFFF
        h = (h * m) & 0xFFFFFFFF
        h ^= k
        idx += 4
        length -= 4
    # 尾部 3/2/1 字节
    if length == 3:
        h ^= (data[idx + 2] << 16) & 0xFFFFFFFF
    if length in (2, 3):
        h ^= (data[idx + 1] << 8) & 0xFFFFFFFF
    if length in (1, 2, 3):
        h ^= data[idx]
        h = (h * m) & 0xFFFFFFFF
    # Final mix
    h ^= h >> 13
    h = (h * m) & 0xFFFFFFFF
    h ^= h >> 15
    # 转成有符号 32-bit
    if h >= 0x80000000:
        h -= 0x100000000
    return h


def compute_cf_murmur2(file_path) -> str:
    """计算文件的 CurseForge murmur2 指纹，返回字符串。"""
    with open(file_path, "rb") as f:
        data = f.read()
    return str(_murmur2_java(data))
