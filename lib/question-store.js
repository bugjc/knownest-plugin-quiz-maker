// ============================================================
// quiz-maker - 题目店自持写层（题域退役批次收尾 B1 片 2）
//
// 管什么：本插件全部自店表写语义的插件侧唯一实现——入库（ADR-102 校验+content_hash 去重
//   +日配额[2026-10-15 用户拍板起暂不设限，拦截结构与 KV 计次记账保留]）、作答记账（双轨：practice_attempts 文档轨 + question_attempts/questions 题库轨
//   SM-2 推进）、退回/恢复/清场、纠错回流（分型自动处置）、嵌入缓存写读、题库计数。
//   全部经 ctx.store（自店前缀钳制原语）与 ctx.storage（plugin_kv 配额记账）落地。
// 不管什么：宿主 IPC 写面（题组判分 recordAttempt/反馈/清场——渲染层 D4 渲染入口，内核执行闸
//   长期在册）；产品事件广播（emitProductEvent 为宿主内核面，插件写路径不广播——题库页按需
//   重拉，徽标/托盘信号以宿主 IPC 写面为准）；文档轨调度权威公式在 core/knowledge（本文件
//   为插件侧镜像副本，公式漂移须与 core/knowledge/schedule.ts、question-types.ts 双侧同步，
//   同 toAnkiTsvCopy 副本纪律）。
// 被谁调用：index.js（questions 资产写门四方法 + 题库页行级动作 + practiceInstant/importBank）
//   + tools/practice-tools.js（出题入库/嵌入缓存）+ tools/learning-tools.js（作答/纠错回流）。
// 契约纪律：questions 资产写门的方法名/参数/返回形状/错误码不变（四消费方零改动）——本文件
//   接管的是实现归属（宿主属主 ctx 单点 → 插件自持），不是契约。
// ============================================================

const SEM = require('./semantic-dedup')

/** 纯 JS SHA-1（content_hash 去重指纹用；沙箱禁 require("crypto") 内置模块——ADR-300 L7，
 *  真机门实证 activate.failed）。算法与 Node crypto.update(utf8).digest('hex') 逐字节一致：
 *  输入经 UTF-8 编码（与原宿主属主面 sha1 同字节序）——存量库 content_hash 判重兼容不变。 */
function sha1Hex(input) {
  const bytes = []
  for (const ch of String(input)) {
    const c = ch.codePointAt(0)
    if (c < 0x80) bytes.push(c)
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  const bitLen = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  const hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0
  bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255,
    (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255)
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0
  const w = new Array(80)
  for (let i = 0; i < bytes.length; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = (bytes[i + j * 4] << 24) | (bytes[i + j * 4 + 1] << 16) | (bytes[i + j * 4 + 2] << 8) | bytes[i + j * 4 + 3]
    for (let j = 16; j < 80; j++) { const n = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16]; w[j] = (n << 1) | (n >>> 31) }
    let a = h0, b = h1, c = h2, d = h3, e = h4
    for (let j = 0; j < 80; j++) {
      let f, k
      if (j < 20) { f = (b & c) | (~b & d); k = 0x5a827999 }
      else if (j < 40) { f = b ^ c ^ d; k = 0x6ed9eba1 }
      else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc }
      else { f = b ^ c ^ d; k = 0xca62c1d6 }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[j]) | 0
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0
  }
  return [h0, h1, h2, h3, h4].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('')
}

/** 单插件单日题目入库上限（原 ADR-201 §2.1 merge-data 体量防线，原值 200——周级健康分
 *  是慢反馈，防不住当天灌入污染复习队列）。
 *  2026-10-15 用户拍板：配额机制待完善暂不设限（B4.5 后分享导入走本写门，导入是显式批量
 *  动作不应受限）——置 Infinity 使下方拦截判断（count >= 上限）永假；拦截结构与 KV 计次
 *  记账原样保留（台账可观测，后续完善配额时只改本常量即启用，且有历史数据可依）。 */
const MAX_INSERT_QUESTIONS_PER_DAY = Infinity

/** 配额记账（plugin_kv）：计次以入库调用为准（含去重/拒收——防低成本刷量）；跨日清零、
 *  持久化插件 KV（重启不重置当日额度，与宿主原 plugin-quota.json 同语义） */
const QUOTA_NS = 'quota'
const QUOTA_KEY = 'question-insert'

function todayStr(d = new Date()) {
  return d.toISOString().slice(0, 10)
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 10)
}

/**
 * 缺包边界守卫（题库页消费面）：quiz_maker_questions 不在册 = 店表迁移未完成（全新库缺包/
 * 半路失败）——返回引导文案，调用方转结构化 error（可观测，不裸抛 sqlite 错）。
 * store 面不可用（旧宿主/测试桩）返回 null 放行走既有查询路径。
 */
async function storeMissingNotice(ctx) {
  try {
    if (!ctx || typeof ctx.store?.listTables !== 'function') return null
    const tables = (await ctx.store.listTables()) || []
    return tables.includes('quiz_maker_questions')
      ? null
      : '题库数据表缺失：练习店表迁移未完成——请重启应用，或在「插件」页停用再启用「练习」后重试'
  } catch {
    return null
  }
}

// ==================== 入库（ADR-102：source_snippet 强制 + 去重 + 日配额） ====================

/**
 * 题目入库（自店写，questions 资产写门 insertQuestion 的实现体）。
 * @returns { id, created, duplicate, reason?, quotaExceeded? }——契约与原宿主属主面逐字段一致
 */
async function insertQuestion(ctx, q) {
  q = q || {}
  // 日配额（计次含去重/拒收，先计次再校验——与宿主原语义一致；记账失败不阻塞配额判定）。
  //  B4.6（2026-10-15 用户拍板）起上限=Infinity 永不拦截，记账照记（台账可观测，结构保留）
  let quota = { day: todayStr(), count: 0 }
  try {
    const saved = await ctx.storage.get(QUOTA_NS, QUOTA_KEY)
    if (saved && typeof saved === 'object' && saved.day === todayStr()) quota = { day: saved.day, count: Number(saved.count) || 0 }
  } catch { /* KV 不可用按零计 */ }
  if (quota.count >= MAX_INSERT_QUESTIONS_PER_DAY) {
    return {
      id: '', created: false, duplicate: false, quotaExceeded: true,
      reason: `quota_exceeded: 单插件单日入库配额（${MAX_INSERT_QUESTIONS_PER_DAY}）已满`,
    }
  }
  try { await ctx.storage.set(QUOTA_NS, QUOTA_KEY, { day: quota.day, count: quota.count + 1 }) } catch { /* 记账失败不阻塞 */ }

  if (!q.documentId) return { id: '', created: false, duplicate: false, reason: '缺少 documentId' }
  if (!q.question || !String(q.question).trim()) return { id: '', created: false, duplicate: false, reason: '缺少 question' }
  if (!q.answer || !String(q.answer).trim()) return { id: '', created: false, duplicate: false, reason: '缺少 answer' }
  // ADR-102 地基①：原文引用片段强制
  if (!q.sourceSnippet || !String(q.sourceSnippet).trim()) {
    return { id: '', created: false, duplicate: false, reason: 'source_snippet 必填（须引用原文片段，禁止编造）' }
  }

  const question = String(q.question).trim()
  const answer = String(q.answer).trim()
  const snippet = String(q.sourceSnippet).trim()
  // ADR-102 地基②：同文档 content_hash 去重（retired 不算重复——下架是显式移除，重建应插新卡）
  const contentHash = sha1Hex(`${q.type}|${question}|${JSON.stringify(q.options || [])}|${answer}`)
  const dupRows = (await ctx.store.query(
    "SELECT id FROM quiz_maker_questions WHERE document_id = ? AND content_hash = ? AND status != 'retired'",
    [q.documentId, contentHash]
  )) || []
  if (dupRows[0] && dupRows[0].id) return { id: String(dupRows[0].id), created: false, duplicate: true }

  const id = newId()
  const now = new Date().toISOString()
  // repo_id 快照（宿主原版经 INSERT 子查询取 documents.repo_id——ctx.store 词法钳制禁跨表，
  // 改为先行只读解析后直插，行为等价；文档缺失时 repo_id 落 NULL 与子查询 NULL 同语义）
  let repoId = null
  try {
    const rows = (await ctx.query('SELECT repo_id AS repoId FROM documents WHERE id = ?', [q.documentId])) || []
    repoId = rows[0]?.repoId ?? null
  } catch { /* 文档读不到按 NULL（悬空题既有形态） */ }
  const r = await ctx.store.exec(
    `INSERT INTO quiz_maker_questions
     (id, document_id, repo_id, knowledge_point_id, type, question, options_json, answer, explanation, source_snippet, content_hash, plugin_id, status, schema_version, verified, generator, cognitive_level, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, q.documentId, repoId, q.knowledgePointId || null, String(q.type || ''),
      question, JSON.stringify(q.options || []), answer,
      q.explanation || '', snippet, contentHash,
      q.pluginId || '', 'confirmed', 1,
      q.verified ? 1 : 0, String(q.generator || '').trim(),
      ['记忆', '理解', '应用'].includes(String(q.cognitiveLevel || '').trim()) ? String(q.cognitiveLevel).trim() : '',
      now, now,
    ]
  )
  if (!r || !r.ok) {
    return { id: '', created: false, duplicate: false, reason: `数据库写入失败: ${(r && r.error) || '未知错误'}` }
  }
  return { id, created: true, duplicate: false }
}

// ==================== 作答记账（双轨 + SM-2 题级推进） ====================

// ---- 判分器（core/knowledge/question-types.ts 服务端策略表的插件侧镜像副本；公式漂移双侧同步）----

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '').replace(/[（）]/g, '(').replace(/[（）]/g, ')')
  .replace(/，/g, ',').replace(/：/g, ':')

function parseArray(text) {
  try {
    const v = JSON.parse(text)
    return Array.isArray(v) ? v.map((x) => String(x)) : []
  } catch {
    return text ? text.split(/[,，、]/).map((x) => x.trim()).filter(Boolean) : []
  }
}

function tokenizeSentence(s) {
  return String(s ?? '')
    .split(/\s+/)
    .map((t) => t.toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, ''))
    .filter(Boolean)
}

/** 听写词级对齐（LCS 锚点 + 缺口顺序配对）——core 唯一实现的镜像副本 */
function gradeDictationTokens(answer, response) {
  const want = tokenizeSentence(answer)
  const got = tokenizeSentence(response)
  const m = want.length
  const n = got.length
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = want[i] === got[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const anchors = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (want[i] === got[j]) { anchors.push([i, j]); i++; j++ } else if (dp[i + 1][j] >= dp[i][j + 1]) { i++ } else { j++ }
  }
  let extras = 0
  for (let seg = 0; seg <= anchors.length; seg++) {
    const wStart = seg === 0 ? 0 : anchors[seg - 1][0] + 1
    const wEnd = seg < anchors.length ? anchors[seg][0] : m
    const gStart = seg === 0 ? 0 : anchors[seg - 1][1] + 1
    const gEnd = seg < anchors.length ? anchors[seg][1] : n
    extras += Math.max(0, (gEnd - gStart) - (wEnd - wStart))
  }
  return { hits: anchors.length, total: m, extras }
}

const graders = {
  single_choice: (q, resp) => {
    const correct = norm(resp) !== '' && norm(resp) === norm(q.answer) ? 1 : 0
    return { correct, quality: correct ? 4 : 2 }
  },
  true_false: (q, resp) => {
    const t = norm(resp), a = norm(q.answer)
    const hit = (t === '正确' || t === 'true' || t === '对') === (a === '正确' || a === 'true' || a === '对')
    return { correct: hit ? 1 : 0, quality: hit ? 4 : 2 }
  },
  multi_choice: (q, resp) => {
    const picked = new Set(parseArray(resp).map(norm))
    const answer = parseArray(q.answer).map(norm)
    if (answer.length === 0 || picked.size === 0) return { correct: 0, quality: 0 }
    const hits = answer.filter((a) => picked.has(a)).length
    const wrongPicks = [...picked].filter((p) => !answer.includes(p)).length
    const exact = hits === answer.length && wrongPicks === 0
    const ratio = Math.max(0, (hits - wrongPicks) / answer.length)
    return { correct: exact ? 1 : 0, quality: Math.min(5, Math.round(ratio * 5)) }
  },
  fill_blank: (q, resp) => {
    const variants = q.answers && q.answers.length ? q.answers.map(norm) : parseArray(q.answer).map(norm)
    const hit = variants.includes(norm(resp))
    return { correct: hit ? 1 : 0, quality: hit ? 5 : 0 }
  },
  ordering: (q, resp) => {
    const want = parseArray(q.answer).map(norm)
    const got = parseArray(resp).map(norm)
    if (got.length !== want.length) return { correct: 0, quality: 0 }
    let rightPos = 0
    for (let i = 0; i < want.length; i++) if (got[i] === want[i]) rightPos++
    return { correct: rightPos === want.length ? 1 : 0, quality: Math.round((rightPos / want.length) * 5) }
  },
  dictation: (q, resp) => {
    const r = gradeDictationTokens(q.answer, resp)
    const exact = r.hits === r.total && r.extras === 0
    const ratio = r.total > 0 ? r.hits / r.total : 0
    const quality = exact ? 5 : Math.max(0, Math.min(3, Math.round(ratio * 5)))
    return { correct: exact ? 1 : 0, quality, note: `命中 ${r.hits}/${r.total}` }
  },
  short_answer: () => ({ correct: null, quality: 2, note: '主观题按自评回流' }),
  mixed: () => ({ correct: null, quality: 2, note: '混合题型按子题判分' }),
}

function gradeResponse(question, response) {
  const grader = graders[question.type]
  if (!grader) return { correct: null, quality: 2, note: '未知题型，按自评处理' }
  return grader(question, response)
}

// ---- SM-2 单步推进（core/knowledge/schedule.ts calculateSM2 镜像副本；公式变更双侧同步）----

function calculateSM2(quality, easeFactor, interval, repetition) {
  let newEF = easeFactor
  let newRep = repetition
  let newInterval = interval
  if (quality >= 3) {
    newRep += 1
    if (newRep === 1) {
      newInterval = 1
    } else if (newRep === 2) {
      newInterval = 6
    } else {
      newInterval = Math.round(newInterval * newEF)
    }
  } else {
    newRep = 0
    newInterval = 1
  }
  newEF = Math.max(1.3, newEF + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)))
  return { easeFactor: newEF, interval: newInterval, repetition: newRep }
}

/**
 * SM-2 输入净化（容错守卫，v0.41.6 存量脏数据热修）：存量 doc_review/questions 行可能
 * 携带非有限 ease_factor/interval_days/repetition（旧版本写入/迁移遗留）——脏值乘进
 * SM-2 会产出 NaN interval → `new Date(NaN).toISOString()` 抛 RangeError: Invalid time
 * value，炸穿 recordAttempt 全链（沉浸做题面板/探针播种链均受害）。
 * 语义=「从未复习」默认档（非法值视为无调度历史，=到期可练）；合法有限值逐字透传，
 * 既有合法数据行为零变化。
 */
function sm2SeedOf(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** 派生到期时间的 ISO 化（容错守卫）：interval 异常残留 NaN 时按「从未复习」回退 1 天，
 *  不让 Invalid Date 流入 toISOString（双保险，与 sm2SeedOf 同语义） */
function nextReviewIsoOf(intervalDays) {
  const iv = Number.isFinite(Number(intervalDays)) && Number(intervalDays) > 0 ? Number(intervalDays) : 1
  const d = new Date(Date.now() + iv * 24 * 60 * 60 * 1000)
  return d.toISOString()
}

/**
 * 作答记账（题库轨入口：questionId 兜底回读题库；原宿主 recordQuestionAttempt 语义自持）。
 * 双轨：practice_attempts 文档轨（自包含快照 + doc_review SM-2）+ question_attempts/questions
 * 题库轨（题级 SM-2 推进）。返回 { id, questionId, correct, quality, reactionMs, answeredAt }。
 */
async function recordAttempt(ctx, a) {
  a = a || {}
  const rows = (await ctx.store.query('SELECT * FROM quiz_maker_questions WHERE id = ?', [a.questionId])) || []
  const bankQ = rows[0]
  if (!bankQ) throw new Error(`题目不存在: ${a.questionId}`)
  if (!bankQ.documentId) throw new Error(`题目未挂文档，无法按文档记账: ${a.questionId}`)

  // ① 判分：客观题统一走判分策略表（selectedOption 布尔=判断题）
  let selected = a.selectedOption
  if (typeof selected === 'string' && /^(true|false)$/i.test(selected.trim())) {
    selected = selected.trim().toLowerCase() === 'true'
  }
  const responseText = typeof selected === 'boolean' ? (selected ? '正确' : '错误') : typeof selected === 'string' ? selected : ''
  let correct = null
  let quality = typeof a.quality === 'number' ? a.quality : null
  const AUTO_GRADED_TYPES = ['single_choice', 'multi_choice', 'true_false', 'fill_blank', 'ordering', 'dictation']
  if (AUTO_GRADED_TYPES.includes(bankQ.type) && responseText) {
    const options = (() => { try { const v = JSON.parse(bankQ.optionsJson || '[]'); return Array.isArray(v) ? v.map(String) : [] } catch { return [] } })()
    const g = gradeResponse({ type: bankQ.type, answer: bankQ.answer, options }, responseText)
    correct = g.correct
    if (quality === null) quality = g.quality
  }
  if (correct !== null && quality === null) {
    quality = correct === 1 ? 4 : 2
  }

  const id = newId()
  const now = new Date().toISOString()
  // ② was_due 快照（作答时刻文档到期状态）：先于 SM-2 更新取值；复习态空 = 从未练习 = 立即到期。
  //    文档存续单独读（悬空文档兜底）：作答照记不丢（was_due=1），仅跳过调度更新。
  let docExists = false
  try {
    docExists = (((await ctx.query('SELECT 1 AS x FROM documents WHERE id = ?', [bankQ.documentId])) || [])[0] != null)
  } catch { docExists = false }
  const docRev = ((await ctx.store.query('SELECT next_review_at AS nextReviewAt FROM quiz_maker_doc_review WHERE doc_id = ?', [bankQ.documentId])) || [])[0]
  // 到期判定（脏值守卫 v0.41.6）：next_review_at 非法（不可解析日期=等同从未复习）按到期计
  const docRevDueMs = docRev && docRev.nextReviewAt ? new Date(docRev.nextReviewAt).getTime() : NaN
  const wasDue = !docExists || !docRev?.nextReviewAt || !Number.isFinite(docRevDueMs) || docRevDueMs <= Date.parse(now) ? 1 : 0

  // ③ 流水落 practice_attempts：快照自包含（回看/复盘不依赖题库；stats 归因按 $.id 关联）
  const snapshot = JSON.stringify({
    id: bankQ.id,
    type: bankQ.type,
    question: bankQ.question,
    options: (() => { try { return JSON.parse(bankQ.optionsJson || '[]') } catch { return [] } })(),
    answer: bankQ.answer,
    explanation: bankQ.explanation,
    sourceSnippet: bankQ.sourceSnippet,
    pluginId: bankQ.pluginId,
    response: responseText,
    correct,
    quality,
  })
  await ctx.store.exec(
    `INSERT INTO quiz_maker_practice_attempts
     (id, document_id, question_snapshot, question_type, plugin_id, correct, quality, reaction_ms, was_due, response_text, answered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, bankQ.documentId, snapshot, bankQ.type, bankQ.pluginId, correct, quality, a.reactionMs ?? null, wasDue, responseText || null, now]
  )

  // ④ SM-2 文档级调度：doc_review 店表 upsert（行缺省按 SM-2 默认值起算；脏值按
  //    「从未复习」默认档净化——v0.41.6 容错守卫，合法值零变化）
  if (quality !== null && docExists) {
    const cur = docRev || {}
    const sm2 = calculateSM2(quality, sm2SeedOf(cur.easeFactor, 2.5), sm2SeedOf(cur.intervalDays, 1), sm2SeedOf(cur.repetition, 0))
    await ctx.store.exec(
      'INSERT OR REPLACE INTO quiz_maker_doc_review (doc_id, ease_factor, interval_days, repetition, next_review_at) VALUES (?, ?, ?, ?, ?)',
      [bankQ.documentId, sm2.easeFactor, sm2.interval, sm2.repetition, nextReviewIsoOf(sm2.interval)]
    )
  }

  // ⑤ 题库轨回流：question_attempts 双写 + questions SM-2 推进
  const qDueMs = bankQ.nextReviewAt ? new Date(bankQ.nextReviewAt).getTime() : NaN
  const qWasDue = !bankQ.nextReviewAt || !Number.isFinite(qDueMs) || qDueMs <= Date.parse(now) ? 1 : 0
  await ctx.store.exec(
    'INSERT INTO quiz_maker_question_attempts (id, question_id, correct, quality, reaction_ms, was_due, response_text, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [newId(), bankQ.id, correct, quality, a.reactionMs ?? null, qWasDue, responseText || null, now]
  )
  if (quality !== null) {
    const sm2 = calculateSM2(quality, sm2SeedOf(bankQ.easeFactor, 2.5), sm2SeedOf(bankQ.intervalDays, 1), sm2SeedOf(bankQ.repetition, 0))
    await ctx.store.exec(
      'UPDATE quiz_maker_questions SET ease_factor = ?, interval_days = ?, repetition = ?, next_review_at = ?, updated_at = ? WHERE id = ?',
      [sm2.easeFactor, sm2.interval, sm2.repetition, nextReviewIsoOf(sm2.interval), now, bankQ.id]
    )
  }
  return { id, questionId: a.questionId, correct, quality, reactionMs: a.reactionMs ?? null, answeredAt: now }
}

// ==================== 退回/恢复/清场/纠错回流 ====================

/** 退回题目（差评题退出复习队列；可经 restoreQuestion 恢复） */
async function retireQuestion(ctx, questionId) {
  await ctx.store.exec("UPDATE quiz_maker_questions SET status = 'retired', updated_at = ? WHERE id = ?", [new Date().toISOString(), questionId])
}

/** 恢复已退回题目（retired → confirmed，回复习调度；幂等） */
async function restoreQuestion(ctx, questionId) {
  await ctx.store.exec("UPDATE quiz_maker_questions SET status = 'confirmed', updated_at = ? WHERE id = ?", [new Date().toISOString(), questionId])
}

/** 物理清空全部已下架题（不可逆硬删除）。返回删除行数供回执用户语言 */
async function purgeRetiredQuestions(ctx) {
  const r = await ctx.store.exec("DELETE FROM quiz_maker_questions WHERE status = 'retired'")
  return Number(r && r.changes) || 0
}

/** 按出题者清理退役题的反馈行（探针数据隔离：退役题反馈仍参与健康度统计，夹具需可清）。
 *  generator 须为非空字符串（与原宿主面同语义，违规抛错） */
async function purgeRetiredQuestionFeedback(ctx, generator) {
  if (typeof generator !== 'string' || !generator.trim()) throw new Error('generator 必须为非空字符串')
  const r = await ctx.store.exec(
    "DELETE FROM quiz_maker_question_feedback WHERE question_id IN (SELECT id FROM quiz_maker_questions WHERE generator = ? AND status = 'retired')",
    [generator]
  )
  return Number(r && r.changes) || 0
}

/**
 * 用户纠错/评价回流（分型自动处置）：
 *  - wrong_answer（答案有误）：1 次即下架——答案错误是不可信题，零容忍
 *  - bad_question（题目有问题）：有效差评（bad − good 抵消）≥2 下架——防难题被误杀
 *  - good_question：不处置，且每次抵消一条 bad_question
 * 差评且关联本次作答（attemptId）→ 计分豁免（该次作答 correct/quality 置空）。
 */
async function flagQuestionFeedback(ctx, fb) {
  fb = fb || {}
  if (!fb.questionId && !fb.documentId) throw new Error('反馈需要 questionId（题库题）或 documentId（即时题）之一')
  const id = newId()
  const now = new Date().toISOString()
  await ctx.store.exec(
    'INSERT INTO quiz_maker_question_feedback (id, question_id, document_id, attempt_id, kind, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, fb.questionId || null, fb.documentId || null, fb.attemptId || null, fb.kind, fb.note || '', now]
  )
  // 计分豁免：差评且关联了本次作答 → 该次作答不计分
  if (fb.attemptId && fb.kind !== 'good_question') {
    await ctx.store.exec('UPDATE quiz_maker_practice_attempts SET correct = NULL, quality = NULL WHERE id = ?', [fb.attemptId])
  }
  const disposition = { retired: false, reason: '' }
  if (fb.questionId) {
    const counts = (await ctx.store.query('SELECT kind, COUNT(*) AS n FROM quiz_maker_question_feedback WHERE question_id = ? GROUP BY kind', [fb.questionId])) || []
    const byKind = new Map(counts.map((r) => [r.kind, Number(r.n) || 0]))
    const wrongCount = byKind.get('wrong_answer') || 0
    const badCount = byKind.get('bad_question') || 0
    const goodCount = byKind.get('good_question') || 0
    if (wrongCount >= 1) {
      disposition.retired = true
      disposition.reason = '答案有误'
    } else if (badCount - goodCount >= 2) {
      disposition.retired = true
      disposition.reason = '多次被标记题目有问题'
    }
    if (disposition.retired) {
      await ctx.store.exec("UPDATE quiz_maker_questions SET status = 'retired', updated_at = ? WHERE id = ?", [now, fb.questionId])
    }
  } else if (fb.kind !== 'good_question' && fb.documentId) {
    disposition.reason = '已记录，该次作答不计入正确率'
  }
  return {
    id,
    questionId: fb.questionId || null,
    documentId: fb.documentId || null,
    attemptId: fb.attemptId || null,
    kind: fb.kind,
    note: fb.note || '',
    createdAt: now,
    disposition,
  }
}

// ==================== 读面辅助（自店口径，页面对账用） ====================

/** 题库数原子口径（未下架题数；repoId 时仓内口径：来源文档属仓或 repo_id 快照属仓） */
async function getBankCount(ctx, repoId) {
  const scopeWhere = repoId
    ? "WHERE status != 'retired' AND (document_id IN (SELECT id FROM documents WHERE repo_id = ?) OR repo_id = ?)"
    : "WHERE status != 'retired'"
  const params = repoId ? [repoId, repoId] : []
  const rows = (await ctx.query(`SELECT COUNT(*) AS n FROM quiz_maker_questions ${scopeWhere}`, params)) || []
  return Number(rows[0]?.n) || 0
}

// ==================== 嵌入缓存（语义去重落缓存，自店表） ====================

/** 保存题目嵌入（Float32 小端 BLOB；入库成功后调用；upsert 幂等） */
async function saveEmbedding(ctx, questionId, vector, model) {
  if (!questionId || !Array.isArray(vector) || vector.length === 0) return
  const bytes = new Uint8Array(Float32Array.from(vector).buffer)
  const existed = ((await ctx.store.query('SELECT 1 AS x FROM quiz_maker_question_embeddings WHERE question_id = ?', [questionId])) || [])[0]
  if (existed) {
    await ctx.store.exec(
      'UPDATE quiz_maker_question_embeddings SET model = ?, dim = ?, vector = ? WHERE question_id = ?',
      [model || 'text-embedding-3-small', vector.length, bytes, questionId]
    )
  } else {
    await ctx.store.exec(
      'INSERT INTO quiz_maker_question_embeddings (question_id, model, dim, vector, created_at) VALUES (?, ?, ?, ?, ?)',
      [questionId, model || 'text-embedding-3-small', vector.length, bytes, new Date().toISOString()]
    )
  }
}

/** 全量嵌入（按模型过滤——不同模型的向量空间不可比；语义去重检索用）。
 *  返回 [{ questionId, dim, vector: Float32Array }]，形态与原宿主 getAllQuestionEmbeddings 一致 */
async function loadEmbeddings(ctx, model, limit = 2000) {
  const rows = (await ctx.store.query(
    'SELECT question_id, dim, vector FROM quiz_maker_question_embeddings WHERE model = ? LIMIT ?',
    [model, limit]
  )) || []
  const out = []
  for (const r of rows) {
    const dim = Number(r.dim) || 0
    const blob = r.vector
    if (!(blob instanceof Uint8Array) || dim <= 0) continue
    out.push({ questionId: String(r.questionId), dim, vector: new Float32Array(blob.buffer, blob.byteOffset, dim) })
  }
  return out
}

/**
 * 语义去重检索（原宿主属主面 findSemanticDuplicates 语义自持：嵌入经 ctx.embed 平台能力面，
 * ai:chat 按调用方计费）。返回 { available, model, vector, similar, note? }——available=false
 * 时调用方跳过（去重是增强不是硬门）。
 */
async function findSemanticDuplicates(ctx, question, opts = {}) {
  const text = String(question || '').trim()
  if (!text) return { available: true, model: '', vector: [], similar: [] }
  const model = opts.model || 'text-embedding-3-small'
  let vectors = null
  try {
    vectors = (await ctx.embed({ texts: [text], model })).vectors
  } catch (err) {
    // ctx.embed 无 Provider/超预算时抛错——去重是增强不是硬门，按不可用降级（同原 no_provider 语义）
    return { available: false, model: '', vector: [], similar: [], note: 'no_provider' }
  }
  const vector = vectors?.[0]
  if (!vector || vector.length === 0) {
    return { available: false, model, vector: [], similar: [], note: 'embed_empty' }
  }
  const cached = await loadEmbeddings(ctx, model)
  const similar = SEM.topSimilar(vector, cached.map((r) => ({ questionId: r.questionId, vector: r.vector })), {
    threshold: opts.threshold,
    limit: opts.limit,
  })
  try { ctx.log(`[quiz-maker] semanticDedup: ${cached.length} cached, ${similar.length} similar`) } catch { /* 日志面缺失不阻塞 */ }
  return { available: true, model, vector: Array.from(vector), similar }
}

module.exports = {
  MAX_INSERT_QUESTIONS_PER_DAY,
  QUOTA_NS,
  QUOTA_KEY,
  storeMissingNotice,
  insertQuestion,
  recordAttempt,
  retireQuestion,
  restoreQuestion,
  purgeRetiredQuestions,
  purgeRetiredQuestionFeedback,
  flagQuestionFeedback,
  getBankCount,
  saveEmbedding,
  loadEmbeddings,
  findSemanticDuplicates,
  // 判分/调度纯函数出口（测试对账锚；业务面勿绕过本层直调）
  gradeResponse,
  calculateSM2,
}
