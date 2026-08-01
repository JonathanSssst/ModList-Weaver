"""程序入口：启动 FastAPI 后台服务 + pywebview 桌面窗口

启动流程：
  1. 查找可用端口
  2. 后台线程运行 uvicorn（FastAPI 服务）
  3. 等待服务就绪
  4. 启动 pywebview 窗口访问 http://127.0.0.1:port（内嵌网页，不弹浏览器）
  5. 关闭窗口时随主进程退出（uvicorn 线程为 daemon）

版本号与 changelog 单一事实来源位于 backend.api:CURRENT_VERSION / CHANGELOG
"""
import json
import os
import socket
import sys
import threading
import time
from pathlib import Path

import uvicorn
import webview


def find_free_port(start=8765, end=8810):
    """在指定范围内查找可用端口"""
    for port in range(start, end):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("未找到可用端口，请检查端口占用")


def start_server(port):
    """在后台线程中运行 uvicorn + FastAPI"""
    uvicorn.run(
        "backend.api:app",
        host="127.0.0.1",
        port=port,
        log_level="warning",
        access_log=False,
    )


def wait_for_server(url, timeout=20):
    """等待 FastAPI 服务就绪"""
    import urllib.request
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url, timeout=1.5)
            return True
        except Exception:
            time.sleep(0.2)
    return False


def _setup_drag_drop(window):
    """通过 pywebview DOM API 支持任意位置拖拽（V3.1）

    edgechromium 后端会为 drop 事件的 file 注入 pywebviewFullPath（完整绝对路径），
    拿到路径后回调给前端 JS（window.__pywebviewDropped）分发处理。
    """
    try:
        from webview.dom import DOMEventHandler
    except Exception:
        return
    doc = window.dom.document
    # dragover / dragenter 必须 preventDefault，否则浏览器不允许放置
    doc.events.dragover += DOMEventHandler(lambda _e: None, prevent_default=True)
    doc.events.dragenter += DOMEventHandler(lambda _e: None, prevent_default=True)

    def _on_drop(event):
        files = ((event or {}).get("dataTransfer") or {}).get("files") or []
        items = []
        for f in files:
            p = (f or {}).get("pywebviewFullPath") or ""
            if not p:
                continue
            items.append({
                "path": p,
                "name": (f or {}).get("name") or os.path.basename(p.rstrip("/\\")),
                "is_dir": os.path.isdir(p),
                "ext": os.path.splitext(p)[1].lower(),
            })
        if items:
            window.evaluate_js(
                "window.__pywebviewDropped && window.__pywebviewDropped(%s)"
                % json.dumps(items, ensure_ascii=False))

    doc.events.drop += DOMEventHandler(_on_drop)


def main():
    # 版本号 / 标题：单一事实来源 backend.api.CURRENT_VERSION
    try:
        from backend.api import CURRENT_VERSION, APP_TITLE
    except Exception:
        CURRENT_VERSION = "0.0.0"
        APP_TITLE = "ModList-Weaver"

    port = find_free_port()
    url = f"http://127.0.0.1:{port}/"

    # 后台线程运行 FastAPI，daemon=True 使其随主进程退出
    server_thread = threading.Thread(target=start_server, args=(port,), daemon=True)
    server_thread.start()

    # 等待服务就绪
    if not wait_for_server(url):
        print("[错误] 后端服务启动失败，请检查依赖是否安装完整。")
        sys.exit(1)

    # 启动 pywebview 桌面窗口（内嵌网页，不会弹出系统浏览器）
    # 窗口图标：源码运行取项目根 assets/app.ico，打包后取运行时资源目录
    _icon = None
    for _base in (Path(os.path.dirname(os.path.abspath(__file__))),
                  Path(getattr(sys, "_MEIPASS", "")) if getattr(sys, "_MEIPASS", "") else None):
        if _base and (_base / "assets" / "app.ico").is_file():
            _icon = str(_base / "assets" / "app.ico")
            break
    window = webview.create_window(
        title=f"{APP_TITLE} v{CURRENT_VERSION} · Minecraft 双源模组迁移工具",
        url=url,
        width=1200,
        height=840,
        min_size=(980, 680),
        text_select=True,
        icon=_icon,
    )
    # 页面加载完成后挂载拖拽监听（获取拖入文件的完整绝对路径）
    window.events.loaded += lambda: _setup_drag_drop(window)
    webview.start()


if __name__ == "__main__":
    main()
