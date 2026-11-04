/**
 * tool-shelf — keep rarely used tools out of the model prompt.
 *
 * Every tool definition costs prompt tokens on every request. Office, schedule
 * and moments tools are genuinely useful but are used a handful of times a
 * day, so their schemas are hidden by default. One small `tool_shelf` tool
 * lists what is on the shelf and loads a tool back for the rest of the
 * process lifetime.
 *
 * Hiding is per agent (`agent.ctx.tools.restrict`), because a context-global
 * restriction is rejected by the registry: every live agent and every agent
 * created later gets the same deny mask.
 */
export const name = 'tool-shelf'

export const inject = ['tools', 'agents']

const DEFAULTS = {
  prefixes: ['office_', 'schedule_', 'moments_'],
  exact: ['workflow'],
  alwaysVisible: [],
}

const MAX_SUMMARY = 90

function summarize(description) {
  const text = String(description || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const cut = text.search(/[。；;.!?！？]/)
  const first = cut > 0 ? text.slice(0, cut) : text
  return first.length > MAX_SUMMARY ? first.slice(0, MAX_SUMMARY) + '…' : first
}

export function apply(ctx, config = {}) {
  const raw = config && typeof config === 'object' ? config : {}
  const prefixes = Array.isArray(raw.prefixes) && raw.prefixes.length
    ? raw.prefixes.map(String)
    : DEFAULTS.prefixes
  const exact = new Set(Array.isArray(raw.exact) ? raw.exact.map(String) : DEFAULTS.exact)
  const alwaysVisible = new Set(
    Array.isArray(raw.alwaysVisible) ? raw.alwaysVisible.map(String) : DEFAULTS.alwaysVisible,
  )

  /** tools explicitly revealed in this process (survives across turns) */
  const loaded = new Set()
  /** tools force-hidden on top of the default groups */
  const unloaded = new Set()
  /** name -> one-line summary, captured while the tool was still visible */
  const catalog = new Map()
  /** Agent -> disposer of its current restriction */
  const masks = new Map()

  let hiddenNow = []

  const isCandidate = (toolName) => {
    if (alwaysVisible.has(toolName)) return false
    if (exact.has(toolName)) return true
    return prefixes.some((prefix) => toolName.startsWith(prefix))
  }

  const globalSchemas = () => {
    try {
      return ctx.tools.schemas() || []
    } catch {
      return []
    }
  }

  const captureCatalog = () => {
    for (const schema of globalSchemas()) {
      if (!isCandidate(schema.name)) continue
      if (!catalog.has(schema.name)) catalog.set(schema.name, summarize(schema.description))
    }
  }

  const computeHidden = () => {
    const out = []
    for (const schema of globalSchemas()) {
      const toolName = schema.name
      if (!isCandidate(toolName)) continue
      if (unloaded.has(toolName)) {
        out.push(toolName)
        continue
      }
      if (loaded.has(toolName)) continue
      out.push(toolName)
    }
    return out
  }

  const sameList = (a, b) => a.length === b.length && a.every((value, index) => value === b[index])

  const clearMask = (agent) => {
    const dispose = masks.get(agent)
    if (!dispose) return
    masks.delete(agent)
    try { dispose() } catch { /* agent already gone */ }
  }

  const maskAgent = (agent) => {
    clearMask(agent)
    if (!hiddenNow.length) return
    const scoped = agent?.ctx?.tools
    if (!scoped) return
    try {
      masks.set(agent, scoped.restrict({ deny: hiddenNow }))
    } catch (error) {
      try { ctx.logger?.warn?.(`tool-shelf: restrict failed: ${error?.message ?? error}`) } catch {}
    }
  }

  const liveAgents = () => {
    try {
      return ctx.agents?.list?.() || []
    } catch {
      return []
    }
  }

  const reapply = () => {
    const hidden = computeHidden()
    const changed = !sameList(hidden, hiddenNow)
    hiddenNow = hidden

    for (const agent of [...masks.keys()]) {
      if (!liveAgents().includes(agent)) clearMask(agent)
    }
    for (const agent of liveAgents()) maskAgent(agent)
    return changed
  }

  const shelfPayload = (extra = {}) => {
    const listing = hiddenNow.map((toolName) => {
      const summary = catalog.get(toolName) || ''
      return summary ? `${toolName}：${summary}` : toolName
    })
    return {
      ok: true,
      hidden: [...hiddenNow],
      count: hiddenNow.length,
      listing: listing.join('\n'),
      message: hiddenNow.length
        ? `工具架上有 ${hiddenNow.length} 个工具：${hiddenNow.join('、')}`
        : '工具架空了：所有工具都在当前工具集里',
      ...extra,
    }
  }

  const GUIDE_PATH = 'D:\\AI\\DSH\\yoyo\\plugins\\tool-shelf\\cards-guide.md'
  const GUIDE_SECTIONS =
    '1 任务说明 / 10 可用组件 / 21 卡片 JSON Schema / 28 卡片示例 / 55 Schema Snippets / 64 this 上下文 / 116 Action 定义 / 179 schemaJson 生成规则（行号）'

  const cardOrigin = () => {
    try {
      const web = ctx.get('webServer')
      return web?.getOrigin?.() || ''
    } catch {
      return ''
    }
  }

  const setCards = async (enabled) => {
    const origin = cardOrigin()
    if (!origin) return { ok: false, message: '没有可用的 webServer，关不掉/开不了卡片提示' }
    try {
      const res = await fetch(`${origin}/api/dsh-genui/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      if (!res.ok) return { ok: false, message: `卡片开关返回 HTTP ${res.status}` }
      const data = await res.json()
      return { ok: Boolean(data?.enabled) === enabled, message: enabled ? '卡片能力已开启' : '卡片能力已关闭' }
    } catch (error) {
      return { ok: false, message: `卡片开关失败：${error?.message ?? error}` }
    }
  }

  const shelfTool = {
    name: 'tool_shelf',
    description:
      '工具架 + 卡片开关。一批不常用但很占空间的工具（office 文档、日程、朋友圈、workflow）默认不在工具集里，' +
      '调用本工具才能查看和取用。' +
      'action=list 看架子上有什么；action=load 把 tools 里的工具取下来，之后的调用就能直接使用它们；' +
      'action=unload 放回去；action=reset 恢复默认。' +
      '需要读写 Word/Excel/PDF、创建定时提醒、发朋友圈或跑 workflow 时，先 list 再 load 对应工具再调用。' +
      'action=cards 打开可视化卡片能力（默认关闭以省 token），action=cards-off 再关掉；' +
      '要给用户出卡片/表单/图表时，先 action=cards，再按返回的指南路径读需要的章节。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'load', 'unload', 'reset', 'cards', 'cards-off'],
          description: 'list 查看；load 取用 tools 中的工具；unload 收回 tools 中的工具；reset 全部恢复默认；cards 开启卡片；cards-off 关闭卡片。',
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: '工具名列表，action 为 load 或 unload 时必填；名字必须来自 list 的结果。',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          hidden: { type: 'array', items: { type: 'string' } },
          count: { type: 'number' },
          listing: { type: 'string' },
          message: { type: 'string' },
          loaded: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_args, value) {
        if (!value || value.ok === false) {
          return [{ type: 'text', text: String(value?.message || '工具架操作失败') }]
        }
        if (value.listing) {
          return [{ type: 'text', text: `${value.message}\n\n${value.listing}` }]
        }
        return [{ type: 'text', text: String(value.message || '完成') }]
      },
    },
    async execute(args) {
      const action = String(args?.action || 'list')
      const requested = Array.isArray(args?.tools)
        ? args.tools.map((toolName) => String(toolName)).filter(Boolean)
        : []

      if (action === 'list') {
        captureCatalog()
        reapply()
        return shelfPayload({ action })
      }

      if (action === 'load') {
        if (!requested.length) {
          return { ok: false, message: 'load 需要 tools 列表：先 list 看名字，再把要用的填进来' }
        }
        const known = new Set([...catalog.keys(), ...globalSchemas().map((schema) => schema.name)])
        const unknown = requested.filter((toolName) => !isCandidate(toolName) || !known.has(toolName))
        if (unknown.length) {
          return {
            ok: false,
            message: `这些工具不在架子上：${unknown.join('、')}。先 list 看可用的名字。`,
            hidden: [...hiddenNow],
          }
        }
        for (const toolName of requested) {
          loaded.add(toolName)
          unloaded.delete(toolName)
        }
        captureCatalog()
        reapply()
        return shelfPayload({ action, loaded: requested })
      }

      if (action === 'unload') {
        if (!requested.length) return { ok: false, message: 'unload 需要 tools 列表' }
        for (const toolName of requested) {
          loaded.delete(toolName)
          unloaded.add(toolName)
        }
        reapply()
        return shelfPayload({ action, loaded: [] })
      }

      if (action === 'reset') {
        loaded.clear()
        unloaded.clear()
        captureCatalog()
        reapply()
        return shelfPayload({ action })
      }

      if (action === 'cards' || action === 'cards-off') {
        const enabled = action === 'cards'
        const result = await setCards(enabled)
        if (!result.ok) return { ok: false, message: result.message }
        return {
          ok: true,
          action,
          message: enabled
            ? `${result.message}（下一轮起进入系统提示）。完整说明书：${GUIDE_PATH}。章节：${GUIDE_SECTIONS}`
            : `${result.message}。要用卡片时再 action=cards。`,
        }
      }

      return { ok: false, message: `不认识的动作：${action}` }
    },
  }

  ctx.effect(() => ctx.tools.register(shelfTool))

  // Tools registered by other plugins arrive after this one; settle first.
  const settle = setTimeout(() => {
    captureCatalog()
    reapply()
  }, 0)
  ctx.effect(() => () => clearTimeout(settle))

  // Every agent that appears later gets the same mask.
  ctx.on('agent/created', (payload) => {
    const agent = payload?.agent
    if (!agent) return
    captureCatalog()
    reapply()
    maskAgent(agent)
  })

  // A late plugin may register more tools (HMR, subagent tooling). Recompute
  // only when the hidden set actually changes, so our own restriction does not
  // loop through tools/change forever.
  ctx.on('tools/change', () => {
    captureCatalog()
    if (!sameList(computeHidden(), hiddenNow)) reapply()
  })
}
