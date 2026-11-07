# dsh-world 补丁

## 原包

| 项 | 值 |
|---|---|
| 包名 | `dsh-world` |
| 原版本 | 0.7.1 |
| 许可证 | MIT |
| 上游仓库 | https://github.com/chenkezhen480/dsh-world |
| 原版权 | 归原作者所有，见本补丁附带的 MIT 许可证 |

本目录**只包含被修改过的文件**，不是完整包。使用前请先安装原包。

## 改动清单：让生活线只在周末跑

**动机**：world 生活线默认每个工作日都会醒一次、写日记、刷对话，token 花得不少。想改成只在周末运行（每周六周日各醒一次 + 各回顾一次），工作日照常不动。

### `lib/life/alarm.js`

- 原来的 `nextLocalTime(now, hhmm, timeZone)` 改名为 `nextLocalTimeOnce`（保留原语义）
- 新增导出 `localWeekday(at, timeZone)`：用 `formatLocalTime(...).slice(0, 10)` 拿到本地日期字符串，再用 `Date.UTC(y, m-1, d).getUTCDay()` 算星期几，**避免直接用 UTC 时间戳算导致跨时区差一天**
- 新增的 `nextLocalTime(now, hhmm, timeZone, options = {})` 支持 `options.weekdays: Set<number>`：如果算出来的那一天不在允许集合里，就继续往后找（带 21 次上限防死循环）
- `nextReview` / `reviewOf` 把 `options` 透传下去

### `lib/life/runtime.js`

- 新增常量 `const WEEKEND_DAYS = new Set([0, 6]);`
- 新增 `const scheduleGate = () => (options.schedule().weekendOnly === false ? {} : { weekdays: WEEKEND_DAYS });`
  —— **默认就是周末制**，想回到每日常规要在设置里显式写 `weekendOnly: false`
- 五个调用点加上这个 gate：`morning()`、`reviewOf(...)`、`nextLocalTime(new Date(state.alarm.setAt), ...)`、以及两处 `nextReview(...)`

### `lib/worldSwitch.js`

- settings 读取里加 `...(typeof stored?.weekendOnly === 'boolean' ? { weekendOnly: stored.weekendOnly } : {})`
- 新增 `weekendOnly: () => settings.weekendOnly !== false` 和 `setWeekendOnly(on)`（只有写 `false` 才落盘，默认即周末制）

### `lib/index.js`

- `schedule` 回调改成 `() => ({ review: power.reviewTime(), wake: power.wakeTime(), weekendOnly: power.weekendOnly() })`

## 实测结果

以周三 2026-11-04 09:00 为基准：

| 从哪算 | 下一次 |
|---|---|
| 日常 wake | 11-05（周四） |
| 周末 wake | **2026-11-07T00:00:00.000Z = 周六 08:00** |
| 周末 review | 2026-11-07T15:00:00.000Z（周六 23:00） |
| 周六 08:00 之后 | 周日 08:00 |
| 周日 23:00 回顾之后 | 下一个周六 |

即：周六、周日各醒一次、各回顾一次，共两天。

## 用法

把 `files/` 下的文件按相对路径覆盖：

```
files/lib/index.js            →  node_modules/dsh-world/lib/index.js
files/lib/worldSwitch.js      →  node_modules/dsh-world/lib/worldSwitch.js
files/lib/life/alarm.js       →  node_modules/dsh-world/lib/life/alarm.js
files/lib/life/runtime.js     →  node_modules/dsh-world/lib/life/runtime.js
```

覆盖后重启 DSH。

## 注意

- 覆盖前先 `node --check` 这四个文件，确认语法没问题
- 改完之后 world 的设置页里不会多出「只在周末」这个开关（没做 UI），要改回去就把 `world.json` 里加 `"weekendOnly": false`
- 这个补丁只测过 0.7.1，上游版本一变就可能冲突
