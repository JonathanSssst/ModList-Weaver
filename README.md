# ModList-Weaver

> Minecraft 双源（Modrinth / CurseForge）模组迁移桌面工具 —— 一键扫描本地 mods，导出模组清单，跨版本/跨加载器批量重下载，自带断点续传、哈希校验、依赖递归与任务队列。

当前版本：**v3.2.0** · 平台：Windows x64（PyInstaller 打包） · 技术栈：Python 3.10+ / FastAPI / pywebview / 原生 HTML+JS

---

## 目录

- [快速开始](#快速开始)
- [配置](#配置)
- [核心特性](#核心特性)
- [技术栈](#技术栈)
- [目录结构](#目录结构)
- [API 接口](#api-接口)
- [工作流](#工作流)
- [版本历史](#版本历史)
- [致谢](#致谢)
- [License](#license)

---

## 快速开始

### 方式一：下载 Release 可执行文件（推荐普通用户）

1. 前往 [Releases](https://github.com/JonathanSssst/ModList-Weaver/releases/latest) 下载 `ModList-Weaver-Windows-vX.X.X.zip`
2. 解压到任意目录
3. 双击 `ModList-Weaver.exe` 即可启动（首次启动稍慢，会初始化缓存）

> 桌面工具，不弹控制台黑窗；无需安装 Java / Python 环境。

### 方式二：源码运行（开发者）

```bash
# 1. 克隆仓库
git clone https://github.com/JonathanSssst/ModList-Weaver.git
cd ModList-Weaver

# 2. 创建虚拟环境（推荐 Python 3.11）
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS / Linux

# 3. 安装依赖
pip install -r requirements.txt

# 4. 启动应用
python main.py
```

启动后程序会自动：

1. 在 `8765~8810` 范围内查找可用端口
2. 后台线程启动 FastAPI + uvicorn 服务
3. 打开 pywebview 桌面窗口（内嵌网页，不弹浏览器）

### 运行测试

```bash
pip install pytest pytest-asyncio
python -m pytest tests -v --tb=short
```

预期输出：39 个用例全部 PASS。

### 本地打包

```bash
pip install pyinstaller pywin32-ctypes
pyinstaller build.spec
# 产物位于 dist/ModList-Weaver/
```

---

## 配置

所有运行时配置持久化在 `cache/settings.json`（首次运行自动生成），支持应用内「设置」页热更新。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `max_concurrency` | `3` | 同时运行的最大下载任务数 |
| `rate_limit_mbps` | `0` | 全局下行带宽限制（MB/s），`0` 表示不限速 |
| `theme` | `auto` | 界面主题：`auto` / `light` / `dark` |
| `source` | `auto` | 下载源偏好：`auto`（先 Modrinth 后 CurseForge）/ `modrinth` / `curseforge` |
| `curseforge_api_key` | `""` | 可选 CurseForge 官方 API Key；为空时走 `api.curse.tools` 公共镜像 |

> 主题、下载源、并发数、限速等设置即时生效，无需重启。

---

## 核心特性

### 1. 双源模组识别与下载

- **Modrinth** 走官方 v2 公开 API，使用 `sha512` 哈希反查
- **CurseForge** 走社区镜像 `api.curse.tools`，使用 `murmur2` 指纹反查（无需 API Key）
- 扫描阶段 Modrinth 未命中时自动 fallback 到 CurseForge，识别率显著提升
- 下载源优先级：`project.source` > 接口 `global_source` > `settings.source`

### 2. 断点续传

- 使用 `.part` 临时文件作为下载载体，避免半成品冒充成品
- 下载前探测服务端 Range 支持，支持时从断点 HTTP Range 续传
- 不支持 Range 或首次下载时从头开始，完成后原子 rename 为最终路径
- Modrinth 与 CurseForge 客户端一致实现

### 3. 多算法哈希校验

优先级自适应：`sha512` > `sha1` > `murmur2`，按源 API 返回的可用字段选择最可靠的校验方案。

### 4. 依赖递归

- 自动解析 `required` 强制前置依赖并下载
- `optional` 可选依赖忽略
- 使用 `processed` 集合去重，防止循环依赖死循环

### 5. 任务队列与持久化

- 同一时间仅执行设定数量的任务，其余 FIFO 排队
- 支持 **暂停 / 继续 / 停止 / 删除**
- 终态任务（completed / failed / stopped）持久化到 `cache/temp/tasks.json`，日志归档于 `cache/logs/`，重启不丢失
- 任务结算页：查看失败 / 缺失明细、重试、打开源 / 目标目录

### 6. 实时进度与网速

- 双进度条：总任务进度 + 当前文件进度
- 0.3s 时间窗口采样的瞬时网速显示
- 跳过计数（已存在且哈希校验通过的模组）

### 7. 现代化桌面 UI

- pywebview 内嵌 WebView2，原生 HTML/CSS/JS 实现
- 明暗主题一键切换，偏好持久化
- 向导式工作流（扫描导出三步、批量下载四步）
- 应用图标：源码运行与打包后均带自定义图标（`assets/app.ico`）
- 模组任意位置「打开源页面」：清单行 / 目录 / 详情页一键跳转原始项目页

### 8. 下载完成通知与存储清理（V3.2）

- 全部任务结束后弹系统通知 + 三音提示，汇总成功 / 失败 / 跳过数
- 设置页「存储与清理」：一键清空任务日志、导入临时文件、历史记录并统计占用
- 需在浏览器 / WebView 中允许桌面通知权限

---

## 技术栈

| 层 | 技术 |
| --- | --- |
| 后端 | Python 3.10+、FastAPI、uvicorn、httpx（异步 HTTP）、pydantic |
| 桌面壳 | pywebview（Windows 走 EdgeChromium / WinForms 后端） |
| 前端 | 原生 HTML + CSS + JavaScript（无构建步骤） |
| 原生对话框 | tkinter（文件夹 / 文件 / 保存路径选择） |
| 模组元数据解析 | zipfile + tomllib（无需 Java 环境） |
| 哈希算法 | hashlib（sha512 / sha1）+ 自实现 Java 兼容 MurmurHash2 |
| 打包 | PyInstaller（目录模式 COLLECT） |
| 测试 | pytest + pytest-asyncio（39 用例） |
| CI/CD | GitHub Actions（2 OS × 3 Python 矩阵 + 自动 Release） |

---

## 目录结构

```
ModList-Weaver/
├── main.py                     # 程序入口：启动 FastAPI + pywebview
├── requirements.txt            # 依赖清单
├── build.spec                  # PyInstaller 打包配置
├── README.md
│
├── backend/                    # 后端：FastAPI + 业务逻辑
│   ├── __init__.py
│   ├── api.py                  # FastAPI 路由 + 版本常量 + Changelog（单一事实来源）
│   ├── scanner.py              # mods 目录扫描、jar 元数据解析、哈希反查
│   ├── modrinth_client.py      # Modrinth v2 API 异步客户端（含断点续传）
│   ├── curseforge_client.py    # CurseForge 客户端 + murmur2 指纹实现
│   ├── downloader.py           # 下载核心：TaskManager / TaskGate / 多源递归
│   └── settings.py             # 全局设置 + 令牌桶限速器
│
├── frontend/                   # 前端：原生 HTML/CSS/JS
│   ├── index.html              # 单页应用外壳 + 8 个页面 (A~H)
│   ├── main.js                 # 交互逻辑（侧边栏 / 向导 / 轮询 / 主题）
│   └── style.css               # 明暗主题样式
│
├── assets/                      # 应用图标（app.ico / app.png，打包用）
│
├── tests/                      # pytest 单元测试
│   ├── __init__.py
│   ├── test_scanner.py         # 哈希计算 / jar 元数据解析
│   ├── test_downloader_logic.py# 版本选择 / TaskGate / 限速器 / 哈希策略
│   ├── test_curseforge_and_settings.py  # murmur2 / Settings 持久化
│   ├── test_resume_and_updates.py      # 断点恢复 / 版本比较 / 更新检测 / 清单导入
│   └── test_qol_v32.py                # 源页面跳转 / 存储统计与清理（V3.2）
│
├── .github/workflows/ci.yml    # GitHub Actions：测试矩阵 + 打包 + Release
├── .gitignore
│
└── cache/                      # 运行时数据（gitignored）
    ├── settings.json           # 用户设置
    ├── temp/tasks.json         # 终态任务持久化
    └── logs/                   # 任务日志归档
```

---

## API 接口

后端 FastAPI 服务监听 `http://127.0.0.1:{port}`，端口在 `8765~8810` 范围内自动选择。所有接口前缀 `/api`。

### 版本与元信息

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/version` | 当前版本 + 完整 Changelog + Release 下载链接 |
| GET | `/api/mc_versions` | Minecraft 官方版本列表（6 小时缓存） |

### 扫描与导出

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/scan_mods` | 扫描 mods 目录，多源哈希反查 project_id |
| POST | `/api/export_json` | 生成 modlist.json 并保存 |
| POST | `/api/preview_list` | 解析 modlist.json 返回清单（下载前勾选用） |

### 搜索与详情

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/search_mod` | 关键词搜索模组（支持 `source` 切换双源） |
| GET | `/api/project/{id}` | 模组详情：图标 / 作者 / 版本列表 / 更新日志 |
| GET | `/api/project_page` | 模组主页 URL（「打开源页面」用，V3.2） |

### 下载

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/download_from_list` | 读取 modlist 启动批量下载（入队） |
| POST | `/api/download_single_mod` | 单模组 + 前置依赖下载（入队） |
| POST | `/api/retry_task` | 按 scope 重试失败 / 缺失模组 |

### 任务队列控制

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/queue` | 队列快照：进行中 + 已完成历史 |
| GET | `/api/task_status` | 轮询单个任务进度（不传返回最近一个） |
| POST | `/api/task_pause` | 暂停任务 |
| POST | `/api/task_resume` | 继续任务 |
| POST | `/api/task_stop` | 停止任务 |
| POST | `/api/task_delete` | 删除任务 |

### 日志与设置

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/logs/{id}` | 读取任务日志缓存 |
| GET | `/api/logs/{id}/download` | 导出日志为 `.log` 文件 |
| GET | `/api/settings` | 读取当前设置 |
| POST | `/api/settings` | 更新设置（即时生效） |
| GET | `/api/storage_info` | 缓存占用统计（日志 / 临时文件 / 历史，V3.2） |
| POST | `/api/clear_cache` | 清理缓存：logs / dropped / history（V3.2） |

### 原生对话框

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/pick_folder` | 原生文件夹选择 |
| GET | `/api/pick_file` | 原生文件选择 |
| GET | `/api/pick_save` | 原生保存路径选择 |
| POST | `/api/open_folder` | 在资源管理器中打开文件夹 |

---

## 工作流

### A. 扫描导出（三步向导）

```
选择 mods 目录
   ↓
扫描 jar 文件 → 解析 fabric.mod.json / mods.toml
   ↓
计算 sha512 + murmur2 → Modrinth 反查 → 未命中 fallback CurseForge
   ↓
勾选要导出的模组（未识别标灰置顶）
   ↓
导出 modlist.json（含 source 字段）
```

### B. 批量下载（四步向导）

```
选择 modlist.json
   ↓
预览清单 + 勾选要下载的模组
   ↓
选择目标 MC 版本 + 加载器 + 保存目录
   ↓
入队下载 → 多源路由 → 已存在哈希校验 → 断点续传 → 依赖递归
   ↓
任务结算页：成功 / 跳过 / 失败 / 缺失 + 重试 + 导出缺失清单
```

### C. 模组列表

关键词搜索 + 双源切换 + 分页浏览 + 模组详情页（图标 / 版本 / 作者 / 更新日志）+ 一键单模组下载（含前置依赖）。

### D. 任务中心

- 进行中任务：双进度条 + 实时网速 + 暂停 / 继续 / 停止 / 删除
- 已完成任务：持久化历史 + 查看日志 / 导出日志 + 重试 + 打开目录

### 多源下载路由策略

```
project_id 是数字？
  ├─ 是 → CurseForge 优先 → Modrinth 兜底
  └─ 否 → Modrinth 优先 → CurseForge 兜底

settings.source = modrinth / curseforge 时强制单源
project.source 字段优先级最高
```

---

## 版本历史

完整 Changelog 在软件内「更新日志」页动态渲染（数据源：`backend/api.py:CHANGELOG`）。

### v3.2.0（2026-08）· 打开源页面 + 存储清理 + 应用图标 + 下载完成通知 + 移除作者头像

- **打开源页面**：模组列表 / 模组目录 / 详情页新增「源页面」按钮，一键跳转 Modrinth / CurseForge 项目主页
- **存储与清理**：设置页展示日志 / 导入临时文件 / 任务历史占用，支持一键清理（`/api/storage_info`、`/api/clear_cache`）
- **应用图标**：新增 `assets/app.ico`，可执行文件与窗口图标统一
- **下载完成通知**：全部任务结束时 toast + 提示音 + 系统通知，汇总成功 / 失败数量
- 「关于」页移除作者头像（head.png），删除 `frontend/src/images/`

### v3.1.0（2026-08）· 模组更新检测 + 软件自动更新 + 断点恢复 + 拖拽导入

- **模组更新检测**：步骤 2「检查更新」按源拉取最新适配版本与已安装版本比对，命中更新标黄徽章并汇总数量
- **软件自动更新**：启动静默检查 GitHub Release，顶部横幅提示新版本，支持下载 / 忽略；「关于」页可手动检查
- **断点恢复**：进程异常退出后重启自动恢复未完成任务（`cache/temp/active.json`）
- **拖拽导入**：桌面窗口把 .json 清单拖入任意区域即导入并跳到批量下载第一步
- **工程化**：移除根目录冗余 `static/`（静态资源统一由 `frontend/` 提供）
- **测试**：新增 `tests/test_resume_and_updates.py`，pytest 35/35 通过

### v3.0.0（2026-08）· 断点续传 + CurseForge 双源 + 自动化 CI/CD

- **断点续传**：`.part` 临时文件 + HTTP Range，下载中断不浪费带宽（双客户端一致实现）
- **CurseForge 双源**：新增独立客户端，murmur2 指纹匹配、依赖递归、429 速率节流自适应
- **多源自动路由**：`settings.source = auto / modrinth / curseforge`；扫描阶段 Modrinth 未命中自动 fallback CurseForge
- **多算法哈希校验**：sha512 > sha1 > murmur2 优先级自适应
- **pytest 单测 29/29 PASS**：scanner / downloader / curseforge / settings 三套用例
- **GitHub Actions CI/CD**：2 OS × 3 Python 测试矩阵；PyInstaller 自动打包；`v*` tag 自动上传 Release
- **工程化**：`build.spec` 补 hiddenimports；`.gitignore` 完善；requirements 加入开发依赖

### v2.5（2026-07）· 交互细节与 UI 稳定性

- 修复批量下载勾选后「下一步」按钮无响应
- 任务 / 历史列表删除按钮图标补全
- 结算页信息卡片重排版，长文本不再错位
- 进入结算页新增淡入上滑过渡动画

### v2.4（2026-06）· 设置页 · 主题 · 四步下载向导

- 新增「设置」页：并发数 + 全局限速，热更新即时生效
- 明暗主题一键切换，偏好持久化
- 批量下载改为四步向导（新增清单预览与勾选步骤）
- 双进度条：总任务 + 当前文件
- 模组详情版本列表支持折叠展开更新日志

### v2.2（2026-05）· 任务持久化 · 结算页 · 更新日志页

- 终态任务持久化本机，重启不丢失
- 日志改为「查看 / 导出」，归档于 `cache/logs`
- 新增任务结算页：失败 / 缺失明细 + 重试 + 打开目录
- 新增独立「更新日志」页

### v2.1（2026-05）· 模组列表 · 单模组下载 · 关于页

- 合并搜索与详情为「模组列表」页，分页展示
- 模组详情页新增一键下载（含 required 前置依赖）
- 新增「关于」页面

### v2.0（2026-04）· 下载队列 · 任务中心 · 扫描向导

- 下载队列：排队执行 + 暂停 / 继续 / 停止 / 删除
- 模组详情页（图标、版本、作者、简介）
- 扫描导出改为三步向导，未识别模组标灰置顶

### v1.0（2026-04）· MVP 首发

- 扫描 mods 目录并通过文件哈希反查 Modrinth
- 导出 modlist.json
- 批量 / 单模组下载（自动解析 required 前置依赖）

---

## 致谢

- [Modrinth](https://modrinth.com/) —— 开放友好的 Minecraft 模组平台，提供无需 Token 的 v2 公开 API
- [CurseForge](https://www.curseforge.com/) —— 老牌模组仓库
- [curse.tools](https://curse.tools/) —— 长期维护的 CurseForge 公共镜像，让无 Key 访问成为可能
- [Mojang](https://www.minecraft.net/) —— Minecraft 官方版本清单 API
- [FastAPI](https://fastapi.tiangolo.com/) / [uvicorn](https://www.uvicorn.org/) / [httpx](https://www.python-httpx.org/) —— 后端核心依赖
- [pywebview](https://pywebview.flowrl.com/) —— 让 Python 也能优雅地构建桌面 GUI
- [PyInstaller](https://pyinstaller.org/) —— Windows 单目录打包
- 所有为本项目提 issue、提建议、做测试的 Minecraft 玩家

---

## License

本项目仅供学习交流使用，遵循 MIT License 开源。

模组本身的版权归属各模组作者，本工具仅作为下载与迁移的辅助工具，不参与任何模组内容的再分发。
