# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包配置：ModList-Weaver

打包命令：
    pyinstaller build.spec

产物：dist/ModList-Weaver/ModList-Weaver.exe（目录模式，保留前端资源）

说明：
- 采用目录模式（COLLECT）而非单文件，避免解压临时目录带来的资源路径问题
- 把 frontend 目录与 backend 包一起打进去，运行时通过 sys._MEIPASS 解析路径
- hiddenimports 包含 pywebview 各后端与 tomllib，避免打包后找不到模块
"""

import os

block_cipher = None

# 项目根目录
BASE_DIR = os.path.abspath(SPECPATH)

a = Analysis(
    ['main.py'],
    pathex=[BASE_DIR],
    binaries=[],
    datas=[
        # 前端静态资源打包进运行时根目录
        ('frontend', 'frontend'),
        # 应用图标（窗口/可执行文件）
        ('assets', 'assets'),
    ],
    hiddenimports=[
        'uvicorn.logging',
        'uvicorn.loops',
        'uvicorn.loops.auto',
        'uvicorn.protocols',
        'uvicorn.protocols.http',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.websockets',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.lifespan',
        'uvicorn.lifespan.on',
        # pywebview 各平台后端
        'webview.platforms.edgechromium',
        'webview.platforms.mshtml',
        'webview.platforms.winforms',
        # jar 元数据解析（Python 3.11+ 内置）
        'tomllib',
        'tkinter',
        'tkinter.filedialog',
        # ---- V3.0：CurseForge 客户端 ----
        'backend.curseforge_client',
        'backend.downloader',
        'backend.settings',
        'backend.scanner',
        'backend.api',
        'backend.modrinth_client',
        'hashlib',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # 应用不使用 Qt，排除多个 Qt 绑定避免 PyInstaller hook 冲突
    excludes=['PyQt5', 'PyQt6', 'PySide2', 'PySide6'],
    cipher=block_cipher,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='ModList-Weaver',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,            # 桌面工具，不弹控制台黑窗
    icon=os.path.join(BASE_DIR, 'assets', 'app.ico'),
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    name='ModList-Weaver',
)
