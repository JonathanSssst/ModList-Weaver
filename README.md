# ModList-Weaver

> Minecraft 双源（Modrinth / CurseForge）模组迁移桌面工具 —— 一键扫描本地 mods，导出模组清单，跨版本/跨加载器批量重下载，自带断点续传、哈希校验、依赖递归与任务队列。

当前版本：**v3.6.5** · 平台：Windows x64（PyInstaller 打包 + Inno Setup 安装包） · 技术栈：Python 3.10+ / FastAPI / pywebview / 原生 HTML+JS

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

Release 提供两种分发方式，任选其一：

- **安装版（推荐）**：下载 `ModList-Weaver-Windows-vX.X.X-setup.exe`，双击安装到 `%LocalAppData%\ModList-Weaver`，自动创建开始菜单 / 桌面快捷方式，无需解压。
- **便携版**：下载 `ModList-Weaver-Windows-vX.X.X.zip`，解压后得到一个 `ModList-Weaver` 文件夹，双击其中的 `ModList-Weaver.exe` 即可启动（首次启动稍慢，会初始化缓存）。

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

预期输出：53 个用例全部 PASS。

### 本地打包

```bash
pip install pyinstaller pywin32-ctypes
pyinstaller build.spec
# 产物位于 dist/ModList-Weaver/

# （可选）编译 Inno Setup 安装包（需已安装 Inno Setup 6）
# "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" /DMyAppVersion=3.6.5 installer.iss
# 产物位于 output/
```

---

## 配置

所有运行时配置持久化在 `cache/settings.json`（首次运行自动生成），支持应用内「设置」页热更新。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `max_concurrency` | `3` | 同时运行的最大下载任务数 |
| `rate_limit_mbps` | `0` | 全局下行带宽限制（MB/s），`0` 表示不限速 |
| `theme` | `auto` | 界面主题：`auto` / `light` / `dark` |
| `accent` | `default` | 强调色：`default`（默认蓝）/ `green`（护眼绿）/ `indigo`（靛蓝） |
| `contrast` | `normal` | 对比度：`normal` / `high`（高对比） |
| `source` | `auto` | 下载源偏好：`auto`（先 Modrinth 后 CurseForge）/ `modrinth` / `curseforge` |
| `curseforge_api_key` | `""` | 可选 CurseForge 官方 API Key；为空时走 `api.curse.tools` 公共镜像 |
| `man_folder` | `""` | 「我的清单」页记忆的上次 mods 目录，重开自动恢复 |

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
- 无边框窗口 + 自定义标题栏：拖动标题栏移动窗口（仅标题栏可拖动，内容区不受影响）、双击最大化 / 还原、四边四角拖拽调宽、最大化不遮挡任务栏（V3.6.4）

### 8. 下载完成通知与存储清理（V3.2）

- 全部任务结束后弹系统通知 + 三音提示，汇总成功 / 失败 / 跳过数
- 设置页「存储与清理」：一键清空任务日志、导入临时文件、历史记录并统计占用
- 需在浏览器 / WebView 中允许桌面通知权限

### 9. 本地模组管理 · 一键更新（V3.3 / V3.7）

- 「本地模组管理」页（E）扫描本地 mods 目录（支持 `.jar.disabled` 禁用文件），按文件哈希反查识别
- 启用 / 禁用（`.disabled` 后缀）/ 删除 / 打开源页面 / 查看详情，未识别模组标灰展示
- 一键检查更新：按目标版本 / 加载器批量下载最新适配版本并自动移除旧文件，原禁用模组更新后保持禁用状态
- 两步向导化（选择目录 → 已安装模组列表），记住上次目录，重开应用自动恢复并自动扫描
- 扫描耗时较长时，「开始扫描」按钮底边显示实时进度条（轮询 `/api/scan_progress`）

### 10. 模组迁移（V3.5 / V3.6）

- 四步向导：扫描源目录 → 勾选模组 → 目标配置 → 确认迁移
- 跳过导出清单环节，直接按目标版本 / 加载器批量下载到新目录

### 11. 我的清单（V3.6）

- 自定义模组包页重构为「我的清单」：搜索添加 / 移除模组、自定义文件名与顺序
- 添加模组时自动读取并附带必需前置依赖（去重），确认提示区分已附带的前置数量
- 导出为与标准清单同格式的 JSON

### 12. 配色主题与界面体验（V3.6 / V3.7）

- 明暗主题 + 3 套强调色（默认蓝 / 护眼绿 / 靛蓝）+ 标准 / 高对比两档，设置页切换并持久化
- 任务中心实时进度：运行中 / 排队中 / 已完成数量实时更新，新增「整体进度」卡（加权总进度 / 累计网速 / 文件数 / ETA）
- 耗时操作为按钮增加 spinner，列表加载展示骨架屏占位
- 详情页：前置依赖卡片、可折叠版本日志、作者角色标签、来源链接（GitHub / Modrinth / CurseForge / MC百科）、版本依赖下拉切换

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
| 测试 | pytest + pytest-asyncio（53 用例） |
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
│   ├── index.html              # 单页应用外壳 + 页面（导出 A / 导入 B / 迁移 I / 我的清单 J / 模组列表 C / 本地模组 E / 任务中心 D / 详情 / 设置 H / 关于 F）
│   ├── main.js                 # 交互逻辑（侧边栏 / 向导 / 轮询 / 主题）
│   └── style.css               # 明暗主题 + 强调色 / 高对比样式
│
├── assets/                      # 应用图标（app.ico / app.png，打包用）
│
├── tests/                      # pytest 单元测试
│   ├── __init__.py
│   ├── test_scanner.py         # 哈希计算 / jar 元数据解析
│   ├── test_downloader_logic.py# 版本选择 / TaskGate / 限速器 / 哈希策略
│   ├── test_curseforge_and_settings.py  # murmur2 / Settings 持久化
│   ├── test_resume_and_updates.py      # 断点恢复 / 版本比较 / 更新检测 / 清单导入
│   ├── test_qol_v32.py                # 源页面跳转 / 存储统计与清理（V3.2）
│   └── test_manage_v33.py              # 本地管理接口 / 一键更新（V3.3）
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
| GET | `/api/changelog` | 本地 CHANGELOG.md 文档（更新日志页渲染） |
| GET | `/api/check_app_update` | 检查应用更新（GitHub Releases） |

### 扫描与导出

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/scan_mods` | 扫描 mods 目录，多源哈希反查 project_id |
| GET | `/api/scan_progress` | 轮询扫描进度（done / total / phase） |
| POST | `/api/export_json` | 生成 modlist.json 并保存 |
| POST | `/api/preview_list` | 解析 modlist.json 返回清单（下载前勾选用） |
| POST | `/api/import_modlist` | 导入 modlist.json 内容到临时文件 |

### 本地模组管理与一键更新（V3.3）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/manage_scan` | 扫描本地 mods 目录（含 `.jar.disabled` 禁用文件） |
| POST | `/api/manage_mod` | 本地 mod 管理：启用 / 禁用 / 删除 |
| POST | `/api/check_updates` | 按目标版本 / 加载器检测可更新模组 |
| POST | `/api/download_updates` | 批量下载更新（含旧文件清理） |

### 模组迁移（V3.5）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/migrate_mods` | 迁移：扫描源目录 → 按目标版本 / 加载器批量下载到新目录 |

### 搜索与详情

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/search_mod` | 关键词搜索模组（支持 `source` 切换双源） |
| GET | `/api/project/{id}` | 模组详情：图标 / 作者 / 版本列表 / 更新日志 |
| POST | `/api/reverse_deps` | 反依赖（后置）分析 |
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

关键词搜索 + 双源切换 + 分页浏览 + 模组详情页（图标 / 版本 / 作者 / 更新日志 / 前置依赖与反依赖）+ 一键单模组下载（含前置依赖）。

### D. 任务中心

- 进行中任务：双进度条 + 实时网速 + 暂停 / 继续 / 停止 / 删除
- 实时汇总：运行中 / 排队中 / 已完成数量 + 「整体进度」卡（按文件加权的总进度、累计网速、文件数、预计剩余时间）
- 已完成任务：持久化历史 + 查看日志 / 导出日志 + 重试 + 打开目录

### E. 本地模组管理

```
扫描本地 mods 目录（含 .jar.disabled 禁用文件）
   ↓
哈希反查识别 → 列表展示（已启用 / 已禁用 / 未识别）
   ↓
启用 · 禁用 · 删除 · 查看详情 · 打开源页面
   ↓
一键检查更新（目标版本 / 加载器）→ 批量下载并自动移除旧文件
```

### F. 模组迁移（四步向导）

```
选择旧版本 mods 源目录 → 扫描
   ↓
勾选要迁移的模组
   ↓
目标 MC 版本 + 加载器 + 新目录
   ↓
批量下载（跳过导出清单环节）
```

### G. 我的清单

```
搜索添加 / 移除模组（自动附带必需前置依赖）
   ↓
自定义文件名与顺序
   ↓
导出与标准清单同格式的 JSON
```

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

### v3.6.5（2026-08）· 搜索修复 · CurseForge 镜像更新

- **project ID 精确搜索**：模组列表 / 我的清单搜索框直接输入 project ID 无法命中——搜索接口不索引 project_id。现在普通搜索无结果时自动按 ID 精确解析：纯数字视为 CurseForge project_id，其余尝试 Modrinth slug / project_id（输入 `238222` 直接命中 JEI、输入 `AANobbMI` 直接命中 Sodium）。
- **CurseForge 镜像更新**：社区镜像原地址 `api.curse.tools/v1/tools/cf` 已失效（全部 404），改用 `api.curse.tools/v1`（搜索 / 详情 / 版本 / 指纹反查全量可用），CurseForge 源恢复。

### v3.6.4（2026-08）· 无边框窗口 · 自定义标题栏

- **无边框窗口**：改为 frameless 窗口 + 前端自定义标题栏——拖动标题栏移动窗口（仅标题栏可拖动，内容区不受影响）、双击标题栏最大化 / 还原、最小化 / 最大化 / 关闭按钮、四边与四角拖拽调宽（带缩放光标提示）。
- **最大化**：尺寸自动钳制在工作区内，不遮挡任务栏；最大化 / 还原时标题栏图标自动切换。
- **界面**：标题栏配色随主题切换，窗口控制按钮悬停高亮（关闭按钮悬停变红）。

### v3.6.3（2026-08）· 扫描进度显示 · 本地目录记忆修复

- **扫描进度**：扫描目录耗时较长时，「开始扫描」按钮底边显示实时进度条（轮询 `/api/scan_progress`），配合按钮 spinner 与骨架屏，扫描过程不再毫无反馈。
- **目录记忆修复**：本地模组目录改为持久化到后端 `cache/settings.json`（原 localStorage 在部分环境重启即丢失），重开应用自动恢复上次目录并自动扫描。

### v3.6.2（2026-08）· 任务中心实时进度 · 我的清单向导化 · 配色主题 · 骨架屏加载

- **任务中心**：运行中 / 排队中 / 已完成数量实时更新，新增「整体进度」卡（按文件加权的总进度、累计网速、文件数与预计剩余时间）。
- **我的清单**：改为两步向导（选择 mods 目录 → 已安装模组列表），记住上次使用的目录，步骤指示条可点击切换。
- **主题**：新增 3 套强调色（默认蓝 / 护眼绿 / 靛蓝）与「标准 / 高对比」对比度选项，设置页切换并自动保存。
- **加载体验**：耗时操作为按钮增加 spinner，列表加载展示骨架屏占位，避免界面闪烁。
- **界面**：导出 / 导入 / 迁移 / 我的清单四页统计卡统一改为紧凑胶囊样式。

### v3.6.1（2026-08）· 我的清单页风格统一 · 详情页重写 · 版本依赖选择

- **我的清单**：清空 / 导出 / 添加三按钮统一等高带图标，数量统计卡改紧凑胶囊。
- **详情页**：重写布局——前置依赖卡片提前展示、版本日志可折叠、作者角色标签移除、新增来源链接（GitHub / Modrinth / CurseForge / MC百科）。
- **前置依赖**：新增版本下拉框，可切换查看不同版本的依赖；下载入口移入主信息栏。
- **模组列表**：头部结果数 / 当前页统计卡改为紧凑横排。

### v3.6.0（2026-08）· 迁移向导化 · 我的清单悬浮框

- **模组迁移**：改为四步向导（扫描源目录 → 勾选模组 → 目标配置 → 确认迁移）。
- **我的清单**：原「自定义模组包」页重命名，添加模组时自动附带必需前置依赖（去重），导出改为悬浮框。

### v3.5.0（2026-08）· 页面重构 · 模组迁移 · 自定义模组包 · 详情页依赖分析

- **菜单重构**：侧边栏改为「导出」「导入」命名并移除字母角标；新增「模组迁移」「自定义模组包」两个页面。
- **模组迁移**：扫描源目录后直接按目标版本 / 加载器批量下载到新目录，跳过导出清单步骤。
- **自定义模组包**：搜索添加 / 移除模组，自定义文件名与顺序，导出与标准清单同格式 JSON。
- **详情页**：新增前置依赖展示（点击跳转依赖详情）与反依赖分析；作者按角色标注；返回逻辑回到来源页面。

### v3.4.0（2026-08）· 发布安装包 · 便携版整理为单文件夹

- **安装包**：新增 Windows 安装版（`.setup.exe`），双击安装到 `%LocalAppData%\ModList-Weaver`，自动创建开始菜单 / 桌面快捷方式，无需管理员权限。
- **便携版**：zip 压缩包改为包含顶层文件夹，解压后得到单一 `ModList-Weaver` 文件夹，不再需要分别提取 `.exe` 与 `_internal`。
- **发布**：GitHub Release 同时提供便携版与安装版两种分发方式，CI 自动构建并上传。

### v3.3.2（2026-08）· 操作后页面状态重置 · 更新日志与侧边栏修复

- **页面重置**：扫描、导出、批量下载、单模组下载与本地模组更新等操作完成后，自动将对应页面向导与表单恢复到初始状态，便于连续进行下一次操作。
- **界面修复**：修复侧边栏点击无响应的致命脚本错误（重复声明变量导致整份脚本无法加载），恢复全部页面切换与交互。
- **更新日志修复**：修复更新日志页面顶部出现多余蓝色横条的问题（文档标题被误当作日志条目渲染）。

### v3.3.1（2026-08）· 加载器匹配修正 · 更新日志本地化 · 界面优化

- **加载器匹配**：修复本地模组检查更新时加载器不对等的问题（Fabric 误匹配 Forge 版本），更新检测与下载均严格按选定加载器过滤。
- **更新日志**：更新日志改为读取本地 `CHANGELOG.md` 文档，支持点击版本号跳转到对应 GitHub Release。
- **界面优化**：移除面包屑左侧汉堡图标（折叠侧边栏仅由侧边栏下方按钮控制），优化模组列表页面高度减少滚动。
- **兼容性提醒**：一键更新时提示模组版本之间可能存在兼容性问题。

### v3.3.0（2026-08）· 一键更新已安装模组 · 本地 mods 目录管理

- **一键更新**：新增「本地模组」页（E），扫描本地 mods 目录后一键检查更新，批量下载最新适配版本并自动移除旧文件，原禁用模组更新后保持禁用状态。
- **本地目录管理**：支持启用 / 禁用（`.disabled` 后缀）/ 删除 / 打开源页面 / 查看详情，未识别模组标灰展示，可直接进入模组列表页查看详情。
- **更新任务**：任务中心新增「模组更新」任务类型，纳入队列 / 进度 / 结算 / 断点恢复体系，失败与缺失可在结算页重试。
- **工程化**：`scan_mods` 新增 `include_disabled` 参数；新增 `/api/manage_scan`、`/api/manage_mod`、`/api/download_updates` 三个接口。
- **测试**：新增 `tests/test_manage_v33.py`（本地管理接口 + 一键更新 + `_cleanup_old_file`），pytest 47/47 通过。

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
