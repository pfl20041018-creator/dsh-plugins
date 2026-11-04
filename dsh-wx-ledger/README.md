# dsh-wx-ledger

微信「这口现在能不能说」的闸门，加「已经说出去的话」的账本。**只读磁盘，不连微信、不发送。**

## 为什么单独拆出来

微信桥（`dsh-wechat-bridge`）负责读库和真的把字敲进微信窗口；它同时也知道一堆「说话的分寸」——
发言时段、回复间隔、主动开口额度、空闲门控——但这些信息只活在它的 sidecar 里，模型的工具面只有
`wechat_inbox` 一次性的闸门字段，发出去的话也没有地方回看。这个插件把这几件事搬到独立的一层：

- 不依赖 sidecar 活着：微信没开、桥没起，账本照样能读。
- 只读：不写状态、不点发送，永远不会因为查一眼而打断自动回复。
- 一个事实只从磁盘读一遍，不在模型上下文里猜。

## 工具

### `wx_gate`

现在这一刻的闸门状态：自动回复开没开、在不在发言时段、距离上一条外发够不够
`minMinutesBetweenReplies` 分钟、主动开口的每日额度（`proactive.json` 的 `dailyCap`）今天用了几条、
空闲门控怎么等（`idleSeconds` / `maxWaitSeconds`）、拟人延迟多少秒、群规则（`at-only`）、白名单、自称。

外加 `quiet.log` 里最近三条「放过 / 拦下」的记录——能看出上一次被门控挡住是因为什么。

结论行会直接说：**现在可以回 / 还要等 N 分钟 / 不在时段内 / 自动回复是关的**。

### `wx_outbox`

发送账本（`outbox.jsonl`）的查询面：

| 参数 | 作用 |
| --- | --- |
| `limit` | 返回几条，默认 15，最大 200 |
| `chat` | 只看某个会话（昵称或 wxid 的一部分） |
| `onlyFailed` | 只看 `ok` / `confirmed` 不为真的条目 |

返回每条的时间、会话名、wxid、正文、`ok`、`confirmed`。`confirmed=false` 意思是「界面上点了发送，
但回读本地数据库没确认」——这类条目在流水里很容易被埋掉，值得专门捞出来补一句或者人工看一眼。

## 数据来源

默认按顺序找状态目录：

1. 插件配置 `stateDir`
2. 环境变量 `DSH_WX_BRIDGE_STATE`
3. `$DSH_PROFILE_DIR/node_modules/dsh-wechat-bridge/sidecar/.state`
4. `D:/AI/DSH/plugins/dsh-wechat-bridge/sidecar/.state`

目录里读四个文件：`autoreply.json`、`proactive.json`、`outbox.jsonl`、`quiet.log`。全部按只读打开，
文件缺了/坏了就当空值处理，不会抛错也不会改文件。

## 已知取舍

- **主动开口额度是保守估计**：`outbox.jsonl` 没有记「这一条是不是主动开口」，所以「今天用了几条」
  用的是今天全部外发条数，会偏高。真要用时可以配合 `proactive.json` 的 `dailyCap` 自己判断。
- `quiet.log` 只留最近若干条（桥自己不轮转），历史被覆盖就看不到了。
- 时间是本地时间字符串，按本机时区解析。
