"""应用设置：并发数、网速限制、主题等常用参数

- 持久化到 cache/settings.json
- 运行时可热更新（下载线程 / 队列调度每次读取最新值）
- 提供 token-bucket 网速限制器，供文件下载流式限速
"""
import asyncio
import json
import time
from pathlib import Path

DEFAULT_SETTINGS = {
    "max_concurrency": 3,   # 同时运行的最大下载任务数
    "rate_limit_mbps": 0,   # 网速限制（MB/s），0 表示不限速
    "theme": "auto",        # auto / light / dark（前端偏好）
}

SETTINGS_FILE = "settings.json"

_inst = None


def init_settings(root_dir):
    """初始化全局设置单例（应在应用启动时调用一次）"""
    global _inst
    _inst = Settings(root_dir)
    return _inst


def get_settings():
    """获取全局设置单例（未初始化时按项目根目录懒加载）"""
    global _inst
    if _inst is None:
        _inst = Settings(Path(__file__).resolve().parent.parent)
    return _inst


class RateLimiter:
    """令牌桶限速器：控制全局下行带宽"""

    def __init__(self, bytes_per_sec=0):
        self._bps = float(bytes_per_sec)
        self._tokens = 0.0
        self._last = time.monotonic()
        self._lock = asyncio.Lock()

    def update(self, bytes_per_sec):
        self._bps = float(bytes_per_sec or 0)

    async def acquire(self, n):
        """等待足以容纳 n 字节的带宽（不限速时立即返回）"""
        bps = self._bps
        if bps <= 0 or n <= 0:
            return
        while True:
            async with self._lock:
                now = time.monotonic()
                self._tokens += (now - self._last) * bps
                self._last = now
                if self._tokens > bps * 2:
                    self._tokens = bps * 2  # 防止长空闲后突发
                if self._tokens >= n:
                    self._tokens -= n
                    return
                need = (n - self._tokens) / bps
                self._tokens = 0.0
            await asyncio.sleep(need)


class Settings:
    """全局设置（单例）"""

    def __init__(self, root_dir):
        self._path = Path(root_dir) / "cache" / SETTINGS_FILE
        self._data = dict(DEFAULT_SETTINGS)
        self._limiter = RateLimiter()
        self.load()

    def load(self):
        try:
            if self._path.is_file():
                data = json.loads(self._path.read_text(encoding="utf-8"))
                for k, v in DEFAULT_SETTINGS.items():
                    if k in data:
                        self._data[k] = data[k]
        except (OSError, json.JSONDecodeError):
            pass
        self._apply_limiter()

    def save(self):
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._path.write_text(
                json.dumps(self._data, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError:
            pass

    def _apply_limiter(self):
        mbps = int(self._data.get("rate_limit_mbps", 0) or 0)
        self._limiter.update(mbps * 1024 * 1024)

    def get(self):
        return dict(self._data)

    def update(self, patch):
        changed = False
        for k, v in (patch or {}).items():
            if k in DEFAULT_SETTINGS:
                self._data[k] = v
                changed = True
        if changed:
            self._apply_limiter()
            self.save()

    def max_concurrency(self):
        return max(1, int(self._data.get("max_concurrency", 3) or 1))

    def rate_limiter(self):
        return self._limiter
