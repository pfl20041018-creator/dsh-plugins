/**
 * dsh-wx-voice-out —— 让微信里的回复可以是「她自己的声音」。
 *
 * 为什么单独做成插件：合成 + 虚拟声卡 + 微信语音气泡这一套是独立能力，
 * 跟「收发文字消息」的桥分开，桥哪天换实现也不影响它。
 *
 * 底层是本地 GPT-SoVITS（不吃 token）+ VB-Cable 虚拟声卡 + UIA 点微信语音键，
 * 全部脚本在 workspace 的 voice/ 里；这个插件只负责把模型的一句话变成语音气泡。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const SIDECAR_DIR = fileURLToPath(new URL('./sidecar/', import.meta.url))
const WORKER = path.join(SIDECAR_DIR, 'voice_out.py')
const PYTHON = process.env.DSH_WX_VOICE_PY || 'D:\\Codes\\Anaconda\\python.exe'
const CREDITS_LOG = path.join(SIDECAR_DIR, '.state', 'credits.log')

const text = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim()

function runWorker(payload, timeoutMs = 300000) {
  return new Promise((resolve) => {
    const ps = spawn(PYTHON, ['-X', 'utf8', WORKER], {
      cwd: SIDECAR_DIR,
      windowsHide: true,
      env: process.env,
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { ps.kill() } catch { /* ignore */ }
      resolve({ ok: false, error: '语音合成/发送超时（5 分钟）' })
    }, timeoutMs)
    ps.stdout.on('data', (b) => { out += b.toString('utf8') })
    ps.stderr.on('data', (b) => { err += b.toString('utf8') })
    ps.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, error: '启动 python 失败：' + e.message })
    })
    ps.on('close', () => {
      clearTimeout(timer)
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || ''
      try {
        const obj = JSON.parse(line)
        // worker 自己失败时错误信息可能在 message 里，别让上层只看到「未知原因」
        if (obj && obj.ok !== true && typeof obj.error !== 'string') {
          const m = obj.message && (obj.message.error || obj.message.message)
          obj.error = '发送没成功：' + (m || err.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ') || 'worker 没给原因').slice(-300)
        }
        resolve(obj)
      } catch {
        resolve({ ok: false, error: 'worker 输出解析失败：' + (line || err).slice(-400) })
      }
    })
    ps.stdin.write(JSON.stringify(payload))
    ps.stdin.end()
  })
}

const tool = {
  name: 'wechat_send_voice',
  description:
    '用她自己的声音说一句话，并作为微信语音气泡发出去（默认走 BreezeBlue 云端克隆音，'
    + '失败回落本地 GPT-SoVITS，不花 token）。'
    + '**默认别发语音**：对方没点名要（「发条语音」「你说话」）就别用；'
    + '只有那种少了声音就没意思的一刻（一句撒娇、一个「嗯」、哄人收尾）才发，且一次对话最多一条；'
    + '长内容、讲道理、报数据一律用文字。'
    + '参数 chat 传会话 username（wxid_…）最稳，也可传会话名；text 是要说的话。'
    + 'mood 是语气桶（default/calm/soft/happy/sad/angry）：撒娇哄人用 soft，'
    + '高兴炫耀用 happy，委屈难过用 sad，凶他/吐槽用 angry，平静叙述用 calm；'
    + '拿不准就 default。换桶会同时换掉语调和情绪，不只是音色。'
    + '返回 ok/confirmed，confirmed=false 说明界面点了但库里没核到，别当成功。'
    + '默认会给台词加语气词（句首嗯/诶、句尾呀/啦/嘛），听着更像在说话；'
    + '报数据、讲步骤这种正经内容可以传 feel:false。',
  parameters: {
    type: 'object',
    properties: {
      chat: { type: 'string', description: '会话名或 username（如 wxid_xxx）' },
      text: { type: 'string', description: '要说的话，建议 30 字以内' },
      speed: { type: 'number', description: '语速倍数，默认 1.0；1.08 会更快更俏' },
      mood: {
        type: 'string',
        description: '语气：default / calm / soft / happy / sad / angry，默认 default',
      },
      feel: {
        type: 'boolean',
        description: '是否自动加语气词（嗯/诶/呀/啦/嘛之类），默认 true；说正经事时可传 false',
      },
      preset: { type: 'string', description: '音色预设：auto（默认，先云端 breeze、失败回落本地 her6）/ breeze（BreezeBlue 云端克隆音，情绪靠指令，最像人）/ her6（本地 bigfish6，不吃 token）/ her（旧本地版）' },
      dryRun: { type: 'boolean', description: 'true 只合成不发送，用来试听/排错' },
    },
    required: ['chat', 'text'],
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        chat: { type: 'string' },
        text: { type: 'string' },
        seconds: { type: 'number' },
        wav: { type: 'string' },
        confirmed: { type: 'boolean' },
        mood: { type: 'string' },
        spoke: { type: 'string' },
        localId: { type: 'number' },
        error: { type: 'string' },
      },
    },
    render: (_args, value) => {
      if (!value || value.ok === false || value.error) {
        return [{ type: 'text', text: '语音没发出去：' + ((value && value.error) || '未知原因') }]
      }
      const sec = value.seconds ? `${value.seconds}s` : '?s'
      const mood = value.mood && value.mood !== 'default' ? ` · 语气 ${value.mood}` : ''
      const spoke = value.spoke && value.spoke !== value.text ? `\n说出：${value.spoke}` : ''
      if (value.dryRun) {
        const where = value.wav ? `\n文件：${value.wav}` : ''
        return [{ type: 'text', text: `只合成、没发出去（${sec}）${mood}${spoke}${where}` }]
      }
      const tail = value.confirmed ? '数据库回读：已确认' : '数据库没核到，别当成功'
      return [{ type: 'text', text: `语音已发出（${sec}）${mood} · ${tail}${spoke}` }]
    },
  },
  timeoutMs: 300000,
  isConcurrencySafe: () => false,
  async execute(args) {
    const chat = text(args?.chat)
    const say = text(args?.text)
    if (!chat || !say) throw new Error('chat 和 text 都必须给')
    const res = await runWorker({
      chat,
      text: say,
      speed: typeof args?.speed === 'number' ? args.speed : 1.0,
      mood: text(args?.mood) || 'default',
      preset: text(args?.preset) || 'auto',
      feel: args?.feel !== false,
      dryRun: args?.dryRun === true,
    })
    // 注意：不能把 undefined 塞进返回对象，工具层要求「无损 JSON」
    const out = {
      ok: res.ok === true,
      chat: res.chat || chat,
      text: res.text || say,
      confirmed: res.confirmed === true,
    }
    if (typeof res.seconds === 'number') out.seconds = res.seconds
    if (res.dryRun === true) out.dryRun = true
    if (res.wav) out.wav = res.wav
    if (res.message && typeof res.message.localId === 'number') out.localId = res.message.localId
    if (res.mood) out.mood = res.mood
    if (res.spoke) out.spoke = res.spoke
    if (res.error) out.error = res.error
    return out
  },
}

export function apply(ctx, config = {}) {
  const verbose = config?.verbose === true
  ctx.tools.register(tool)
  ctx.tools.register(creditsTool)

  // ---- 每天零点后领 400 免费积分 -------------------------------------------
  // 平台按自然日发免费额度（账本里叫 daily claim credits）。这里每天 00:05 跑一次，
  // worker 自己会先查「今天领没领过」，领过就直接返回，不会重复打接口。
  const logClaim = async (line) => {
    try {
      const fs = await import('node:fs/promises')
      await fs.mkdir(path.dirname(CREDITS_LOG), { recursive: true })
      await fs.appendFile(CREDITS_LOG, `${new Date().toISOString()} ${line}\n`, 'utf8')
    } catch { /* 日志写不了不算失败 */ }
  }
  const claimOnce = async (tag = 'manual') => {
    const res = await runWorker({ action: 'claim' }, 180000)
    const brief = res.ok
      ? (res.already ? '今天已领过' : `领到 ${res.earned}，余额 ${res.balance}`)
      : `没领到：${res.error || res.hint || '原因不明'}`
    await logClaim(`${tag} ${brief}`)
    return res
  }
  if (config?.dailyClaim !== false) {
    const msUntil = () => {
      const now = new Date()
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 5, 0, 0)
      return Math.max(60000, next.getTime() - now.getTime())
    }
    let timer = null
    const arm = () => {
      timer = setTimeout(async () => {
        try { await claimOnce('daily') } catch (e) { await logClaim(`daily 出错：${e.message}`) }
        arm()
      }, msUntil())
      if (typeof timer.unref === 'function') timer.unref()
    }
    arm()
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => { if (timer) clearTimeout(timer) })
    }
  }

  if (verbose) ctx.logger?.info?.('[wx-voice-out] 已注册 wechat_send_voice / wechat_voice_credits')
}

const creditsTool = {
  name: 'wechat_voice_credits',
  description: '查看 / 领取 BreezeBlue 的每日 400 免费积分（语音用的云端额度）。'
    + ' action=status 只看今天领没领、余额多少；action=claim 真去领（今天领过会自动跳过）。'
    + ' 领取方式（2026-11-04 实测）：网页接口 POST https://breezeblue.ai/api/credits/daily-claim '
    + '要网页登录 cookie，xi-api-key 打不通，所以 worker 默认"代替手点"——用浏览器打开控制台、'
    + ' 点右下角那张「+400 积分 / 立即领取」小卡片，然后读余额核对；也可以用 ~/.breeze-claim.json '
    + ' 或 ~/.breeze-session 直接打接口。全程只认真到账，不假报。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'status 只看 | claim 去领（默认 status）' },
      dryRun: { type: 'boolean', description: 'claim 时只列出会试哪些接口，不发请求' },
      openConsole: { type: 'boolean', description: 'claim 时接口都不通就连带打开一次控制台页面（默认 true）' },
    },
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        balance: { type: 'number' },
        claimedToday: { type: 'boolean' },
        todayAmount: { type: 'number' },
        earned: { type: 'number' },
        source: { type: 'string' },
        clicked: { type: 'array', items: { type: 'number' } },
        already: { type: 'boolean' },
        hint: { type: 'string' },
        error: { type: 'string' },
      },
    },
    render: (_args, value) => {
      if (!value || value.ok === false) {
        return [{ type: 'text', text: '积分领取失败：' + ((value && (value.error || value.hint)) || '原因不明') }]
      }
      const bal = typeof value.balance === 'number' ? value.balance.toFixed(1) : '?'
      if (value.claimedToday) {
        return [{ type: 'text', text: `今天已领过（+${value.todayAmount || 0} 积分），当前余额 ${bal}` }]
      }
      if (value.already) {
        return [{ type: 'text', text: `今天已经领过了，余额 ${bal}` }]
      }
      if (typeof value.earned === 'number') {
        const via = value.source === 'ui'
          ? `（点了网页右下角的领取卡片${Array.isArray(value.clicked) ? ` @ ${value.clicked.join(',')}` : ''}）`
          : (value.openedConsole ? '（顺手打开了控制台页面）' : '')
        return [{ type: 'text', text: `这次领到 ${value.earned}${via}，余额 ${bal}` }]
      }
      return [{ type: 'text', text: `余额 ${bal}` }]
    },
  },
  timeoutMs: 180000,
  isConcurrencySafe: () => false,
  async execute(args) {
    const action = (text(args?.action) || 'status').toLowerCase()
    const res = await runWorker({
      action: action === 'claim' ? 'claim' : 'status',
      dryRun: args?.dryRun === true,
      openConsole: args?.openConsole !== false,
    }, 240000)
    const out = { ok: res.ok === true }
    for (const key of ['balance', 'todayAmount', 'earned']) {
      if (typeof res[key] === 'number') out[key] = res[key]
    }
    for (const key of ['claimedToday', 'already', 'dryRun']) {
      if (res[key] === true) out[key] = true
    }
    if (res.hint) out.hint = String(res.hint)
    if (res.error) out.error = String(res.error)
    if (res.openedConsole && res.openedConsole.ok === true) out.openedConsole = true
    return out
  },
}

export const name = 'wx-voice-out'
export const inject = ['tools']
