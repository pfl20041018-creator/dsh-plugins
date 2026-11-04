# -*- coding: utf-8 -*-
"""朋友圈 sidecar：读 sns.db 拿动态，驱动 UIA 截图 / 点赞 / 评论。

协议：stdin 每次一行 JSON {"id": n, "method": "...", "params": {...}}，
stdout 每次一行 JSON {"id": n, "ok": true, "result": ...} 或
{"id": n, "ok": false, "error": "..."}。

只做三件事：
  * feed / post      —— 只读数据库（快、不抢焦点、不需要解锁屏幕）
  * shots            —— 打开朋友圈窗口，把某条动态的 cell 截图落盘（给看图模型）
  * like / comment   —— 打开朋友圈窗口，点赞 / 评论

媒体为什么走截图：朋友圈图片的 CDN 地址（shmmsns.qpic.cn）现在带 Referer 也只
返回 120x120 的「暂时无法查看」占位图，本机缓存里也没有明文文件，所以唯一能拿到
真实画面内容的路子，是把微信界面上渲染出来的缩略图截下来。
"""
from __future__ import annotations

import ctypes
import json
import os
import sys
import time
import traceback

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_DIR = os.path.join(HERE, ".state")
LEDGER_FILE = os.path.join(STATE_DIR, "actions.jsonl")
SHOT_DIR = os.path.join(STATE_DIR, "shots")
os.makedirs(STATE_DIR, exist_ok=True)
os.makedirs(SHOT_DIR, exist_ok=True)


def _win_rect(hwnd):
    try:
        import win32gui
        return win32gui.GetWindowRect(hwnd)
    except Exception:
        return None


def _mouse_click(x, y):
    try:
        import ctypes
        u32 = ctypes.windll.user32
        u32.SetCursorPos(int(x), int(y))
        time.sleep(0.18)
        u32.mouse_event(0x0002, 0, 0, 0, 0)
        time.sleep(0.06)
        u32.mouse_event(0x0004, 0, 0, 0, 0)
    except Exception as exc:
        _log("点按失败", x, y, exc)


def _mouse_down(x, y):
    try:
        import ctypes
        u32 = ctypes.windll.user32
        u32.SetCursorPos(int(x), int(y))
        time.sleep(0.15)
        u32.mouse_event(0x0002, 0, 0, 0, 0)
    except Exception as exc:
        _log("按下失败", x, y, exc)


def _mouse_up():
    try:
        import ctypes
        ctypes.windll.user32.mouse_event(0x0004, 0, 0, 0, 0)
    except Exception:
        pass


def _press_key(vk):
    try:
        import ctypes
        u32 = ctypes.windll.user32
        u32.keybd_event(vk, 0, 0, 0)
        time.sleep(0.05)
        u32.keybd_event(vk, 0, 2, 0)
    except Exception:
        pass


def _paste_text(text):
    try:
        import win32clipboard
        win32clipboard.OpenClipboard()
        win32clipboard.EmptyClipboard()
        win32clipboard.SetClipboardText(text, win32clipboard.CF_UNICODETEXT)
        win32clipboard.CloseClipboard()
        import ctypes
        u32 = ctypes.windll.user32
        u32.keybd_event(0x11, 0, 0, 0)
        u32.keybd_event(0x56, 0, 0, 0)
        time.sleep(0.06)
        u32.keybd_event(0x56, 0, 2, 0)
        u32.keybd_event(0x11, 0, 2, 0)
    except Exception as exc:
        _log("粘贴失败", exc)


def _wait_dialog(timeout=6.0):
    import win32gui
    deadline = time.time() + timeout
    while time.time() < deadline:
        found = []

        def each(hwnd, _):
            try:
                if win32gui.GetClassName(hwnd) == "#32770":
                    found.append(hwnd)
            except Exception:
                pass

        win32gui.EnumWindows(each, None)
        if found:
            return found[0]
        time.sleep(0.3)
    return None


def _pick_files(paths):
    """文件选择框里：Alt+N 定位文件名 -> 粘贴路径 -> 回车。多张图分多次追加。"""
    import win32gui
    import ctypes
    u32 = ctypes.windll.user32
    first = True
    for pth in paths:
        if not first:
            _wait_dialog(3.0)
        u32.keybd_event(0x12, 0, 0, 0)
        u32.keybd_event(0x4E, 0, 0, 0)
        time.sleep(0.05)
        u32.keybd_event(0x4E, 0, 2, 0)
        u32.keybd_event(0x12, 0, 2, 0)
        time.sleep(0.4)
        _paste_text(pth)
        time.sleep(0.4)
        _press_key(0x0D)
        time.sleep(1.2)
        first = False


def _verify_publish(mdb, text, timeout=12.0):
    head = text[:12]
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            items = mdb.get_moments(limit=3)
        except Exception:
            items = []
        for it in items:
            body = str(it.get("text") or "")
            if head and head in body:
                return True, body
        time.sleep(1.0)
    return False, ""


def _log(*parts):
    print("[moments]", *parts, file=sys.stderr, flush=True)


def _patch_pyautogui():
    """让 pyautogui.screenshot 覆盖整个虚拟桌面。

    wechatauto 的 _find_more_button / _theme 用 ``pyautogui.screenshot()`` 抓图，
    而它只截主屏；微信一旦开在副屏（x 超过主屏宽度），抓出来根本不含窗口，
    模板匹配永远失败 —— 于是「点不开 ⋯ 菜单」，评论也发不出去。
    这里换成 ImageGrab(all_screens=True)，坐标原点与虚拟桌面左上角对齐。
    """
    try:
        import pyautogui
        from PIL import ImageGrab
    except Exception as exc:
        _log("补丁 pyautogui 失败", exc)
        return
    if getattr(pyautogui, "_vdesk_patched", False):
        return
    u = ctypes.windll.user32

    def screenshot(imageFilename=None, region=None):
        if region is None:
            vx, vy = u.GetSystemMetrics(76), u.GetSystemMetrics(77)
            vw, vh = u.GetSystemMetrics(78), u.GetSystemMetrics(79)
            img = ImageGrab.grab(bbox=(vx, vy, vx + vw, vy + vh), all_screens=True)
        else:
            left, top, width, height = (int(v) for v in region)
            img = ImageGrab.grab(bbox=(left, top, left + width, top + height), all_screens=True)
        if imageFilename:
            img.save(imageFilename)
        return img

    pyautogui.screenshot = screenshot
    pyautogui._vdesk_patched = True


def _same_text(left, right):
    a = "".join((left or "").split())
    b = "".join((right or "").split())
    if not a or not b:
        return a == b
    return a == b or a in b or b in a


def _screen_locked():
    """Windows 下判断是不是锁屏。

    锁屏时前台窗口是 ``Windows.UI.Core.CoreWindow``（标题「Windows 默认锁屏
    界面」）；``OpenInputDesktop`` 在锁屏下有时仍返回非零，不能单独用。
    """
    try:
        u = ctypes.windll.user32
        hwnd = u.GetForegroundWindow()
        if hwnd:
            buf = ctypes.create_unicode_buffer(256)
            u.GetClassNameW(hwnd, buf, 256)
            cls = buf.value or ""
            buf2 = ctypes.create_unicode_buffer(256)
            u.GetWindowTextW(hwnd, buf2, 256)
            title = buf2.value or ""
            if "CoreWindow" in cls or "LockScreen" in cls or "锁屏" in title:
                return True
        h = u.OpenInputDesktop(0, False, 0x0001)
        if h:
            u.CloseDesktop(h)
            return False
        return True
    except Exception:
        return False


class MomentsSidecar:
    def __init__(self):
        self._db = None
        self._mdb = None
        self._wx = None
        self._feeds = None
        self._feeds_at = 0.0

    # -- 基础资源（惰性） --------------------------------------------------
    def db(self):
        if self._db is None:
            from wechatauto import WeChatDB
            self._db = WeChatDB()
        return self._db

    def mdb(self):
        if self._mdb is None:
            from wechatauto import MomentDB
            self._mdb = MomentDB(self.db())
        return self._mdb

    def wx(self):
        if self._wx is None:
            _patch_pyautogui()
            from wechatauto import WeChat
            self._wx = WeChat()
        return self._wx

    # -- 动态列表 ---------------------------------------------------------
    def _feeds_or_read(self, limit, refresh=False):
        now = time.time()
        if refresh or self._feeds is None or now - self._feeds_at > 30:
            self._feeds = self.mdb().get_moments(limit=0) or []
            self._feeds_at = now
        return self._feeds[:limit] if limit else list(self._feeds)

    @staticmethod
    def _key(feed):
        return "%s|%s|%s" % (
            feed.get("nickname") or feed.get("username") or "",
            (feed.get("text") or "").strip()[:24],
            feed.get("create_time") or "",
        )

    @staticmethod
    def _time_text(ts):
        try:
            ts = int(ts)
        except Exception:
            return ""
        return time.strftime("%m-%d %H:%M", time.localtime(ts))

    def ledger_entries(self):
        out = []
        try:
            with open(LEDGER_FILE, "r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        out.append(json.loads(line))
                    except Exception:
                        continue
        except FileNotFoundError:
            pass
        except Exception as exc:
            _log("读账本失败", exc)
        return out

    def ledger_append(self, entry):
        entry = dict(entry)
        entry.setdefault("at", time.strftime("%Y-%m-%d %H:%M:%S"))
        try:
            with open(LEDGER_FILE, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except Exception as exc:
            _log("写账本失败", exc)

    def _acted(self, key):
        """这条动态我动过什么：{'like': '...', 'comment': '...'}"""
        acts = {}
        for e in self.ledger_entries():
            if e.get("key") != key or e.get("ok") is False:
                continue
            kind = e.get("kind")
            if kind in ("like", "comment"):
                acts[kind] = e.get("at") or ""
            elif kind == "unlike":
                acts.pop("like", None)
        return acts

    def _project(self, feed, index):
        key = self._key(feed)
        images = feed.get("images") or []
        videos = feed.get("videos") or []
        likes = feed.get("likes") or []
        comments = feed.get("comments") or []
        return {
            "index": index,
            "key": key,
            "author": feed.get("nickname") or feed.get("username") or "",
            "username": feed.get("username") or "",
            "time": self._time_text(feed.get("create_time")),
            "text": (feed.get("text") or "").strip(),
            "images": len(images),
            "videos": len(videos),
            "likes": len(likes),
            "commentCount": len(comments),
            "comments": [
                {
                    "author": c.get("nickname") or c.get("username") or "",
                    "text": (c.get("content") or c.get("text") or "").strip(),
                    "replyTo": (c.get("reply_to") or {}).get("nickname") if isinstance(c.get("reply_to"), dict) else c.get("reply_to"),
                }
                for c in comments[:4]
            ],
            "acted": self._acted(key),
        }

    def method_feed(self, params):
        limit = int(params.get("limit") or 8)
        limit = max(1, min(limit, 40))
        author = (params.get("author") or "").strip()
        feeds = self._feeds_or_read(0, bool(params.get("refresh")))
        rows = []
        for i, feed in enumerate(feeds):
            if author and author not in (feed.get("nickname") or ""):
                continue
            rows.append(self._project(feed, i))
            if len(rows) >= limit:
                break
        return {
            "account": getattr(self.db(), "account", ""),
            "total": len(feeds),
            "rows": rows,
        }

    def _find_feed(self, params):
        feeds = self._feeds_or_read(0, False)
        idx = params.get("index")
        if idx is not None:
            try:
                idx = int(idx)
            except Exception:
                raise ValueError("index 不是数字")
            if idx < 0 or idx >= len(feeds):
                raise ValueError("index 越界：只有 %d 条动态" % len(feeds))
            return feeds[idx]
        key = (params.get("key") or "").strip()
        if key:
            for feed in feeds:
                if self._key(feed) == key:
                    return feed
            raise ValueError("按 key 没找到这条动态（可能已经重新抓过列表，先 momnets_feed 看看）")
        author = (params.get("author") or "").strip()
        keyword = (params.get("keyword") or "").strip()
        if not author and not keyword:
            raise ValueError("需要 index、key、或 author/keyword 之一")
        for feed in feeds:
            if author and author not in (feed.get("nickname") or ""):
                continue
            if keyword and keyword not in (feed.get("text") or ""):
                continue
            return feed
        raise ValueError("没找到符合条件的动态")

    def method_post(self, params):
        feed = self._find_feed(params)
        feeds = self._feeds_or_read(0, False)
        idx = feeds.index(feed) if feed in feeds else -1
        row = self._project(feed, idx)
        try:
            tree = self.mdb().comment_tree(feed, with_raw=False) or []
        except Exception as exc:
            _log("comment_tree 失败", exc)
            tree = []
        row["commentThread"] = [
            {
                "author": c.get("nickname") or c.get("username") or "",
                "text": (c.get("content") or c.get("text") or "").strip(),
                "replyTo": (c.get("reply_to") or {}).get("nickname") if isinstance(c.get("reply_to"), dict) else c.get("reply_to"),
            }
            for c in tree
        ]
        row["imageMd5"] = [im.get("md5") for im in (feed.get("images") or [])]
        return row

    # -- 打开朋友圈窗口 ---------------------------------------------------
    def _find(self, node, pred, max_depth=26):
        def walk(n, depth):
            if n is None or depth > max_depth:
                return None
            try:
                kids = n.GetChildren()
            except Exception:
                return None
            for c in kids:
                try:
                    if pred(c):
                        return c
                except Exception:
                    pass
                r = walk(c, depth + 1)
                if r is not None:
                    return r
            return None
        return walk(node, 0)

    def _gui(self):
        return self.wx()._gui

    def _timeline_items(self):
        try:
            return self.wx().Moment.GetMoments(refresh=True) or []
        except Exception as exc:
            _log("GetMoments 失败", exc)
            return []

    def open_moments(self):
        """切到朋友圈页并等时间线出来。返回 (ok, reason)。"""
        items = self._timeline_items()
        if items:
            return True, "朋友圈已在页内（%d 条可见）" % len(items)
        if _screen_locked():
            return False, "屏幕锁着，点不了界面。解锁后我再刷。"
        try:
            gui = self._gui()
            u = gui._get_uia()
            if u is None or getattr(u, "_win", None) is None:
                return False, "UIA 树拿不到（微信可能没登录/没激活无障碍）"
            tab = self._find(
                u._win,
                lambda c: (c.ClassName or "") == "mmui::XTabBarItem" and (c.Name or "").strip() == "发现",
                max_depth=12,
            )
            if tab is not None:
                u._click_ctrl(tab)
                time.sleep(1.6)
            cell = self._find(
                u._win,
                lambda c: (c.ClassName or "") == "mmui::ExtensionDiscoverContentCell"
                and (c.Name or "").strip() == "朋友圈",
                max_depth=18,
            )
            if cell is None:
                # 新版发现页把入口画成 XTableView 里的一行行文字，
                # 没有 ExtensionDiscoverContentCell 这一层，退一步点文字节点。
                cell = self._find(
                    u._win,
                    lambda c: (c.ControlTypeName or "") == "TextControl"
                    and (c.Name or "").strip() == "朋友圈",
                    max_depth=20,
                )
            if cell is None:
                return False, "发现页里没找到「朋友圈」入口（微信版本布局变了？）"
            u._click_ctrl(cell)
        except Exception as exc:
            return False, "打开朋友圈失败：%s" % exc
        for _ in range(10):
            time.sleep(1.0)
            if self._timeline_items():
                return True, "已打开朋友圈"
        return False, "点了「朋友圈」但时间线一直没渲染出来"

    def _locate(self, feed):
        """在 UIA 时间里定位到这条动态。"""
        author = feed.get("nickname") or ""
        text = (feed.get("text") or "").strip()
        keyword = text[:18] if text else None
        if not author and not keyword:
            raise ValueError("这条动态没有作者也没有文字，定位不了界面位置")
        try:
            item = self.wx().Moment.find_moment(
                publisher=author or None, keyword=keyword, db=self.mdb(), max_screens=120,
            )
        except Exception as exc:
            _log("find_moment 失败", exc)
            item = None
        if item is None:
            raise ValueError("界面里没定位到「%s」这条动态（可能太旧，得等你翻到它）" % (author or keyword))
        return item

    # -- 点「发送」----------------------------------------------------------
    def _bring_front(self):
        """把微信抬到前台——后台点控件会落到桌面上，这是最容易翻车的一步。"""
        try:
            self.wx()._gui.bring_to_front()
            time.sleep(0.5)
            return True
        except Exception as exc:
            _log("抬前台失败", exc)
            return False

    def _click_send(self, region):
        """在 region 里找微信那颗绿色的「发送」按钮并点掉。

        wechatauto 的 Comment() 靠 OCR 找按钮，本机没装 OCR 就卡在
        「屏幕中未识别到『发送』按钮」。这里不认字，只认颜色：微信的发送键是
        固定的一抹绿，按面积/长宽比筛出最大的那块就是它。
        """
        try:
            import numpy as np
            import cv2
            from PIL import ImageGrab
        except Exception as exc:
            _log("找发送按钮缺依赖", exc)
            return False
        left, top, right, bottom = (int(v) for v in region)
        left, top = max(0, left), max(0, top)
        width, height = max(2, right - left), max(2, bottom - top)
        try:
            # 必须用 ImageGrab(all_screens=True)：pyautogui 只截主屏，
            # 微信在副屏时整张图全黑，什么都找不到。
            shot = ImageGrab.grab(bbox=(left, top, left + width, top + height), all_screens=True)
        except Exception as exc:
            _log("截评论框失败", exc)
            return False
        img = np.array(shot.convert("RGB"))
        hsv = cv2.cvtColor(img, cv2.COLOR_RGB2HSV)
        mask = cv2.inRange(hsv, np.array([35, 100, 90]), np.array([90, 255, 255]))
        count, _labels, stats, cents = cv2.connectedComponentsWithStats(mask, 8)

        # 先认整个评论框（绿描边的大矩形），发送键固定在它右下角内缩处。
        # 按几何算比按面积猜稳：绿描边和绿按钮是同一个色。
        frame = None
        best = None
        for i in range(1, count):
            x, y, w, h, area = (int(v) for v in stats[i])
            if w >= 300 and h >= 80 and area > 800:
                if frame is None or area > frame[0]:
                    frame = (area, left + x, top + y, w, h)
                continue
            if not (40 <= w <= 180 and 22 <= h <= 80):
                continue
            if area < 400:
                continue
            if not (0.9 < w / float(h) < 4.5):
                continue
            if best is None or area > best[0]:
                best = (area, left + int(x + w / 2.0), top + int(y + h / 2.0))

        if frame is not None:
            _area, fx, fy, fw, fh = frame
            target = (fx + fw - 49, fy + fh - 26)
            _log("从评论框算发送键：%s" % (target,))
        elif best is not None:
            target = (best[1], best[2])
        else:
            _log("没找到绿色的发送按钮（region=%s）" % (region,))
            return False
        u32 = ctypes.windll.user32
        u32.SetCursorPos(int(target[0]), int(target[1]))
        time.sleep(0.3)
        u32.mouse_event(0x0002, 0, 0, 0, 0)
        time.sleep(0.06)
        u32.mouse_event(0x0004, 0, 0, 0, 0)
        _log("点了发送按钮", target[0], target[1])
        return True

    def _verify_comment(self, feed, text):
        """数据库里有没有我这条评论——唯一可信的成功判据。"""
        head = text[:8]
        try:
            from wechatauto import WeChatDB, MomentDB
            md = MomentDB(WeChatDB())
            feeds = md.get_moments(limit=40)
        except Exception as exc:
            _log("核对评论失败", exc)
            return False
        key = self._key(feed)
        for f in feeds:
            if self._key(f) != key:
                continue
            for c in f.get("comments") or []:
                content = (c.get("content") or "") if isinstance(c, dict) else str(c)
                if head and head in content:
                    return True
        return False

    def _dismiss_dialog(self):
        """把微信自己弹的「评论未发送 / 我知道了」关掉，别留着挡路。

        只按一次 ESC：连按两次会把微信整个缩回托盘（实测过），
        收完尾还得确认主窗口是露着的，不然下一轮连主窗口都找不到。
        """
        u32 = ctypes.windll.user32
        u32.keybd_event(0x1B, 0, 0, 0)
        time.sleep(0.08)
        u32.keybd_event(0x1B, 0, 2, 0)
        time.sleep(0.6)
        try:
            import win32con
            import win32gui
            hwnd = getattr(self.wx()._gui, "main_hwnd", None)
            if hwnd and not win32gui.IsWindowVisible(hwnd):
                win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
                time.sleep(0.3)
                win32gui.ShowWindow(hwnd, win32con.SW_SHOW)
                _log("微信缩回托盘了，重新亮出来", hwnd)
        except Exception as exc:
            _log("恢复微信窗口失败", exc)

    # -- 截图 -------------------------------------------------------------
    def method_shots(self, params):
        feed = self._find_feed(params)
        if _screen_locked():
            return {"ok": False, "reason": "屏幕锁着，截到的是锁屏壁纸。解锁后我再截。", "files": []}
        ok, reason = self.open_moments()
        if not ok:
            return {"ok": False, "reason": reason, "files": []}
        if not (feed.get("images") or feed.get("videos")):
            return {"ok": False, "reason": "这条没有图片/视频", "files": []}
        item = self._locate(feed)
        try:
            rect = item.control.BoundingRectangle
        except Exception:
            rect = None
        if rect is None or rect.right <= rect.left:
            raise ValueError("拿不到这条动态的屏幕位置")
        max_n = max(1, min(int(params.get("max") or 3), 9))
        gui = self._gui()
        touched = []
        # cell 可能比屏幕长：从上往下分段截，宁多勿漏
        height = rect.bottom - rect.top
        step = max(240, int((rect.bottom - rect.top) * 0.62))
        stamp = time.strftime("%Y%m%d-%H%M%S")
        tag = "".join(ch for ch in (feed.get("nickname") or "post") if ch.isalnum())[:12] or "post"
        offset = 0
        while len(touched) < max_n and offset < height:
            box = (int(rect.left), int(rect.top + offset), int(rect.right),
                   int(min(rect.top + offset + step, rect.bottom)))
            img = gui._grab_screen(box)
            path = os.path.join(SHOT_DIR, "%s-%s-%d.png" % (stamp, tag, len(touched)))
            img.save(path)
            touched.append(path)
            offset += step
        return {
            "ok": True,
            "author": feed.get("nickname"),
            "text": (feed.get("text") or "")[:60],
            "files": touched,
            "note": "这是朋友圈界面上的实际渲染画面，图片内容就在里面；看完再决定怎么评论。",
        }

    # -- 点赞 / 评论 ------------------------------------------------------
    def method_like(self, params):
        feed = self._find_feed(params)
        cancel = bool(params.get("cancel"))
        if _screen_locked():
            return {"ok": False, "reason": "屏幕锁着，点不了界面。解锁后我再赞。"}
        ok, reason = self.open_moments()
        if not ok:
            return {"ok": False, "reason": reason}
        item = self._locate(feed)
        self._bring_front()
        res = self.wx().Moment.Like(item, cancel=cancel)
        success = bool(getattr(res, "is_success", False))
        self.ledger_append({
            "kind": "unlike" if cancel else "like",
            "key": self._key(feed),
            "author": feed.get("nickname"),
            "text": (feed.get("text") or "")[:40],
            "ok": success,
        })
        return {
            "ok": success,
            "cancel": cancel,
            "author": feed.get("nickname"),
            "message": getattr(res, "get", lambda *_: None)("message") if hasattr(res, "get") else str(res),
        }

    def method_comment(self, params):
        feed = self._find_feed(params)
        text = (params.get("text") or "").strip()
        if not text:
            raise ValueError("评论内容不能为空")
        if len(text) > 120:
            raise ValueError("评论太长（%d 字），朋友圈评论要短" % len(text))
        reply_to = (params.get("replyTo") or "").strip() or None
        if _screen_locked():
            return {"ok": False, "reason": "屏幕锁着，点不了界面。解锁后我再评。"}
        ok, reason = self.open_moments()
        if not ok:
            return {"ok": False, "reason": reason}
        item = self._locate(feed)
        self._bring_front()
        if reply_to:
            res = self.wx().Moment.ReplyComment(item, reply_to=reply_to, content=text)
        else:
            res = self.wx().Moment.Comment(item, text)
        success = bool(getattr(res, "is_success", False))
        message = getattr(res, "get", lambda *_: None)("message") if hasattr(res, "get") else str(res)
        if not success and "发送" in str(message):
            # 字已经敲进评论框了，只差按发送：整窗扫绿框，算右下角那颗发送键
            try:
                import win32gui
                l, t, r, b = win32gui.GetWindowRect(self.wx()._gui.main_hwnd)
                region = (l, t, r, b)
            except Exception:
                br = item.control.BoundingRectangle
                region = (br.left - 40, br.bottom - 60, br.right + 40, br.bottom + 520)
            self._click_send(region)

        # 别信返回码：微信自己发不出去时会弹「评论未发送」，输入框照样被关掉。
        # 唯一能当准的是数据库里到底有没有这句评论。
        verified = False
        for _ in range(8):
            time.sleep(0.7)
            if self._verify_comment(feed, text):
                verified = True
                break
        if not verified:
            self._dismiss_dialog()
        message = ("评论已经出现在动态里了" if verified
                   else "微信没接受这条评论（它自己弹了「评论未发送」），别当成功")
        success = verified
        self.ledger_append({
            "kind": "comment",
            "key": self._key(feed),
            "author": feed.get("nickname"),
            "text": (feed.get("text") or "")[:40],
            "content": text,
            "replyTo": reply_to,
            "ok": success,
        })
        return {
            "ok": success,
            "author": feed.get("nickname"),
            "replyTo": reply_to,
            "message": message,
        }

    def method_ledger(self, params):
        limit = max(1, min(int(params.get("limit") or 10), 50))
        entries = self.ledger_entries()[-limit:]
        entries.reverse()
        return {"total": len(self.ledger_entries()), "rows": entries}

    def method_status(self, params):
        info = {"locked": _screen_locked(), "account": ""}
        try:
            info["account"] = getattr(self.db(), "account", "")
            info["moments"] = self.mdb().count()
        except Exception as exc:
            info["dbError"] = str(exc)
        info["ledger"] = len(self.ledger_entries())
        return info

    # -- 循环 -------------------------------------------------------------
    # -- 发朋友圈 ---------------------------------------------------------
    def method_publish(self, params):
        """发一条朋友圈：text 必填；images 传本机图片路径（最多 9 张）；visibility 取 public/private。"""
        text = str(params.get("text") or "").strip()
        if not text:
            raise ValueError("朋友圈文案不能为空")
        images = [str(x) for x in (params.get("images") or []) if x]
        for pth in images:
            if not os.path.exists(pth):
                raise ValueError("找不到图片：%s" % pth)
        if len(images) > 9:
            raise ValueError("最多 9 张图")
        visibility = str(params.get("visibility") or "public").lower()
        if visibility not in ("public", "private"):
            visibility = "public"
        if visibility == "private":
            # 「谁可以看」那套弹层是独立顶层窗口，点完焦点会被抢走，点击坐标
            # 会落到别的窗口上（实测误触「取消 → 保留」）。先不做这个功能，
            # 宁可拒绝也不乱点。
            raise RuntimeError("暂不支持私密发布，先发公开，再去朋友圈里改可见范围")
        if _screen_locked():
            raise RuntimeError("屏幕锁着，先解锁再发")
        gui = self.wx()._gui
        self._bring_front()
        self.open_moments()
        time.sleep(1.2)
        rect = _win_rect(gui.main_hwnd)
        if not rect:
            raise RuntimeError("拿不到微信窗口位置")
        left, top, right, bottom = rect
        width, height = right - left, bottom - top

        def point(fx, fy):
            return left + int(width * fx), top + int(height * fy)

        # 1) 相机按钮：认图，不认固定坐标（换屏幕/换缩放后才不会偏）
        hwnd = gui.main_hwnd
        try:
            # 先找 sidecar 同目录（开源包里自带一份 wxui.py），再退回本机共享目录
            _here = os.path.dirname(os.path.abspath(__file__))
            for _p in (_here, r"D:\AI\DSH\yoyo\tools"):
                if _p and _p not in sys.path:
                    sys.path.append(_p)
            import wxui
            wxui.dpi_aware()
        except Exception as exc:
            wxui = None
            _log("认图模块没加载，退回比例坐标", exc)

        def camera_center():
            if wxui is not None:
                hit = wxui.locate_screen(hwnd, "camera-btn", region_frac=(0.80, 0.0, 1.0, 0.25))
                if hit:
                    return hit[0], hit[1]
            return point(0.875, 0.104)

        cam_x, cam_y = camera_center()
        if images:
            _mouse_click(cam_x, cam_y)
            time.sleep(1.8)
            if not _wait_dialog(6.0):
                raise RuntimeError("没等到选图窗口（相机按钮没点上？）")
            _pick_files(images)
            time.sleep(2.5)
        else:
            # 纯文字：微信是「长按相机」进文字编辑；短按只会开选图框，
            # 而 ESC 关选图框会把整个发布框一起关掉（之前的坑）。
            _mouse_down(cam_x, cam_y)
            time.sleep(1.1)
            _mouse_up()
            time.sleep(1.5)
        # 2) 文案：点编辑框里的占位行（0.136 太靠上，会点空导致粘不上）
        _mouse_click(*point(0.45, 0.20))
        time.sleep(0.4)
        _paste_text(text)
        time.sleep(0.8)
        # 3) 可见范围：「谁可以看」整行 + 「私密」两个字 + 绿色「确定」，全认图
        if visibility == "private":
            if wxui is not None:
                hit = wxui.locate_screen(hwnd, "audience-row")
                if hit:
                    wxui.click_screen(hit[0], hit[1])
                else:
                    _mouse_click(*point(0.537, 0.746))
                time.sleep(1.3)
                hit = wxui.locate_screen(hwnd, "private-opt")
                if hit:
                    wxui.click_screen(hit[0], hit[1])
                else:
                    _mouse_click(*point(0.301, 0.389))
                time.sleep(0.9)
                confirmed = wxui.click_green(
                    hwnd,
                    region=(int(width * 0.22), int(height * 0.55), int(width * 0.86), height),
                )
                if not confirmed:
                    _mouse_click(*point(0.4125, 0.803))
                time.sleep(2.0)  # 可见范围对话框收起后布局要重排，等稳了再点发表
            else:
                _mouse_click(*point(0.537, 0.746))
                time.sleep(1.0)
                _mouse_click(*point(0.301, 0.389))
                time.sleep(0.5)
                _mouse_click(*point(0.4125, 0.803))
                time.sleep(1.0)
        # 4) 发表：认「微信绿」的按钮（弹窗高度随内容变，固定比例必点空）。
        # 朋友圈是独立顶层窗口，点「确定」后焦点会跑到那个窗口上，第一次点
        # 「发表」常常只起到「激活窗口」的作用——所以点完要看发布框还在不在，
        # 还在就补一下。
        published = False
        if wxui is not None:
            # 朋友圈弹窗是独立顶层窗口，点完「确定」后它会抢焦点；不把主窗口
            # 重新提到前台，后面的点击会落到那个窗口的本地坐标上（实测点到
            # 「取消 → 保留」，微信提示「已保存到个人相册」）。
            try:
                import ctypes as _ct

                _ct.windll.user32.SetForegroundWindow(hwnd)
                time.sleep(0.6)
            except Exception:
                pass
            for _ in range(3):
                if not wxui.click_green(
                    hwnd,
                    region=(int(width * 0.20), int(height * 0.55), int(width * 0.85), height),
                ):
                    break
                time.sleep(1.6)
                if wxui.locate_screen(hwnd, "audience-row") is None:
                    published = True
                    break
        if not published:
            _mouse_click(*point(0.4125, 0.841))
        time.sleep(2.5)
        # 5) 回读
        verified, seen = _verify_publish(self.mdb(), text, timeout=12.0)
        return {
            "ok": bool(verified),
            "text": text,
            "images": images,
            "visibility": visibility,
            "verified": bool(verified),
            "message": "已发出并在库里核到" if verified else "微信没接受这条（可能退回了草稿或弹了未发送提示），库里没核到",
        }

    def handle(self, req):
        method = str(req.get("method") or "")
        params = req.get("params") or {}
        fn = getattr(self, "method_" + method, None)
        if fn is None:
            raise ValueError("未知方法：%s" % method)
        return fn(params)


def main():
    side = MomentsSidecar()
    out = sys.stdout
    _log("started")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        rid = req.get("id")
        try:
            result = side.handle(req)
            payload = {"id": rid, "ok": True, "result": result}
        except Exception as exc:
            _log("error", traceback.format_exc()[-800:])
            payload = {"id": rid, "ok": False, "error": str(exc)}
        try:
            out.write(json.dumps(payload, ensure_ascii=False) + "\n")
            out.flush()
        except Exception:
            pass
    _log("stdin closed, exit")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
