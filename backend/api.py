"""FastAPI REST 接口定义

接口列表：
  GET  /api/version              当前软件版本 + 版本历史（Changelog）
  POST /api/scan_mods            扫描 mods 目录，返回模组列表 + project_id 反查结果
  POST /api/check_updates        检测已识别模组是否有新版本（V3.1）
  POST /api/export_json          生成 modlist 并保存本地
  POST /api/download_from_list   读取 modlist 启动批量下载（进入下载队列）
  POST /api/search_mod           关键词搜索 Modrinth 模组（分页/筛选）
  GET  /api/project/{id}         模组详情（图标/版本/作者/简介）
  GET  /api/project_page         模组主页 URL（「打开源页面」用，V3.2）
  GET  /api/mc_versions          获取 Minecraft 官方版本列表（下拉框用）
  POST /api/download_single_mod  单模组 + 前置依赖下载（进入下载队列）
  GET  /api/queue                下载队列快照（进行中 + 已完成历史）
  POST /api/task_pause           暂停下载任务
  POST /api/task_resume          继续下载任务
  POST /api/task_stop            停止下载任务
  POST /api/task_delete          删除下载任务
  GET  /api/task_status          轮询下载任务进度
  GET  /api/logs/{id}            读取任务日志缓存（cache/logs）
  GET  /api/logs/{id}/download   导出任务日志为 .log 文件
  POST /api/retry_task           将失败/缺失模组重新加入下载队列
  POST /api/open_folder          在资源管理器中打开文件夹
  GET  /api/pick_folder          原生文件夹选择对话框
  GET  /api/pick_file            原生文件选择对话框
  GET  /api/pick_save            原生保存路径对话框
  GET  /api/check_app_update     检查软件是否有新版本（GitHub Release，V3.1）
  POST /api/import_modlist       导入拖拽的 modlist.json 内容（V3.1）
  GET  /api/storage_info         缓存占用统计（日志/临时文件/历史，V3.2）
  POST /api/clear_cache          清理缓存：logs / dropped / history（V3.2）
"""
import json
import os
import sys
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .modrinth_client import ModrinthClient, ModrinthError
from .curseforge_client import CurseForgeClient, CurseForgeError
from .scanner import scan_mods
from .downloader import (
    TaskManager, run_batch_download, run_single_download,
    _pick_best_version, _pick_primary_from_version,
)
from .settings import init_settings, get_settings

# ============================================================
# 版本信息（单一事实来源：标题栏、关于页、CI tag 均以此为准）
# 每次大版本发布更新此处，前端会通过 /api/version 自动显示
# ============================================================
CURRENT_VERSION = "3.2.0"
APP_TITLE = "ModList-Weaver"

# 软件内 Changelog（与「关于」页保持一致的结构化历史）
# 新增版本直接在头部插入，date 格式 YYYY-MM
CHANGELOG = [
    {
        "version": "3.2.0",
        "date": "2026-08",
        "title": "打开源页面 · 存储清理 · 应用图标 · 下载完成通知 · 移除作者头像",
        "items": [
            "【打开源页面】模组列表 / 模组目录 / 详情页新增「源页面」按钮，一键跳转 Modrinth / CurseForge 项目主页。",
            "【存储与清理】设置页新增「存储与清理」：展示日志 / 导入临时文件 / 任务历史占用，支持一键清理。",
            "【应用图标】新增应用图标（assets/app.ico），可执行文件与窗口图标统一。",
            "【下载完成通知】全部任务结束时 toast + 提示音 + 系统通知提醒，并汇总成功 / 失败数量。",
            "「关于」页移除作者头像（head.png），仅保留作者名与 GitHub 链接。",
        ],
    },
    {
        "version": "3.1.0",
        "date": "2026-08",
        "title": "模组更新检测 · 软件自动更新 · 断点恢复 · 拖拽导入",
        "items": [
            "【模组更新检测】步骤 2 新增「检查更新」按钮：按模组所属源（Modrinth / CurseForge）拉取最新适配版本，与已安装版本比对，命中更新在列表标黄徽章显示最新版本号，并汇总更新数量。",
            "【软件自动更新检查】启动时静默检查 GitHub Release，发现新版本在页面顶部弹出更新横幅，支持一键跳转下载或忽略本次版本（「关于」页亦可手动检查）。",
            "【断点恢复】进程异常退出后，重启自动恢复未完成任务（cache/temp/active.json），按原参数重新排队执行。",
            "【拖拽导入】桌面窗口支持将 .json 模组清单直接拖入任意区域完成导入，自动跳到批量下载第一步；非桌面环境降级为浏览器原生拖拽读取。",
            "【工程化】移除根目录冗余 static/ 目录（静态资源统一由 frontend/ 提供），前端资产打包与路径不受影响。",
            "【测试】新增 tests/test_resume_and_updates.py（断点恢复、版本比较、更新检测、清单导入），pytest 35/35 通过。",
        ],
    },
    {
        "version": "3.0.1",
        "date": "2026-08",
        "title": "更新日志并入关于页 · 作者头像修复",
        "items": [
            "「更新日志」并入「关于」页面：关于页直接展示完整版本历史，最新版本默认展开，历史版本自动折叠，可点击版本号展开/收起。",
            "侧边栏移除独立「更新日志」入口，导航更精简。",
            "修复关于页作者头像无法显示的问题（静态资源路径指向错误，/src → /static/src）。",
        ],
    },
    {
        "version": "3.0.0",
        "date": "2026-08",
        "title": "断点续传 + CurseForge 双源 + 自动化 CI/CD",
        "items": [
            "【断点续传】下载中断后保留 .part 临时文件，HTTP Range 请求从断点续传，避免重复下载浪费带宽（Modrinth / CurseForge 双客户端一致实现）。",
            "【CurseForge 双源支持】新增独立 CurseForge 客户端：murmur2 指纹匹配、项目搜索、版本列表、依赖递归、文件下载、服务端 429 速率节流自适应。",
            "【多源自动路由】settings.source = auto / modrinth / curseforge；扫描阶段 Modrinth sha512 未命中时自动 fallback CurseForge murmur2，识别率显著提升。",
            "【多算法哈希校验】优先级自适应：sha512 > sha1 > murmur2，按源 API 返回的可用字段选择最可靠的校验方案。",
            "【pytest 单测 29/29 PASS】新增 tests/ 三套用例：scanner 哈希与 jar 解析、downloader 版本选择/TaskGate/限速器/哈希策略、CurseForge murmur2 + Settings 持久化边界。",
            "【GitHub Actions CI/CD】push/PR：2 OS × 3 Python 跑单测矩阵；main/master/v* tag：PyInstaller 自动打 Windows 包；打 v* 正式 tag：自动上传 .zip 到 GitHub Release 并生成发布说明。",
            "【工程化】build.spec 补 backend.*、hashlib 等 hiddenimports；requirements.txt 加入 pytest 开发依赖；.gitignore 补 build/ dist/ .pytest_cache/。",
        ],
    },
    {
        "version": "2.5",
        "date": "2026-07",
        "title": "交互细节与 UI 稳定性",
        "items": [
            "修复批量下载勾选模组后「下一步：目标配置」按钮无响应的问题。",
            "修复任务 / 历史列表删除按钮缺少图标的问题（并补上「继续」按钮图标）。",
            "结算页信息卡片重新排版：「任务」「保存目录」「清单文件」独占整行，长文本不再挤压错位。",
            "进入结算页新增淡入上滑过渡动画。",
        ],
    },
    {
        "version": "2.4",
        "date": "2026-06",
        "title": "设置页 · 主题 · 四步下载向导",
        "items": [
            "新增「设置」页：最大并发下载数（默认 3）与全局网速限制，可热更新即时生效。",
            "支持明暗主题，顶栏一键切换，偏好持久化。",
            "批量下载改为四步向导：新增清单预览与勾选步骤，可按需选择下载模组。",
            "任务详情改为双进度条：总任务进度 + 当前文件进度。",
            "结算页合并失败 / 缺失为统一列表，按类型着色并标注原因，支持「查找类似」。",
            "模组详情版本列表支持折叠展开更新日志。",
            "精简各处说明性文字，界面更聚焦。",
        ],
    },
    {
        "version": "2.2",
        "date": "2026-05",
        "title": "任务持久化 · 结算页 · 更新日志页",
        "items": [
            "「批量下载」改为三步向导，「模组列表」去除步骤编号。",
            "所有版本输入改为下拉选择（读取 Minecraft 官方版本列表）。",
            "任务中心拆分为「进行中 / 已完成」：终态任务持久化本机，重启不丢失。",
            "日志不再内嵌刷新，改为「查看日志 / 导出日志」，日志归档于 cache/logs。",
            "新增任务结算页：查看失败 / 缺失明细、重试、打开源 / 目标目录。",
            "新增独立「更新日志」页；「关于」改为独立分类并展示作者头像。",
            "修复任务中心删除按钮显示异常、面包屑根节点固定不变等问题。",
        ],
    },
    {
        "version": "2.1",
        "date": "2026-05",
        "title": "模组列表 · 单模组下载 · 关于页",
        "items": [
            "合并「搜索 & 单模组」与「模组详情」为「模组列表」页，分页展示，支持筛选与搜索。",
            "模组详情页新增一键下载（含 required 前置依赖）。",
            "新增「关于」页面，展示本软件更新日志与作者信息。",
        ],
    },
    {
        "version": "2.0",
        "date": "2026-04",
        "title": "下载队列 · 任务中心 · 扫描向导",
        "items": [
            "新增下载队列：排队执行，支持暂停、继续、停止与删除。",
            "新增模组详情页（图标、版本、作者、简介）。",
            "扫描导出改为三步向导，支持勾选自定义导出，未识别模组标灰置顶。",
            "任务中心重新排版，长文件名友好展示。",
        ],
    },
    {
        "version": "1.0",
        "date": "2026-04",
        "title": "MVP 首发：扫描 → 导出 → 批量下载",
        "items": [
            "扫描 mods 目录并通过文件哈希反查 Modrinth 项目。",
            "导出 modlist.json。",
            "批量 / 单模组下载（自动解析 required 前置依赖）。",
        ],
    },
]

app = FastAPI(title=f"{APP_TITLE} API", docs_url=None, redoc_url=None)


def _resolve_frontend_dir():
    """解析前端静态资源目录，兼容开发态与 PyInstaller 打包态"""
    # 1. 开发模式：backend/api.py 的上两级 / frontend
    dev = Path(__file__).resolve().parent.parent / "frontend"
    if dev.is_dir():
        return dev
    # 2. PyInstaller onefile 模式：sys._MEIPASS / frontend
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        frozen = Path(meipass) / "frontend"
        if frozen.is_dir():
            return frozen
    # 3. PyInstaller COLLECT 目录模式：可执行文件同级 / frontend
    exe_dir = Path(sys.executable).resolve().parent
    frozen2 = exe_dir / "frontend"
    if frozen2.is_dir():
        return frozen2
    return dev


_FRONTEND_DIR = _resolve_frontend_dir()
if _FRONTEND_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=str(_FRONTEND_DIR)), name="static")

# 初始化全局设置（并发数 / 网速限制）与任务管理器 / 客户端
init_settings(_FRONTEND_DIR.parent if _FRONTEND_DIR.is_dir() else Path.cwd())

# 全局下载源客户端（httpx 连接池复用）
client = ModrinthClient()
cf_client = CurseForgeClient()
# 全局任务管理器
task_manager = TaskManager()


def _build_task_factory(kind, params, state):
    """根据持久化参数重建下载任务的 run_factory（用于重启后断点恢复）"""
    if kind == "batch":
        async def _factory(gate):
            return await run_batch_download(
                client, params.get("json_path"), params.get("mc_version"),
                params.get("loader"), params.get("save_dir"), state, gate,
                project_ids=params.get("project_ids"),
                cf_client=cf_client, global_source=params.get("source"))
        return _factory

    async def _factory(gate):
        return await run_single_download(
            client, params.get("project_id"), params.get("mc_version"),
            params.get("loader"), params.get("save_dir"), state, gate,
            cf_client=cf_client, force_source=params.get("source"))
    return _factory


@app.on_event("startup")
async def _resume_interrupted_tasks():
    """启动时自动恢复上次未完成的下载任务（断点恢复）"""
    try:
        await task_manager.resume_active(_build_task_factory)
    except Exception:
        # 恢复失败不影响主流程
        pass


@app.get("/")
async def index():
    """返回前端首页"""
    return FileResponse(str(_FRONTEND_DIR / "index.html"))


@app.get("/about")
async def about():
    """"关于"页面：与首页共用同一前端资源"""
    return FileResponse(str(_FRONTEND_DIR / "index.html"))


@app.get("/api/version")
async def api_version():
    """返回当前软件版本、App 标题、完整版本历史（软件内「更新日志」页自动渲染）"""
    return {
        "title": APP_TITLE,
        "version": CURRENT_VERSION,
        "display": f"{APP_TITLE} v{CURRENT_VERSION}",
        "changelog": CHANGELOG,
        "release_download": f"https://github.com/JonathanSssst/{APP_TITLE}/releases/tag/v{CURRENT_VERSION}",
    }


# ==================== 软件更新检查 / 清单导入（V3.1） ====================

class CheckUpdatesRequest(BaseModel):
    mods: list = []  # [{project_id, version_id, version_number, version_name, source, name}]
    mc_version: Optional[str] = None
    loader: Optional[str] = None


class ImportModlistRequest(BaseModel):
    filename: Optional[str] = "modlist.json"
    content: str


_GITHUB_REPO = "JonathanSssst/ModList-Weaver"
USER_AGENT_FOR_APP_UPDATE = "ModList-Weaver/3.1 (app update check)"
_app_update_cache = {"t": 0.0, "data": None}
_APP_UPDATE_TTL = 3600  # 缓存 1 小时


def _parse_version(v):
    """解析 'v3.1.0' / '3.1.0' 为 (major, minor, patch)，解析失败返回 None"""
    s = str(v or "").strip().lower()
    if s.startswith("v"):
        s = s[1:]
    parts = []
    for seg in s.split("."):
        digits = "".join(ch for ch in seg if ch.isdigit())
        parts.append(int(digits) if digits else 0)
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts[:3])


@app.get("/api/check_app_update")
async def api_check_app_update(force: bool = False):
    """检查 GitHub Release 是否有新版本（V3.1，1 小时内存缓存）

    返回 has_update 标记与最新版信息；网络异常时填充 error 字段供前端提示。
    """
    global _app_update_cache
    now = time.time()
    if not force and _app_update_cache["data"] and now - _app_update_cache["t"] < _APP_UPDATE_TTL:
        return _app_update_cache["data"]

    result = {
        "current_version": CURRENT_VERSION,
        "latest_version": CURRENT_VERSION,
        "has_update": False,
        "release_url": "",
        "published_at": "",
        "body": "",
        "error": "",
    }
    try:
        resp = await client._client.get(
            f"https://api.github.com/repos/{_GITHUB_REPO}/releases/latest",
            headers={"User-Agent": USER_AGENT_FOR_APP_UPDATE, "Accept": "application/vnd.github+json"},
            timeout=15.0)
        if resp.status_code == 404:
            result["error"] = "未找到 Release"
        elif resp.status_code >= 400:
            result["error"] = f"GitHub API HTTP {resp.status_code}"
        else:
            data = resp.json() or {}
            tag = data.get("tag_name") or ""
            latest = _parse_version(tag)
            current = _parse_version(CURRENT_VERSION)
            if latest and current:
                result["has_update"] = latest > current
            result["latest_version"] = tag.lstrip("v") or "未知"
            result["release_url"] = data.get("html_url") or ""
            result["published_at"] = (data.get("published_at") or "")[:10]
            result["body"] = (data.get("body") or "")[:2000]
    except Exception as e:
        result["error"] = str(e)[:200]
    _app_update_cache = {"t": now, "data": result}
    return result


@app.post("/api/import_modlist")
async def api_import_modlist(req: ImportModlistRequest):
    """导入拖拽的 modlist.json 内容（V3.1）

    浏览器沙箱无法直接获取绝对路径，前端读取文件内容后提交，
    后端落盘到 cache/temp/dropped 并返回文件路径供批量下载流程使用。
    """
    if not req.content or not req.content.strip():
        raise HTTPException(status_code=400, detail="清单内容为空")
    try:
        json.loads(req.content)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail=f"清单不是合法 JSON: {e}")
    safe_name = "".join(ch for ch in (req.filename or "modlist.json")
                        if ch.isalnum() or ch in "._-") or "modlist.json"
    if not safe_name.lower().endswith(".json"):
        safe_name += ".json"
    drop_dir = Path(__file__).resolve().parent.parent / "cache" / "temp" / "dropped"
    drop_dir.mkdir(parents=True, exist_ok=True)
    path = drop_dir / f"{int(time.time())}_{safe_name}"
    try:
        path.write_text(req.content, encoding="utf-8")
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"保存导入清单失败: {e}")
    return {"path": str(path), "filename": path.name}


# ==================== MC 版本列表（下拉框） ====================

_mc_versions_cache = {"t": 0.0, "data": None}
_MC_VERSION_TTL = 6 * 3600  # 缓存 6 小时


@app.get("/api/mc_versions")
async def api_mc_versions():
    """获取 Minecraft 官方版本列表（6 小时内存缓存，失败时回退旧缓存）"""
    global _mc_versions_cache
    now = time.time()
    if _mc_versions_cache["data"] and now - _mc_versions_cache["t"] < _MC_VERSION_TTL:
        return _mc_versions_cache["data"]
    try:
        versions = await client.get_mc_versions()
    except ModrinthError as e:
        if _mc_versions_cache["data"]:
            return _mc_versions_cache["data"]
        raise HTTPException(status_code=502, detail=f"获取 MC 版本列表失败: {e}")
    _mc_versions_cache = {"t": now, "data": {"versions": versions}}
    return _mc_versions_cache["data"]


# ==================== 请求模型 ====================

class ScanRequest(BaseModel):
    folder: str


class ExportRequest(BaseModel):
    mods: list
    game_version: Optional[str] = ""
    loader: Optional[str] = ""
    save_path: Optional[str] = None


class DownloadListRequest(BaseModel):
    json_path: str
    mc_version: str
    loader: str
    save_dir: str
    project_ids: Optional[list] = None  # 仅下载指定的 project_id 列表
    source: Optional[str] = None         # 强制下载源：modrinth / curseforge / auto(默认)


class SearchRequest(BaseModel):
    query: str
    game_version: Optional[str] = None
    loader: Optional[str] = None
    project_type: Optional[str] = None
    limit: int = 10
    offset: int = 0
    source: Optional[str] = None         # modrinth(默认) / curseforge


class DownloadSingleRequest(BaseModel):
    project_id: str
    mc_version: str
    loader: str
    save_dir: str
    source: Optional[str] = None         # 强制下载源


class TaskControlRequest(BaseModel):
    task_id: str


class RetryRequest(BaseModel):
    task_id: str
    scope: Optional[str] = "all"  # all / failed / missing


class SettingsUpdateRequest(BaseModel):
    max_concurrency: Optional[int] = None
    rate_limit_mbps: Optional[float] = None
    theme: Optional[str] = None
    source: Optional[str] = None          # V3.0：下载源偏好
    curseforge_api_key: Optional[str] = None  # V3.0：CurseForge 官方 API Key（可选）


class PreviewRequest(BaseModel):
    json_path: str


class OpenFolderRequest(BaseModel):
    path: str


# ==================== 原生对话框（tkinter） ====================

def _tk_directory(title):
    """弹出原生文件夹选择框，返回选中路径（取消则返回空串）"""
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        folder = filedialog.askdirectory(title=title or "选择文件夹")
        root.destroy()
        return folder or ""
    except Exception:
        return ""


def _tk_open_file(title, filetypes):
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        path = filedialog.askopenfilename(title=title or "选择文件", filetypes=filetypes)
        root.destroy()
        return path or ""
    except Exception:
        return ""


def _tk_save_file(title, default_filename, filetypes):
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        path = filedialog.asksaveasfilename(
            title=title or "保存文件", initialfile=default_filename or "", filetypes=filetypes)
        root.destroy()
        return path or ""
    except Exception:
        return ""


@app.get("/api/pick_folder")
def api_pick_folder(title: str = "选择文件夹"):
    """选择文件夹"""
    return {"folder": _tk_directory(title)}


@app.get("/api/pick_file")
def api_pick_file(title: str = "选择文件", ext: str = "json"):
    """选择文件（默认 JSON）"""
    filetypes = [(f"{ext.upper()} 文件", f"*.{ext}"), ("所有文件", "*.*")]
    return {"path": _tk_open_file(title, filetypes)}


@app.get("/api/pick_save")
def api_pick_save(title: str = "保存文件", filename: str = "modlist.json", ext: str = "json"):
    """选择保存路径"""
    filetypes = [(f"{ext.upper()} 文件", f"*.{ext}"), ("所有文件", "*.*")]
    return {"path": _tk_save_file(title, filename, filetypes)}


# ==================== 核心业务接口 ====================

@app.post("/api/scan_mods")
async def api_scan_mods(req: ScanRequest):
    """扫描 mods 目录，解析 jar 元数据并通过多平台哈希反查 project_id

    顺序：先 Modrinth (sha512) 反查，未命中再 CurseForge (murmur2) 反查；
    每个命中结果含 source 字段（modrinth / curseforge）。
    """
    if not req.folder or not Path(req.folder).is_dir():
        raise HTTPException(status_code=400, detail=f"目录不存在: {req.folder}")
    try:
        results = await scan_mods(req.folder, client, cf_client)
    except FileNotFoundError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except (ModrinthError, CurseForgeError) as e:
        raise HTTPException(status_code=502, detail=f"下载源 API 错误: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"扫描失败: {e}")

    matched = sum(1 for r in results if r["matched"])
    return {
        "total": len(results),
        "matched": matched,
        "unmatched": len(results) - matched,
        "mods": results,
    }


@app.post("/api/check_updates")
async def api_check_updates(req: CheckUpdatesRequest):
    """检测已识别模组是否有新版本（V3.1）

    对每个已匹配模组查询其版本列表（优先适配 mc_version / loader，
    否则取最新发布版），与本机安装的 version_id 比对，不同即视为有新版本。
    """
    updates = []
    errors = []
    checked = 0
    for m in req.mods or []:
        pid = (m or {}).get("project_id")
        if not pid:
            continue
        src = (m or {}).get("source") or "modrinth"
        installed_vid = (m or {}).get("version_id")
        checked += 1
        cl = cf_client if str(src).lower() == "curseforge" else client
        try:
            versions = await cl.get_versions_by_project(pid, None, None) or []
        except (ModrinthError, CurseForgeError) as e:
            errors.append({"project_id": pid, "name": (m or {}).get("name") or pid, "error": str(e)})
            continue
        if not versions:
            continue
        if req.mc_version and req.loader:
            best, _ = _pick_best_version(versions, req.mc_version, req.loader)
        else:
            best = versions[0]
        if not best:
            continue
        latest_vid = str(best.get("id") or best.get("version_id") or "")
        if installed_vid and latest_vid and str(installed_vid) != latest_vid:
            pf = _pick_primary_from_version(best)
            updates.append({
                "project_id": pid,
                "name": (m or {}).get("name") or pid,
                "source": src,
                "current_version": (m or {}).get("version_number")
                    or (m or {}).get("version_name") or "未知",
                "latest_version": best.get("version_number") or best.get("name") or latest_vid,
                "latest_version_id": latest_vid,
                "game_versions": (best.get("game_versions") or [])[:4],
                "loaders": (best.get("loaders") or [])[:3],
                "changelog": (best.get("changelog") or "")[:500],
                "filename": (pf or {}).get("filename"),
                "download_url": (pf or {}).get("download_url"),
            })
    return {"checked": checked, "update_count": len(updates), "updates": updates, "errors": errors}


@app.post("/api/export_json")
async def api_export_json(req: ExportRequest):
    """生成 modlist 并保存本地（含多源 source 字段，V3.0）

    结构与清单保持一致，核心字段 projects:[{project_id, source, ...}]
    仅导出成功识别到 project_id 的模组。
    """
    projects = []
    for m in req.mods or []:
        if not (m or {}).get("project_id"):
            continue
        meta = m.get("metadata") or {}
        projects.append({
            "project_id": m["project_id"],
            "name": m.get("name") or meta.get("name") or m.get("filename"),
            "version_id": m.get("version_id"),
            "version_number": m.get("version_number"),
            "filename": m.get("filename"),
            "source_loader": meta.get("loader"),
            "source": m.get("source") or "modrinth",  # V3.0：来源标识 modrinth / curseforge
        })

    manifest = {
        "name": "ModList-Weaver Export",
        "version": "3.0",
        "game_version": req.game_version or "",
        "loader": req.loader or "",
        "projects": projects,
    }

    save_path = req.save_path
    if not save_path:
        out_dir = Path("output")
        out_dir.mkdir(parents=True, exist_ok=True)
        save_path = str(out_dir / "modlist.json")
    try:
        with open(save_path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
    except OSError as e:
        raise HTTPException(status_code=400, detail=f"保存失败: {e}")

    return {"save_path": save_path, "count": len(projects)}


@app.post("/api/download_from_list")
async def api_download_from_list(req: DownloadListRequest):
    """读取 modlist 启动批量下载（入队，立即返回 task_id）

    V3.0：支持 req.source 全局强制下载源（modrinth / curseforge / auto），
    清单中 project 级别的 source 字段优先。
    """
    if not Path(req.json_path).is_file():
        raise HTTPException(status_code=400, detail=f"清单文件不存在: {req.json_path}")
    if not req.mc_version or not req.loader:
        raise HTTPException(status_code=400, detail="必须指定目标游戏版本与加载器")

    async def _factory(gate):
        return await run_batch_download(
            client, req.json_path, req.mc_version, req.loader, req.save_dir, state, gate,
            project_ids=req.project_ids, cf_client=cf_client,
            global_source=req.source)

    tid, state = await task_manager.create(
        "batch", _factory,
        params={
            "json_path": req.json_path,
            "mc_version": req.mc_version,
            "loader": req.loader,
            "save_dir": req.save_dir,
            "project_ids": req.project_ids,
            "source": req.source,
        })
    return {"task_id": tid, "queued": state.status != "running"}


@app.post("/api/preview_list")
async def api_preview_list(req: PreviewRequest):
    """解析 modlist.json，返回模组清单（用于批量下载前勾选）"""
    if not Path(req.json_path).is_file():
        raise HTTPException(status_code=400, detail=f"清单文件不存在: {req.json_path}")
    try:
        with open(req.json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        raise HTTPException(status_code=400, detail=f"清单解析失败: {e}")
    projects = data.get("projects", []) if isinstance(data, dict) else []
    items = []
    for p in projects or []:
        pid = (p or {}).get("project_id")
        if not pid:
            continue
        items.append({
            "project_id": pid,
            "name": (p or {}).get("name") or pid,
            "filename": (p or {}).get("filename") or "",
            "version_number": (p or {}).get("version_number") or "",
        })
    return {"total": len(items), "projects": items}


@app.post("/api/search_mod")
async def api_search_mod(req: SearchRequest):
    """关键词搜索模组（支持分页与筛选 + 双源）

    req.source: "curseforge" 时走 CurseForge，否则（默认）走 Modrinth。
    query 可为空串：配合 loader / project_type 筛选时用于分页浏览模组目录。
    """
    source = (req.source or "modrinth").lower()
    try:
        if source == "curseforge":
            data = await cf_client.search_mods(
                req.query or "", req.game_version, req.loader, req.limit, req.offset, req.project_type)
        else:
            data = await client.search_mods(
                req.query or "", req.game_version, req.loader, req.limit, req.offset, req.project_type)
    except (ModrinthError, CurseForgeError) as e:
        raise HTTPException(status_code=502, detail=str(e))
    return data


@app.post("/api/download_single_mod")
async def api_download_single_mod(req: DownloadSingleRequest):
    """单模组 + 前置依赖下载（进入下载队列，立即返回 task_id）

    V3.0：req.source 强制指定下载源；auto 时按 settings.source 或 project_id 特征选择。
    """
    if not req.project_id:
        raise HTTPException(status_code=400, detail="project_id 不能为空")
    if not req.mc_version or not req.loader:
        raise HTTPException(status_code=400, detail="必须指定目标游戏版本与加载器")

    async def _factory(gate):
        return await run_single_download(
            client, req.project_id, req.mc_version, req.loader, req.save_dir, state, gate,
            cf_client=cf_client, force_source=req.source)

    tid, state = await task_manager.create(
        "single", _factory,
        params={
            "project_id": req.project_id,
            "mc_version": req.mc_version,
            "loader": req.loader,
            "save_dir": req.save_dir,
            "source": req.source,
        })
    return {"task_id": tid, "queued": state.status != "running"}


@app.get("/api/project/{project_id}")
async def api_project_detail(project_id: str, source: Optional[str] = None):
    """模组详情：项目信息 + 作者 + 版本列表（含更新日志）

    source 参数可显式指定 modrinth / curseforge；未指定时：
    - project_id 是纯数字 -> 优先 CurseForge，失败回退 Modrinth
    - 否则优先 Modrinth，失败回退 CurseForge
    """
    project = None
    authors = []
    raw_versions = []
    errors = []

    candidates = []
    if source == "curseforge":
        candidates = [("curseforge", cf_client, int(project_id) if str(project_id).isdigit() else project_id)]
    elif source == "modrinth":
        candidates = [("modrinth", client, project_id)]
    elif str(project_id).isdigit():
        candidates = [
            ("curseforge", cf_client, int(project_id)),
            ("modrinth", client, project_id),
        ]
    else:
        candidates = [
            ("modrinth", client, project_id),
            ("curseforge", cf_client, project_id),
        ]

    for src_name, cl, pid in candidates:
        try:
            project = await cl.get_project(pid)
        except (ModrinthError, CurseForgeError) as e:
            errors.append(f"[{src_name}] {e}")
            continue
        if project:
            try:
                if src_name == "modrinth":
                    team_id = project.get("team")
                    if team_id:
                        try:
                            members = await client.get_team(team_id) or []
                        except (ModrinthError, CurseForgeError):
                            members = []
                        for m in members:
                            user = m.get("user") or {}
                            authors.append({
                                "name": user.get("username") or m.get("name"),
                                "avatar_url": user.get("avatar_url"),
                                "role": m.get("role"),
                            })
                    raw_versions = await client.get_versions_by_project(pid) or []
                else:
                    authors = project.get("authors") or []
                    raw_versions = await cf_client.get_versions_by_project(pid) or []
                project["source"] = src_name
                break
            except (ModrinthError, CurseForgeError) as e:
                errors.append(f"[{src_name}] versions/authors fetch: {e}")
                project = None
                authors = []
                raw_versions = []
                continue

    if not project:
        raise HTTPException(status_code=404, detail=f"项目不存在: {project_id}（{'; '.join(errors) if errors else ''}）")

    versions = []
    for v in raw_versions[:30]:
        if project.get("source") == "modrinth":
            files = v.get("files") or []
            primary = next((f for f in files if f.get("primary")), files[0] if files else None)
            versions.append({
                "id": v.get("id"),
                "name": v.get("name"),
                "version_number": v.get("version_number"),
                "game_versions": v.get("game_versions", []),
                "loaders": v.get("loaders", []),
                "date_published": v.get("date_published"),
                "changelog": v.get("changelog", ""),
                "filename": primary.get("filename") if primary else None,
                "filesize": primary.get("size") if primary else None,
                "download_url": primary.get("url") if primary else None,
            })
        else:
            versions.append({
                "id": v.get("id") or v.get("version_id"),
                "name": v.get("name") or v.get("version_number"),
                "version_number": v.get("version_number"),
                "game_versions": v.get("game_versions", []),
                "loaders": v.get("loaders", []),
                "date_published": v.get("date_published"),
                "changelog": v.get("changelog", ""),
                "filename": v.get("filename"),
                "filesize": v.get("filesize"),
                "download_url": v.get("download_url"),
            })

    return {
        "project_id": project.get("id") or project.get("project_id") or project_id,
        "slug": project.get("slug"),
        "title": project.get("title"),
        "description": project.get("description"),
        "body": project.get("body"),
        "icon_url": project.get("icon_url"),
        "project_type": project.get("project_type"),
        "categories": project.get("categories", []),
        "loaders": project.get("loaders", []),
        "game_versions": project.get("game_versions", []),
        "downloads": project.get("downloads"),
        "followers": project.get("followers"),
        "license": project.get("license") or ((project.get("license") or {}).get("id") if isinstance(project.get("license"), dict) else None),
        "source_url": project.get("source_url"),
        "source": project.get("source"),
        "authors": authors,
        "versions": versions,
    }


@app.get("/api/project_page")
async def api_project_page(project_id: str, source: Optional[str] = None):
    """返回模组在所属平台的主页 URL（「打开源页面」用）

    Modrinth 的 project_id 即 slug，可直接拼 URL；CurseForge 需先解析 slug，
    解析失败时回退到平台内搜索页。
    """
    src = (source or "").strip().lower()

    async def _cf_url(pid):
        try:
            p = await cf_client.get_project(pid)
            slug = (p or {}).get("slug")
            if slug:
                return f"https://www.curseforge.com/minecraft/mc-mods/{slug}"
        except Exception:
            pass
        return f"https://www.curseforge.com/minecraft/search?search={project_id}"

    if src == "modrinth":
        return {"url": f"https://modrinth.com/project/{project_id}", "source": "modrinth"}
    if src == "curseforge":
        url = await _cf_url(int(project_id) if project_id.isdigit() else project_id)
        return {"url": url, "source": "curseforge"}
    # 未指定源：纯数字 → CurseForge，否则 → Modrinth
    if project_id.isdigit():
        return {"url": await _cf_url(int(project_id)), "source": "curseforge"}
    return {"url": f"https://modrinth.com/project/{project_id}", "source": "modrinth"}


# ==================== 下载队列控制 ====================

@app.get("/api/queue")
def api_queue():
    """下载队列快照：进行中任务 + 已完成历史（终态任务持久化于 cache/temp）"""
    return {
        "tasks": task_manager.list(),
        "history": task_manager.history(),
    }


@app.get("/api/settings")
def api_get_settings():
    """读取当前设置（并发数 / 网速限制 / 主题）"""
    return get_settings().get()


@app.get("/api/storage_info")
def api_storage_info():
    """缓存占用统计（日志 / 导入临时文件 / 历史任务数），V3.2"""
    logs_dir = task_manager._logs_dir
    temp_dir = task_manager._temp_dir
    dropped_dir = temp_dir / "dropped"

    def _size(p):
        total = 0
        try:
            for f in p.rglob("*"):
                if f.is_file():
                    total += f.stat().st_size
        except OSError:
            pass
        return total

    logs_bytes = _size(logs_dir)
    dropped_bytes = _size(dropped_dir)
    return {
        "logs_bytes": logs_bytes,
        "dropped_bytes": dropped_bytes,
        "history_count": len(task_manager.history_order),
        "active_count": len(task_manager.tasks),
        "total_bytes": logs_bytes + dropped_bytes + _size(temp_dir),
    }


class ClearCacheRequest(BaseModel):
    what: str  # "logs" / "dropped" / "history"


@app.post("/api/clear_cache")
def api_clear_cache(req: ClearCacheRequest):
    """清理缓存：logs=日志文件 / dropped=导入临时文件 / history=终态任务历史"""
    what = (req.what or "").strip().lower()
    removed = 0
    if what == "logs":
        for f in task_manager._logs_dir.glob("*.log"):
            try:
                f.unlink()
                removed += 1
            except OSError:
                pass
    elif what == "dropped":
        d = task_manager._temp_dir / "dropped"
        for f in d.glob("*"):
            try:
                f.unlink()
                removed += 1
            except OSError:
                pass
    elif what == "history":
        removed = task_manager.clear_history()
    else:
        raise HTTPException(status_code=400, detail="what 必须是 logs / dropped / history")
    return {"removed": removed}


@app.post("/api/settings")
def api_update_settings(req: SettingsUpdateRequest):
    """更新设置，写入 cache/settings.json 并即时生效"""
    patch = {}
    if req.max_concurrency is not None:
        patch["max_concurrency"] = req.max_concurrency
    if req.rate_limit_mbps is not None:
        patch["rate_limit_mbps"] = req.rate_limit_mbps
    if req.theme is not None:
        patch["theme"] = req.theme
    if req.source is not None:
        patch["source"] = req.source
    if req.curseforge_api_key is not None:
        patch["curseforge_api_key"] = req.curseforge_api_key
    if not patch:
        raise HTTPException(status_code=400, detail="没有需要更新的设置项")
    get_settings().update(patch)
    return get_settings().get()


@app.get("/api/logs/{task_id}")
def api_logs(task_id: str):
    """读取任务日志缓存（进行中读内存，终态读 cache/logs）"""
    logs = task_manager.get_logs(task_id)
    if logs is None:
        raise HTTPException(status_code=404, detail="日志不存在")
    return {"task_id": task_id, "logs": logs}


@app.get("/api/logs/{task_id}/download")
def api_logs_download(task_id: str):
    """导出任务日志为 .log 文本文件"""
    logs = task_manager.get_logs(task_id)
    if logs is None:
        raise HTTPException(status_code=404, detail="日志不存在")
    text = task_manager.format_logs(logs)
    filename = f"{task_id}.log"
    return Response(
        content=text,
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/retry_task")
async def api_retry_task(req: RetryRequest):
    """按 scope 重试任务的失败 / 缺失模组（各生成一个单模组任务）

    scope: all=失败+缺失  failed=仅失败  missing=仅缺失
    """
    entry = task_manager.get(req.task_id)
    if entry:
        st = entry.state
        mc, loader, save_dir = st.mc_version, st.loader, st.save_dir
        failed, missing = st.failed, st.missing
    else:
        h = task_manager.history_entry(req.task_id)
        if not h:
            raise HTTPException(status_code=404, detail="任务不存在")
        d = h["state"]
        mc, loader, save_dir = d.get("mc_version", ""), d.get("loader", ""), d.get("save_dir", "")
        failed, missing = d.get("failed", []), d.get("missing", [])
    if not mc or not loader or not save_dir:
        raise HTTPException(status_code=400, detail="任务缺少目标版本/加载器/保存目录信息")
    pids = []
    scope = req.scope or "all"
    if scope in ("all", "failed"):
        for f in failed:
            if f.get("project_id"):
                pids.append(f["project_id"])
    if scope in ("all", "missing"):
        for m in missing:
            if m.get("project_id"):
                pids.append(m["project_id"])
    pids = list(dict.fromkeys(pids))
    if not pids:
        raise HTTPException(status_code=400, detail="没有可重试的失败/缺失模组")

    async def _create_one(_pid):
        tid, st = await task_manager.create(
            "single",
            lambda gate, _p=_pid: run_single_download(
                client, _p, mc, loader, save_dir, st, gate),
            params={
                "project_id": _pid,
                "mc_version": mc,
                "loader": loader,
                "save_dir": save_dir,
                "source": None,
            })
        return tid, st

    created = []
    for pid in pids:
        tid, _ = await _create_one(pid)
        created.append({"task_id": tid, "project_id": pid})
    return {"count": len(created), "created": created}


@app.post("/api/open_folder")
def api_open_folder(req: OpenFolderRequest):
    """在系统资源管理器中打开文件夹"""
    if not req.path or not os.path.isdir(req.path):
        raise HTTPException(status_code=400, detail=f"文件夹不存在: {req.path}")
    try:
        os.startfile(req.path)
    except OSError as e:
        raise HTTPException(status_code=400, detail=f"无法打开文件夹: {e}")
    return {"ok": True}


@app.post("/api/task_pause")
def api_task_pause(req: TaskControlRequest):
    if not task_manager.pause(req.task_id):
        raise HTTPException(status_code=400, detail="任务不存在或当前状态不可暂停")
    return {"ok": True}


@app.post("/api/task_resume")
def api_task_resume(req: TaskControlRequest):
    if not task_manager.resume(req.task_id):
        raise HTTPException(status_code=400, detail="任务不存在或当前状态不可继续")
    return {"ok": True}


@app.post("/api/task_stop")
def api_task_stop(req: TaskControlRequest):
    if not task_manager.stop(req.task_id):
        raise HTTPException(status_code=400, detail="任务不存在或当前状态不可停止")
    return {"ok": True}


@app.post("/api/task_delete")
def api_task_delete(req: TaskControlRequest):
    if not task_manager.delete(req.task_id):
        raise HTTPException(status_code=400, detail="任务不存在")
    return {"ok": True}


@app.get("/api/task_status")
def api_task_status(task_id: Optional[str] = None):
    """轮询获取下载进度、日志、成功/失败/缺失列表

    不传 task_id 时返回最近一个任务。
    """
    entry = None
    if task_id:
        entry = task_manager.get(task_id)
    else:
        entry = task_manager.latest()
    if not entry:
        return JSONResponse({"status": "idle", "logs": []})
    try:
        pos = task_manager.queue.index(entry.task_id) + 1
    except ValueError:
        pos = None
    return JSONResponse(entry.state.to_dict(position=pos, queue_size=len(task_manager.queue)))
