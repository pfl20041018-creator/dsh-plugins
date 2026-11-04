# dsh-tool-shelf

把「用得少但必须有」的工具从模型眼前收起来，放进一个架子；需要的时候一句话取下来。

你的 profile 装得越热闹，tool schema 就越长——office 七八个、日程四五个、朋友圈六七个，加起来轻松上万 token，而且**每一次请求都要重付一遍**。这些工具一年用不了几次，却天天占着上下文。这个插件让它们在默认状态下不出现在工具列表里，只留一个 `tool_shelf` 小工具当目录。

## 效果

- 默认隐藏：`office_*`、`schedule_*`、`moments_*`、`workflow`（都可配）
- 模型看到的是一个目录，不是完整 schema
- 说一声「用一下工具架」就能取下来，取下来之后当场可用
- 被收起的工具**既不发 schema，也调不动**，不会被误调

## 机制

用 DSH 自己的 `tools.restrict({ deny })` 做，**不是**改 prompt、也不是拦截调用：

- 必须挂在 **agent 作用域**上（`agent.ctx.tools.restrict`），所以是按会话生效的：这个会话收了，别的会话不受影响。
- 监听 `agent/created` 覆盖新开的会话，`tools/change` 覆盖工具注册变化。
- agent 销毁，限制自动解除。

被收起的工具在 `wireSchemas()` 阶段就被过滤掉，所以是真的不占 token。

## 装

```bash
dsh plugin --profile desktop add github:pfl20041018-creator/dsh-plugins/dsh-tool-shelf
```

或者在本仓库根目录：

```bash
dsh plugin --profile desktop add ./dsh-tool-shelf
```

## 配置

```yaml
- insert:
    - id: tool-shelf
      name: "@pfl20041018-creator/dsh-tool-shelf"
      config:
        prefixes: [office_, schedule_, moments_]   # 按前缀归类
        exact: [workflow]                          # 精确点名
        alwaysVisible: []                          # 永不收起的工具
```

## 工具

### `tool_shelf`

| action | 作用 |
| --- | --- |
| `list` | 架子上有什么（名字 + 一句话摘要） |
| `load` | 把指定的取下来（`tools: ["office_write_docx"]`） |
| `unload` | 放回去 |
| `reset` | 全部恢复默认（全收起） |
| `cards` / `cards-off` | 见下 |

## 卡片开关（这个插件独有的一块）

DSH 的 `dsh-genui` 有一套很长的「怎么写出合法 schemaJson」的说明书，默认每请求都带，六万多字符。它其实自带运行时开关（`POST /api/dsh-genui/prompt {"enabled":false}`），只是没接出来。

本插件的 `cards` / `cards-off` 就是那个开关的把手：

- 平时关着，省下约 3.7 万 token/请求
- 真要出卡片、表单、图表时，`action: cards` 一句话打开，下一轮说明书就在系统提示里
- 用完 `cards-off` 收回，重启后仍是关的（状态存在 genui 的 settings 里）

## 限制（说清楚，别踩）

- `schedule_*`、`workflow` 这类是 **scope-local 注册**（每个会话/每个 agent 自己注册的），`tools.restrict` 明确不允许命名它们，所以默认配置里这几个**收不掉**，只能收全局注册的工具。
- 收起只影响「模型能看见、能调用」，不会停掉工具背后的 Cordis 插件或 MCP 进程。
- 假设你在用 DSH 的 agent 作用域模型；老版本没有 `agents` 服务时装不上。

## 许可

MIT
