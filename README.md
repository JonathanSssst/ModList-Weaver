# ModList-Weaver

> Minecraft Modrinth 模组批量迁移桌面工具 —— 本地扫描、清单导出、批量下载、哈希校验、依赖递归一站式解决。

基于 FastAPI + pywebview 的跨平台桌面应用，无需 Java 环境，纯 Python 解析 jar 元数据并通过 Modrinth API 完成模组迁移。适用于 HMCL 等启动器用户的版本切换、整合包迁移、依赖补齐等场景。

---

## 核心特性

### 扫描 & 识别
- 纯 Python 读取 jar 内部元数据（`fabric.mod.json` / `mods.toml` / `MANIFEST.MF`），自动识别 Fabric / Quilt / Forge / NeoForge 加载器
- 计算 `sha512` 哈希后调用 Modrinth `version_files` 接口批量反查 `project_id`，识别率高
- 无法识别的模组在前端标灰展示，便于人工处理

### 清单导出
- 一键导出 HMCL 兼容的 `modlist.json` 清单（仅含成功识别的模组）
- 字段结构：`name / version / game_version / loader / projects:[{project_id, ...}]`

### 批量下载
- 读取 modlist 后向 Modrinth 查询目标 MC 版本 + 加载器的适配版本
- 递归识别 `required` 强制前置依赖并自动下载（`optional` 可选依赖忽略）
- `processed` 集合去重，防止循环依赖死循环
- 无适配版本的模组自动标记缺失，导出 `missing_mods.txt` 清单

### 哈希校验机制
下载前比对本地文件 `sha512` 与 Modrinth 期望哈希：
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
- 模组搜索：关键词 + 游戏版本 + 加载器 + 项目类型筛选
- 模组详情：图标、作者团队、版本列表、更新日志
- 原生对话框：文件夹/文件选择、保存路径（基于 tkinter）
- 网速限制：令牌桶限速器，全局下行带宽可配（MB/s，0 表示不限速）

---

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面壳 | pywebview（内嵌 WebView2，无系统浏览器弹窗） |
| 后端 | FastAPI + uvicorn + httpx + pydantic |
| 前端 | 原生 HTML / CSS / JavaScript（深色科技风） |
| 打包 | PyInstaller（目录模式，兼容开发态与打包态资源路径） |
| 元数据解析 | zipfile + json + tomllib（Python 3.11+ 内置） |

---

## 目录结构

```
ModList-Weaver/
├── main.py                  # 程序入口：FastAPI + pywebview
├── build.spec               # PyInstaller 打包配置
├── requirements.txt         # Python 依赖
├── backend/
│   ├── api.py               # FastAPI 路由与接口定义
│   ├── scanner.py           # jar 元数据解析 + sha512 哈希反查
│   ├── downloader.py        # 下载队列 + 依赖递归 + 哈希校验
│   ├── modrinth_client.py   # Modrinth API 客户端（httpx 连接池）
│   └── settings.py          # 全局设置 + 令牌桶限速器
├── frontend/
│   ├── index.html           # 前端入口
│   ├── main.js              # 前端业务逻辑
│   ├── style.css            # 深色主题样式
│   └── src/images/          # 静态图片资源
├── cache/                   # 运行时数据（已 gitignore）
│   ├── settings.json        # 用户设置
│   ├── temp/tasks.json      # 任务历史持久化
│   └── logs/                # 任务日志缓存
├── mods/                    # 模组存放目录（运行时填充）
└── output/                  # 导出清单输出目录
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
```

### 运行

```bash
python main.py
```

应用会在 `127.0.0.1:8765~8810` 范围内自动查找可用端口，启动 FastAPI 后端并打开 pywebview 桌面窗口（1200×840，最小 980×680）。

### 打包为可执行文件

```bash
pyinstaller build.spec
```

产物位于 `dist/ModList-Weaver/ModList-Weaver.exe`（目录模式，保留前端资源结构）。

---

## 工作流

应用左侧导航分为两组：

**A. 扫描 & 导出清单**（三步向导）
1. 选择本地 mods 目录 → 自动扫描所有 `.jar` 文件
2. 通过 sha512 哈希反查 Modrinth 获取 project_id
3. 导出 HMCL 兼容的 modlist.json

**B. 批量下载模组**（三步向导）
1. 选择 modlist.json + 目标 MC 版本 + 加载器 + 保存目录
2. 预览清单可勾选下载范围
3. 启动下载队列，实时监控进度与网速

**C. 模组列表**
- 浏览 Modrinth 模组目录，按关键词/版本/加载器筛选
- 查看模组详情（图标、作者、版本、更新日志）
- 单模组下载（自动补齐 required 前置依赖）

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
| POST | `/api/scan_mods` | 扫描 mods 目录并反查 project_id |
| POST | `/api/export_json` | 导出 HMCL 兼容 modlist |
| POST | `/api/preview_list` | 预览 modlist 清单 |
| POST | `/api/download_from_list` | 批量下载（入队） |
| POST | `/api/search_mod` | 关键词搜索 Modrinth 模组 |
| GET | `/api/project/{id}` | 模组详情 |
| GET | `/api/mc_versions` | Minecraft 官方版本列表（6h 缓存） |
| POST | `/api/download_single_mod` | 单模组 + 依赖下载 |
| GET | `/api/queue` | 队列快照（进行中 + 历史） |
| GET | `/api/task_status` | 轮询任务进度 |
| POST | `/api/task_pause\|resume\|stop\|delete` | 任务控制 |
| POST | `/api/retry_task` | 重试失败/缺失模组 |
| GET | `/api/logs/{id}` | 读取任务日志 |
| GET | `/api/logs/{id}/download` | 导出日志为 .log |
| GET | `/api/pick_folder\|file\|save` | 原生对话框 |
| GET/POST | `/api/settings` | 读取/更新设置 |

---

## 配置

设置持久化在 `cache/settings.json`，运行时热更新：

```json
{
  "max_concurrency": 3,
  "rate_limit_mbps": 0,
  "theme": "auto"
}
```

- `max_concurrency`：最大并发下载任务数（默认 3）
- `rate_limit_mbps`：全局下行限速（MB/s，0 = 不限速）
- `theme`：主题模式（auto / light / dark）

---

## 致谢

- [Modrinth](https://modrinth.com/) —— 提供开放的模组 API
- [HMCL](https://hmcl.huangyuhui.net/) —— modlist 清单格式参考
- 所有 Minecraft 模组开发者

---

## License

本项目仅供学习与个人使用。模组版权归各自作者所有，请遵守 Modrinth 与各模组的许可协议。
