"""微信界面元素定位（跨分辨率 / 跨缩放）。

不再用「窗口比例坐标」点按钮——窗口换成不同 DPI 的屏幕后，微信内部布局
不是等比缩放的：菜单栏、输入框、按钮都按逻辑像素固定，窗口只是把中间那块
拉大，所以 0.875 / 0.104 这种比例在 2K 屏和 4K 屏落到的地方不一样。

这里改成「认图」：
  1. 找到微信主窗口，只截这一个窗口（不截整屏，也不用窗口比例）；
  2. 在截图里用多尺度模板匹配找按钮图标（模板存在 ui-templates/）；
  3. 绿色大按钮（发表、发送）没有固定图标，改用颜色 + 形状定位；
  4. 返回的坐标是屏幕坐标，直接点。

模板图像由 `capture_templates.py` 从真实截图裁出来，见同目录说明。
"""

from __future__ import annotations

import os
import time
from typing import Iterable

import cv2
import numpy as np
from PIL import Image

TEMPLATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ui-templates")

# 微信绿 #07C160 ≈ HSV(74, 245, 193)
GREEN_LO = (70, 150, 140)
GREEN_HI = (82, 255, 240)

DEFAULT_SCALES = (0.70, 0.80, 0.90, 1.00, 1.10, 1.20, 1.30, 1.45, 1.60)


def win32():
    import win32gui

    return win32gui


def dpi_aware() -> None:
    """让本进程用物理像素看窗口，否则 150% 缩放下 rect 只有逻辑值。"""
    import ctypes

    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


def find_window(title: str = "微信", class_name: str = "Qt51514QWindowIcon") -> int:
    """找微信主窗口（可见、非最小化窗口也会返回）。"""
    win32gui = win32()
    hits: list[tuple[int, str]] = []

    def each(hwnd, _):
        try:
            if not win32gui.IsWindowVisible(hwnd):
                return
            text = win32gui.GetWindowText(hwnd)
            cls = win32gui.GetClassName(hwnd)
            if title in text or (class_name and cls == class_name):
                hits.append((hwnd, text))
        except Exception:
            pass

    win32gui.EnumWindows(each, None)
    for hwnd, text in hits:
        if title in text:
            return hwnd
    return hits[0][0] if hits else 0


def bring_front(hwnd: int, settle: float = 0.8) -> None:
    import ctypes

    user32 = ctypes.windll.user32
    user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    time.sleep(0.3)
    user32.SetForegroundWindow(hwnd)
    time.sleep(settle)


def force_front(hwnd: int, settle: float = 0.7) -> bool:
    """把窗口真正提到前台。

    朋友圈的编辑框是独立顶层窗口，点开「谁可以看」之类的弹层后它会抢焦点；
    这时 SetForegroundWindow 会因为前台锁直接失败，后续点击就落到别的窗口的
    本地坐标上（实测点到「取消 → 保留」，微信提示「已保存到个人相册」）。
    先敲一下 Alt 再设前台，是绕开前台锁的常规办法。
    """
    import ctypes

    user32 = ctypes.windll.user32
    user32.ShowWindow(hwnd, 9)
    time.sleep(0.2)
    for _ in range(3):
        user32.keybd_event(0x12, 0, 0, 0)
        user32.keybd_event(0x12, 0, 2, 0)
        user32.SetForegroundWindow(hwnd)
        user32.BringWindowToTop(hwnd)
        time.sleep(0.35)
        if user32.GetForegroundWindow() == hwnd:
            time.sleep(settle * 0.5)
            return True
    time.sleep(settle)
    return user32.GetForegroundWindow() == hwnd


def window_rect(hwnd: int) -> tuple[int, int, int, int]:
    return win32().GetWindowRect(hwnd)


def grab(hwnd: int) -> tuple[Image.Image, tuple[int, int, int, int]]:
    """截微信窗口本身（物理像素），返回 (图, (l,t,r,b))。"""
    from PIL import ImageGrab

    l, t, r, b = window_rect(hwnd)
    img = ImageGrab.grab(bbox=(l, t, r, b), all_screens=True)
    return img, (l, t, r, b)


def to_cv(img: Image.Image) -> np.ndarray:
    return cv2.cvtColor(np.array(img.convert("RGB")), cv2.COLOR_RGB2BGR)


def _load_template(name: str) -> np.ndarray | None:
    for ext in (".png", ".jpg"):
        path = os.path.join(TEMPLATE_DIR, name + ext)
        if os.path.exists(path):
            tpl = cv2.imread(path)
            return tpl if tpl is not None and tpl.size else None
    return None


def locate(
    img: np.ndarray,
    template: str,
    threshold: float = 0.80,
    scales: Iterable[float] = DEFAULT_SCALES,
    region: tuple[int, int, int, int] | None = None,
    region_frac: tuple[float, float, float, float] | None = None,
) -> dict | None:
    """在窗口截图里找模板图标。

    region=(x0,y0,x1,y1) 可把搜索范围限定在窗口局部（比如只在输入框那条找）；
    region_frac=(fx0,fy0,fx1,fy1) 是同一个意思但用窗口比例表示，窗口大小变了
    依然有效——缩小后的截图里不会有别的角落干扰，这是「缩小到 0.7 倍也认得出」
    的关键。
    返回 {"x","y","score","scale"}，坐标是相对窗口左上角。
    """
    base_tpl = _load_template(template)
    if base_tpl is None:
        return None
    if region_frac is not None:
        h, w = img.shape[0], img.shape[1]
        region = (
            int(w * region_frac[0]),
            int(h * region_frac[1]),
            int(w * region_frac[2]),
            int(h * region_frac[3]),
        )
    x0, y0 = (0, 0) if region is None else (region[0], region[1])
    x1, y1 = (img.shape[1], img.shape[0]) if region is None else (region[2], region[3])
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(img.shape[1], x1), min(img.shape[0], y1)
    haystack = img[y0:y1, x0:x1]
    if haystack.size == 0:
        return None

    best: dict | None = None
    for s in scales:
        tpl = base_tpl if abs(s - 1.0) < 1e-6 else cv2.resize(base_tpl, None, fx=s, fy=s)
        if tpl.shape[0] >= haystack.shape[0] or tpl.shape[1] >= haystack.shape[1]:
            continue
        res = cv2.matchTemplate(haystack, tpl, cv2.TM_CCOEFF_NORMED)
        _, max_val, _, max_loc = cv2.minMaxLoc(res)
        if best is None or max_val > best["score"]:
            best = {
                "x": x0 + max_loc[0] + tpl.shape[1] // 2,
                "y": y0 + max_loc[1] + tpl.shape[0] // 2,
                "score": round(float(max_val), 3),
                "scale": s,
                "w": tpl.shape[1],
                "h": tpl.shape[0],
            }
    if best is None or best["score"] < threshold:
        return None
    return best


def green_blocks(img: np.ndarray) -> list[dict]:
    """所有够大的微信绿区块（发表、发送这类按钮）。"""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, GREEN_LO, GREEN_HI)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < 800:
            continue
        x, y, w, h = cv2.boundingRect(cnt)
        out.append(
            {
                "x": x + w // 2,
                "y": y + h // 2,
                "area": int(area),
                "w": w,
                "h": h,
                "ratio": round(w / max(h, 1), 2),
            }
        )
    return out


def locate_green(
    img: np.ndarray,
    region: tuple[int, int, int, int] | None = None,
    ratio_range: tuple[float, float] = (2.0, 6.5),
    min_area: int = 1500,
) -> dict | None:
    """找按钮形状的绿色块：横向胶囊（发表/发送），按面积取最大。

    朋友圈左侧「朋友圈」高亮条也是绿的（360×72），但它贴左边且很大，
    用 x 起点排除掉。
    """
    blocks = green_blocks(img)
    cands = []
    for b in blocks:
        if region:
            x0, y0, x1, y1 = region
            if not (x0 <= b["x"] <= x1 and y0 <= b["y"] <= y1):
                continue
        if b["area"] < min_area:
            continue
        if not (ratio_range[0] <= b["ratio"] <= ratio_range[1]):
            continue
        if b["x"] < img.shape[1] * 0.18:  # 左侧导航高亮
            continue
        cands.append(b)
    if not cands:
        return None
    cands.sort(key=lambda b: b["area"], reverse=True)
    return cands[0]


def click_screen(x: int, y: int) -> None:
    import ctypes

    user32 = ctypes.windll.user32
    user32.SetCursorPos(int(x), int(y))
    time.sleep(0.12)
    user32.mouse_event(0x0002, 0, 0, 0, 0)
    time.sleep(0.06)
    user32.mouse_event(0x0004, 0, 0, 0, 0)
    time.sleep(0.15)


def locate_screen(hwnd: int, template: str, **kw) -> tuple[int, int, dict] | None:
    """找模板并换成屏幕坐标。返回 (x, y, info)。"""
    img, (l, t, _, _) = grab(hwnd)
    info = locate(to_cv(img), template, **kw)
    if not info:
        return None
    return l + info["x"], t + info["y"], info


def locate_green_screen(hwnd: int, **kw) -> tuple[int, int, dict] | None:
    img, (l, t, _, _) = grab(hwnd)
    info = locate_green(to_cv(img), **kw)
    if not info:
        return None
    return l + info["x"], t + info["y"], info


def click_template(hwnd: int, template: str, **kw) -> bool:
    hit = locate_screen(hwnd, template, **kw)
    if not hit:
        return False
    click_screen(hit[0], hit[1])
    return True


def click_green(hwnd: int, **kw) -> bool:
    hit = locate_green_screen(hwnd, **kw)
    if not hit:
        return False
    click_screen(hit[0], hit[1])
    return True
