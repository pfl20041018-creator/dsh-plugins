// 记忆总账：只看不改。
//
// 这台机器上的记忆散在十来处（人设卡、事实卡、心情、会话原文、压缩缓存、
// 微信账本、鲸鱼日记、表情库、用量、日程）。本插件不接管任何一处写入，
// 只把它们列出来、按关键词跨源查一遍，让「我到底记得什么」变得可回答。
//
// 只读保证：这里没有 writeFile / appendFile / rm，任何工具都不会改动别人的数据。

import { readFile, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

export const name = 'memory-hub';
export const inject = ['tools', 'systemPrompt'];

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const PROFILE_DIR =
  process.env.DSH_PROFILE_DIR || join(DSH_HOME, 'profiles', process.env.DSH_PROFILE || 'desktop');
const FISH_DIR = join(DSH_HOME, 'fish-memory');
const MOOD_DIR = join(DSH_HOME, 'feiyu-mood');
const SESSIONS_DIR = join(DSH_HOME, 'sessions');
const PROJCACHE_DIR = join(DSH_HOME, 'storages', 'session_projcache');
const SCHEDULE_FILE = join(DSH_HOME, 'storages', 'schedule.json');
const USAGE_FILE = join(DSH_HOME, '.dshw-usage.json');
const WX_STATE = join(PROFILE_DIR, 'node_modules', '@local', 'dsh-wechat-bridge', 'sidecar', '.state');
// 鲸鱼的家搬过两次：先在工作区，后来才挪到 ~/.dsh。两处都认。
const WHALE_STATE_CANDIDATES = [
  join('D:\\AI\\DSH\\yoyo', 'bili-whale', 'state'),
  join(DSH_HOME, 'bili-whale', 'state'),
];
const MEME_DIR = join(PROFILE_DIR, 'node_modules', 'dsh-meme', 'memes');
// dsh-world 的世界目录（本机是 junction，实际落在 D:\AI\DSH\yoyo\worlds）
const WORLDS_DIR = join(DSH_HOME, 'worlds');
const ZSTD_CANDIDATES = ['D:\\Codes\\Anaconda\\Library\\bin\\zstd.exe', 'zstd'];

const asText = (lines) => [{ type: 'text', text: lines.join('\n') }];
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
};
const kb = (bytes) => {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${n}B`;
};

async function safeStat(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function readJsonl(path, max = 100000) {
  const rows = [];
  try {
    const raw = await readFile(path, 'utf8');
    let buffer = '';
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
        buffer = '';
      } catch {
        buffer = buffer ? `${buffer}\\n${line}` : line;
        try {
          rows.push(JSON.parse(buffer));
          buffer = '';
        } catch {
          // 留着给下一行拼，拼不上就丢
        }
      }
      if (rows.length >= max) break;
    }
  } catch {
    // 文件不存在
  }
  return rows;
}

async function listDir(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

// ── 各来源的“账面” ─────────────────────────────────────────────

async function soulCard() {
  try {
    const raw = await readFile(join(PROFILE_DIR, 'cordis.patch.yml'), 'utf8');
    const blocks = raw.split(/\n(?=\s*-\s+insert:|\s*-\s+id:)/);
    const hit = blocks.find((block) => /soul-md|soulCard|人设/.test(block));
    if (!hit) return null;
    const chars = hit.replace(/\s+/g, ' ').length;
    return { chars, preview: hit.replace(/\s+/g, ' ').slice(0, 120) };
  } catch {
    return null;
  }
}

async function fishStats() {
  const entries = await listDir(FISH_DIR);
  const items = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^session-.+\.json$/.test(entry.name)) continue;
    const path = join(FISH_DIR, entry.name);
    const info = await safeStat(path);
    const data = await readJson(path, {});
    items.push({
      session: entry.name.replace(/^session-|\.json$/g, ''),
      bytes: info?.size || 0,
      memories: Array.isArray(data.memories) ? data.memories.length : 0,
      traces: Array.isArray(data.traces) ? data.traces.length : 0,
    });
  }
  return items.sort((a, b) => b.bytes - a.bytes);
}

async function moodStats() {
  const info = await safeStat(join(MOOD_DIR, 'state.json'));
  const data = await readJson(join(MOOD_DIR, 'state.json'), {});
  const moods = data && typeof data === 'object' ? Object.keys(data.moods || data).length : 0;
  return { bytes: info?.size || 0, sessions: moods };
}

async function sessionLogs() {
  const out = [];
  for (const workspace of await listDir(SESSIONS_DIR)) {
    if (!workspace.isDirectory()) continue;
    const wsPath = join(SESSIONS_DIR, workspace.name);
    for (const session of await listDir(wsPath)) {
      if (!session.isDirectory()) continue;
      const file = join(wsPath, session.name, 'session.v4.jsonl.zstd');
      const info = await safeStat(file);
      if (!info) continue;
      out.push({
        workspace: workspace.name,
        session: session.name,
        file,
        bytes: info.size,
        mtime: info.mtime.toISOString(),
      });
    }
  }
  return out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}

async function projcacheStats() {
  let bytes = 0;
  let count = 0;
  const walk = async (dir, depth) => {
    if (depth > 2) return;
    for (const entry of await listDir(dir)) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        const info = await safeStat(full);
        bytes += info?.size || 0;
        count += 1;
      }
    }
  };
  await walk(PROJCACHE_DIR, 0);
  return { files: count, bytes };
}

async function wechatStats() {
  const outbox = await readJsonl(join(WX_STATE, 'outbox.jsonl'));
  const deferred = await readJsonl(join(WX_STATE, 'deferred.jsonl'));
  const voice = await readJson(join(WX_STATE, 'voice-text.json'), {});
  const sessions = await readJson(join(WX_STATE, 'sessions.json'), {});
  const access = await readJson(join(WX_STATE, 'access.json'), {});
  return {
    outbox,
    deferred,
    voices: Object.keys(voice || {}).length,
    sessions,
    access,
  };
}

async function whaleStats() {
  let root = WHALE_STATE_CANDIDATES[0];
  for (const candidate of WHALE_STATE_CANDIDATES) {
    if (await safeStat(candidate)) {
      root = candidate;
      break;
    }
  }
  const files = {};
  for (const name of ['whale-diary.md', 'whale-diary-private.md', 'whale-log.jsonl', 'whale-night.json']) {
    const info = await safeStat(join(root, name));
    files[name] = { bytes: info?.size || 0, mtime: info?.mtime.toISOString() || null };
  }
  return { root, files };
}

async function memeStats() {
  let count = 0;
  let packs = 0;
  for (const pack of await listDir(MEME_DIR)) {
    if (!pack.isDirectory()) continue;
    packs += 1;
    const inner = join(MEME_DIR, pack.name, 'memes');
    for (const tag of await listDir(inner)) {
      if (!tag.isDirectory()) continue;
      for (const file of await listDir(join(inner, tag.name))) {
        if (file.isFile()) count += 1;
      }
    }
  }
  return { packs, count };
}

async function usageStats() {
  const data = await readJson(USAGE_FILE, {});
  return {
    balance: data.lastBalance ?? null,
    today: data.todayUsage ?? null,
    events: Array.isArray(data.events) ? data.events.length : 0,
    days: data.history ? Object.keys(data.history).length : 0,
  };
}

async function scheduleStats() {
  const data = await readJson(SCHEDULE_FILE, {});
  // 存储层形状：{ unit, global, tables: { tasks: { <id>: {...} } } }
  const tables = data && typeof data === 'object' ? data.tables : null;
  if (tables && typeof tables === 'object') {
    let count = 0;
    let active = 0;
    for (const table of Object.values(tables)) {
      if (!table || typeof table !== 'object') continue;
      const rows = Array.isArray(table.rows) ? table.rows : Object.values(table);
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        if (Array.isArray(row.rows)) {
          count += row.rows.length;
          active += row.rows.filter((r) => r && (r.enabled !== false)).length;
        } else {
          count += 1;
          if (row.enabled !== false) active += 1;
        }
      }
    }
    return { count, active, tables: Object.keys(tables).length };
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  return { count: list.length, active: list.length, tables: 0 };
}

// ── 跨源搜索 ───────────────────────────────────────────────────

function tokensOf(query) {
  const raw = String(query || '').trim();
  if (!raw) return [];
  const parts = raw.split(/[\s,，、;；]+/).filter(Boolean);
  if (parts.length > 1) return parts.slice(0, 6);
  const single = parts[0] || '';
  // 单句太长时按 2 字滑窗再拆几段，避免整句去 indexOf 一个都匹配不上
  if (single.length <= 6) return [single];
  const windows = [];
  for (let i = 0; i + 3 <= single.length && windows.length < 6; i += 3) windows.push(single.slice(i, i + 3));
  return windows.length ? windows : [single];
}

// 在文本里找第一个命中的词，尽量把窗口放在命中位置；多词命中越多分越高
function findHit(haystack, tokens, width = 90) {
  const body = String(haystack || '');
  if (!body) return null;
  const lower = body.toLowerCase();
  let firstIndex = -1;
  let matched = 0;
  for (const token of tokens) {
    const idx = lower.indexOf(String(token).toLowerCase());
    if (idx >= 0) {
      matched += 1;
      if (firstIndex < 0) firstIndex = idx;
    }
  }
  if (firstIndex < 0) return null;
  const start = Math.max(0, firstIndex - Math.floor(width / 3));
  const end = Math.min(body.length, firstIndex + width);
  return {
    score: matched,
    snippet: `${start > 0 ? '…' : ''}${body.slice(start, end).replace(/\s+/g, ' ')}${end < body.length ? '…' : ''}`,
  };
}

function searchable(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return JSON.stringify(value);
  return '';
}

async function searchFish(tokens, hits, limit) {
  for (const entry of await listDir(FISH_DIR)) {
    if (!entry.isFile() || !/^session-.+\.json$/.test(entry.name)) continue;
    const data = await readJson(join(FISH_DIR, entry.name), {});
    for (const memory of data.memories || []) {
      const body = searchable(memory.text || memory.content || memory);
      const hit = findHit(body, tokens);
      if (hit) {
        hits.push({
          source: '事实卡',
          score: hit.score + 2,
          where: `会话 ${entry.name.replace(/^session-|\.json$/g, '').slice(0, 8)}`,
          when: memory.at || memory.createdAt || '',
          snippet: hit.snippet,
        });
        if (hits.length >= limit) return;
      }
    }
    for (const trace of data.traces || []) {
      const body = searchable(trace.text || trace.content || trace);
      const hit = findHit(body, tokens);
      if (hit) {
        hits.push({
          source: '事实卡(流水)',
          score: hit.score,
          where: `会话 ${entry.name.replace(/^session-|\.json$/g, '').slice(0, 8)}`,
          when: trace.at || trace.createdAt || '',
          snippet: hit.snippet,
        });
        if (hits.length >= limit) return;
      }
    }
  }
}

async function whaleRoot() {
  for (const candidate of WHALE_STATE_CANDIDATES) {
    if (await safeStat(candidate)) return candidate;
  }
  return WHALE_STATE_CANDIDATES[0];
}

async function worldFiles(root, name) {
  const out = [];
  const push = async (dir, pattern) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (pattern && !pattern.test(entry.name)) continue;
      out.push(join(dir, entry.name));
    }
  };
  await push(root, /^world-prompt\.md$/);
  await push(join(root, 'diary'), /\.(md|txt)$/);
  await push(join(root, 'room'), /\.md$/);
  await push(join(root, 'life'), /\.(md|txt|jsonl?)$/);
  await push(join(root, 'conversations'), /\.md$/);
  return out;
}

async function worldSummary() {
  let worlds;
  try {
    worlds = await readdir(WORLDS_DIR, { withFileTypes: true });
  } catch {
    return '还没有世界目录';
  }
  const parts = [];
  for (const entry of worlds) {
    if (!entry.isDirectory()) continue;
    const files = await worldFiles(join(WORLDS_DIR, entry.name), entry.name);
    let bytes = 0;
    for (const file of files) {
      const info = await safeStat(file);
      bytes += info?.size || 0;
    }
    parts.push(`${entry.name}：${files.length} 个文件 / ${kb(bytes)}`);
  }
  return parts.length > 0 ? parts.join(' · ') : '世界目录是空的';
}

async function searchWorld(tokens, hits, limit) {
  let worlds;
  try {
    worlds = await readdir(WORLDS_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of worlds) {
    if (!entry.isDirectory()) continue;
    const root = join(WORLDS_DIR, entry.name);
    const files = await worldFiles(root, entry.name);
    for (const file of files.slice(0, 40)) {
      let raw = '';
      try {
        raw = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      if (raw.length > 2 * 1024 * 1024) raw = raw.slice(-2 * 1024 * 1024);
      for (const paragraph of raw.split(/\n{2,}/)) {
        const hit = findHit(paragraph, tokens);
        if (hit) {
          hits.push({
            source: '世界生活',
            score: hit.score + 1,
            where: `${entry.name}/${basename(file)}`,
            when: '',
            snippet: hit.snippet,
          });
          if (hits.length >= limit) return;
        }
      }
    }
  }
}

async function searchWhale(tokens, hits, limit) {
  const root = await whaleRoot();
  for (const name of ['whale-diary.md', 'whale-diary-private.md']) {
    let raw = '';
    try {
      raw = await readFile(join(root, name), 'utf8');
    } catch {
      continue;
    }
    for (const paragraph of raw.split(/\n{2,}/)) {
      const hit = findHit(paragraph, tokens);
      if (hit) {
        hits.push({
          source: `鲸鱼${name.includes('private') ? '私密' : ''}日记`,
          score: hit.score + 2,
          where: name,
          when: '',
          snippet: hit.snippet,
        });
        if (hits.length >= limit) return;
      }
    }
  }
  const logs = await readJsonl(join(root, 'whale-log.jsonl'), 5000);
  for (const row of logs.reverse()) {
    const hit = findHit(searchable(row), tokens);
    if (hit) {
      hits.push({ source: '鲸鱼日志', score: hit.score, where: row.kind || row.type || 'log', when: row.at || '', snippet: hit.snippet });
      if (hits.length >= limit) return;
    }
  }
}

async function searchWechat(tokens, hits, limit) {
  const outbox = await readJsonl(join(WX_STATE, 'outbox.jsonl'));
  for (const row of outbox.reverse()) {
    const hit = findHit(`${row.name || ''} ${row.text || ''}`, tokens);
    if (hit) {
      hits.push({
        source: row.proactive ? '我主动说的' : '微信发出去的话',
        score: hit.score + 1,
        where: `${row.name || row.username || '?'}`,
        when: row.at || '',
        snippet: hit.snippet,
      });
      if (hits.length >= limit) return;
    }
  }
  const voice = await readJson(join(WX_STATE, 'voice-text.json'), {});
  for (const [key, value] of Object.entries(voice || {})) {
    const hit = findHit(searchable(value), tokens);
    if (hit) {
      hits.push({ source: '语音转写', score: hit.score + 1, where: key.split('|')[0], when: value.at || '', snippet: hit.snippet });
      if (hits.length >= limit) return;
    }
  }
}

function zstdBinary() {
  return ZSTD_CANDIDATES[0];
}

function decompressTail(file, maxLines = 4000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(zstdBinary(), ['-d', '-c', file], { windowsHide: true });
    } catch {
      return finish('');
    }
    const keep = [];
    let carry = '';
    child.stdout.on('data', (chunk) => {
      carry += chunk.toString('utf8');
      const lines = carry.split('\n');
      carry = lines.pop() || '';
      for (const line of lines) {
        keep.push(line);
        if (keep.length > maxLines) keep.splice(0, keep.length - maxLines);
      }
    });
    child.on('error', () => finish(''));
    child.on('close', () => {
      if (carry) keep.push(carry);
      finish(keep.join('\n'));
    });
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(keep.join('\n'));
    }, 5000);
  });
}

async function searchSessions(tokens, hits, limit, scope) {
  const logs = await sessionLogs();
  const filtered = scope && scope !== 'all' ? logs.filter((row) => row.workspace.includes(scope)) : logs;
  const seen = new Set();
  for (const row of filtered.slice(0, 6)) {
    const dump = await decompressTail(row.file, 3000);
    if (!dump) continue;
    const label = row.workspace.replace(/^--|--$/g, '').replace(/^-/, '');
    for (const line of dump.split('\n')) {
      if (!line.trim()) continue;
      let obj = null;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      // 只要真正的对话消息，跳过工具调用/结果（那些是过程噪音，不是记忆）
      const type = String(obj.type || '');
      if (!/message/.test(type) || /tool/.test(type)) continue;
      const hit = findHit(searchable(obj.message || obj.content || obj), tokens);
      if (!hit) continue;
      const key = `${label}|${hit.snippet}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({
        source: '会话原文',
        score: hit.score,
        where: label,
        when: typeof obj.at === 'number' ? new Date(obj.at).toISOString().slice(0, 16) : '',
        snippet: hit.snippet,
      });
      if (hits.length >= limit) return;
    }
  }
}

// ── 近况摘要：一次拿到「最近发生了什么」 ─────────────────────────

const clipText = (raw, head, tail) => {
  const value = String(raw || '').trim();
  if (value.length <= head + tail + 40) return value;
  return `${value.slice(0, head)}\n……\n${value.slice(-tail)}`;
};

async function latestWorldDiary() {
  let worlds = [];
  try {
    worlds = (await readdir(WORLDS_DIR, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  } catch {
    return null;
  }
  let best = null;
  for (const entry of worlds) {
    const dir = join(WORLDS_DIR, entry.name, 'diary');
    let names = [];
    try {
      names = (await readdir(dir)).filter((name) => /\.md$/.test(name)).sort();
    } catch {
      continue;
    }
    if (names.length === 0) continue;
    const name = names[names.length - 1];
    const path = join(dir, name);
    const info = await safeStat(path);
    if (!info) continue;
    if (!best || info.mtime > best.mtime) {
      best = { world: entry.name, day: name.replace(/\.md$/, ''), mtime: info.mtime, path };
    }
  }
  if (!best) return null;
  const raw = await readFile(best.path, 'utf8');
  return { world: best.world, day: best.day, text: clipText(raw, 400, 1200) };
}

async function latestWhaleWatched() {
  const root = await whaleRoot();
  const rows = [];
  for (const name of ['whale-diary.md', 'whale-diary-private.md']) {
    let raw = '';
    try {
      raw = await readFile(join(root, name), 'utf8');
    } catch {
      continue;
    }
    const tableRows = raw
      .split('\n')
      .filter((line) => /^\|\s*20\d\d-\d\d-\d\d/.test(line))
      .slice(-4);
    rows.push(...tableRows);
    const lastHeading = raw.lastIndexOf('\n## ');
    if (lastHeading >= 0) {
      rows.push(`〔${name} 最近一段〕${clipText(raw.slice(lastHeading + 1), 80, 500)}`);
    }
  }
  return rows;
}

async function recentWechatSaid(count = 5) {
  const outbox = await readJsonl(join(WX_STATE, 'outbox.jsonl'));
  return outbox.slice(-count).map((row) => ({
    at: String(row.at || ''),
    to: String(row.name || row.username || '?'),
    text: clipText(String(row.text || ''), 60, 200),
    proactive: Boolean(row.proactive),
  }));
}

async function memoryBrief() {
  const [worldDiary, watched, said, mood, schedule, usage] = await Promise.all([
    latestWorldDiary(),
    latestWhaleWatched(),
    recentWechatSaid(),
    moodStats(),
    scheduleStats(),
    usageStats(),
  ]);
  return {
    worldDiary: {
      world: worldDiary?.world || '',
      day: worldDiary?.day || '',
      text: worldDiary?.text || '还没写过世界日记',
    },
    watched: watched.map((row) => String(row)),
    said: said.map((row) => ({
      at: row.at,
      to: row.to,
      text: row.text,
      proactive: row.proactive,
    })),
    mood: { sessions: Number(mood?.sessions) || 0 },
    schedule: { active: Number(schedule?.active) || 0 },
    usage: {
      balance: usage?.balance === null || usage?.balance === undefined ? '' : String(usage.balance),
      today: usage?.today === null || usage?.today === undefined ? '' : String(usage.today),
    },
    note: '只读摘录：世界日记 / B 站观后感 / 我最近对外说过的话 / 心情 / 日程 / 用量。更早的用 memory_hub_search。',
  };
}

function paramsToJsonSchema(parameters) {
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(parameters || {})) {
    properties[key] = { ...spec };
    if (properties[key].required) {
      required.push(key);
      delete properties[key].required;
    }
  }
  const schema = { type: 'object', properties };
  if (required.length) schema.required = required;
  return schema;
}

export function apply(ctx, config = {}) {
  const register = (definition) =>
    ctx.tools.register({
      ...definition,
      parameters: paramsToJsonSchema(definition.parameters),
    });

  register({
    name: 'memory_hub',
    description:
      '记忆总账（只读）：一次列出这台机器上所有记忆来源——人设卡、事实卡、心情、会话原文、压缩缓存、微信账本、鲸鱼日记、世界生活、表情库、用量、日程。想知道「我到底记得什么、存在哪」时用它。不会改动任何数据。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          sources: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                path: { type: 'string' },
                summary: { type: 'string' },
                bytes: { type: 'number' },
                count: { type: 'number' },
              },
            },
          },
          total: { type: 'number' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const lines = [`记忆来源 ${value.total} 处（只读汇总，不改任何数据）`];
        for (const row of value.sources || []) {
          lines.push(`· ${row.title}｜${row.summary}`);
          lines.push(`    ${row.path}`);
        }
        lines.push(`说明：${value.note}`);
        return asText(lines);
      },
    },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    async execute() {
      const [soul, fish, mood, sessions, cache, wx, whale, meme, usage, schedule] = await Promise.all([
        soulCard(),
        fishStats(),
        moodStats(),
        sessionLogs(),
        projcacheStats(),
        wechatStats(),
        whaleStats(),
        memeStats(),
        usageStats(),
        scheduleStats(),
      ]);

      const fishMemories = fish.reduce((sum, row) => sum + row.memories, 0);
      const fishBytes = fish.reduce((sum, row) => sum + row.bytes, 0);
      const proactiveCount = (wx.outbox || []).filter((row) => row.proactive).length;
      const tierCount = Object.keys(wx.access?.tier1 || {}).length + (wx.access?.tier3?.length || 0);

      const sources = [
        {
          id: 'soul-md',
          title: '人设卡（人格）',
          path: join(PROFILE_DIR, 'cordis.patch.yml'),
          summary: soul ? `约 ${soul.chars} 字符 | 由 soul-md 注入系统提示${''}` : '没找到（读不到 patch）',
          bytes: soul?.chars || 0,
          count: soul ? 1 : 0,
        },
        {
          id: 'fish-memory',
          title: '事实卡（fish-memory）',
          path: FISH_DIR,
          summary: `${fish.length} 个会话文件 | 共 ${fishMemories} 条事实 | ${kb(fishBytes)}`,
          bytes: fishBytes,
          count: fishMemories,
        },
        {
          id: 'feiyu-mood',
          title: '心情（feiyu-mood）',
          path: MOOD_DIR,
          summary: `${mood.sessions} 个会话的心情状态 | ${kb(mood.bytes)}`,
          bytes: mood.bytes,
          count: mood.sessions,
        },
        {
          id: 'sessions',
          title: '会话原文（DSH 自己的日志）',
          path: SESSIONS_DIR,
          summary: `${sessions.length} 个会话 | 共 ${kb(sessions.reduce((s, r) => s + r.bytes, 0))}（压缩存储）`,
          bytes: sessions.reduce((s, r) => s + r.bytes, 0),
          count: sessions.length,
        },
        {
          id: 'projcache',
          title: '压缩缓存（billion-context）',
          path: PROJCACHE_DIR,
          summary: `${cache.files} 个文件 | ${kb(cache.bytes)}`,
          bytes: cache.bytes,
          count: cache.files,
        },
        {
          id: 'wechat',
          title: '微信账本（我说过/待回/语音转写）',
          path: WX_STATE,
          summary: `外发 ${wx.outbox?.length || 0} 条（其中主动 ${proactiveCount}）| 待回 ${wx.deferred?.length || 0} 条 | 语音转写 ${wx.voices} 条 | 联系人映射 ${Object.keys(wx.sessions || {}).length} 个 | 白名单 ${tierCount} 条`,
          bytes: 0,
          count: (wx.outbox?.length || 0) + (wx.deferred?.length || 0),
        },
        {
          id: 'whale',
          title: '鲸鱼日记与夜间日志（bili-whale）',
          path: whale.root,
          summary:
            Object.entries(whale.files)
              .filter(([, v]) => v.bytes)
              .map(([k, v]) => `${k} ${kb(v.bytes)}`)
              .join(' | ') || '还没有日记',
          bytes: Object.values(whale.files).reduce((s, v) => s + v.bytes, 0),
          count: Object.values(whale.files).filter((v) => v.bytes).length,
        },
        {
          id: 'meme',
          title: '表情包图库',
          path: MEME_DIR,
          summary: `${meme.packs} 个图库 | ${meme.count} 张`,
          bytes: 0,
          count: meme.count,
        },
        {
          id: 'usage',
          title: '用量账本',
          path: USAGE_FILE,
          summary: `余额 ${usage.balance ?? '?'} | 今天 ${usage.today ?? '?'} | ${usage.events} 条流水 | ${usage.days} 天历史`,
          bytes: 0,
          count: usage.events,
        },
        {
          id: 'schedule',
          title: '定时任务',
          path: SCHEDULE_FILE,
          summary: `${schedule.count} 条`,
          bytes: 0,
          count: schedule.count,
        },
        {
          id: 'world',
          title: '世界生活（dsh-world：自述 / 日记 / 生活线）',
          path: WORLDS_DIR,
          summary: await worldSummary(),
          bytes: 0,
          count: 0,
        },
      ];

      return {
        sources,
        total: sources.length,
        note: '只读汇总；每个来源各自维护自己的写入，本工具不会改任何文件。要按关键词跨源找，用 memory_hub_search。',
      };
    },
  });

  register({
    name: 'memory_hub_search',
    description:
      '跨源搜记忆（只读）：在事实卡、会话原文、鲸鱼日记、微信账本、语音转写里按关键词找，返回命中来源 + 片段。scope=all 搜全部；scope=某个聊天目录名（例如 chats-Gypsophila.）只搜那一路会话原文，避免把别人的对话带进当前话题。',
    parameters: {
      query: { type: 'string', description: '要找的词或句子（中文直接写）', required: true },
      limit: { type: 'number', description: '最多几条，默认 12，上限 40' },
      scope: { type: 'string', description: 'all（默认）或会话目录关键词，例如 chats-Gypsophila.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          hits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                source: { type: 'string' },
                where: { type: 'string' },
                when: { type: 'string' },
                snippet: { type: 'string' },
              },
            },
          },
          total: { type: 'number' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value.total) {
          return asText([`「${value.query}」在 ${value.note} 里都没找到。`]);
        }
        const lines = [`「${value.query}」命中 ${value.total} 条：`];
        for (const hit of value.hits || []) {
          const when = hit.when ? `${hit.when} · ` : '';
          lines.push(`· [${hit.source}] ${when}${hit.where}`);
          lines.push(`    ${hit.snippet}`);
        }
        return asText(lines);
      },
    },
    timeoutMs: 180000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const query = text(args?.query);
      const tokens = tokensOf(query);
      const limit = clamp(args?.limit, 1, 40, 12);
      const scope = text(args?.scope) || 'all';
      if (!query || tokens.length === 0) {
        return { query, hits: [], total: 0, note: '没给关键词' };
      }

      const hits = [];
      await searchFish(tokens, hits, limit * 4);
      if (hits.length < limit * 4) await searchWhale(tokens, hits, limit * 4);
      if (hits.length < limit * 4) await searchWorld(tokens, hits, limit * 4);
      if (hits.length < limit * 4) await searchWechat(tokens, hits, limit * 4);
      if (hits.length < limit * 4) await searchSessions(tokens, hits, limit * 4, scope);

      // 先按命中词数排（更相关的在前），再去重 + 每个来源最多 3 条
      hits.sort((a, b) => (b.score || 0) - (a.score || 0));
      const seen = new Set();
      const perSource = new Map();
      const picked = [];
      for (const hit of hits) {
        const signature = `${hit.source}|${hit.snippet.slice(0, 60)}`;
        if (seen.has(signature)) continue;
        const used = perSource.get(hit.source) || 0;
        if (used >= 3) continue;
        seen.add(signature);
        perSource.set(hit.source, used + 1);
        picked.push(hit);
        if (picked.length >= limit) break;
      }

      // 统一成字符串字段：某些来源的时间戳可能缺失（undefined），工具输出校验要求 string
      const clean = picked.map((hit) => ({
        source: String(hit.source || ''),
        score: Number(hit.score) || 0,
        where: String(hit.where || ''),
        when: hit.when === undefined || hit.when === null ? '' : String(hit.when),
        snippet: String(hit.snippet || ''),
      }));

      return {
        query,
        tokens: tokens.map((token) => String(token)),
        hits: clean,
        total: clean.length,
        note: '事实卡 / 鲸鱼日记 / 微信账本 / 会话原文',
      };
    },
  });

  register({
    name: 'memory_hub_brief',
    description:
      '近况摘要（只读）：一次拿到「最近发生了什么」——世界日记最新一天、B 站最近看了什么、我最近对外说过的话、心情、日程、用量。对方问「你最近在干嘛」「世界里发生了什么」「最近刷了什么视频」时用它，比搜索快。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          worldDiary: {
            type: 'object',
            properties: {
              world: { type: 'string' },
              day: { type: 'string' },
              text: { type: 'string' },
            },
          },
          watched: { type: 'array', items: { type: 'string' } },
          said: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                at: { type: 'string' },
                to: { type: 'string' },
                text: { type: 'string' },
                proactive: { type: 'boolean' },
              },
            },
          },
          mood: { type: 'object', properties: { sessions: { type: 'number' } } },
          schedule: { type: 'object', properties: { active: { type: 'number' } } },
          usage: {
            type: 'object',
            properties: {
              balance: { type: 'string' },
              today: { type: 'string' },
            },
          },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const lines = ['【近况】'];
        if (value.worldDiary?.day) {
          lines.push(`世界日记 ${value.worldDiary.day}（${value.worldDiary.world}）：`);
          lines.push(value.worldDiary.text);
        } else {
          lines.push('世界：还没写过日记。');
        }
        if (value.watched?.length) {
          lines.push('', 'B 站最近看的：');
          for (const row of value.watched) lines.push(row);
        }
        if (value.said?.length) {
          lines.push('', '我最近在外面对人说：');
          for (const row of value.said) {
            const mark = row.proactive ? '（主动）' : '';
            const at = row.at ? `${row.at} · ` : '';
            lines.push(`· ${at}[${row.to}]${mark} ${row.text}`);
          }
        }
        lines.push(
          '',
          `心情档案 ${value.mood?.sessions || 0} 份；日程 ${value.schedule?.active || 0} 条未关；余额 ${value.usage?.balance || '?'}，今天已用 ${value.usage?.today || '?'}`,
        );
        lines.push(value.note || '');
        return asText(lines);
      },
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    execute: async () => memoryBrief(),
  });

  // 记忆地图：静态一段，告诉模型记忆在哪、该什么时候查（内容不变，不破坏缓存前缀）
  ctx.systemPrompt.section({
    name: 'memory-hub-map',
    order: 61,
    text: [
      '## 记忆地图',
      '你的记忆不在一处，统一由「记忆总账」看：',
      '- 盘点自己记得什么、存在哪 → memory_hub',
      '- 对方问起过去的事、某个人、某句话 → memory_hub_search',
      '- 对方问你最近在干嘛、世界里有啥新鲜事、最近刷了什么视频 → memory_hub_brief',
      '聊天里说到过去、近况、世界、B 站的时候，先查再说，别凭印象编。',
    ].join('\n'),
  });
}
