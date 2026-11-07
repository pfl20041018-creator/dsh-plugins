# 怎么把这套东西搭起来

这不是一个能直接 `git clone` 就跑的项目。它是一台运行中的机器人的**装配说明**：装什么、怎么配、哪些地方我们改过。

DSH 本体、第三方插件、微信客户端都不在这个仓库里——它们各有各的来源和许可证。

---

## 0. 前提

| 项 | 要求 |
|---|---|
| 系统 | Windows 10/11（这套东西大量依赖窗口自动化，只有 Windows 能跑） |
| DSH | DeepSeek Harness 桌面版，从官方渠道安装 |
| Node | 随 DSH 一起装的运行时即可，不需要单独装 |
| Python | 建议 Anaconda 或 3.10+，微信/媒体相关插件要用 |
| 微信 | Windows 桌面版 4.x，需已登录 |
| 可选 | ComfyUI（本地出图/出视频）、VB-Cable（语音回放） |

目录约定（下文的 `<DSH_HOME>`）：

```
C:\Users\<你>\.dsh\            ← DSH 的数据根
  profiles\desktop\            ← 插件装在 node_modules 下
  sessions\                    ← 会话记录
  storages\                    ← 定时任务、工作区名单
D:\AI\DSH\<workspace>\         ← 你自己的项目目录
```

---

## 1. 装 DSH

从官方渠道装桌面版，登录。第一件事是在 Web GUI 里能正常对话。

---

## 2. 装插件

装法有两种，推荐第一种：

```js
// 用 DSH 自己的插件管理器（会写进 profile 的 bundle 层）
plugin_manager({ action: "install_bundle", target: "<本地包绝对路径>" })
```

第二种是把包直接放进 `profiles/desktop/node_modules/`，再在 `cordis.patch.yml` 里 insert 一行。这种方式容易在升级时丢，不推荐。

### 我们用的插件清单

| 包 | 版本 | 来源 | 干什么 |
|---|---|---|---|
| `dsh-wechat-bridge` | 0.1.0 | 本仓库 | 微信收发、分级权限、语音/图片/文件、自动回复守则 |
| `dsh-wx-ledger` | 1.0.0 | 本仓库 | 发言闸门、外发账本、主动搭话额度 |
| `dsh-wx-moments` | 1.0.0 | 本仓库 | 朋友圈发/赞/评 |
| `dsh-wx-voice-out` | 1.0.0 | 本仓库 | 用克隆音发语音气泡 |
| `dsh-memory-hub` | 1.0.0 | 本仓库 | 跨源记忆盘点/搜索/近况摘要 |
| `dsh-tool-shelf` | 1.0.2 | 本仓库 | 把低频工具藏起来按需加载 |
| `dsh-draw` | 1.0.0 | 本仓库 | 调 ComfyUI 出图/改图 |
| `dsh-morning` | 1.0.0 | 本仓库 | 人物侧写、早安晚安素材 |
| `dsh-usage-ledger` | 1.0.0 | 本仓库 | token 用量与余额 |
| `dsh-bili-whale` | 0.4.6 | npm | 刷 B 站、写日记、私信 |
| `dsh-world` | 0.7.1 | npm | 生活线（我们加了周末门控，见 `patches/`） |
| `dsh-genui` | 0.3.1 | npm | 卡片生成（可关，省 3.7 万 token/请求） |
| `dsh-meme` | 0.1.71 | npm | 表情包图库 |
| `dsh-fish-memory` | 1.4.6 | npm | 事实卡记忆 |
| `dsh-soul-md` | 0.10.4 | npm | 人设卡注入 |
| `dsh-feiyu-mood` | 0.8.2 | npm | 心情状态 |
| `dsh-office-toolkit` | 0.3.33 | npm | Office 读写（默认被 tool-shelf 藏起来） |
| `dsh-token-diet` | 0.1.0 | npm | 侧边栏 token 统计 |
| `billion-context` | 0.1.212 | npm | 上下文压缩 |
| `dsh-comfyui` | 0.5.5 | npm | ComfyUI 工具集 |

---

## 3. 配置骨架

`profiles/desktop/cordis.patch.yml` 是总开关。最小可用骨架（**所有值都要换成你自己的**）：

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: high      # 只能填模型支持的值，填错会报 UNSUPPORTED_REASONING_EFFORT

- insert:
    - id: wechat-bridge
      name: "@local/dsh-wechat-bridge"
      config:
        sessionId: ""          # 你的微信会话 id
        expectedAccount: ""    # 只认这一个微信号
        exportImages: true
```

**关于 `reasoningEffort`**：`deepseek-flash` 实测只接受 `high`。写成 `medium` 会直接在启动时报错，老会话因为 header 里存着旧配置不报、新会话必炸——这个坑我们踩过。

---

## 4. 补丁

见 [`patches/`](patches/README.md)。两个补丁：

- **dsh-bili-whale**：修「私信永久停摆」的 bug（空收件箱返回 `messages: null` 被误判成失败）
- **dsh-world**：把生活线改成只在周末跑

覆盖对应文件后重启即可。

---

## 5. 目录长什么样

```
<workspace>\
  people\            # 每人一份 md：wxid、偏好、作息、雷区、近况
  groups\            # 每个群一个目录：group.md、memory.md、members\
  comfy\
    instances.json   # ComfyUI 实例注册表（端口、目录、模型、工作流参数）
    extra_model_paths.yaml
  reports\           # 账单、花费归档
  docs\pits.md       # 踩坑记录
  voice\             # 语音合成与发送
  tools\             # 零散脚本（工作区修复、日志清理等）
```

`people/` 和 `groups/` 里是**真人信息**，发布任何东西之前先把这两个目录排除掉。

---

## 6. 几条硬经验

都是真踩过的，详细版在 [`pits.md`](pits.md)：

1. **PowerShell `Set-Content -Encoding UTF8` 会加 BOM**，插件读 JSON 直接失败、静默回落默认值。写配置文件一律用 `[System.IO.File]::WriteAllText($p, $text, (New-Object System.Text.UTF8Encoding($false)))`
2. **`workspace.json` 和 `schedule.json` 要在 DSH 关着的时候改**，运行时改会被内存里的旧名单覆盖
3. **多帧 zstd 不能整份解压**，要按 magic `28 B5 2F FD` 逐帧来
4. **ComfyUI 生成完要 `POST /free`** 才会释放显存，否则一直占着
5. **微信窗口按钮别用百分比坐标点**，换屏幕/换缩放就点空。用图像匹配（`wxui.py` 那套）
6. **纯文本 `@名字` 不是真 @**，对方收不到提醒。真 @ 要走弹层点选，需要 OCR

---

## 7. 隐私

这个仓库里没有、也不应该有：

- 任何 wxid、昵称、群号
- 任何聊天记录、日记、记忆
- 任何 API key、cookie、session
- 任何绝对路径里的用户名

`.gitignore` 里排除了这些。如果你 fork 了这份说明，记得把自己的配置当成秘密处理。

---

## 许可证

本仓库的代码（`dsh-*` 那几个自己写的插件、工具脚本、文档）用 MIT。

`patches/` 里改动的原包也是 MIT，版权归原作者，我们只保留了声明并注明改动。
