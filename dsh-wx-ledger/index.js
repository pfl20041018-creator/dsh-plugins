// dsh-wx-ledger —— 微信「这口现在能不能说」的闸门，加上「已经说出去的话」的账本。
//
// 只读：不拉起 sidecar、不连微信、不发送任何东西。数据全部来自 wechat-bridge
// 留在磁盘上的状态目录：
//   autoreply.json  发言时段 / 回复节流分钟数 / 群规则 / 白名单 / 主人
//   proactive.json  主动开口的每日额度与最短间隔
//   outbox.jsonl    每一条真的发出去的话，带 ok / confirmed
//   quiet.log       空闲门控放过或拦下的那几次，带 idle / waited
// 所以微信桥自己挂了、微信没登录，这个插件照样答得上来。

import fs from 'node:fs'
import path from 'node:path'

export const name = 'wx-ledger'

export const inject = ['tools']

/* ------------------------------------------------------------------ 读盘 */

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function readJson(file) {
  const raw = readText(file)
  if (raw.trim() === '') return null
  try {
    const value = JSON.parse(raw)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function parseJsonLine(line) {
  try {
    const value = JSON.parse(line)
    return value !== null && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/**
 * outbox 是 JSONL。个别条目正文里带了裸换行，直接把行切开就解析不了；
 * 这里在失败后把后几行用「转义换行」拼回去再试，拼得回来就当一条，拼不回来只记坏行。
 */
function readJsonl(file) {
  const raw = readText(file)
  if (raw === '') return { rows: [], bad: 0, exists: false }
  const lines = raw.split(/\r?\n/)
  const rows = []
  let bad = 0
  let index = 0
  while (index < lines.length) {
    const head = lines[index].trim()
    if (head === '') {
      index += 1
      continue
    }
    const direct = parseJsonLine(head)
    if (direct !== null) {
      rows.push(direct)
      index += 1
      continue
    }
    let merged = head
    let recovered = false
    for (let next = index + 1; next < Math.min(lines.length, index + 6); next += 1) {
      merged = `${merged}\\n${lines[next].trim()}`
      const parsed = parseJsonLine(merged)
      if (parsed !== null) {
        rows.push(parsed)
        index = next + 1
        recovered = true
        break
      }
    }
    if (!recovered) {
      bad += 1
      index += 1
    }
  }
  return { rows, bad, exists: true }
}

/* ------------------------------------------------------------------ 时间 */

const pad2 = (value) => String(value).padStart(2, '0')

function dayKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function stamp(date) {
  return `${dayKey(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

/** outbox 里是本地时间字符串 "YYYY-MM-DD HH:mm:ss"，按本地时区还原。 */
function parseStamp(value) {
  if (typeof value !== 'string') return null
  const matched = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value)
  if (matched === null) return null
  const at = new Date(
    Number(matched[1]),
    Number(matched[2]) - 1,
    Number(matched[3]),
    Number(matched[4]),
    Number(matched[5]),
    matched[6] === undefined ? 0 : Number(matched[6]),
  )
  return Number.isNaN(at.getTime()) ? null : at
}

function minutesBetween(from, to) {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 60000))
}

function hhmmToMinutes(value) {
  const matched = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  return matched === null ? null : Number(matched[1]) * 60 + Number(matched[2])
}

function inActiveWindow(windowPair, now) {
  const start = Array.isArray(windowPair) ? hhmmToMinutes(windowPair[0]) : null
  const end = Array.isArray(windowPair) ? hhmmToMinutes(windowPair[1]) : null
  if (start === null || end === null) return true
  if (start === end) return true
  const current = now.getHours() * 60 + now.getMinutes()
  return start < end ? current >= start && current <= end : current >= start || current <= end
}

/* ------------------------------------------------------------------ 状态目录 */

const BRIDGE_STATE_FILES = ['autoreply.json', 'outbox.jsonl']

function stateDirCandidates(config) {
  const candidates = []
  const configured = typeof config?.stateDir === 'string' ? config.stateDir.trim() : ''
  if (configured !== '') candidates.push(configured)
  const fromEnv = typeof process.env.DSH_WX_BRIDGE_STATE === 'string' ? process.env.DSH_WX_BRIDGE_STATE.trim() : ''
  if (fromEnv !== '') candidates.push(fromEnv)
  const profileDir = typeof process.env.DSH_PROFILE_DIR === 'string' ? process.env.DSH_PROFILE_DIR.trim() : ''
  if (profileDir !== '') {
    candidates.push(path.join(profileDir, 'node_modules', '@local', 'dsh-wechat-bridge', 'sidecar', '.state'))
    candidates.push(path.join(profileDir, 'node_modules', 'dsh-wechat-bridge', 'sidecar', '.state'))
  }
  candidates.push(path.join('D:', 'AI', 'DSH', 'plugins', 'dsh-wechat-bridge', 'sidecar', '.state'))
  return candidates
}

function resolveStateDir(config) {
  for (const dir of stateDirCandidates(config)) {
    if (dir === '') continue
    try {
      if (!fs.existsSync(dir)) continue
      if (!fs.statSync(dir).isDirectory()) continue
      // 目录存在但一个状态文件都没有，说明找错了地方，继续往下试。
      if (!BRIDGE_STATE_FILES.some((file) => fs.existsSync(path.join(dir, file)))) continue
      return dir
    } catch {
      // 权限/断链之类，换下一个候选
    }
  }
  return ''
}

function requireStateDir(config) {
  const dir = resolveStateDir(config)
  if (dir === '') {
    throw new Error(
      '找不到微信桥的状态目录。可以在插件配置里给 stateDir，或设环境变量 DSH_WX_BRIDGE_STATE，' +
        '指向 dsh-wechat-bridge/sidecar/.state。',
    )
  }
  return dir
}

/* ------------------------------------------------------------------ 投影 */

function asText(lines) {
  return [{ type: 'text', text: lines.join('\n') }]
}

function projectEntry(raw, knownNames) {
  const username = typeof raw.username === 'string' ? raw.username : ''
  const at = typeof raw.at === 'string' ? raw.at : ''
  const when = parseStamp(at)
  const declared = typeof raw.name === 'string' && raw.name !== '' ? raw.name : ''
  const fallback = typeof knownNames[username] === 'string' ? knownNames[username] : ''
  return {
    at,
    when,
    day: when === null ? '' : dayKey(when),
    username,
    name: declared !== '' ? declared : fallback !== '' ? fallback : username,
    text: typeof raw.text === 'string' ? raw.text.replace(/\s+/gu, ' ').trim() : '',
    ok: raw.ok !== false,
    confirmed: raw.confirmed !== false,
    proactive: raw.proactive === true,
  }
}

function matchesChat(entry, wanted) {
  if (wanted === '') return true
  return (
    entry.username.toLowerCase().includes(wanted) ||
    entry.name.toLowerCase().includes(wanted)
  )
}

function readGateContext(config) {
  const dir = requireStateDir(config)
  const autoreply = readJson(path.join(dir, 'autoreply.json')) ?? {}
  const proactive = readJson(path.join(dir, 'proactive.json')) ?? {}
  const knownNames =
    autoreply.knownNames !== null && typeof autoreply.knownNames === 'object' ? autoreply.knownNames : {}
  const { rows, bad } = readJsonl(path.join(dir, 'outbox.jsonl'))
  const entries = rows
    .map((raw) => projectEntry(raw, knownNames))
    .filter((entry) => entry.at !== '')
  return { dir, autoreply, proactive, entries, badLines: bad }
}

/* ------------------------------------------------------------------ 插件 */

export function apply(ctx, config = {}) {
  ctx.tools.register({
    name: 'wx_gate',
    description:
      '看微信自动回复的闸门现在是什么状态：在不在发言时段、距离上次外发够没够节流分钟数、' +
      '主动开口的每日额度还剩多少、空闲门控怎么等、最近有没有被门控拦下来的发言。' +
      '准备回一条微信、或者想知道「我现在能不能主动找 ta」的时候先看这个。只读磁盘，不连微信、不发送。',
    parameters: {
      type: 'object',
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          now: { type: 'string' },
          enabled: { type: 'boolean' },
          inWindow: { type: 'boolean' },
          activeWindow: { type: 'string' },
          replyGapMinutes: { type: 'integer' },
          minutesSinceLastSend: { type: 'integer' },
          minutesUntilNextReply: { type: 'integer' },
          allowed: { type: 'boolean' },
          groupMode: { type: 'string' },
          whitelistMode: { type: 'string' },
          selfNames: { type: 'array', items: { type: 'string' } },
          ownerName: { type: 'string' },
          quiet: { type: 'object' },
          proactive: { type: 'object' },
          recentGates: { type: 'array', items: { type: 'object' } },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const window = value.activeWindow === '' ? '未配置' : value.activeWindow
        const lines = [
          `现在 ${value.now} · 自动回复：${value.enabled ? '开' : '关'} · 发言时段 ${window}（${
            value.inWindow ? '在时段内' : '不在时段内'
          }）`,
        ]
        if (value.minutesSinceLastSend < 0) {
          lines.push(`节流：账本里还没有外发记录，没有 ${value.replyGapMinutes} 分钟间隔的限制`)
        } else if (value.minutesUntilNextReply > 0) {
          lines.push(
            `节流：距上一条外发 ${value.minutesSinceLastSend} 分钟，还要再等 ${value.minutesUntilNextReply} 分钟才轮到下一句`,
          )
        } else {
          lines.push(`节流：距上一条外发 ${value.minutesSinceLastSend} 分钟，已经过 ${value.replyGapMinutes} 分钟门槛`)
        }
        const proactive = value.proactive
        if (proactive.enabled === true) {
          lines.push(
            `主动开口：额度 ${proactive.dailyCap} 条/天，两条之间至少隔 ${proactive.minMinutesBetween} 分钟；` +
              `今天全部外发 ${proactive.todaySent} 条（含回别人消息，不等于主动开口数，只能当上限参考）`,
          )
          if (proactive.quietHours !== '') lines.push(`主动开口的安静时段：${proactive.quietHours}`)
        } else {
          lines.push('主动开口：关。不要自己开口，只在别人说话后回。')
        }
        if (value.quiet.enabled === true) {
          lines.push(
            `空闲门控：电脑空闲 ${value.quiet.idleSeconds} 秒后才发，最多等 ${value.quiet.maxWaitSeconds} 秒；` +
              `拟人延迟 ${value.quiet.replyDelaySeconds} 秒`,
          )
        } else {
          lines.push('空闲门控：关（发送会直接抢焦点）')
        }
        lines.push(
          `群：${value.groupMode} · 白名单：${value.whitelistMode} · 自称：${
            value.selfNames.length > 0 ? value.selfNames.join('/') : '未配置'
          } · 主人：${value.ownerName === '' ? '未配置' : value.ownerName}`,
        )
        if (value.recentGates.length > 0) {
          lines.push('最近的门控记录：')
          for (const gate of value.recentGates) {
            lines.push(`  ${gate.at} ${gate.decision} idle=${gate.idleSeconds}s waited=${gate.waitedSeconds}s ${gate.text}`)
          }
        }
        lines.push(value.note)
        return asText(lines)
      },
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    async execute() {
      const now = new Date()
      const { dir, autoreply, proactive, entries } = readGateContext(config)
      const gapMinutes = Number.isFinite(Number(autoreply.minMinutesBetweenReplies))
        ? Math.max(0, Math.trunc(Number(autoreply.minMinutesBetweenReplies)))
        : 0
      const sent = entries.filter((entry) => entry.when !== null && entry.when.getTime() <= now.getTime())
      const lastSend = sent.length === 0 ? null : sent[sent.length - 1].when
      const minutesSinceLastSend = lastSend === null ? -1 : minutesBetween(lastSend, now)
      const minutesUntilNextReply = minutesSinceLastSend < 0 ? 0 : Math.max(0, gapMinutes - minutesSinceLastSend)
      const inWindow = inActiveWindow(autoreply.activeWindow, now)
      const enabled = autoreply.enabled !== false
      const allowed = enabled && inWindow && minutesUntilNextReply === 0
      const today = dayKey(now)
      const todaySent = entries.filter((entry) => entry.day === today).length
      const quiet = autoreply.quiet !== null && typeof autoreply.quiet === 'object' ? autoreply.quiet : {}
      const delay = Array.isArray(quiet.replyDelaySeconds) ? quiet.replyDelaySeconds : []
      const proactiveEnabled = proactive.enabled === true
      const recentGates = readText(path.join(dir, 'quiet.log'))
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '')
        .slice(-3)
        .map((line) => {
          const parts = line.split('\t')
          const idle = /idle=(\d+)s/.exec(line)
          const waited = /waited=(\d+)s/.exec(line)
          return {
            at: (parts[0] ?? '').slice(11, 19),
            decision: parts[3] === 'send' ? '放行' : '拦下',
            idleSeconds: idle === null ? 0 : Number(idle[1]),
            waitedSeconds: waited === null ? 0 : Number(waited[1]),
            text: (parts[4] ?? '').slice(0, 60),
          }
        })
        .reverse()
      return {
        now: stamp(now),
        enabled,
        inWindow,
        activeWindow: Array.isArray(autoreply.activeWindow) ? autoreply.activeWindow.join('-') : '',
        replyGapMinutes: gapMinutes,
        minutesSinceLastSend,
        minutesUntilNextReply,
        allowed,
        groupMode: typeof autoreply.groupMode === 'string' ? autoreply.groupMode : 'at-only',
        whitelistMode: typeof autoreply.whitelistMode === 'string' ? autoreply.whitelistMode : 'all',
        selfNames: Array.isArray(autoreply.selfAliases) ? autoreply.selfAliases.map((name) => String(name)) : [],
        ownerName:
          autoreply.owner !== null && typeof autoreply.owner === 'object' && typeof autoreply.owner.name === 'string'
            ? autoreply.owner.name
            : '',
        quiet: {
          enabled: quiet.enabled === true,
          idleSeconds: Number.isFinite(Number(quiet.idleSeconds)) ? Number(quiet.idleSeconds) : 0,
          maxWaitSeconds: Number.isFinite(Number(quiet.maxWaitSeconds)) ? Number(quiet.maxWaitSeconds) : 0,
          replyDelaySeconds: delay.length === 2 ? `${delay[0]}-${delay[1]}` : '',
        },
        proactive: {
          enabled: proactiveEnabled,
          dailyCap: Number.isFinite(Number(proactive.dailyCap)) ? Number(proactive.dailyCap) : 0,
          minMinutesBetween: Number.isFinite(Number(proactive.minMinutesBetween))
            ? Number(proactive.minMinutesBetween)
            : 0,
          todaySent,
          minutesSinceLastSend,
          quietHours: Array.isArray(proactive.quietHours) ? proactive.quietHours.join('-') : '',
        },
        recentGates,
        note:
          allowed
            ? '闸门结论：现在可以回/可以说。'
            : `闸门结论：${
                !enabled ? '自动回复是关的' : !inWindow ? '不在发言时段内' : `还要等 ${minutesUntilNextReply} 分钟`
              }——别硬发。`,
      }
    },
  })

  ctx.tools.register({
    name: 'wx_outbox',
    description:
      '翻微信桥的发送账本：每一条真的发出去的话（时间、发给谁、正文、ok、confirmed）。' +
      '用来回答「我今天回了谁」「上次跟 ta 说话是什么时候」「哪几条点发送了库里却没确认」这类问题——' +
      'confirmed=false 的条目是没在微信数据库里核到的，可能需要补一句或人工看一眼。只读，不发送。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '最多返回几条（默认 15，最大 200）' },
        chat: { type: 'string', description: '只看某个会话：昵称或 wxid 的一部分' },
        onlyFailed: { type: 'boolean', description: '只看 ok 或 confirmed 不为真的条目' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          stateDir: { type: 'string' },
          total: { type: 'integer' },
          todayCount: { type: 'integer' },
          failedCount: { type: 'integer' },
          badLines: { type: 'integer' },
          rows: { type: 'array', items: { type: 'object' } },
        },
      },
      render: (_args, value) => {
        const lines = [
          `账本：共 ${value.total} 条，今天 ${value.todayCount} 条，未确认 ${value.failedCount} 条` +
            (value.badLines > 0 ? `（另有 ${value.badLines} 行读不懂，已跳过）` : ''),
        ]
        if (value.rows.length === 0) {
          lines.push('没有匹配的记录。')
          return asText(lines)
        }
        for (const row of value.rows) {
          const mark = row.ok && row.confirmed ? '✓' : '✗未确认'
          lines.push(`  ${row.at.slice(5, 16)} ${row.name} ${mark} ${row.text.slice(0, 60)}`)
        }
        return asText(lines)
      },
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    async execute(args = {}) {
      const { dir, entries, badLines } = readGateContext(config)
      const rawLimit = Number.isFinite(Number(args.limit)) ? Math.trunc(Number(args.limit)) : 15
      const limit = Math.min(200, Math.max(1, rawLimit))
      const wanted = typeof args.chat === 'string' ? args.chat.trim().toLowerCase() : ''
      const onlyFailed = args.onlyFailed === true
      const today = dayKey(new Date())
      const selected = entries.filter(
        (entry) => matchesChat(entry, wanted) && (!onlyFailed || !entry.ok || !entry.confirmed),
      )
      const rows = selected
        .slice(-limit)
        .reverse()
        .map((entry) => ({
          at: entry.at,
          name: entry.name,
          username: entry.username,
          text: entry.text.slice(0, 160),
          ok: entry.ok,
          confirmed: entry.confirmed,
        }))
      return {
        stateDir: dir,
        total: entries.length,
        todayCount: entries.filter((entry) => entry.day === today).length,
        failedCount: entries.filter((entry) => !entry.ok || !entry.confirmed).length,
        badLines,
        rows,
      }
    },
  })

  ctx.tools.register({
    name: 'proactive_gate',
    description:
      '主动找某人说话之前必须先问的闸门：现在在不在允许主动开口的时段（默认 07:00-22:00）、' +
      '今天对这个人已经主动开口过几次（每人每天上限 3 次）、距上次主动找 ta 隔了够不够久、' +
      '最近跟 ta 说过的几句话（避免重复）。' +
      '**不传 chat 或传 auto 时，它会自己从最近聊过的人里挑一个今天还没被主动找过的**（每人单独算额度，' +
      '不会只盯着主人一个），返回里带 candidates。allowed=false 就不许开口，理由写在 reason 里。' +
      '只读账本，不连微信、不发送。主动开口时记得 wechat_send 带 proactive:true，' +
      '这样才会记进「今天对 ta 几次」里。',
    parameters: {
      type: 'object',
      properties: {
        chat: {
          type: 'string',
          description: '对谁开口：昵称或 wxid 的一部分；传 auto 或不传＝让闸门自己挑一个最该找的人',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          allowed: { type: 'boolean' },
          reason: { type: 'string' },
          now: { type: 'string' },
          window: { type: 'string' },
          inWindow: { type: 'boolean' },
          targetName: { type: 'string' },
          targetUsername: { type: 'string' },
          dailyCap: { type: 'integer' },
          todayProactive: { type: 'integer' },
          remaining: { type: 'integer' },
          minGapMinutes: { type: 'integer' },
          minutesSinceLastProactive: { type: 'integer' },
          minutesSinceLastToChat: { type: 'integer' },
          lastTexts: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const lines = [
          `现在 ${value.now} · 主动开口时段 ${value.window}（${value.inWindow ? '在时段内' : '不在时段内'}）`,
          `对象：${value.targetName === '' ? '（账本里没有这个人）' : value.targetName}`,
          `今天对 ta 主动开口 ${value.todayProactive} 次 / 上限 ${value.dailyCap} 次，还剩 ${value.remaining} 次`,
          value.minutesSinceLastProactive < 0
            ? `距上次主动找 ta：今天还没有过（两次之间至少要隔 ${value.minGapMinutes} 分钟）`
            : `距上次主动找 ta ${value.minutesSinceLastProactive} 分钟（两次之间至少要隔 ${value.minGapMinutes} 分钟）`,
          value.minutesSinceLastToChat < 0
            ? '账本里还没有跟 ta 的发送记录'
            : `距上次（不管是不是主动）跟 ta 说话 ${value.minutesSinceLastToChat} 分钟`,
        ]
        if (value.lastTexts.length > 0) {
          lines.push('最近跟 ta 说过的话（别重复）：')
          for (const text of value.lastTexts) lines.push(`  ${text}`)
        }
        lines.push(
          value.allowed
            ? `闸门结论：可以开口。${value.note}`
            : `闸门结论：别开口——${value.reason}。`,
        )
        return asText(lines)
      },
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    async execute(args = {}) {
      const now = new Date()
      const { autoreply, proactive, entries } = readGateContext(config)
      const spec =
        Array.isArray(proactive.proactiveWindow) && proactive.proactiveWindow.length === 2
          ? proactive.proactiveWindow.map((part) => String(part))
          : ['07:00', '22:00']
      const cap = Number.isFinite(Number(proactive.dailyCapPerPerson))
        ? Math.max(1, Math.trunc(Number(proactive.dailyCapPerPerson)))
        : 3
      const minGap = Number.isFinite(Number(proactive.proactiveMinGapMinutes))
        ? Math.max(0, Math.trunc(Number(proactive.proactiveMinGapMinutes)))
        : 120
      const ownerName =
        autoreply.owner !== null && typeof autoreply.owner === 'object' && typeof autoreply.owner.name === 'string'
          ? autoreply.owner.name
          : ''
      const today = dayKey(now)
      const inWindow = inActiveWindow(spec, now)

      // 每个人单独评估：同一个人一天最多 cap 次，间隔够久，且刚说过话别追
      const evaluate = (username) => {
        const wanted = String(username).toLowerCase()
        const mine = entries.filter((entry) => matchesChat(entry, wanted))
        const last = mine.length === 0 ? null : mine[mine.length - 1]
        const landed = mine.filter((entry) => entry.proactive && entry.ok)
        const lastProactive = landed.slice(-1)[0] ?? null
        const todayProactive = landed.filter((entry) => entry.day === today).length
        const minutesSinceLastProactive = lastProactive === null ? -1 : minutesBetween(lastProactive.when, now)
        const minutesSinceLastToChat = last === null ? -1 : minutesBetween(last.when, now)
        const remaining = Math.max(0, cap - todayProactive)
        let reason = 'ok'
        if (remaining === 0) reason = `今天对 ta 已经开口 ${todayProactive} 次，到上限 ${cap} 次了`
        else if (minutesSinceLastProactive >= 0 && minutesSinceLastProactive < minGap)
          reason = `距上次主动找 ta 才 ${minutesSinceLastProactive} 分钟，至少隔 ${minGap} 分钟`
        else if (minutesSinceLastToChat >= 0 && minutesSinceLastToChat < 5) reason = '刚跟 ta 说过话，别连着追'
        return {
          username,
          name: last === null ? nameOf(username) : last.name,
          last,
          todayProactive,
          remaining,
          minutesSinceLastProactive,
          minutesSinceLastToChat,
          eligible: reason === 'ok',
          reason,
        }
      }

      const nameOf = (username) => {
        const found = entries.find((entry) => String(entry.username).toLowerCase() === String(username).toLowerCase())
        return found ? String(found.name || found.username) : String(username)
      }

      // 候选池：最近聊过、不是文件传输助手、不是群
      const known = new Map()
      for (const entry of entries) {
        const username = String(entry.username || '')
        if (!username || username === 'filehelper' || username.endsWith('@chatroom')) continue
        if (!known.has(username)) known.set(username, { count: 0, lastAt: entry.when || null })
        const row = known.get(username)
        row.count += 1
        row.lastAt = entry.when || row.lastAt
      }

      const wantedRaw = typeof args.chat === 'string' ? args.chat.trim() : ''
      const auto = wantedRaw === '' || wantedRaw.toLowerCase() === 'auto'
      let target
      let candidates = []
      if (auto) {
        const rows = [...known.keys()].map((username) => evaluate(username))
        candidates = rows
          .sort((a, b) => {
            // 先看今天被主动找得少的（把额度摊开），再看最久没联系的
            if (a.todayProactive !== b.todayProactive) return a.todayProactive - b.todayProactive
            return (b.minutesSinceLastToChat || 0) - (a.minutesSinceLastToChat || 0)
          })
          .slice(0, 5)
        target = candidates.find((row) => row.eligible) || candidates[0] || evaluate(ownerName)
      } else {
        target = evaluate(wantedRaw.toLowerCase())
        candidates = [target]
      }

      const { last, todayProactive, remaining, minutesSinceLastProactive, minutesSinceLastToChat } = target
      const mine = entries.filter((entry) => matchesChat(entry, String(target.username).toLowerCase()))
      const ownerFallback = target.name === '' ? ownerName : target.name

      let allowed = true
      let reason = target.reason
      if (proactive.enabled !== true) {
        allowed = false
        reason = '主动开口是关的（proactive.json 里 enabled 不是 true）'
      } else if (!inWindow) {
        allowed = false
        reason = `现在不在主动开口时段（${spec[0]}-${spec[1]}）`
      } else if (!target.eligible) {
        allowed = false
      }

      return {
        allowed,
        reason,
        now: stamp(now),
        window: `${spec[0]}-${spec[1]}`,
        inWindow,
        targetName: ownerFallback,
        targetUsername: target.username || '',
        dailyCap: cap,
        todayProactive,
        remaining,
        minGapMinutes: minGap,
        minutesSinceLastProactive,
        minutesSinceLastToChat,
        candidates: candidates.map((row) => ({
          name: row.name,
          username: row.username,
          todayProactive: row.todayProactive,
          remaining: row.remaining,
          minutesSinceLastToChat: row.minutesSinceLastToChat,
          eligible: row.eligible,
          reason: row.reason,
        })),
        lastTexts: mine
          .slice(-3)
          .reverse()
          .map((entry) => `${entry.at.slice(5, 16)} ${entry.text.slice(0, 80)}`),
        note:
          '开口要短、要具体：从记忆里挑一件和 ta 有关的小事，别问「在吗」，也别重复上面说过的话。' +
          '每人单独算额度——今天可以找不同的人，不必都堆在主人身上。',
      }
    },
  })
}
