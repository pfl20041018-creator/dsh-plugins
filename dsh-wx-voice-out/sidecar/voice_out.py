# -*- coding: utf-8 -*-
"""把一句话合成她的声音，再以微信语音气泡发出去。

这个 worker 由 dsh-wx-voice-out 插件调用（Anaconda 的 base python 跑，
因为 wechatauto / sounddevice 装在那儿）。它做三件事：

1. 用 conda 环境 yoyo 里的 GPT-SoVITS 把文字合成 wav
   （脚本在 <workspace>\\voice\\tts_her_ft.py，权重/参考音都在 workspace 里）；
2. 只做峰值归一（不做 loudnorm），避免把字间底噪抬起来；
3. 把音频播进 VB-Cable，再用 UIA 点微信的语音键、按住、松开，发成语音气泡，
   最后从数据库回读确认。

输入：stdin 一行 JSON，字段
  chat       会话名或 username（必填）
  text       要说的话（必填，中文）
  speed      GPT-SoVITS speed_factor，默认 1.0
  mood       情绪参考音：default / calm / soft / happy / sad / angry，默认 default
  preset     预设名，默认 "her"（也就是固化下来的那一套）
  dryRun     true 时只合成不发送
输出：stdout 一行 JSON {ok, chat, text, seconds, wav, message, confirmed, error?}
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# 权限分级（三级白名单 / 峰谷时段 / 每日预算）只在微信桥的 sidecar 里实现一份，
# 这里借过来用，避免两处规则走岔。
_BRIDGE_SIDECAR = os.environ.get(
    "DSH_WX_BRIDGE_SIDECAR", r"D:\AI\DSH\plugins\dsh-wechat-bridge\sidecar"
)
if _BRIDGE_SIDECAR not in sys.path:
    sys.path.insert(0, _BRIDGE_SIDECAR)
try:
    import access  # noqa: E402
except Exception:  # pragma: no cover - 桥不在就退化成不拦
    access = None

WORKSPACE = os.environ.get("DSH_WX_VOICE_WORKSPACE", r"D:\AI\DSH\yoyo")
PY_YOYO = os.environ.get("DSH_WX_VOICE_PY", r"D:\Codes\Anaconda\envs\yoyo\python.exe")
REPO = os.path.join(WORKSPACE, "vendor", "gptsovits", "GPT-SoVITS-main")
TTS_SCRIPT = os.path.join(WORKSPACE, "voice", "tts_her_ft.py")
OUT_DIR = os.path.join(WORKSPACE, "voice", "out")
VOICE_DIR = os.path.join(WORKSPACE, "voice")

# 固化下来的那套参数（2026-11-02 用户验收：bigfish5 + fridge 参考音）
# moods 是「情绪参考音库」：模型只认参考音，音色和语气都从它身上抄，
# 所以同一句话换一桶参考音，语调和情绪就变了。
# 参考音与文字都来自她自己的语料（voice/refbank/，见 refbank.json）。
MOODS = {
    "default": {
        "ref": os.path.join(VOICE_DIR, "ref32", "ref-fridge-474.wav"),
        "ref_text": "这谁啊，这谁把这么多饭放在我们家冰箱里。",
    },
    "calm": {
        "ref": os.path.join(VOICE_DIR, "refbank", "calm", "calm-0.wav"),
        "ref_text": "我一直都是这样认真上班的，为什么我要跪啊。",
    },
    "soft": {
        "ref": os.path.join(VOICE_DIR, "refbank", "soft", "soft-0.wav"),
        "ref_text": "也要变得美味呀。",
    },
    "happy": {
        "ref": os.path.join(VOICE_DIR, "refbank", "happy", "happy-0.wav"),
        "ref_text": "噢噢！水底下有什么东西在顶船底。",
    },
    "sad": {
        "ref": os.path.join(VOICE_DIR, "refbank", "sad", "sad-0.wav"),
        "ref_text": "不要了，吃不下了千千。",
    },
    "angry": {
        "ref": os.path.join(VOICE_DIR, "refbank", "angry", "angry-0.wav"),
        "ref_text": "呸呸呸，卖艺不卖身，松手。",
    },
}

PRESETS = {
    "her": {
        "ckpt": os.path.join(REPO, "GPT_weights_v2", "bigfish5-e36.ckpt"),
        "vits": os.path.join(REPO, "SoVITS_weights_v2", "bigfish5_e40_s2680.pth"),
        "moods": MOODS,
        "mood": "default",
    },
    # 2026-11-03：语料扩到 33 个视频（ds5，526 段/58 分钟）+ 60 轮重训
    "her6": {
        "ckpt": os.path.join(REPO, "GPT_weights_v2", "bigfish6-e60.ckpt"),
        "vits": os.path.join(REPO, "SoVITS_weights_v2", "bigfish6_e60_s5160.pth"),
        "moods": MOODS,
        "mood": "default",
    },
}


# ---- BreezeBlue 云端（2026-11-03 用户验收：v2-soft 那条最好听）----
# 本地模型听参考音，云端模型听「指令」——同一句台词，指令决定情绪。
BREEZE_VOICE_ID = "voc_jhh7eqk877n3"   # 用她视频里 36 秒人声克隆出来的私有音色
BREEZE_KEY_FILE = os.path.join(os.path.expanduser("~"), ".breeze-key")
BREEZE_API = "https://api.breeze.blue/v1"
BREEZE_GUIDANCE = 3.0
# 音高要靠指令自己抬：只写「平静温柔」会出来 235Hz 的大人声，
# 加上「声音偏高、像十几岁的小女孩」立刻到 400Hz 上下。
BREEZE_PITCH = "声音偏高一点，像十几岁的小女孩。"
BREEZE_INSTRUCTIONS = {
    "default": BREEZE_PITCH + "自然地说，语速适中，别念稿子。",
    "calm": BREEZE_PITCH + "平静温柔地说，语速适中，声音稳，不夸张。",
    "soft": BREEZE_PITCH + "软软的语气，尾音轻轻上扬，带点撒娇，比平时慢一点点。",
    "happy": BREEZE_PITCH + "开心又得意地说，语速偏快，尾音翘起来，像在蹦。",
    "sad": BREEZE_PITCH + "委屈难过地说，声音轻一点，语速慢，尾音往下掉，别哭出来。",
    "angry": BREEZE_PITCH + "生气但强忍着说，语速偏快，语气冲一点，别喊。",
}


def breeze_key() -> str:
    if os.environ.get("BREEZE_API_KEY"):
        return os.environ["BREEZE_API_KEY"].strip()
    with open(BREEZE_KEY_FILE, encoding="utf-8") as f:
        return f.read().strip()


def breeze_synth(text: str, mood: str, speed: float = 1.0) -> str:
    import requests

    body = {
        "text": text,
        "model_id": "breeze-tts-2",
        "language_code": "zh",
        "instructions": BREEZE_INSTRUCTIONS.get(mood, BREEZE_INSTRUCTIONS["default"]),
        "voice_settings": {"guidance_scale": BREEZE_GUIDANCE},
    }
    if abs(speed - 1.0) > 1e-3:
        body["voice_settings"]["speed"] = speed
    r = requests.post(
        f"{BREEZE_API}/text-to-speech/{BREEZE_VOICE_ID}",
        headers={"xi-api-key": breeze_key(), "Accept": "audio/*",
                 "Content-Type": "application/json"},
        params={"output_format": "wav_24000"},
        json=body,
        timeout=180,
    )
    if r.status_code != 200:
        raise RuntimeError(f"breeze HTTP {r.status_code}: {r.text[:300]}")
    os.makedirs(OUT_DIR, exist_ok=True)
    wav = os.path.join(OUT_DIR, "voice-out-%d.wav" % int(time.time() * 1000))
    with open(wav, "wb") as f:
        f.write(r.content)
    return wav


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ---- 每日 400 积分（2026-11-03 用户要的自动化）--------------------------------
# 平台每天给免费额度（账本里记成 "daily claim credits"），但公开 API 文档里
# 没有「领取」这个端点，只能摸。策略：
#   1) 先读 /v1/balance，看今天有没有那条 daily claim 记录 —— 有就不再动（幂等）；
#   2) 没有就依次尝试候选端点（可用 ~/.breeze-claim.json 覆盖成你从 F12 抄到的那条）；
#   3) 支持 ~/.breeze-session（浏览器 cookie 串）——控制台的领取接口多半要会话不要 key；
#   4) 试完再读一次余额，真多了才算成功，绝不假报。
BREEZE_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
BREEZE_CLAIM_CFG = os.path.join(os.path.expanduser("~"), ".breeze-claim.json")
BREEZE_SESSION_FILE = os.path.join(os.path.expanduser("~"), ".breeze-session")
# 2026-11-04 从控制台前端 chunk（/_next/static/chunks/07_keg8c_hq2z.js）里挖出来的真身：
#   claimDailyCredits -> POST https://breezeblue.ai/api/credits/daily-claim
# 它挂在**网页 origin** 上、要网页登录态（cookie）；用 xi-api-key 打是 401。
# 所以 web 那条走 cookie，api 那几条留着用 key 兜底。
BREEZE_WEB_API = "https://breezeblue.ai"
BREEZE_CLAIM_CANDIDATES = [
    ("web", "/api/credits/daily-claim"),
    ("api", "/credits/daily-claim"),
    ("api", "/credits/claim"),
    ("api", "/account/claim-daily"),
    ("api", "/account/credits/claim"),
    ("api", "/daily-claim"),
    ("api", "/daily-claim-credits"),
]

# 订阅页 FAQ 原话：「Free 和付费套餐每天可领取 400 免费积分」。
# 控制台里没有可见的「领取」按钮，但今早 09:29 那次 ledger 记录（"daily claim credits"）
# 正是用户打开控制台时自己落下的 —— 所以最稳的兜底是：替他把控制台页面打开一次。
EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]
BREEZE_CONSOLE_URL = "https://breezeblue.ai/zh/app/home"


def _edge_windows():
    """返回所有 Edge 顶层窗口 (hwnd, 标题, (l,t,r,b))，物理像素。"""
    import ctypes

    import win32gui

    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        pass
    found = []

    def each(hwnd, _):
        try:
            if not win32gui.IsWindowVisible(hwnd):
                return
            if win32gui.GetClassName(hwnd) != "Chrome_WidgetWin_1":
                return
            title = win32gui.GetWindowText(hwnd)
            if not title:
                return
            found.append((hwnd, title, win32gui.GetWindowRect(hwnd)))
        except Exception:
            pass

    win32gui.EnumWindows(each, None)
    return found


def _click_point(x, y):
    import ctypes

    u32 = ctypes.windll.user32
    u32.SetCursorPos(int(x), int(y))
    time.sleep(0.25)
    u32.mouse_event(0x0002, 0, 0, 0, 0)
    time.sleep(0.08)
    u32.mouse_event(0x0004, 0, 0, 0, 0)


def ui_claim(wait=8):
    r"""控制台右下角那张「+400 积分 / 立即领取」小卡片，点它。

    2026-11-04 实测：网页接口 `POST /api/credits/daily-claim` 要网页登录 cookie，
    Edge 的 cookie 是 App-Bound Encryption（v20）、外部进程解不开，所以只能"代替手点"。
    卡片固定在视口右下角，实测偏移：右边距 ≈420px、下边距 ≈193px（物理像素、
    主屏 3840×2160、窗口最大化时）。
    """
    import subprocess

    exe = next((p for p in EDGE_CANDIDATES if os.path.exists(p)), None)
    opened = False
    try:
        if exe:
            subprocess.Popen([exe, BREEZE_CONSOLE_URL],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            opened = True
        else:
            os.startfile(BREEZE_CONSOLE_URL)  # noqa: S606 - 只打开浏览器
            opened = True
    except Exception as exc:
        return {"ok": False, "step": "open", "error": repr(exc)[:160]}
    if not opened:
        return {"ok": False, "step": "open", "error": "找不到 Edge"}
    time.sleep(max(4, int(wait)))
    targets = [w for w in _edge_windows() if "breeze" in w[1].lower()]
    if not targets:
        return {"ok": False, "step": "find-window", "error": "没找到 BreezeBlue 的标签页窗口"}
    hwnd, title, rect = targets[0]
    try:
        import win32con

        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        win32gui.SetForegroundWindow(hwnd)
    except Exception:
        pass
    time.sleep(0.6)
    left, top, right, bottom = rect
    x = right - 420
    y = bottom - 193
    _click_point(x, y)
    time.sleep(2.6)
    after = claim_status()
    return {"ok": bool(after.get("claimedToday")), "step": "click",
            "clicked": [x, y], "title": title[:40],
            "balance": after.get("balance"), "claimedToday": after.get("claimedToday"),
            "claimedAt": after.get("claimedAt")}


def open_console_and_wait(wait=25):
    """兜底：开一次控制台并把右下角那张领取卡片点掉。"""
    result = ui_claim(wait=min(wait, 10))
    return bool(result.get("ok")), result


def _breeze_headers(extra=None):
    h = {"xi-api-key": breeze_key(), "Accept": "application/json",
         "User-Agent": BREEZE_UA}
    if extra:
        h.update(extra)
    return h


def _local_day(stamp):
    """把 2026-11-03T01:29:55+00:00 换成北京时间的日期字符串。"""
    if not stamp:
        return ""
    try:
        from datetime import datetime, timezone
        s = str(stamp).replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone().strftime("%Y-%m-%d")
    except Exception:
        return ""


def breeze_balance():
    import requests

    r = requests.get(BREEZE_API + "/balance", headers=_breeze_headers(), timeout=30)
    if r.status_code != 200:
        raise RuntimeError("breeze balance HTTP %s: %s" % (r.status_code, r.text[:200]))
    return r.json()


def claim_status():
    data = breeze_balance()
    today = time.strftime("%Y-%m-%d")
    topups = data.get("topups") or []
    todays = [t for t in topups
              if "daily" in str(t.get("description") or "").lower()
              and _local_day(t.get("created_at")) == today]
    last = topups[0] if topups else None
    return {
        "ok": True,
        "balance": data.get("balance"),
        "claimedToday": bool(todays),
        "todayAmount": round(sum(float(t.get("amount") or 0) for t in todays), 2),
        "todayCount": len(todays),
        "claimedAt": (todays[-1] or {}).get("created_at") if todays else None,
        "lastTopup": ({"amount": last.get("amount"),
                       "description": last.get("description"),
                       "created_at": last.get("created_at")} if last else None),
        "today": today,
    }


def _claim_providers():
    """返回 [(名字, 请求参数), ...]，按优先级排。"""
    import json as _json

    providers = []
    if os.path.exists(BREEZE_CLAIM_CFG):
        try:
            with open(BREEZE_CLAIM_CFG, encoding="utf-8") as f:
                cfg = _json.load(f)
            if cfg.get("url"):
                providers.append(("config", cfg))
        except Exception as exc:
            log("读 ~/.breeze-claim.json 失败：%r" % (exc,))
    def base_of(kind):
        return BREEZE_WEB_API if kind == "web" else BREEZE_API

    for kind, path in BREEZE_CLAIM_CANDIDATES:
        if kind == "web":
            continue  # 网页接口要 cookie，没 cookie 打了也是 401
        providers.append(("key:" + path, {"url": base_of(kind) + path,
                                          "method": "POST", "json": {}}))
    if os.path.exists(BREEZE_SESSION_FILE):
        try:
            with open(BREEZE_SESSION_FILE, encoding="utf-8") as f:
                cookie = f.read().strip()
            if cookie:
                for kind, path in BREEZE_CLAIM_CANDIDATES:
                    providers.append(("cookie:" + path, {
                        "url": base_of(kind) + path,
                        "method": "POST",
                        "json": {},
                        "cookie": cookie,
                    }))
        except Exception as exc:
            log("读 ~/.breeze-session 失败：%r" % (exc,))
    return providers


def claim_daily(dry_run=False, open_console=True, wait=25):
    """领今天的免费额度。返回里 tried/verified 都如实写，方便明天零点排查。"""
    import requests

    before = claim_status()
    if before["claimedToday"]:
        return {"ok": True, "already": True, "skip": "今天已经领过了",
                "balance": before["balance"], "todayAmount": before["todayAmount"],
                "claimedAt": before["claimedAt"]}
    if dry_run:
        return {"ok": True, "dryRun": True, "wouldTry": [p[0] for p in _claim_providers()],
                "balance": before["balance"],
                "wouldOpenConsole": bool(open_console)}
    # 2026-11-04 起：API 那条路走不通（接口要网页 cookie），
    # 默认先"替人点一下"右下角那张领取卡片——实测最稳。
    ui_result = None
    if open_console:
        ui_result = ui_claim(wait=min(10, max(5, int(wait))))
        if ui_result.get("ok"):
            after_ui = claim_status()
            return {"ok": True, "source": "ui", "clicked": ui_result.get("clicked"),
                    "balance": after_ui.get("balance"),
                    "claimedToday": after_ui.get("claimedToday"),
                    "todayAmount": after_ui.get("todayAmount"),
                    "claimedAt": after_ui.get("claimedAt"),
                    "earned": round(float(after_ui.get("balance") or 0)
                                    - float(before["balance"] or 0), 2)}

    tried = []
    for name, spec in _claim_providers():
        extra = {"Content-Type": "application/json", "Accept": "application/json"}
        if "breezeblue.ai/api/" in spec.get("url", ""):
            extra["Origin"] = BREEZE_WEB_API
            extra["Referer"] = BREEZE_WEB_API + "/zh/app/home"
        if spec.get("cookie"):
            extra["Cookie"] = spec["cookie"]
        try:
            r = requests.request(
                spec.get("method", "POST"),
                spec["url"],
                headers=_breeze_headers(extra),
                json=spec.get("json") or {},
                timeout=30,
            )
            tried.append({"provider": name, "status": r.status_code,
                          "body": (r.text or "")[:200]})
            if r.status_code in (200, 201):
                break
        except Exception as exc:
            tried.append({"provider": name, "error": repr(exc)[:160]})

    mid = claim_status()
    # 接口没一个能用的，就走兜底：替他把控制台打开一次（订阅页 FAQ：每天可领取 400）。
    opened = None
    if ui_result is not None:
        opened = {"ok": False, "detail": ui_result}
    if not mid["claimedToday"] and open_console and ui_result is None:
        ok_open, detail = open_console_and_wait(wait)
        opened = {"ok": ok_open, "detail": detail}

    after = claim_status()
    earned = round(float(after["balance"] or 0) - float(before["balance"] or 0), 2)
    ok = bool(after["claimedToday"]) or earned > 0
    out = {"ok": ok, "earned": earned, "balance": after["balance"],
           "claimedToday": after["claimedToday"], "todayAmount": after["todayAmount"],
           "tried": tried[-6:]}
    if opened is not None:
        out["openedConsole"] = opened
    if not ok:
        out["hint"] = ("没领到。要么把控制台 F12 里那条请求存成 ~/.breeze-claim.json"
                       "（{\"url\":\"…\",\"method\":\"POST\",\"json\":{}}），"
                       "要么把登录后的 cookie 存成 ~/.breeze-session；"
                       "如果控制台页面打开后过一会儿就自动到账，说明不用请求、只要每天开一次页面。")
    return out


# ---- 语气词（让合成的语音听起来像在跟人说话，不是念稿）----
# 只在语音里加，文字消息不加；一条最多加两处（开头一个、句尾一个）。
HEAD_FILLERS = {
    "default": ["诶，", "啊，", "那个，"],
    "soft": ["诶，", "唔，", "嗯，"],
    "happy": ["诶呀，", "啊，", "诶，"],
    "sad": ["唔，", "唉，", "嗯，"],
    "angry": ["哼，", "诶，", "喂，"],
    "calm": ["诶，", "那个，"],
}
TAIL_PARTICLES = ["呀", "啦", "嘛", "呢", "哦", "啊"]
_HAS_PARTICLE = ("吗", "吧", "呢", "呀", "啦", "嘛", "哦", "啊", "噢", "呗", "咯")


def add_fillers(text, mood="default", seed=None):
    """给一句话加自然的语气词：句首一个、句尾一个，最多两处。"""
    import random
    rng = random.Random(seed if seed is not None else hash(text))
    body = text.strip()
    if not body:
        return body

    touched = 0
    heads = HEAD_FILLERS.get(mood) or HEAD_FILLERS["default"]
    # 句首：前半句没语气词、整体不是问句才加。
    # 如果开头是「小克，」这种称呼，就把语气词挪到称呼后面——直接顶在最前面会把称呼吃掉。
    starts_with_particle = body[0] in "嗯诶啊唔唉哼喂哦噢"
    if not starts_with_particle and rng.random() < 0.5:
        m = re.match(r"^([^，,。！？]{1,5})[，,](.+)$", body)
        if m and not m.group(2)[:1] in "嗯诶啊唔唉哼喂哦噢":
            body = m.group(1) + "，" + rng.choice(heads) + m.group(2)
        else:
            body = rng.choice(heads) + body
        touched += 1

    # 句尾：最后一段已经带语气助词就不动；问句不加（「…吗嘛」很怪）
    tail = body.rstrip("。！？!?…~ ")
    end = body[len(tail):] or "。"
    if end.startswith(("？", "?")):
        return body
    last_clause = tail.replace("||", "，").split("，")[-1]
    if last_clause and not last_clause.endswith(_HAS_PARTICLE) and touched < 2:
        if mood in ("soft", "sad"):
            pool = ["呀", "嘛", "啦"]
        else:
            pool = ["呀", "啦", "哦", "啊"]
        body = tail + rng.choice(pool) + end
    return body



def synth(text, speed, preset, mood="default"):
    # breeze：云端「指令驱动」；auto：先云端、失败回落本地 her6（断网/超额度也能说话）
    if preset == "breeze":
        return breeze_synth(text, mood, speed)
    if preset == "auto":
        try:
            return breeze_synth(text, mood, speed)
        except Exception as exc:
            log("breeze 失败(%s)，回落本地 her6" % repr(exc)[:120])
            preset = "her6"
    p = PRESETS.get(preset) or PRESETS["her6"]
    moods = p.get("moods") or {}
    picked = moods.get(mood) or moods.get(p.get("mood") or "default") or {}
    ref = picked.get("ref") or MOODS["default"]["ref"]
    ref_text = picked.get("ref_text") or MOODS["default"]["ref_text"]
    for path in (p["ckpt"], p["vits"], ref):
        if not os.path.exists(path):
            raise RuntimeError("缺文件：" + path)
    os.makedirs(OUT_DIR, exist_ok=True)
    wav = os.path.join(OUT_DIR, "voice-out-%d.wav" % int(time.time() * 1000))
    cmd = [PY_YOYO, "-X", "utf8", TTS_SCRIPT, text,
           "--out", wav, "--ckpt", p["ckpt"], "--vits", p["vits"],
           "--ref", ref, "--ref-text", ref_text]
    if abs(speed - 1.0) > 1e-3:
        cmd += ["--speed", str(speed)]
    env = dict(os.environ, PATH=r"C:\Users\gypsophila\.dsh\bili-whale\bin;" + os.environ.get("PATH", ""))
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                       errors="replace", env=env, timeout=300)
    if r.returncode != 0 or not os.path.exists(wav):
        raise RuntimeError("合成失败：" + (r.stderr or r.stdout or "")[-400:])
    return wav


def restore_wechat() -> bool:
    """微信被 ESC 收进托盘时把它捞回来——发语音前先做一次。"""
    try:
        import ctypes

        import win32con
        import win32gui
    except Exception:
        return False

    found = []

    def each(hwnd, _):
        try:
            cls = win32gui.GetClassName(hwnd)
            title = win32gui.GetWindowText(hwnd)
        except Exception:
            return
        if cls == "Qt51514QWindowIcon" and title in ("微信", "Weixin"):
            found.append(hwnd)

    win32gui.EnumWindows(each, None)
    if not found:
        return False
    hwnd = found[0]
    if win32gui.IsWindowVisible(hwnd):
        return True
    try:
        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        win32gui.ShowWindow(hwnd, win32con.SW_SHOW)
        ctypes.windll.user32.SetForegroundWindow(hwnd)
        time.sleep(0.8)
    except Exception:
        return False
    return bool(win32gui.IsWindowVisible(hwnd))


def send(chat, wav):
    sys.path.insert(0, VOICE_DIR)
    import say  # workspace\voice\say.py

    for attempt in (0, 1):
        try:
            return say.say_wav(chat, wav, keep_wav=True, normalize=False)
        except RuntimeError as exc:
            if attempt == 0 and "未找到微信主窗口" in str(exc) and restore_wechat():
                log("微信窗口被藏起来了，已恢复，重试发送")
                continue
            raise


def main():
    raw = sys.stdin.read().strip()
    if not raw:
        print(json.dumps({"ok": False, "error": "stdin 没收到 JSON"}))
        return
    p = json.loads(raw)

    # 每日积分：不合成、不发送，只跟 BreezeBlue 的账本打交道
    action = (p.get("action") or "").strip().lower()
    if action in ("claim", "credits", "status"):
        try:
            if action == "status":
                print(json.dumps(claim_status(), ensure_ascii=False))
            else:
                print(json.dumps(claim_daily(
                    dry_run=p.get("dryRun") is True,
                    open_console=p.get("openConsole") is not False,
                    wait=int(p.get("wait") or 25),
                ), ensure_ascii=False))
        except Exception as exc:
            print(json.dumps({"ok": False, "error": repr(exc)[:400]}, ensure_ascii=False))
        return

    chat = (p.get("chat") or "").strip()
    text = (p.get("text") or "").strip()
    if not chat or not text:
        print(json.dumps({"ok": False, "error": "chat 和 text 都必须给"}))
        return
    preset = p.get("preset") or "auto"
    speed = float(p.get("speed") or 1.0)
    mood = (p.get("mood") or "default").strip().lower()
    if mood not in MOODS:
        mood = "default"
    feel = p.get("feel")
    if feel is None:
        feel = True
    if access is not None:
        verdict = access.decide(chat, "voice")
        if not verdict.get("allow"):
            print(json.dumps({
                "ok": False,
                "chat": chat,
                "blocked": True,
                "reason": verdict.get("reason", ""),
                "speakable": verdict.get("speakable", ""),
                "message": "语音被权限拦下：%s" % verdict.get("reason", ""),
            }, ensure_ascii=False))
            return
    if feel:
        text = add_fillers(text, mood)
    try:
        t0 = time.time()
        wav = synth(text, speed, preset, mood)
        log("synth ok %.1fs mood=%s %s" % (time.time() - t0, mood, wav))
        if p.get("dryRun"):
            secs = None
            try:
                import wave

                with wave.open(wav, "rb") as fh:
                    secs = round(fh.getnframes() / float(fh.getframerate()), 2)
            except Exception:
                pass
            out = {"ok": True, "dryRun": True, "wav": wav,
                   "chat": chat, "text": text, "mood": mood}
            if secs is not None:
                out["seconds"] = secs
            print(json.dumps(out, ensure_ascii=False))
            return
        res = send(chat, wav)
        res.update({"ok": bool(res.get("confirmed")), "text": text, "spoke": text,
                    "preset": preset, "speed": speed, "mood": mood})
        print(json.dumps(res, ensure_ascii=False))
    except Exception as exc:  # 如实报错，别假装发出去了
        print(json.dumps({"ok": False, "chat": chat, "text": text,
                          "error": repr(exc)[:500]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
