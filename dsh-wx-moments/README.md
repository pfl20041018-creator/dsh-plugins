# dsh-wx-moments · 朋友圈插件

给这个 harness 加一个能「刷朋友圈」的手：读动态、看清图、点赞、评论。

## 工具

| 工具 | 做什么 | 要不要点界面 |
| --- | --- | --- |
| `moments_feed` | 最近几条动态（作者、时间、正文、评论、几张图、已赞/已评） | 不用，只读 sns.db |
| `moments_post` | 某条的详情 + 完整评论串 | 不用 |
| `moments_shots` | 把那条在微信界面上的样子截成 png，给看图模型 | 要（开朋友圈窗口） |
| `moments_like` | 点赞 / 取消赞 | 要 |
| `moments_comment` | 评论 / 回复某人 | 要 |
| `moments_ledger` | 我赞过谁、评过谁 | 不用 |
| `moments_status` | 账号、动态条数、屏幕是否锁着 | 不用 |

行为规矩写在同目录的 `MOMENTS.md`（点赞不过度、评论要短要有由头、看图再说话）。

## 为什么图片是截图而不是下载

朋友圈图片的 CDN 地址（`shmmsns.qpic.cn/mmsns/...`）现在带不带 Referer 都只回
120×120 的「暂时无法查看」占位图，本机缓存里也没有明文文件（`moments.py` 试过
`find_local_media` / `download_moment_media`，全为空）。所以唯一能拿到真实画面
内容的路子，是把微信界面上渲染出来的缩略图截下来交给视觉模型。

## 实现

* Host 半部 `index.js`：注册 7 个工具，常驻一个 python 子进程（行分隔 JSON），
  和 `dsh-wechat-bridge` 用的是同一套 sidecar 写法。
* `sidecar/moments.py`：`wechatauto`（Anaconda site-packages）的 `MomentDB` /
  `Moment` / `WeChatDB`。选 `python` 时可用 `DSH_WX_MOMENTS_PYTHON` 覆盖。
* 点赞/评论记在 `sidecar/.state/actions.jsonl`，`moments_feed` 会标「已赞/已评」；
  截图落在 `sidecar/.state/shots/`（可以定期清）。

## 当前状态（2026-11-02）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| `moments_feed` / `moments_post` / `moments_ledger` | 可用 | 只读 `sns.db`，不碰界面 |
| `moments_shots` | 可用 | 截图落盘给看图模型，已实测读出图里内容 |
| `moments_like` | 可用 | 已实测：界面出现「♥ yoyo」，库里 `likes: 1` |
| `moments_comment` | 可用 | 2026-11-02 19:40 实测：两条评论都进了库（`comments` 有记录，界面显示「yoyo：…」） |

### `moments_comment` 曾经踩过的两个坑（已修）

1. **发送键定位**：`wechatauto` 的 `Comment()` 靠 OCR 找「发送」，本机没装 OCR 就卡住。
   改成不认字只认色：扫整窗找**绿色描边的评论框**，发送键固定在框右下角内缩
   `(right-49, bottom-26)`。之前按「绿色小块」瞎猜，会点到别的东西上。
2. **副屏截图为空**：`wechatauto` 用 `pyautogui.screenshot()` 找「⋯」按钮，而 pyautogui
   **只截主屏**——微信一开到副屏（x > 主屏宽），截出来根本不含窗口，模板匹配永远失败，
   于是「点不开 ⋯ 菜单」。修法：`_patch_pyautogui()` 把 `pyautogui.screenshot` 换成
   `ImageGrab(all_screens=True)`（`moments.py` 里在 `wx()` 初始化前打补丁）。

现在这个工具仍然**以数据库回读为准**：只有评论真的出现在动态里才回 `ok: true`；
微信要是弹「评论未发送」，它会老实说没评上。

## 限制

* 需要微信 4.x 登录着、能拿到 UIA 树；锁屏时点赞/评论/截图会直接报「屏幕锁着」。
* UIA 无障碍树会掉（隐藏窗口 / 最小化到托盘 / 按两次 ESC 都可能触发）：
  掉了以后 `u._win` 只剩 `MMUIRenderSubWindowHW`，热激活也救不回来，只能重启微信。
  所以这个插件**不要发 ESC**（关弹窗除外），也别把微信窗口藏起来。
* `wechatauto` 的点赞/评论依赖 `cv2` 和 `pyautogui`（模板匹配找「⋯」和「发送」），
  Anaconda 里要各装一份：`pip install opencv-python-headless pyautogui`。
* `moments_shots` / `like` / `comment` 会抢焦点十几秒，别在人家正用电脑的时候跑。
* 太旧的朋友圈需要滚很久才定位得到（`find_moment` 有翻屏上限）。
* 发朋友圈（发布）在微信 4.x 是自绘界面，官方库已舍弃，这里也不支持。
