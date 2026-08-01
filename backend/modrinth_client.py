"""Modrinth v2 公开 API 异步客户端封装

严格遵守 Modrinth API 规范：
- 配置合法 User-Agent（Modrinth 强制要求标注项目名）
- 控制请求频率，避免触发 429 限流（官方限流 300 次 / 60 秒）
- 公开 API，无需 Token
- 文件下载附带 sha512 校验
"""
import asyncio
import hashlib
import json
import time
from pathlib import Path

import httpx

from .settings import get_settings

# 合法 User-Agent：Modrinth 要求格式 "项目名/版本 (描述/联系方式)"
USER_AGENT = "ModList-Weaver/1.0 (Minecraft mod migration desktop tool)"
# Modrinth v2 API 基址
BASE_URL = "https://api.modrinth.com/v2"
# Mojang 官方版本清单（用于下拉框获取游戏版本）
MC_VERSION_MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
# 请求最小间隔（秒），保守控制频率
MIN_REQUEST_INTERVAL = 0.25
# 文件下载重试次数
DOWNLOAD_MAX_RETRIES = 3


class ModrinthError(Exception):
    """Modrinth API 业务异常"""


class ModrinthClient:
    """异步 Modrinth API 客户端

    所有 API 查询请求经过统一节流与重试逻辑；
    文件下载走 CDN，不节流，但做 sha512 校验。
    """

    def __init__(self):
        headers = {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        self._client = httpx.AsyncClient(headers=headers, timeout=30.0, follow_redirects=True)
        self._last_request_time = 0.0
        self._lock = asyncio.Lock()

    async def close(self):
        """关闭底层 HTTP 连接"""
        await self._client.aclose()

    async def _throttle(self):
        """请求节流：保证两次 API 请求之间至少间隔 MIN_REQUEST_INTERVAL"""
        async with self._lock:
            now = time.monotonic()
            elapsed = now - self._last_request_time
            if elapsed < MIN_REQUEST_INTERVAL:
                await asyncio.sleep(MIN_REQUEST_INTERVAL - elapsed)
            self._last_request_time = time.monotonic()

    async def _request(self, method, path, **kwargs):
        """通用 API 请求：处理 429 限流、5xx 服务端错误重试、4xx 抛业务异常"""
        max_retries = 4
        last_error = None
        for attempt in range(max_retries):
            await self._throttle()
            try:
                resp = await self._client.request(method, f"{BASE_URL}{path}", **kwargs)
            except (httpx.RequestError, httpx.TimeoutException) as e:
                # 网络超时 / 连接错误，退避重试
                last_error = e
                await asyncio.sleep(1.0 * (attempt + 1))
                continue

            # 429 限流：读取 Retry-After 后重试
            if resp.status_code == 429:
                retry_after = float(resp.headers.get("Retry-After", "2"))
                await asyncio.sleep(max(retry_after, 1.0))
                continue
            # 404 资源不存在，返回 None 由调用方判断
            if resp.status_code == 404:
                return None
            # 5xx 服务端错误，退避重试
            if resp.status_code >= 500:
                await asyncio.sleep(1.0 * (attempt + 1))
                continue
            # 其他 4xx 直接抛业务异常
            if resp.status_code >= 400:
                raise ModrinthError(f"HTTP {resp.status_code}: {resp.text[:300]}")

            # 成功响应
            if resp.status_code == 204 or not resp.text:
                return None
            return resp.json()

        raise ModrinthError(
            f"请求 {path} 失败，超过最大重试次数: {last_error or '服务端持续限流或错误'}")

    # ==================== 查询接口 ====================

    async def search_mods(self, query, game_version=None, loader=None, limit=10, offset=0, project_type=None):
        """搜索模组

        :param query: 搜索关键词（项目名/slug）
        :param game_version: 可选，按游戏版本过滤
        :param loader: 可选，按加载器过滤（fabric/forge/neoforge/quilt）
        :param limit: 返回数量上限
        :param offset: 分页偏移量
        :param project_type: 可选，按项目类型过滤（mod/modpack/resourcepack/...）
        :return: Modrinth search 响应 dict
        """
        facets = []
        if game_version:
            facets.append([f"versions:{game_version}"])
        if loader:
            facets.append([f"categories:{loader}"])
        if project_type:
            facets.append([f"project_type:{project_type}"])
        params = {"query": query, "limit": limit, "offset": offset, "index": "relevance"}
        if facets:
            # facets 是嵌套数组，Modrinth 要求 JSON 字符串
            params["facets"] = json.dumps(facets)
        return await self._request("GET", "/search", params=params)

    async def get_project(self, project_id):
        """根据 project_id 或 slug 获取项目详情"""
        return await self._request("GET", f"/project/{project_id}")

    async def get_team(self, team_id):
        """根据团队 ID 获取团队成员（作者）列表"""
        return await self._request("GET", f"/team/{team_id}/members")

    async def get_versions_by_project(self, project_id, game_versions=None, loaders=None):
        """获取项目的版本列表，可按游戏版本与加载器过滤

        Modrinth 默认按发布时间降序返回，因此首个匹配项即为最新版本。
        """
        params = {}
        if game_versions:
            params["game_versions"] = json.dumps(game_versions)
        if loaders:
            params["loaders"] = json.dumps(loaders)
        return await self._request("GET", f"/project/{project_id}/version", params=params)

    async def get_version(self, version_id):
        """根据 version_id 获取版本详情"""
        return await self._request("GET", f"/version/{version_id}")

    async def get_files_by_hashes(self, hashes, algorithm="sha512"):
        """通过文件哈希批量反查版本信息

        :param hashes: 哈希值列表
        :param algorithm: 哈希算法（sha1/sha512）
        :return: {hash: version_object} 映射
        """
        if not hashes:
            return {}
        body = {"hashes": hashes, "algorithm": algorithm}
        return await self._request("POST", "/version_files", json=body) or {}

    async def get_mc_versions(self):
        """获取 Minecraft 官方版本列表（稳定版 + 快照版，按发布时间降序）

        :return: [{"id": "1.21.1", "type": "release"}, ...]
        """
        try:
            resp = await self._client.get(MC_VERSION_MANIFEST)
        except httpx.RequestError as e:
            raise ModrinthError(f"获取 MC 版本清单失败: {e}") from e
        if resp.status_code >= 400:
            raise ModrinthError(f"获取 MC 版本清单失败 HTTP {resp.status_code}")
        data = resp.json() or {}
        versions = []
        for v in data.get("versions", []):
            versions.append({"id": v.get("id"), "type": v.get("type")})
        return versions

    # ==================== 文件下载 ====================

    async def _probe_range_support(self, url):
        """轻量探测目标 URL 是否支持 Range 请求（返回 206 + Accept-Ranges: bytes）

        不支持时返回 0，表示应整文件从头下载；支持时返回服务端报告的总字节数。
        """
        try:
            resp = await self._client.request(
                "GET", url, headers={"Range": "bytes=0-0"}, timeout=10.0)
        except (httpx.HTTPError, OSError):
            return 0
        if resp.status_code == 206:
            # 206 Partial Content：服务端支持 Range
            content_range = resp.headers.get("Content-Range", "")
            # Content-Range: bytes 0-0/12345
            if content_range and "/" in content_range:
                total = content_range.split("/", 1)[-1].strip()
                if total.isdigit():
                    return int(total)
            accept = resp.headers.get("Accept-Ranges", "")
            if "bytes" in accept.lower():
                total = resp.headers.get("Content-Length", "")
                if total.isdigit():
                    return int(total)
        # 200 或无 Range 支持
        return 0

    async def download_file(self, url, dest_path, expected_sha512=None, progress_cb=None):
        """流式下载文件，支持断点续传（Range），完成后 sha512 校验

        策略：
          1. 使用 .part 临时文件作为下载载体，避免半成品冒充成品
          2. 下载前探测 Range 支持；若支持且 .part 已存在，从断点续传
          3. 不支持 Range 或首次下载时，从头开始
          4. 全部字节下载完成后，原子 rename 为最终 dest_path

        :param url: 文件下载直链（来自 version.files[].url）
        :param dest_path: 本地保存最终路径
        :param expected_sha512: 期望的 sha512（来自 version.files[].hashes.sha512）
        :param progress_cb: 异步进度回调 async cb(done_bytes, total_bytes)
        :return: 已下载字节数
        :raises ModrinthError: 哈希校验失败或下载失败
        """
        dest_path = Path(dest_path)
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        part_path = dest_path.with_suffix(dest_path.suffix + ".part")
        sha = hashlib.sha512()

        # 1. 确定已有的 .part 大小（断点字节数）与 Range 支持情况
        existing_bytes = 0
        if part_path.is_file():
            existing_bytes = part_path.stat().st_size
        total_server = await self._probe_range_support(url) if existing_bytes > 0 else 0
        resume = existing_bytes > 0 and total_server > 0 and existing_bytes < total_server

        # 如断点字节数 >= 服务端报告的总大小，可能 .part 已经完整（只是上次 crash 没改名）
        if existing_bytes > 0 and total_server > 0 and existing_bytes >= total_server:
            resume = False
            existing_bytes = 0
            try:
                part_path.unlink()
            except OSError:
                pass

        # 断点续传：先把 .part 已有内容喂入 sha 计算，保证最终校验一致
        if resume:
            try:
                with open(part_path, "rb") as f:
                    while True:
                        block = f.read(1024 * 1024)
                        if not block:
                            break
                        sha.update(block)
            except OSError as e:
                resume = False
                existing_bytes = 0
                part_path.unlink(missing_ok=True)
                sha = hashlib.sha512()

        downloaded = existing_bytes
        total_size = total_server if resume else 0

        # 2. 构造请求：续传时带 Range: bytes={existing}-
        headers = {}
        if resume:
            headers["Range"] = f"bytes={existing_bytes}-"

        try:
            async with self._client.stream("GET", url, headers=headers) as resp:
                if resp.status_code >= 400:
                    # 如续传请求 416 Range Not Satisfiable 等：降级为整文件下载
                    if resume and resp.status_code in (416, 413, 417):
                        part_path.unlink(missing_ok=True)
                        # 重新递归一次（降级路径）
                        return await self.download_file(url, dest_path, expected_sha512, progress_cb)
                    raise ModrinthError(f"下载失败 HTTP {resp.status_code}: {url}")

                if not total_size:
                    total_size = int(resp.headers.get("content-length", 0))
                    if resume:
                        # 续传 206 的 content-length 是剩余字节，总字节要加断点
                        cr = resp.headers.get("Content-Range", "")
                        if cr and "/" in cr:
                            t = cr.split("/", 1)[-1].strip()
                            if t.isdigit():
                                total_size = int(t)
                            else:
                                total_size = total_size + existing_bytes
                        else:
                            total_size = total_size + existing_bytes

                write_mode = "ab" if resume and resp.status_code == 206 else "wb"
                if write_mode == "wb" and part_path.is_file():
                    try:
                        part_path.unlink()
                    except OSError:
                        pass
                downloaded = 0 if write_mode == "wb" else existing_bytes

                try:
                    with open(part_path, write_mode) as f:
                        async for chunk in resp.aiter_bytes(chunk_size=65536):
                            f.write(chunk)
                            sha.update(chunk)
                            downloaded += len(chunk)
                            await get_settings().rate_limiter().acquire(len(chunk))
                            if progress_cb:
                                await progress_cb(downloaded, total_size)
                except asyncio.CancelledError:
                    # 任务被用户停止：保留 .part 以便下次续传
                    raise
        except (httpx.HTTPError, OSError) as e:
            # 流式传输中断：保留 .part，归一化为 ModrinthError 供上层重试
            raise ModrinthError(f"下载中断: {url} ({e})") from e

        # 3. 哈希校验
        if expected_sha512:
            actual = sha.hexdigest()
            if actual.lower() != expected_sha512.lower():
                part_path.unlink(missing_ok=True)
                raise ModrinthError(
                    f"哈希校验失败: 期望 {expected_sha512[:16]}... 实际 {actual[:16]}..."
                )

        # 4. 原子改名：.part -> 最终文件（若目标已存在，在 Windows 下必须先删）
        try:
            if dest_path.is_file():
                dest_path.unlink()
            part_path.rename(dest_path)
        except OSError as e:
            part_path.unlink(missing_ok=True)
            raise ModrinthError(f"重命名下载结果失败: {e}") from e

        return downloaded
