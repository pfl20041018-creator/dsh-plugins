# dsh-plugins

给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）用的几个插件，围绕一件事：**让一个住在电脑里的助手，能真的跟人相处**——记得住、说得上话、看得见它的世界。

都是自己日用、慢慢磨出来的，代码不漂亮但踩过的坑都在里面。

## 插件

| 插件 | 一句话 | 备注 |
| --- | --- | --- |
| [dsh-tool-shelf](dsh-tool-shelf/) | 把用得少的工具收进架子，要用再取；顺带给 genui 的卡片说明书装个开关 | 省 token 的大头 |
| [dsh-memory-hub](dsh-memory-hub/) | 记忆总账：只读盘点本机所有记忆来源，跨源搜索，给一个「近况」摘要 | 只读，不写入 |
| [dsh-wx-ledger](dsh-wx-ledger/) | 微信发言闸门 + 外发账本：现在能不能说、今天主动过几次、哪条没确认 | 只读磁盘 |
| [dsh-wx-moments](dsh-wx-moments/) | 刷朋友圈：读动态、截图看内容、点赞、评论 | 需要 Windows 微信 |
| [dsh-wx-voice-out](dsh-wx-voice-out/) | 用自己的音色回微信语音条（GPT-SoVITS + 虚拟声卡） | 需要 VB-Cable、显卡 |

## 装

每个插件目录各自是一个独立的包，可以单独装：

```bash
# 从 GitHub 直接装（子目录）
dsh plugin --profile desktop add github:pfl20041018-creator/dsh-plugins/dsh-tool-shelf

# 或者 clone 下来从本地装
git clone https://github.com/pfl20041018-creator/dsh-plugins.git
dsh plugin --profile desktop add ./dsh-plugins/dsh-tool-shelf
```

`dsh-wx-*` 三个依赖一个能发消息的微信桥（例如 `dsh-wechat-bridge`）和本机登录着的 Windows 微信客户端，不依赖的那些功能会说明「不需要微信也能用」。

## 共同前提

- DSH `>= 0.2.0-rc`（用到 `agents` 服务与 agent 作用域的工具限制）
- Windows（`dsh-wx-*` 强依赖微信客户端；其余跨平台）

## 许可

MIT，各插件目录下各有 LICENSE。
