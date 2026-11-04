# dsh-wx-voice-out

给 DeepSeek Harness 的微信桥加一条「用你自己的声音回语音条」的路。

文字写不出语气的时候——一句撒娇、一声「在呢」、被点名「发条语音听听」——这个插件把一句话合成成你自己的音色，再当成微信语音条发出去。

> 这是**发送端**。它假设你已经有一个能发消息的微信桥（例如 `dsh-wechat-bridge`），本插件只负责「合成 + 塞进语音气泡」。

## 它是怎么做到的（三层）

| 层 | 干什么 | 在哪 |
| --- | --- | --- |
| 合成 | GPT-SoVITS 本地推理，把文字变成指定音色 | `sidecar/voice_out.py` |
| 传输 | 音频播进 VB-Cable 虚拟声卡（不外放，系统默认录音设备指向 `CABLE Output`） | `sidecar/voice_out.py` |
| 发送 | 按住微信语音键 → 放音 → 松开 → 回读数据库确认 | 走微信桥的 UIA 发送 |

**不花 token**：合成跑在你自己的显卡上，插件只负责把一句话递进去。

## 工具

`wechat_send_voice`

| 参数 | 说明 |
| --- | --- |
| `chat` | 会话 username（最稳）或会话名 |
| `text` | 要说的话，建议 30 字以内 |
| `speed` | 语速倍数，默认 1.0 |
| `preset` | 音色预设，默认 `her`；多套音色可自行扩展 |
| `dryRun` | 只合成不发送，用来试听 / 排错 |

返回 `ok` / `seconds` / `confirmed`。**`confirmed=false` 表示界面点了但数据库没回读到**，不要当成发送成功。

## 前提（缺一个都会失败）

1. **VB-Cable** 已安装，且系统默认录音设备是 `CABLE Output`（装完记得能切回去）
2. 微信客户端在运行、已登录、屏幕没锁
3. 一个可用的 **GPT-SoVITS** 环境和一份你训练好的音色权重（`*.ckpt` + `*.pth`）
4. Python 环境里有 `sounddevice`、`Pillow` 等依赖

## 配置

在 `cordis.patch.yml` 里挂载：

```yaml
- insert:
    - id: wx-voice-out
      name: "@your-scope/dsh-wx-voice-out"
      config:
        pythonPath: ""        # 跑推理的 python，留空用 PATH 里的 python
        ttsScript: ""         # 合成脚本绝对路径
        playToCable: true     # 是否播进虚拟声卡
        maxSeconds: 60        # 微信语音上限，超了直接拒
```

## 已知限制

- 合成一次约 10–15 秒（每次都要加载模型），发送再 5–8 秒；**不适合当「每句话都发语音」的默认路径**
- 微信语音上限 60 秒，插件会拦
- 发送期间会抢一次焦点、把微信切到目标会话
- 屏幕锁着时 UIA 拿不到窗口，会如实报错而不是假装成功

## 许可

MIT
