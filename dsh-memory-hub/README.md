# dsh-memory-hub｜记忆总账（只读）

这台机器上的「记忆」并不在一处。它散在人设卡、事实卡、心情、会话原文、压缩缓存、
微信账本、鲸鱼日记、表情库、用量账本、定时任务里。本插件**不接管任何一处写入**，
只做两件事：

1. `memory_hub` —— 一次列出所有来源（路径、体量、条数），回答「我到底记得什么」。
2. `memory_hub_search` —— 按关键词跨源查（事实卡 → 鲸鱼日记 → 微信账本 → 会话原文），
   返回命中来源 + 片段；带 `scope` 参数可限制只搜某一路会话原文，避免把别人的话带进当前话题。

## 为什么是只读

多套写入同时存在时，最危险的是「两个管家各记一本、互相覆盖」。
所以这里**没有任何 writeFile / appendFile / rm**：看到的是现状，不会改动任何人。
要改记忆，仍走各自的写入方（`remember`、soul 卡、鲸鱼日记等）。

## 工具

### memory_hub

无参数。返回十个来源的总账：

| 来源 | 实际位置 |
| --- | --- |
| 人设卡 | `profiles/desktop/cordis.patch.yml`（soul-md 条目） |
| 事实卡 | `~/.dsh/fish-memory/session-*.json` |
| 心情 | `~/.dsh/feiyu-mood/state.json` |
| 会话原文 | `~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd` |
| 压缩缓存 | `~/.dsh/storages/session_projcache/` |
| 微信账本 | `plugins/dsh-wechat-bridge/sidecar/.state/` |
| 鲸鱼日记 | `bili-whale/state/` |
| 表情库 | `node_modules/dsh-meme/memes/` |
| 用量账本 | `~/.dsh/.dshw-usage.json` |
| 定时任务 | `~/.dsh/storages/schedule.json` |

### memory_hub_search

| 参数 | 说明 |
| --- | --- |
| `query` | 关键词或一句话（必填） |
| `limit` | 最多几条，默认 12，上限 40 |
| `scope` | `all`（默认）或会话目录关键词（如 `chats-<name>`），只影响「会话原文」这一路 |

搜索顺序：事实卡 → 鲸鱼日记 → 微信账本 → 会话原文。前一路够数就不往后翻，
所以「聊天时想不起某件事」这种问题通常一秒出结果；会话原文那一路需要解压，
只取每个会话最后 3000 行。

## 限制

- 会话原文是 zstd 压缩的 JSONL，解压依赖本机 `zstd.exe`（默认 `D:\Codes\Anaconda\Library\bin\zstd.exe`）；找不到就跳过这一路，不报错。
- 只搜最近 6 个会话文件，且每个只翻尾部 3000 行——久远的内容要翻，去用 `decompress`。
- 图片、语音文件本身不做内容检索（那要走视觉/转写工具）。
- 不提供「合并/迁移/删除」能力，这是刻意的。
