# ModList-Weaver

> Minecraft **双源（Modrinth + CurseForge）** 模组批量迁移桌面工具 —— 本地扫描、清单导出、断点续传、哈希校验、依赖递归一站式解决。

基于 FastAPI + pywebview 的跨平台桌面应用，无需 Java 环境，纯 Python 解析 jar 元数据并通过 Modrinth / CurseForge 双平台 API 完成模组迁移。适用于 HMCL 等启动器用户的版本切换、整合包迁移、依赖补齐等场景。

---

## 版本历史 / Changelog

> 📦 每个大版本（V1.0 / V2.0 / V3.0 …）都已通过 GitHub Actions 打包为 Windows 单目录分发包，可在仓库 **Releases** 页直接下载。

---

### 🚀 V3.0 —— 断点续传 + CurseForge 双源 + 自动化 CI/CD（2026-08）

**当前最新正式版本 · `git tag v3.0.0`**

| 分类 | 功能点 |
|---|---|
| 🔁 **断点续传** | `.part` 临时文件 + HTTP Range 请求检测，下载中断后保留已下载字节，下次自动从断点续传（Modrinth / CurseForge 双客户端一致实现） |
| 🌐 **CurseForge 双源支持** | 新增独立 `CurseForgeClient`：murmur2 指纹匹配、项目搜索、版本列表、依赖递归、文件下载、服务端 429/速率节流自适应 |
| 🔀 **多源自动路由** | `settings.source = auto/modrinth/curseforge`；扫描时 Modrinth sha512 未命中 → 自动 fallback CurseForge murmur2；下载时数字 project_id 优先 CurseForge，slug 优先 Modrinth |
| 🔐 **多算法哈希校验** | 哈希优先级自适应：`sha512 > sha1 > murmur2`，从各自源 API 返回的可用字段中自动选择最可靠的校验方案 |
| 🧪 **单元测试 29/29 PASS** | 新增 `tests/` 三套 pytest 用例：`test_scanner.py`（哈希 + jar 解析） / `test_downloader_logic.py`（版本选择 + TaskGate + 限速器 + 哈希策略） / `test_curseforge_and_settings.py`（murmur2 + Settings 持久化边界） |
| 🚀 **GitHub Actions CI** | `.github/workflows/ci.yml` 三阶段自动化：① 所有 push/PR → `windows × ubuntu` × `Python 3.10/3.11/3.12` 跑单测矩阵 ② `main/master/v* tag` → PyInstaller 打 Windows 包 ③ **打 `v*` 正式 tag** → 自动上传 `.zip` 到仓库 Release 页并生成发布说明 |
| 🏗️ **工程化** | `build.spec` 补全 backend 各模块、hashlib hiddenimports；`requirements.txt` 加入 pytest 开发依赖；`.gitignore` 补 `build/ dist/ .pytest_cache/` |

---

### 🧭 V2.0 —— 任务队列 + 实时监控 + 可暂停下载（2026-06）

- **异步任务队列**：`run_batch_download` 任务队列化，默认并发 3（可配置），多任务并行独立调度
- **协作式任务控制**：任务支持 `暂停 / 继续 / 停止 / 删除` 四元组；`TaskGate` 门控实现 awaitable 阻塞/放行/中断三种状态
- **终态持久化**：任务完成 / 失败 / 停止后持久化到 `cache/temp/tasks.json`，重启后可查看历史并一键重试（`all / failed / missing` 三种作用域）
- **实时监控**：文件粒度下载进度、瞬时网速（0.3s 滑动窗口，B/s → KB/s → MB/s → GB/s 自动换算）、跳过数独立统计
- **实时日志流**：任务日志异步流式写入，支持前端 tail 读取，一键导出 `.log`
- **令牌桶限速器**：`settings.rate_limit_mbps` 全局下行带宽节流（0 = 不限速）
- **原生对话框**：基于 tkinter 的文件夹 / 文件 / 保存路径选择，不弹浏览器窗
- **模组列表页**：Modrinth 关键词搜索 + MC 版本 + 加载器 + 项目类型筛选；单模组一键下载 + 自动补齐 required 前置依赖

---

### 🌱 V1.0 —— 项目骨架：扫描 → 导出 → 批量下载 MVP（2026-04）

- **纯 Python jar 元数据解析**：`scanner.py` 直接读取 jar 内部 `fabric.mod.json` / `mods.toml` / `MANIFEST.MF`，自动识别 Fabric / Quilt / Forge / NeoForge 加载器，**不依赖 Java 环境**
- **sha512 批量反查**：本地 jar 算 sha512 → Modrinth `version_files` 批量接口反查 project_id，识别率高；未命中标灰人工处理
- **HMCL 兼容清单导出**：一键导出 `modlist.json`，字段 `name / version / game_version / loader / projects[]` 完全匹配 HMCL 导入格式
- **Modrinth 批量下载**：读取 modlist → 按目标 MC 版本 + 加载器选择适配版本 → sha512 去重校验（一致跳过 / 不一致覆盖）
- **依赖递归**：`required` 前置依赖自动下载，`optional` 忽略；`processed` 集合去重防环
- **缺失模组报告**：无适配版本的模组导出 `missing_mods.txt` 清单
- **桌面壳**：`main.py` 启动 uvicorn 后端（127.0.0.1:8765~8810 自动找可用端口） + pywebview 内嵌 WebView2 桌面窗口（1200×840）
- **深色科技风前端**：原生 HTML/CSS/JS 单页，左侧导航 + 右侧内容区 + 底部状态栏网速显示
- **settings 持久化**：`cache/settings.json` 热更新 max_concurrency / rate_limit_mbps / theme

---

## 核心特性

### 扫描 & 识别（V3.0 多源）
- 纯 Python 读取 jar 内部元数据（`fabric.mod.json` / `mods.toml` / `MANIFEST.MF`），自动识别 Fabric / Quilt / Forge / NeoForge 加载器
- **先 Modrinth sha512 批量反查** → **未命中再 CurseForge murmur2 指纹反查**，识别率显著提升
- 每个命中结果带 `source` 字段（`modrinth` / `curseforge`），前端可区分来源
- 无法识别的模组在前端标灰展示，便于人工处理

### 清单导出
- 一键导出 HMCL 兼容的 `modlist.json` 清单（V3.0 新增 `source` 字段写入每项，保留来源信息）
- 字段结构：`name / version:3.0 / game_version / loader / projects:[{project_id, source, ...}]`

### 批量下载（V3.0 多源 + 断点续传）
- 读取 modlist 后按 source / settings 偏好从 Modrinth 或 CurseForge 查询适配版本
- 递归识别 `required` 强制前置依赖并自动下载（`optional` 可选依赖忽略）；依赖偏好跟随父模组来源，避免跨源混乱
- `processed` 集合去重，防止循环依赖死循环
- 无适配版本的模组自动标记缺失，导出 `missing_mods.txt` 清单
- **断点续传**：下载中断后 `.part` 文件保留，下次启动自动检测 Range 支持并从断点续传，减少带宽浪费

### 哈希校验机制（V3.0 多算法自适应）
下载前比对本地文件与服务端期望哈希（**按 sha512 > sha1 > murmur2 优先级自动选择最可靠的算法**）：
- 哈希一致 → **跳过**，不重复下载
- 哈希不一致 → **删除旧文件并覆盖**（处理旧版本或损坏文件）
- 不存在 → 正常下载

### 任务队列
- 同时支持多任务排队（并发数可配置，默认 3）
- 任务支持 **暂停 / 继续 / 停止 / 删除** 协作式控制
- 终态任务持久化到 `cache/temp/tasks.json`，重启后可继续查看与重试
- 失败/缺失模组可一键重试（按 `all / failed / missing` 作用域）

### 实时监控
- 下载进度按文件粒度展示（已下载字节 / 总字节）
- 瞬时网速显示（0.3s 采样窗口，自动单位换算 B/s → KB/s → MB/s → GB/s）
- 跳过计数独立展示，区分"新下载"与"已存在校验通过"
- 任务日志实时流式输出，可导出为 `.log` 文件

### 其他
- **双源模组搜索**：`/api/search_mod` 支持 `source=modrinth/curseforge`
- **双源模组详情**：`/api/project/{id}` 支持 `source` 参数，或按 project_id 数字特征自动选择
- 原生对话框：文件夹/文件选择、保存路径（基于 tkinter）
- 网速限制：令牌桶限速器，全局下行带宽可配（MB/s，0 表示不限速）

---

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面壳 | pywebview（内嵌 WebView2，无系统浏览器弹窗） |
| 后端 | FastAPI + uvicorn + httpx + pydantic |
| **双源客户端** | `backend/modrinth_client.py`（Modrinth REST API + 断点续传） |
|  | `backend/curseforge_client.py`（curse.tools 镜像 API + murmur2 指纹 + 速率节流） |
| 前端 | 原生 HTML / CSS / JavaScript（深色科技风） |
| 打包 | PyInstaller（目录模式，兼容开发态与打包态资源路径） |
| **测试** | pytest + pytest-asyncio（29 个核心纯逻辑用例） |
| **CI / 发布** | GitHub Actions（`test` 矩阵 + `build-windows` 打包上传 Release） |
| 元数据解析 | zipfile + json + tomllib（Python 3.11+ 内置） |
| 指纹哈希 | Modrinth: sha512；CurseForge: murmur2-hash（CF 文件指纹算法） |

---

## 目录结构

```
ModList-Weaver/
├── main.py                  # 程序入口：FastAPI + pywebview
├── build.spec               # PyInstaller 打包配置（含 V3.0 CurseForge 相关 hiddenimports）
├── requirements.txt         # Python 依赖（含 pytest / pytest-asyncio）
├── .github/workflows/ci.yml # GitHub Actions CI：单测矩阵 + Windows 打包 + Release 上传
├── backend/
│   ├── api.py               # FastAPI 路由与接口定义（V3.0 新增 source 参数）
│   ├── scanner.py           # jar 元数据解析 + sha512 / murmur2 双源哈希反查
│   ├── downloader.py        # 下载队列 + 依赖递归 + 哈希校验 + 多源路由
│   ├── modrinth_client.py   # Modrinth API 客户端（V3.0 新增断点续传）
│   ├── curseforge_client.py # CurseForge 客户端（搜索 / 版本 / 依赖 / 下载 / 速率节流）★V3.0 新增
│   └── settings.py          # 全局设置（扩展 source 字段）+ 令牌桶限速器
├── tests/                   # pytest 测试用例（29 个，V3.0 新增）
│   ├── test_scanner.py
│   ├── test_downloader_logic.py
│   └── test_curseforge_and_settings.py
├── frontend/
│   ├── index.html           # 前端入口
│   ├── main.js              # 前端业务逻辑
│   ├── style.css            # 深色主题样式
│   └── src/images/          # 静态图片资源
├── cache/                   # 运行时数据（已 gitignore）
│   ├── settings.json        # 用户设置
│   ├── temp/tasks.json      # 任务历史持久化
│   └── logs/                # 任务日志缓存
├── mods/                    # 临时模组存放目录（运行时填充，已 gitignore）
└── output/                  # 导出清单输出目录（已 gitignore）
```

---

## 快速开始

### 环境要求
- Python 3.10+（推荐 3.11+，原生支持 `tomllib`）
- Windows / macOS / Linux 桌面环境（pywebview 依赖系统 WebView）

### 安装依赖

```bash
pip install -r requirements.txt
```

依赖清单：
```
fastapi>=0.110.0
uvicorn>=0.27.0
httpx>=0.27.0
pywebview>=4.4
pydantic>=2.5
pytest>=8.0
pytest-asyncio>=0.23
```

### 运行

```bash
python main.py
```

应用会在 `127.0.0.1:8765~8810` 范围内自动查找可用端口，启动 FastAPI 后端并打开 pywebview 桌面窗口（1200×840，最小 980×680）。

### 单元测试（V3.0）

```bash
python -m pytest tests -v
```

当前覆盖 29 个纯逻辑用例，不依赖真实网络，CI 里也会在 Windows / Ubuntu × Python 3.10 / 3.11 / 3.12 矩阵下运行。

### 打包为可执行文件

```bash
pyinstaller build.spec
```

产物位于 `dist/ModList-Weaver/ModList-Weaver.exe`（目录模式，保留前端资源结构）。

---

## GitHub Actions CI / 发布（V3.0）

`.github/workflows/ci.yml` 定义了 2 个 job，push / PR / tag 触发：

| Job | 触发条件 | 做什么 |
|---|---|---|
| `test` | 所有 push / PR | `windows-latest` + `ubuntu-latest` × Python 3.10 / 3.11 / 3.12 矩阵跑 `pytest tests` |
| `build-windows` | 仅 `main / master` push **或** `v*` tag | 1. 单测通过后 2. PyInstaller 打 Windows 包 3. 压缩为 `<name>-Windows-<tag>.zip` 4. 同时传 Artifact（30 天）与 GitHub Release（仅 v* tag） |

**发布流程**：
```bash
# 1) 本地打好 tag 并推送
git tag v3.0.0
git push origin v3.0.0

# 2) GitHub Actions 自动：跑测试 → 打包 → 上传 Release 页
#    产物：ModList-Weaver-Windows-v3.0.0.zip
```

---

## 工作流

应用左侧导航分为两组：

**A. 扫描 & 导出清单**（三步向导）
1. 选择本地 mods 目录 → 自动扫描所有 `.jar` 文件
2. **双源反查**：先 Modrinth sha512 → 未命中再 CurseForge murmur2，获取 `project_id` + `source`
3. 导出 HMCL 兼容的 modlist.json（带来源字段）

**B. 批量下载模组**（三步向导 + 断点续传）
1. 选择 modlist.json + 目标 MC 版本 + 加载器 + 保存目录（可在 settings 中指定下载源优先级：`auto / modrinth / curseforge`）
2. 预览清单可勾选下载范围
3. 启动下载队列，实时监控进度与网速；**中断后保留 `.part`，下次自动续传**

**C. 模组列表**
- **双源浏览**：搜索时可选 `source=modrinth/curseforge`
- 查看模组详情（图标、作者、版本、更新日志）
- 单模组下载（自动补齐 required 前置依赖，依赖来源默认跟随父模组）

**D. 任务中心**
- 查看进行中队列与已完成历史
- 暂停 / 继续 / 停止 / 删除任务
- 重试失败或缺失模组
- 查看 / 导出任务日志

---

## API 接口

后端 FastAPI 提供 REST 接口（关闭了 docs_url，可通过代码注释查看完整列表），核心端点：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/scan_mods` | 扫描 mods 目录并双源反查 project_id |
| POST | `/api/export_json` | 导出 HMCL 兼容 modlist（带来源） |
| POST | `/api/preview_list` | 预览 modlist 清单 |
| POST | `/api/download_from_list` | 批量下载（入队，支持断点续传） |
| POST | `/api/search_mod` | 关键词搜索（`source` 可选 modrinth / curseforge） |
| GET | `/api/project/{id}` | 模组详情（`source` 可选，按 ID 特征自动） |
| GET | `/api/mc_versions` | Minecraft 官方版本列表（6h 缓存） |
| POST | `/api/download_single_mod` | 单模组 + 依赖下载（双源） |
| GET | `/api/queue` | 队列快照（进行中 + 历史） |
| GET | `/api/task_status` | 轮询任务进度 |
| POST | `/api/task_pause\|resume\|stop\|delete` | 任务控制 |
| POST | `/api/retry_task` | 重试失败/缺失模组 |
| GET | `/api/logs/{id}` | 读取任务日志 |
| GET | `/api/logs/{id}/download` | 导出日志为 .log |
| GET | `/api/pick_folder\|file\|save` | 原生对话框 |
| GET/POST | `/api/settings` | 读取/更新设置（含 `source` 下载源偏好） |

---

## 配置

设置持久化在 `cache/settings.json`，运行时热更新：

```json
{
  "max_concurrency": 3,
  "rate_limit_mbps": 0,
  "theme": "auto",
  "source": "auto"
}
```

- `max_concurrency`：最大并发下载任务数（默认 3）
- `rate_limit_mbps`：全局下行限速（MB/s，0 = 不限速）
- `theme`：主题模式（auto / light / dark）
- **`source`**：下载源偏好（`auto` 自动 / `modrinth` 仅 Modrinth / `curseforge` 仅 CurseForge，默认 auto）

---

## 致谢

- [Modrinth](https://modrinth.com/) —— 提供开放的模组 API
- [CurseForge](https://www.curseforge.com/) 与 [curse.tools 镜像 API](https://curse.tools/) —— 提供 CurseForge 生态的无密钥访问接口
- [HMCL](https://hmcl.huangyuhui.net/) —— modlist 清单格式参考
- 所有 Minecraft 模组开发者

---

## License

本项目仅供学习与个人使用。模组版权归各自作者所有，请遵守 Modrinth 与各模组的许可协议。
