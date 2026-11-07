# dsh-bili-whale 补丁

## 原包

| 项 | 值 |
|---|---|
| 包名 | `dsh-bili-whale` |
| 原版本 | 0.4.6 |
| 许可证 | MIT |
| 来源 | npm 包（作者未在 package.json 里声明 repository） |
| 原版权 | 归原作者所有，见本补丁附带的 MIT 许可证 |

本目录**只包含被修改过的文件**，不是完整包。使用前请先安装原包。

## 改动清单

### 1. `tools/lib/dm-history.mjs` — 空收件箱被误判成失败

**现象**：每 15 分钟报一次 `私信历史读取失败，保留游标（code=0）`，退避到 15 分钟后永久停摆，B 站私信再也收不到。

**原因**：B 站私信接口在没有消息时返回

```json
{"code":0,"data":{"messages":null,"has_more":0,"min_seqno":18446744073709551615,"max_seqno":0}}
```

`messages` 是 `null` 而不是 `[]`，而原代码用 `!Array.isArray(body.data?.messages)` 判断，把「合法的空收件箱」当成了结构异常。

**改法**：先把 null / undefined 归一成空数组，只有「既不是数组也不是 null」才报结构异常。

### 2. `lib/session-delivery.js` — 重复建会话导致日志冲突

**现象**：日志里反复出现

```
refusing to materialize "bili-whale": a log already exists on disk (open it instead)
```

**原因**：原代码在投递时无条件 `controller.create({ sessionId, cwd })`。当这个会话已经有内容时，DSH 的 session log 层会走 materialize 流程，发现目录里已有 log 就抛错。

**改法**：先 `controller.inspect(id)` 判断会话是否存在，存在就跳过 create，直接让 prompt 走 resume；只有需要轮换（`rotating`）时才 create。

### 3. `lib/index.js` — WORK_DIR 回退值导致 cwd 分叉

**现象**：会话被建到 `...\bili-whale\state\whale-work\` 而不是配置里写的 `...\bili-whale\work\`，日记和唤醒都对不上。

**原因**：`const WORK_DIR = path.join(DSH_HOME, 'whale-work')` 是回退值。当配置里的 `home` 校验失败时（例如 config 文件带了 BOM 导致解析失败），就会静默落到这个目录。

**改法**：回退值改成 `path.join(DSH_HOME, '..', 'work')`。

## 用法

把 `files/` 下的文件按**相对路径**覆盖到原包对应位置：

```
files/tools/lib/dm-history.mjs  →  node_modules/dsh-bili-whale/tools/lib/dm-history.mjs
files/lib/session-delivery.js   →  node_modules/dsh-bili-whale/lib/session-delivery.js
files/lib/index.js              →  node_modules/dsh-bili-whale/lib/index.js
```

覆盖后重启 DSH。

## 提醒

改动 1 才是真正的修复；改动 2、3 是针对我们这台机器上实际症状的加固，不是所有人都需要。只想要「私信不再停摆」的话，只覆盖 `dm-history.mjs` 就够了。
