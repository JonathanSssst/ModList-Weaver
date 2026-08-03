"""程序入口：启动 FastAPI 后台服务 + pywebview 桌面窗口

启动流程：
  1. 查找可用端口
  2. 后台线程运行 uvicorn（FastAPI 服务）
  3. 等待服务就绪
  4. 启动 pywebview 窗口访问 http://127.0.0.1:port（内嵌网页，不弹浏览器）
  5. 关闭窗口时随主进程退出（uvicorn 线程为 daemon）

版本号与 changelog 单一事实来源位于 backend.api:CURRENT_VERSION / CHANGELOG

窗口（V3.7）：frameless 无边框 + 前端自定义标题栏。
  - 拖动窗口：pywebview 原生拖拽区（标题栏 #titlebarDrag 带 .pywebview-drag-region 类，
    easy_drag=False 保证仅标题栏可拖动，内容区不受影响）
  - 边缘拖拽调宽：真实鼠标命中测试落在 WebView2 子窗口上，系统级边缘缩放不可用，
    由前端指针事件 + js_api.resize()（pywebview window.resize + FixPoint）实现
  - 最大化/还原：ShowWindow + 前端按钮；WM_GETMINMAXINFO 把最大化尺寸钳制在
    工作区内（不遮挡任务栏）
  - 双击标题栏最大化/还原：WM_NCLBUTTONDBLCLK
"""
import ctypes
import os
import socket
import sys
import threading
import time
from ctypes import wintypes
from pathlib import Path

import uvicorn
import webview

# ============================================================
# 无边框窗口：自定义标题栏 + 原生窗口行为（V3.7）
# 尺寸常量需与 frontend/style.css / frontend/index.html 保持一致
# ============================================================
_TITLEBAR_H = 42          # 前端标题栏高度（CSS px）
_TITLEBAR_CONTROLS_W = 138  # 标题栏右侧窗口控制按钮区宽度（3×46px，CSS px）
_RESIZE_BORDER = 6        # 边缘拖拽调宽条带宽度（CSS px）

_GWL_WNDPROC = -4
_WM_NCHITTEST = 0x0084
_WM_GETMINMAXINFO = 0x0024
_WM_NCLBUTTONDBLCLK = 0x00A3
_HTCLIENT = 1
_HTCAPTION = 2
_HTLEFT, _HTRIGHT = 10, 11
_HTTOP, _HTTOPLEFT, _HTTOPRIGHT = 12, 13, 14
_HTBOTTOM, _HTBOTTOMLEFT, _HTBOTTOMRIGHT = 15, 16, 17
_SW_RESTORE, _SW_MAXIMIZE = 9, 3
_MONITOR_DEFAULTTONEAREST = 2
_LOGPIXELSX = 88

_user32 = ctypes.windll.user32
_gdi32 = ctypes.windll.gdi32

# 保持窗口过程回调引用，防止被 GC 回收
_FRAME_HOOK = {"hwnd": 0, "old_proc": 0, "proc": None}


class _POINTL(ctypes.Structure):
    _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]


class _MINMAXINFO(ctypes.Structure):
    _fields_ = [
        ("ptReserved", _POINTL),
        ("ptMaxSize", _POINTL),
        ("ptMaxPosition", _POINTL),
        ("ptMinTrackSize", _POINTL),
        ("ptMaxTrackSize", _POINTL),
    ]


class _RECT(ctypes.Structure):
    _fields_ = [
        ("left", wintypes.LONG),
        ("top", wintypes.LONG),
        ("right", wintypes.LONG),
        ("bottom", wintypes.LONG),
    ]


class _MONITORINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("rcMonitor", _RECT),
        ("rcWork", _RECT),
        ("dwFlags", wintypes.DWORD),
    ]


_WNDPROC = ctypes.WINFUNCTYPE(
    ctypes.c_ssize_t, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM
)


def _setup_user32():
    """为用到的 user32 API 显式声明参数/返回类型，避免 64 位下指针截断。"""
    u = _user32
    u.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
    u.FindWindowW.restype = wintypes.HWND
    u.IsWindow.argtypes = [wintypes.HWND]
    u.IsWindow.restype = wintypes.BOOL
    u.IsZoomed.argtypes = [wintypes.HWND]
    u.IsZoomed.restype = wintypes.BOOL
    u.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    u.ShowWindow.restype = wintypes.BOOL
    u.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(_RECT)]
    u.GetClientRect.restype = wintypes.BOOL
    u.ScreenToClient.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
    u.ScreenToClient.restype = wintypes.BOOL
    u.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]
    u.MonitorFromWindow.restype = wintypes.HANDLE
    u.GetMonitorInfoW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_MONITORINFO)]
    u.GetMonitorInfoW.restype = wintypes.BOOL
    u.GetDC.argtypes = [wintypes.HWND]
    u.GetDC.restype = wintypes.HDC
    u.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
    u.ReleaseDC.restype = ctypes.c_int
    _gdi32.GetDeviceCaps.argtypes = [wintypes.HDC, ctypes.c_int]
    _gdi32.GetDeviceCaps.restype = ctypes.c_int
    if hasattr(u, "GetDpiForWindow"):
        u.GetDpiForWindow.argtypes = [wintypes.HWND]
        u.GetDpiForWindow.restype = ctypes.c_uint


_setup_user32()


def _dpi_scale(hwnd):
    """窗口所在显示器的 DPI 缩放系数（逻辑 px → 物理 px）。"""
    if hasattr(_user32, "GetDpiForWindow"):
        dpi = _user32.GetDpiForWindow(hwnd)
        if dpi:
            return dpi / 96.0
    dc = _user32.GetDC(hwnd)
    try:
        dpi = _gdi32.GetDeviceCaps(dc, _LOGPIXELSX)
    finally:
        _user32.ReleaseDC(hwnd, dc)
    return (dpi or 96) / 96.0


def _frame_wndproc(hwnd, msg, wparam, lparam):
    """无边框窗口的窗口过程：补上拖动 / 缩放 / 最大化行为。"""
    if msg == _WM_NCHITTEST:
        x = lparam & 0xFFFF
        y = (lparam >> 16) & 0xFFFF
        pt = wintypes.POINT(x, y)
        _user32.ScreenToClient(hwnd, ctypes.byref(pt))
        scale = _dpi_scale(hwnd)
        cx, cy = pt.x, pt.y

        # 最大化：顶部标题栏区域仍可按住拖下还原
        if _user32.IsZoomed(hwnd):
            return _HTCAPTION if cy < int(_TITLEBAR_H * scale) else _HTCLIENT

        rect = _RECT()
        _user32.GetClientRect(hwnd, ctypes.byref(rect))
        w, h = rect.right, rect.bottom
        b = int(_RESIZE_BORDER * scale)
        tb = int(_TITLEBAR_H * scale)
        cw = int(_TITLEBAR_CONTROLS_W * scale)

        if cy < b:
            return _HTTOPLEFT if cx < b else (_HTTOPRIGHT if cx >= w - b else _HTTOP)
        if cy >= h - b:
            return _HTBOTTOMLEFT if cx < b else (_HTBOTTOMRIGHT if cx >= w - b else _HTBOTTOM)
        if cx < b:
            return _HTLEFT
        if cx >= w - b:
            return _HTRIGHT
        if cy < tb and cx < w - cw:
            return _HTCAPTION
        return _HTCLIENT

    if msg == _WM_GETMINMAXINFO:
        mmi = _MINMAXINFO.from_address(lparam)
        hmon = _user32.MonitorFromWindow(hwnd, _MONITOR_DEFAULTTONEAREST)
        mi = _MONITORINFO()
        mi.cbSize = ctypes.sizeof(_MONITORINFO)
        if _user32.GetMonitorInfoW(hmon, ctypes.byref(mi)):
            mmi.ptMaxPosition.x = mi.rcWork.left
            mmi.ptMaxPosition.y = mi.rcWork.top
            mmi.ptMaxSize.x = mi.rcWork.right - mi.rcWork.left
            mmi.ptMaxSize.y = mi.rcWork.bottom - mi.rcWork.top
        return 0

    if msg == _WM_NCLBUTTONDBLCLK and wparam == _HTCAPTION:
        _user32.ShowWindow(hwnd, _SW_RESTORE if _user32.IsZoomed(hwnd) else _SW_MAXIMIZE)
        return 0

    return _user32.CallWindowProcW(_FRAME_HOOK["old_proc"], hwnd, msg, wparam, lparam)


def _install_wndproc(hwnd):
    """子类化窗口过程并保持回调引用。"""
    if _FRAME_HOOK["proc"] is not None:
        return
    set_long = getattr(_user32, "SetWindowLongPtrW", None) or _user32.SetWindowLongW
    get_long = getattr(_user32, "GetWindowLongPtrW", None) or _user32.GetWindowLongW
    get_long.argtypes = [wintypes.HWND, ctypes.c_int]
    get_long.restype = ctypes.c_ssize_t
    set_long.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_ssize_t]
    set_long.restype = ctypes.c_ssize_t
    _user32.CallWindowProcW.argtypes = [
        ctypes.c_ssize_t, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
    ]
    _user32.CallWindowProcW.restype = ctypes.c_ssize_t

    old_proc = get_long(hwnd, _GWL_WNDPROC)
    proc = _WNDPROC(_frame_wndproc)
    _FRAME_HOOK.update(hwnd=hwnd, old_proc=old_proc, proc=proc)
    set_long(hwnd, _GWL_WNDPROC, ctypes.cast(proc, ctypes.c_void_p).value)


def _find_hwnd(win):
    """获取 pywebview 窗口的 Win32 HWND（优先内部对象，失败按标题查找）。"""
    try:
        import webview.platforms.winforms as winforms  # noqa: PLC0415
        form = winforms.BrowserView.instances.get(win.uid)
        if form is not None:
            hwnd = int(form.Handle)
            if hwnd:
                return hwnd
    except Exception:
        pass
    hwnd = _user32.FindWindowW(None, win.title)
    return int(hwnd) if hwnd else 0


def _install_frame_hook(win):
    """窗口显示后安装无边框窗口过程钩子（在 pywebview.start 的后台线程中运行）。"""
    if not win.events.shown.wait(timeout=20):
        return
    hwnd = _find_hwnd(win)
    if hwnd:
        _install_wndproc(hwnd)


class _TitleBarApi:
    """暴露给前端标题栏的窗口控制方法（通过 pywebview js_api 调用）。"""

    def __init__(self):
        self._window = None

    def bind(self, window):
        self._window = window

    def _hwnd(self):
        hwnd = _FRAME_HOOK.get("hwnd") or 0
        if hwnd and _user32.IsWindow(hwnd):
            return hwnd
        return 0

    def minimize(self):
        if self._window is not None:
            self._window.minimize()

    def toggle_maximize(self):
        hwnd = self._hwnd()
        if hwnd:
            _user32.ShowWindow(hwnd, _SW_RESTORE if _user32.IsZoomed(hwnd) else _SW_MAXIMIZE)
        elif self._window is not None:
            self._window.maximize()

    def is_maximized(self):
        hwnd = self._hwnd()
        return bool(hwnd and _user32.IsZoomed(hwnd))

    def resize(self, width, height, fix_point=3):
        """按固定角/边调整窗口尺寸（前端边缘拖拽调宽用）。

        fix_point 为 FixPoint 位组合：1=NORTH 2=WEST 4=EAST 8=SOUTH。
        默认 3（NORTH|WEST）表示固定左上角（右下角拉动）。
        """
        if self._window is None:
            return
        try:
            from webview.window import FixPoint  # noqa: PLC0415
        except Exception:
            FixPoint = None
        fp = FixPoint(fix_point) if FixPoint is not None else None
        self._window.resize(int(width), int(height), fp)

    def close(self):
        if self._window is not None:
            self._window.destroy()


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
    # 窗口图标：源码运行取项目根 assets/app.ico，打包后取运行时资源目录
    _icon = None
    for _base in (Path(os.path.dirname(os.path.abspath(__file__))),
                  Path(getattr(sys, "_MEIPASS", "")) if getattr(sys, "_MEIPASS", "") else None):
        if _base and (_base / "assets" / "app.ico").is_file():
            _icon = str(_base / "assets" / "app.ico")
            break
    titlebar = _TitleBarApi()
    window = webview.create_window(
        title=f"{APP_TITLE} v{CURRENT_VERSION} · Minecraft 双源模组迁移工具",
        url=url,
        width=1200,
        height=840,
        min_size=(980, 680),
        frameless=True,   # V3.7：无边框 + 前端自定义标题栏（窗口行为由 _install_frame_hook 补齐）
        easy_drag=False,  # V3.7：仅标题栏可拖动（pywebview 拖拽区 .pywebview-drag-region）；True 会整窗任意位置都可拖动
        text_select=True,
        js_api=titlebar,
    )
    titlebar.bind(window)
    # icon 仅由 webview.start() 支持（winforms 后端据此设置窗口图标）
    # func 在 GUI 循环启动后于后台线程运行，安装无边框窗口的原生拖动/缩放
    webview.start(_install_frame_hook, args=(window,), icon=_icon)


if __name__ == "__main__":
    main()
