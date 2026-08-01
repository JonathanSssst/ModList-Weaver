"""程序入口：启动 FastAPI 后台服务 + pywebview 桌面窗口

启动流程：
  1. 查找可用端口
  2. 后台线程运行 uvicorn（FastAPI 服务）
  3. 等待服务就绪
  4. 启动 pywebview 窗口访问 http://127.0.0.1:port（内嵌网页，不弹浏览器）
  5. 关闭窗口时随主进程退出（uvicorn 线程为 daemon）

版本号与 changelog 单一事实来源位于 backend.api:CURRENT_VERSION / CHANGELOG
"""
import os
import socket
import sys
import threading
import time

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
    webview.create_window(
        title=f"{APP_TITLE} v{CURRENT_VERSION} · Minecraft 双源模组迁移工具",
        url=url,
        width=1200,
        height=840,
        min_size=(980, 680),
        text_select=True,
    )
    webview.start()


if __name__ == "__main__":
    main()
