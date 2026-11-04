// 朋友圈插件（Host 侧）：读 sns.db 看动态，驱动微信界面截图 / 点赞 / 评论。
//
// 设计取舍：
//   * 列表、正文、评论全部只读 sns.db —— 快、不抢焦点、屏幕锁着也能用；
//   * 图片内容只能靠截「微信界面上渲染出来的样子」，因为 CDN 地址现在只回
//     占位图、本机缓存也没有明文文件；
//   * 点赞/评论必须点界面，所以都走 sidecar 里的 UIA，失败就把原因原样交回；
//   * 动过谁记在 sidecar/.state/actions.jsonl，用来防重复点赞/重复评论。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const name = 'wx-moments';
export const inject = ['tools'];

const DEFAULT_SCRIPT = fileURLToPath(new URL('./sidecar/moments.py', import.meta.url));
const SIDECAR_DIR = fileURLToPath(new URL('./sidecar/', import.meta.url));
const PYTHON_CANDIDATES = ['python', 'python3', 'py'];
const READ_TIMEOUT_MS = 120000;
const ACT_TIMEOUT_MS = 240000;

function asText(lines) {
  return [{ type: 'text', text: lines.join('\n') }];
}

function parametersToJsonSchema(parameters = {}) {
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(parameters)) {
    properties[key] = { ...spec };
    delete properties[key].required;
    if (spec?.required) required.push(key);
  }
  const schema = { type: 'object', properties, additionalProperties: false };
  if (required.length) schema.required = required;
  return schema;
}

function text(description, required = false) {
  return { type: 'string', description, ...(required ? { required } : {}) };
}
function integer(description, required = false) {
  return { type: 'integer', description, ...(required ? { required } : {}) };
}
function bool(description) {
  return { type: 'boolean', description };
}

class Sidecar {
  #child = null;
  #buffer = '';
  #pending = new Map();
  #nextId = 1;
  #script;
  #lastError = '';

  constructor(script) {
    this.#script = script;
  }

  get running() {
    return Boolean(this.#child);
  }

  get lastError() {
    return this.#lastError;
  }

  async request(method, params = {}, timeoutMs = READ_TIMEOUT_MS) {
    this.#ensure();
    const id = this.#nextId++;
    const line = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`朋友圈 sidecar 超时（${method} ${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#child.stdin.write(`${line}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  #ensure() {
    if (this.#child) return;
    const candidates = [process.env.DSH_WX_MOMENTS_PYTHON, ...PYTHON_CANDIDATES]
      .filter(Boolean)
      .filter((value, index, list) => list.indexOf(value) === index);
    this.#spawnWith(candidates, 0);
  }

  #spawnWith(candidates, index) {
    if (index >= candidates.length) {
      throw new Error(`找不到可用的 python（试过 ${candidates.join('/')}）：${this.#lastError}`);
    }
    const bin = candidates[index];
    const child = spawn(bin, ['-X', 'utf8', this.#script], {
      cwd: SIDECAR_DIR,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const message = String(chunk).trim();
      if (message) this.#lastError = message.slice(-400);
    });
    child.on('error', (error) => {
      this.#lastError = String(error?.message || error);
      this.#child = null;
      if (this.#pending.size === 0 && index + 1 < candidates.length) {
        this.#spawnWith(candidates, index + 1);
      } else {
        this.#failAll(new Error(`朋友圈 sidecar 启动失败：${this.#lastError}`));
      }
    });
    child.on('exit', () => {
      this.#child = null;
      this.#failAll(new Error('朋友圈 sidecar 已退出'));
    });
    child.unref?.();
  }

  #onData(chunk) {
    this.#buffer += chunk;
    let index = this.#buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line) this.#onLine(line);
      index = this.#buffer.indexOf('\n');
    }
  }

  #onLine(line) {
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = this.#pending.get(payload.id);
    if (!waiter) return;
    this.#pending.delete(payload.id);
    clearTimeout(waiter.timer);
    if (payload.ok) waiter.resolve(payload.result);
    else waiter.reject(new Error(payload.error || '朋友圈 sidecar 报错'));
  }

  #failAll(error) {
    for (const [id, waiter] of this.#pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      this.#pending.delete(id);
    }
  }

  dispose() {
    if (!this.#child) return;
    try {
      this.#child.stdin.end();
      this.#child.kill();
    } catch {
      /* ignore */
    }
    this.#child = null;
    this.#failAll(new Error('朋友圈 sidecar 已关闭'));
  }
}

const TARGET_PARAMETERS = {
  index: integer('动态在 moments_feed 结果里的序号（0 = 最新一条）。'),
  key: text('moments_feed 返回的 key，最稳的定位方式。'),
  author: text('发布者昵称（和 keyword 一起用）。'),
  keyword: text('正文里的关键词（和 author 一起用）。'),
};

function targetOf(args) {
  return {
    ...(args?.index !== undefined ? { index: args.index } : {}),
    ...(args?.key ? { key: args.key } : {}),
    ...(args?.author ? { author: args.author } : {}),
    ...(args?.keyword ? { keyword: args.keyword } : {}),
  };
}

function feedLabel(row) {
  const bits = [`[${row.index}] ${row.author || '?'}`, row.time || ''];
  if (row.images) bits.push(`${row.images} 图`);
  if (row.videos) bits.push(`${row.videos} 视频`);
  if (row.commentCount) bits.push(`${row.commentCount} 评论`);
  if (row.acted?.like) bits.push('已赞');
  if (row.acted?.comment) bits.push('已评');
  return bits.filter(Boolean).join(' · ');
}

export function apply(ctx, config = {}) {
  const scriptPath = config.scriptPath || DEFAULT_SCRIPT;
  const sidecar = new Sidecar(scriptPath);
  ctx.effect?.(() => () => sidecar.dispose());

  const register = (definition) => {
    const output = definition.output
      ? {
          ...definition.output,
          schema: definition.output.schema,
        }
      : undefined;
    ctx.tools.register({
      ...definition,
      parameters: parametersToJsonSchema(definition.parameters),
      ...(output ? { output } : {}),
    });
  };

  register({
    name: 'moments_feed',
    description:
      '看朋友圈：从本地数据库读出最近的朋友圈动态（作者、时间、正文、几张图、谁评过）。只读、秒回、不抢鼠标。想看图片里到底是什么，再用 moments_shots 截那条。',
    parameters: {
      limit: integer('最多几条，默认 8，上限 40。'),
      author: text('只看某个人的朋友圈（昵称，部分匹配）。'),
      refresh: bool('true 时重新读一次数据库（默认 30 秒内复用缓存）。'),
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          account: { type: 'string' },
          total: { type: 'integer' },
          rows: { type: 'array', items: { type: 'object' } },
        },
      },
      render: (_args, value) => {
        if (!value?.rows?.length) return asText(['朋友圈里没有能读出来的动态。']);
        const lines = [`共 ${value.total} 条可读动态，取前 ${value.rows.length} 条：`];
        for (const row of value.rows) {
          lines.push(`${feedLabel(row)}`);
          if (row.text) lines.push(`    ${row.text.replace(/\s+/g, ' ').slice(0, 160)}`);
          for (const c of row.comments || []) {
            const who = c.replyTo ? `${c.author} 回 ${c.replyTo}` : c.author;
            lines.push(`    · ${who}：${(c.text || '').slice(0, 80)}`);
          }
        }
        lines.push('（要配图评论就先 moments_shots 截图，别只看文字瞎猜。）');
        return asText(lines);
      },
    },
    timeoutMs: READ_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args = {}) {
      return sidecar.request('feed', {
        limit: args.limit,
        author: args.author,
        refresh: args.refresh,
      });
    },
  });

  register({
    name: 'moments_post',
    description:
      '读某一条朋友圈的详情：完整正文、全部评论（含谁回谁）、有几张图。只读数据库，不点界面。',
    parameters: { ...TARGET_PARAMETERS },
    output: {
      schema: {
        type: 'object',
        properties: {
          author: { type: 'string' },
          text: { type: 'string' },
          comments: { type: 'array', items: { type: 'object' } },
          commentThread: { type: 'array', items: { type: 'object' } },
        },
      },
      render: (_args, value) => {
        const lines = [
          `${value.author || '?'} · ${value.time || ''} · ${value.images || 0} 图 ${value.videos || 0} 视频 · ${value.likes || 0} 赞`,
          value.text || '（没有文字，只有图/视频）',
        ];
        const thread = value.commentThread?.length ? value.commentThread : value.comments || [];
        for (const c of thread) {
          const who = c.replyTo ? `${c.author} 回 ${c.replyTo}` : c.author;
          lines.push(`  · ${who}：${c.text}`);
        }
        if (value.acted?.like) lines.push('（我已经赞过这条）');
        if (value.acted?.comment) lines.push('（我已经评过这条）');
        if (value.images) lines.push('要看图里是什么，用 moments_shots 截这条。');
        return asText(lines);
      },
    },
    timeoutMs: READ_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args = {}) {
      return sidecar.request('post', targetOf(args));
    },
  });

  register({
    name: 'moments_shots',
    description:
      '把某条朋友圈在微信界面上的样子截下来（图片/视频的实际画面就在里面），落成 png 给你用 read_image / modlens 看。会打开朋友圈窗口、抢焦点十几秒；屏幕锁着或者找不到那条会直接告诉你原因。评论配图之前一定要先看这个。',
    parameters: {
      ...TARGET_PARAMETERS,
      max: integer('最多截几段（一条太长会分段截），默认 3，上限 9。'),
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          reason: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        if (!value?.ok) return asText([`没截到：${value?.reason || '未知原因'}`]);
        const lines = [
          `${value.author || '?'} 的朋友圈画面（${value.files.length} 张）：`,
          ...value.files.map((file) => `  ${file}`),
        ];
        if (value.text) lines.push(`正文：${value.text}`);
        lines.push('现在用 read_image 或 modlens 打开这些 png，看清图里到底是什么再说话。');
        return asText(lines);
      },
    },
    timeoutMs: ACT_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args = {}) {
      const result = await sidecar.request('shots', { ...targetOf(args), max: args.max }, ACT_TIMEOUT_MS);
      return result;
    },
  });

  register({
    name: 'moments_like',
    description:
      '给一条朋友圈点赞（cancel=true 取消赞）。要打开界面点，抢焦点；朋友圈里一条动态只赞一次，别反复点。',
    parameters: {
      ...TARGET_PARAMETERS,
      cancel: bool('true = 取消赞。'),
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          reason: { type: 'string' },
          author: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value?.ok) return asText([`没点上：${value?.reason || value?.message || '未知原因'}`]);
        return asText([`${value.cancel ? '取消赞' : '点赞'}成功：${value.author || ''}`]);
      },
    },
    timeoutMs: ACT_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args = {}) {
      return sidecar.request('like', { ...targetOf(args), cancel: args.cancel }, ACT_TIMEOUT_MS);
    },
  });

  register({
    name: 'moments_comment',
    description:
      '给一条朋友圈评论（replyTo 指定时是回复某个人）。评论要短、像人随口说的、跟这条内容有关；抢焦点，一次没成就别再刷。',
    parameters: {
      ...TARGET_PARAMETERS,
      text: text('评论内容（上限 120 字，越短越好）。', true),
      replyTo: text('要回复谁的昵称（可选）。'),
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          reason: { type: 'string' },
          author: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value?.ok) return asText([`没评上：${value?.reason || value?.message || '未知原因'}`]);
        const target = value.replyTo ? `${value.replyTo}（回评）` : value.author || '';
        return asText([`评论成功：${target}`]);
      },
    },
    timeoutMs: ACT_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args = {}) {
      return sidecar.request(
        'comment',
        { ...targetOf(args), text: args.text, replyTo: args.replyTo },
        ACT_TIMEOUT_MS,
      );
    },
  });

  register({
    name: 'moments_publish',
    description:
      '发一条朋友圈：text 是文案（必填），images 是本机图片路径数组（最多 9 张，可不传），' +
      'visibility 传 public（全部可见，默认）或 private（仅自己可见）。发完会去数据库回读，核不到就说没发出去。',
    parameters: {
      text: text('朋友圈文案（必填）。', true),
      images: {
        type: 'array',
        items: { type: 'string' },
        description: '本机图片绝对路径，最多 9 张，可不传。',
      },
      visibility: {
        type: 'string',
        enum: ['public', 'private'],
        description: 'public=全部可见（默认），private=仅自己可见。',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          verified: { type: 'boolean' },
          visibility: { type: 'string' },
          text: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render(_args, value) {
        const rows = [];
        const vis = value.visibility === 'private' ? '仅自己可见' : '全部可见';
        rows.push(
          value.verified
            ? `朋友圈已发表（${vis}）· 数据库已核到`
            : `朋友圈没发出去（${vis}）· ${value.message || '微信没接受'}`,
        );
        if (value.text) rows.push(`文案：${value.text}`);
        return asText(rows);
      },
    },
    timeoutMs: 300000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const text = String(args?.text ?? '').trim();
      if (!text) throw new Error('文案不能为空');
      const images = Array.isArray(args?.images)
        ? args.images.map((x) => String(x)).filter(Boolean)
        : [];
      const visibility = String(args?.visibility ?? 'public');
      return sidecar.request('publish', { text, images, visibility }, 280000);
    },
  });

  register({
    name: 'moments_ledger',
    description: '我这台机器在朋友圈里做过什么（赞过谁、评过谁），用来避免重复点赞、重复评论。',
    parameters: { limit: integer('最近几条，默认 10。') },
    output: {
      schema: {
        type: 'object',
        properties: { total: { type: 'integer' }, rows: { type: 'array', items: { type: 'object' } } },
      },
      render: (_args, value) => {
        if (!value?.rows?.length) return asText(['还没在朋友圈里动过手。']);
        const lines = [`共 ${value.total} 条动作，最近：`];
        for (const row of value.rows) {
          const what = row.kind === 'comment' ? `评论「${(row.content || '').slice(0, 40)}」` : row.kind === 'unlike' ? '取消赞' : '点赞';
          lines.push(`  ${row.at} ${what} → ${row.author || ''}「${(row.text || '').slice(0, 30)}」${row.ok === false ? '（失败）' : ''}`);
        }
        return asText(lines);
      },
    },
    timeoutMs: READ_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args = {}) {
      return sidecar.request('ledger', { limit: args.limit });
    },
  });

  register({
    name: 'moments_status',
    description: '朋友圈插件体检：账号、数据库里多少条动态、屏幕是不是锁着、本地动作账本多少条。',
    parameters: {},
    output: {
      schema: { type: 'object', properties: { account: { type: 'string' }, locked: { type: 'boolean' } } },
      render: (_args, value) =>
        asText([
          `账号：${value.account || '（没读到）'}`,
          `动态：${value.moments ?? '?'} 条（数据库）`,
          `屏幕：${value.locked ? '锁着（点赞/评论/截图都做不了）' : '可用'}`,
          `动作账本：${value.ledger ?? 0} 条`,
          ...(value.dbError ? [`数据库报错：${value.dbError}`] : []),
        ]),
    },
    timeoutMs: READ_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute() {
      return sidecar.request('status', {});
    },
  });
}
