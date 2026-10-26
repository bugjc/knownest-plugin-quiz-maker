// ============================================================
// Knownest - 学习口径库（quiz-maker 侧唯一权威实现）
// 管什么：平台化「统计口径单一实现铁律」的 quiz-maker 侧承载——原 kernel
//   storage-service 七个读口径（getQuestions/getQuestionsForReview/studySummary/
//   getDocStats/getDueBreakdown/getStreak/getWeakDocs/getQuestionBankHealth）
//   逐字移植，读面 = 自店表（quiz_maker_*）+ 平台白名单（documents/
//   knowledge_points/taxonomy_semantics），经插件 ctx.query 全量合法。
// 不管什么：写面（insertQuestion/recordAttempt 等走 ctx 方法=D4 跨域写面）；
//   kernel IPC 自身消费（practice:overview 等读 storageService 为内核内部面）。
// 被谁调用：index.js（资产方法与页面/工具）+ tools/learning-tools.js +
//   tools/study-coach-tools.js。kernel 同名方法已随方法族下线批摘除（2026-10-12）。
// 移植纪律：SQL 与输出契约逐字保持（camelCase 别名直出），改口径须双侧同步发版。
// ============================================================

const Q = 'quiz_maker_questions'
const QA = 'quiz_maker_question_attempts'
const QF = 'quiz_maker_question_feedback'
const PA = 'quiz_maker_practice_attempts'

/** 题目池查询（kernel getQuestions 移植）：filters 全兼容，行=camelCase 契约键 */
async function getQuestions(query, filter = {}) {
  const where = []
  const params = []
  if (filter.documentId) { where.push('q.document_id = ?'); params.push(filter.documentId) }
  if (filter.documentIds && filter.documentIds.length) { where.push(`q.document_id IN (${filter.documentIds.map(() => '?').join(',')})`); params.push(...filter.documentIds) }
  if (filter.ids && filter.ids.length) { where.push(`q.id IN (${filter.ids.map(() => '?').join(',')})`); params.push(...filter.ids) }
  if (filter.knowledgePointId) { where.push('q.knowledge_point_id = ?'); params.push(filter.knowledgePointId) }
  if (filter.type) { where.push('q.type = ?'); params.push(filter.type) }
  if (filter.status) { where.push('q.status = ?'); params.push(filter.status) }
  if (filter.pluginId) { where.push('q.plugin_id = ?'); params.push(filter.pluginId) }
  if (filter.repoId) { where.push('(q.document_id IN (SELECT id FROM documents WHERE repo_id = ?) OR q.repo_id = ?)'); params.push(filter.repoId, filter.repoId) }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const limitSql = filter.limit ? ` LIMIT ${Math.min(500, filter.limit)}` : ''
  const offsetSql = filter.offset ? ` OFFSET ${filter.offset}` : ''
  const rows = await query(
    `SELECT q.id, q.document_id AS documentId, q.knowledge_point_id AS knowledgePointId,
            q.repo_id AS repoId, q.type, q.question, q.options_json AS optionsJson, q.answer,
            q.explanation, q.source_snippet AS sourceSnippet, q.content_hash AS contentHash,
            q.plugin_id AS pluginId, q.status, q.schema_version AS schemaVersion,
            q.created_at AS createdAt, q.updated_at AS updatedAt,
            q.ease_factor AS easeFactor, q.interval_days AS intervalDays,
            q.repetition, q.next_review_at AS nextReviewAt, q.verified,
            q.cognitive_level AS cognitiveLevel, q.generator,
            COUNT(a.id) AS attempts
     FROM ${Q} q
     LEFT JOIN ${QA} a ON a.question_id = q.id
     ${whereSql} GROUP BY q.id ORDER BY q.created_at DESC${limitSql}${offsetSql}`,
    params
  )
  return (rows || []).map((r) => ({ ...r, attempts: Number(r.attempts) || 0 }))
}

/** 题级到期队列（kernel getQuestionsForReview 移植，@deprecated 题级调度兼容面） */
async function getQuestionsForReview(query, limit = 15, repoId) {
  const now = new Date().toISOString()
  const repoScope = repoId ? 'AND (q.document_id IN (SELECT id FROM documents WHERE repo_id = ?) OR q.repo_id = ?)' : ''
  const params = repoId ? [now, repoId, repoId, limit] : [now, limit]
  return (await query(
    `SELECT q.*, MAX(a.answered_at) AS lastAttemptAt, COUNT(a.id) AS attemptCount
     FROM ${Q} q
     LEFT JOIN ${QA} a ON a.question_id = q.id
     WHERE q.status = 'confirmed'
       AND (q.next_review_at IS NULL OR q.next_review_at <= ?)
       ${repoScope}
     GROUP BY q.id
     ORDER BY (q.next_review_at IS NULL) ASC, q.next_review_at ASC, q.created_at ASC
     LIMIT ?`,
    params
  )) || []
}

/** sys-hub 系统仓名：判定来源=内核唯一常量 SYS_HUB_REPO_NAME（storage-service.ts，
 *  收敛点批 2026-10-10）——插件 lib 不可 require 内核层，命名与语义同源镜像（先例：
 *  morning-report 仓库名归属判定）；sys-hub 排除口径变更须内核/本侧双侧同步。 */
const SYS_HUB_REPO_NAME = 'sys-hub'

/** 到期三数字（kernel getDueBreakdown 移植）：行缺省 = 从未练习 = 立即到期。
 *  sys-hub 排除（2026-10-17 产品裁决，与内核侧双侧同步）：知识导航树结构性排除 sys-hub
 *  仓库（getDocTreeRows 同一仓库归属判定），D1-A「托盘/通知/徽标/树 ⏰ 四方同数」不变式
 *  在收件箱碎片等系统产物带 SM-2 调度时必破（真机实证：树 ⏰=5 徽标=6，差=sys.inbox
 *  碎片）——催办口径随树对齐：系统产物属即时轨，到期由收件箱/文档视图自身承载，不计入
 *  跨仓催办；三数字同查询同步排除（同源互洽不破） */
async function getDueBreakdown(query, now = new Date()) {
  const nowIso = now.toISOString()
  const rows = (await query(
    `SELECT
       SUM(CASE WHEN dr.doc_id IS NULL OR dr.next_review_at IS NULL OR dr.next_review_at <= ? THEN 1 ELSE 0 END) AS dueAll,
       SUM(CASE WHEN dr.next_review_at IS NOT NULL AND dr.next_review_at <= ? THEN 1 ELSE 0 END) AS dueWithHistory,
       SUM(CASE WHEN dr.doc_id IS NULL OR dr.next_review_at IS NULL THEN 1 ELSE 0 END) AS neverPracticed
     FROM documents d
     JOIN repositories r ON r.id = d.repo_id
     LEFT JOIN quiz_maker_doc_review dr ON dr.doc_id = d.id
     WHERE r.name != '${SYS_HUB_REPO_NAME}'`,
    [nowIso, nowIso]
  )) || []
  const r = rows[0] || {}
  return {
    dueAll: Number(r.dueAll) || 0,
    dueWithHistory: Number(r.dueWithHistory) || 0,
    neverPracticed: Number(r.neverPracticed) || 0,
  }
}

/** 连击原子口径（kernel getStreak 移植）：两轨 UNION 按日回数，数量恒走文档轨 */
async function getStreak(query, now = new Date()) {
  const dayStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const today = dayStr(now)
  const yesterday = dayStr(new Date(now.getTime() - 86400000))
  const since = new Date(now.getTime() - 120 * 86400000).toISOString()
  const rows = (await query(
    `SELECT DISTINCT DATE(answered_at, 'localtime') AS day FROM ${PA} WHERE answered_at >= ?
     UNION
     SELECT DISTINCT DATE(answered_at, 'localtime') AS day FROM ${QA} WHERE answered_at >= ?`,
    [since, since]
  )) || []
  const days = new Set(rows.map((r) => String(r.day)))
  let streakDays = 0
  const cursor = new Date(now.getTime() - 86400000)
  while (days.has(dayStr(cursor)) && streakDays < 365) {
    streakDays++
    cursor.setDate(cursor.getDate() - 1)
  }
  const countDay = async (day) => {
    const r = ((await query(`SELECT COUNT(*) AS n FROM ${PA} WHERE DATE(answered_at, 'localtime') = ?`, [day])) || [])[0]
    return Number(r?.n) || 0
  }
  return { streakDays, answeredToday: await countDay(today), answeredYesterday: await countDay(yesterday) }
}

/** 薄弱文档原子口径（kernel getWeakDocs 移植）：正确率<60% 按作答数降序 */
async function getWeakDocs(query, limit = 5) {
  const rows = (await query(
    `SELECT d.id, d.title, COUNT(*) AS attempts,
            (SUM(CASE WHEN a.correct = 1 THEN 100.0 ELSE 0 END) * 1.0 / COUNT(*)) AS accuracy
     FROM documents d
     JOIN ${PA} a ON a.document_id = d.id
     GROUP BY d.id, d.title
     HAVING accuracy < 60
     ORDER BY COUNT(*) DESC
     LIMIT ?`,
    [limit]
  )) || []
  return rows.map((r) => ({ id: r.id, title: r.title, attempts: Number(r.attempts) || 0, accuracy: Number(r.accuracy) || 0 }))
}

/** 文档学习统计（kernel getDocStats 移植）：按文档聚合作答/正确率/反馈数 */
async function getDocStats(query, filter = {}) {
  const where = []
  const params = []
  if (filter.repoId) { where.push('d.repo_id = ?'); params.push(filter.repoId) }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const rows = (await query(
    `SELECT a.document_id AS documentId, d.title AS title,
            COUNT(*) AS attempts,
            COALESCE(SUM(CASE WHEN a.correct = 1 THEN 1 ELSE 0 END), 0) AS correctCount,
            MAX(a.answered_at) AS lastAttemptAt,
            (SELECT COUNT(*) FROM ${QF} f
              WHERE (f.document_id = a.document_id
                 OR f.question_id IN (SELECT id FROM ${Q} WHERE document_id = a.document_id))
                  AND f.kind != 'good_question') AS feedbackCount
     FROM ${PA} a
     JOIN documents d ON d.id = a.document_id
     ${whereSql}
     GROUP BY a.document_id
     ORDER BY attempts DESC, lastAttemptAt DESC`,
    params
  )) || []
  return rows.map((r) => {
    const attempts = Number(r.attempts) || 0
    const correctCount = Number(r.correctCount) || 0
    return {
      documentId: r.documentId, title: r.title, attempts, correctCount,
      lastAttemptAt: r.lastAttemptAt, feedbackCount: Number(r.feedbackCount) || 0,
      accuracy: attempts > 0 ? Math.round((correctCount / attempts) * 100) : null,
    }
  })
}

/** 学习统计摘要（kernel getStudySummary 移植）：文档锚点口径全量读模型 */
async function getStudySummary(query, filter = {}) {
  const docScope = filter?.repoId ? ' AND d.repo_id = ?' : ''
  const docParams = filter?.repoId ? [filter.repoId] : []
  const countRow = async (sql, params = []) => {
    const rows = (await query(sql, params)) || []
    return Number(rows[0]?.n) || 0
  }
  const total = await countRow(`SELECT COUNT(*) AS n FROM documents d WHERE 1 = 1${docScope}`, docParams)
  const nowIso = new Date().toISOString()
  const due = await countRow(
    `SELECT COUNT(*) AS n FROM documents d
     LEFT JOIN quiz_maker_doc_review dr ON dr.doc_id = d.id
     WHERE (dr.doc_id IS NULL OR dr.next_review_at IS NULL OR dr.next_review_at <= ?)${docScope}`,
    [nowIso, ...docParams]
  )
  const mastered = await countRow(
    `SELECT COUNT(*) AS n FROM documents d
     JOIN quiz_maker_doc_review dr ON dr.doc_id = d.id
     WHERE dr.repetition >= 2${docScope}`,
    docParams
  )
  const attScope = filter?.repoId ? ' AND a.document_id IN (SELECT id FROM documents WHERE repo_id = ?)' : ''
  const attParams = filter?.repoId ? [filter.repoId] : []
  const answered = await countRow(`SELECT COUNT(DISTINCT a.document_id) AS n FROM ${PA} a WHERE 1 = 1${attScope}`, attParams)
  const totals = ((await query(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN a.correct = 1 THEN 1 ELSE 0 END) AS c FROM ${PA} a WHERE 1 = 1${attScope}`,
    attParams
  )) || [])[0] || {}
  const totalAttempts = Number(totals.n) || 0
  const totalCorrect = Number(totals.c) || 0
  const weakCount = await countRow(
    `SELECT COUNT(*) AS n FROM (
       SELECT a.document_id FROM ${PA} a WHERE 1 = 1${attScope}
       GROUP BY a.document_id
       HAVING COUNT(*) >= 2 AND (SUM(CASE WHEN a.correct = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*)) < 60
     )`,
    attParams
  )
  const contribution = ((await query(
    `SELECT COALESCE(a.plugin_id, '') AS pluginId, COUNT(DISTINCT a.document_id) AS questions,
            COUNT(*) AS attempts, SUM(CASE WHEN a.correct = 1 THEN 1 ELSE 0 END) AS correct
     FROM ${PA} a WHERE 1 = 1${attScope}
     GROUP BY COALESCE(a.plugin_id, '')`,
    attParams
  )) || []).map((g) => ({
    pluginId: g.pluginId || '(未知)',
    questions: Number(g.questions) || 0,
    attempts: Number(g.attempts) || 0,
    correct: Number(g.correct) || 0,
    accuracy: Number(g.attempts) > 0 ? Math.round((Number(g.correct) / Number(g.attempts)) * 100) : null,
  }))
  // 近 30 自然日趋势（本地时区桶）
  const DAY = 24 * 60 * 60 * 1000
  const TREND_DAYS = 30
  const dayKeyLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const since = new Date(Date.now() - (TREND_DAYS - 1) * DAY)
  since.setHours(0, 0, 0, 0)
  const trendRows = (await query(
    `SELECT DATE(a.answered_at, 'localtime') AS day, COUNT(*) AS n,
            SUM(CASE WHEN a.correct = 1 THEN 1 ELSE 0 END) AS c
     FROM ${PA} a WHERE a.answered_at >= ? GROUP BY day`,
    [since.toISOString()]
  )) || []
  const trendByDay = new Map(trendRows.map((r) => [String(r.day), r]))
  const attemptTrend = []
  const accuracyTrend = []
  for (let i = 0; i < TREND_DAYS; i++) {
    const key = dayKeyLocal(new Date(Date.now() - (TREND_DAYS - 1 - i) * DAY))
    const r = trendByDay.get(key)
    attemptTrend.push([key, r ? Number(r.n) : 0])
    if (r && Number(r.n) > 0) accuracyTrend.push([key, { correct: Number(r.c) || 0, total: Number(r.n) }])
  }
  const todayLocal = dayKeyLocal(new Date())
  const clearedToday = await countRow(
    `SELECT COUNT(DISTINCT a.document_id) AS n FROM ${PA} a
     WHERE a.was_due = 1 AND DATE(a.answered_at, 'localtime') = ?`,
    [todayLocal]
  )
  const firstTagRows = (await query(`SELECT DATE(MIN(answered_at), 'localtime') AS day FROM ${PA} WHERE was_due IS NOT NULL`)) || []
  const firstTaggedDay = (firstTagRows[0]?.day && String(firstTagRows[0].day)) || null
  return {
    total, due, mastered, answered, totalAttempts, totalCorrect,
    accuracy: totalAttempts > 0 ? Math.round((totalCorrect / totalAttempts) * 100) : null,
    weakCount, clearedToday, todayDueTotal: clearedToday + due, firstTaggedDay, contribution,
    trend: { attemptTrend, accuracyTrend },
  }
}

/** 题库健康度（kernel getQuestionBankHealth 移植）：总量/反馈/近期/效果/认知分布全量读模型 */
async function getQuestionBankHealth(query, repoId) {
  const repoScope = repoId ? 'WHERE (document_id IN (SELECT id FROM documents WHERE repo_id = ?) OR repo_id = ?)' : ''
  const scopeParams = repoId ? [repoId, repoId] : []
  const qScope = repoId ? 'WHERE (q.document_id IN (SELECT id FROM documents WHERE repo_id = ?) OR q.repo_id = ?)' : ''
  const totals = ((await query(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END), 0) AS active,
            COALESCE(SUM(CASE WHEN status = 'retired' THEN 1 ELSE 0 END), 0) AS retired,
            COALESCE(SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END), 0) AS verified
     FROM ${Q} ${repoScope}`,
    scopeParams
  )) || [])[0] || { total: 0, active: 0, retired: 0, verified: 0 }
  const feedback = (await query(
    `SELECT f.kind AS kind, COUNT(*) AS n FROM ${QF} f
     JOIN ${Q} q ON q.id = f.question_id
     ${qScope ? `${qScope} AND ` : 'WHERE '}1=1
     GROUP BY f.kind`,
    repoId ? [...scopeParams] : []
  )) || []
  const fbByKind = new Map(feedback.map((r) => [r.kind, Number(r.n) || 0]))
  const badFeedback = (fbByKind.get('bad_question') || 0) + (fbByKind.get('wrong_answer') || 0)
  const goodFeedback = fbByKind.get('good_question') || 0
  const now = Date.now()
  const recent = [7, 30].map(async (days) => {
    const cutoff = new Date(now - days * 86400000).toISOString()
    const row = ((await query(
      `SELECT COUNT(DISTINCT q.id) AS questions, COUNT(a.id) AS attempts,
              COALESCE(SUM(CASE WHEN a.correct = 1 THEN 1 ELSE 0 END), 0) AS correct
       FROM ${Q} q
       JOIN ${QA} a ON a.question_id = q.id AND a.correct IS NOT NULL
       ${qScope ? `${qScope} AND ` : 'WHERE '}q.created_at >= ?`,
      [...(repoId ? scopeParams : []), cutoff]
    )) || [])[0] || { questions: 0, attempts: 0, correct: 0 }
    const attempts = Number(row.attempts) || 0
    return { days, questions: Number(row.questions) || 0, attempts, accuracy: attempts > 0 ? Math.round((Number(row.correct) / attempts) * 100) : null }
  })
  // E-1 薄弱修复信号
  const weakRepair = ((await query(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN last_correct = 1 THEN 1 ELSE 0 END), 0) AS repaired
     FROM (
       SELECT q.id,
              (SELECT a.correct FROM ${QA} a WHERE a.question_id = q.id AND a.correct IS NOT NULL
               ORDER BY a.answered_at DESC LIMIT 1) AS last_correct
       FROM ${Q} q
       JOIN ${QA} a2 ON a2.question_id = q.id
       ${qScope ? `${qScope} AND ` : 'WHERE '}q.status != 'retired'
       GROUP BY q.id
       HAVING COUNT(a2.id) >= 2 AND SUM(CASE WHEN a2.correct = 1 THEN 1 ELSE 0 END) * 100 < COUNT(a2.id) * 60
     )`,
    repoId ? [...scopeParams] : []
  )) || [])[0] || { total: 0, repaired: 0 }
  const weakTotal = Number(weakRepair.total) || 0
  const weakRepairRate = weakTotal > 0 ? Math.round((Number(weakRepair.repaired) / weakTotal) * 100) : null
  // E-2 间隔保持率（LAG 窗口）
  const pairRows = (await query(
    `SELECT CASE
              WHEN gap < 1 THEN '<1d'
              WHEN gap < 3 THEN '1-3d'
              WHEN gap < 7 THEN '3-7d'
              WHEN gap < 14 THEN '7-14d'
              WHEN gap < 30 THEN '14-30d'
              ELSE '30d+'
            END AS bucket,
            COUNT(*) AS pairs,
            COALESCE(SUM(CASE WHEN cur_correct = 1 THEN 1 ELSE 0 END), 0) AS kept
     FROM (
       SELECT q.id AS qid,
              julianday(a.answered_at) - julianday(LAG(a.answered_at) OVER (PARTITION BY a.question_id ORDER BY a.answered_at)) AS gap,
              a.correct AS cur_correct,
              LAG(a.correct) OVER (PARTITION BY a.question_id ORDER BY a.answered_at) AS prev_correct
       FROM ${QA} a
       JOIN ${Q} q ON q.id = a.question_id
       ${qScope}
     )
     WHERE prev_correct = 1 AND cur_correct IS NOT NULL AND gap IS NOT NULL
     GROUP BY bucket`,
    repoId ? [...scopeParams] : []
  )) || []
  const BUCKETS = ['<1d', '1-3d', '3-7d', '7-14d', '14-30d', '30d+']
  const retention = BUCKETS.map((b) => {
    const row = pairRows.find((r) => r.bucket === b)
    const pairs = row ? Number(row.pairs) : 0
    const kept = row ? Number(row.kept) : 0
    return { bucket: b, pairs, kept, rate: pairs > 0 ? Math.round((kept / pairs) * 100) : null }
  })
  // E-3 认知层级分布
  const cogRows = ((await query(
    `SELECT COALESCE(SUM(CASE WHEN cognitive_level = '记忆' THEN 1 ELSE 0 END), 0) AS memory,
            COALESCE(SUM(CASE WHEN cognitive_level = '理解' THEN 1 ELSE 0 END), 0) AS understanding,
            COALESCE(SUM(CASE WHEN cognitive_level = '应用' THEN 1 ELSE 0 END), 0) AS application,
            COALESCE(SUM(CASE WHEN IFNULL(cognitive_level, '') = '' THEN 1 ELSE 0 END), 0) AS untagged
     FROM ${Q} ${repoScope}`,
    scopeParams
  )) || [])[0] || { memory: 0, understanding: 0, application: 0, untagged: 0 }
  return {
    total: Number(totals.total) || 0,
    active: Number(totals.active) || 0,
    retired: Number(totals.retired) || 0,
    verified: Number(totals.verified) || 0,
    badFeedback,
    goodFeedback,
    feedbackRate: (badFeedback + goodFeedback) > 0 ? Math.round((100 * badFeedback) / (badFeedback + goodFeedback)) : null,
    verifiedRate: Number(totals.total) > 0 ? Math.round((100 * Number(totals.verified)) / Number(totals.total)) : null,
    recent: await Promise.all(recent),
    effect: {
      weakTotal,
      weakRepairRate,
      retention,
    },
    cognitiveDist: {
      memory: Number(cogRows.memory) || 0,
      understanding: Number(cogRows.understanding) || 0,
      application: Number(cogRows.application) || 0,
      untagged: Number(cogRows.untagged) || 0,
    },
  }
}

/** 清偿保险丝口径（rhythm-config 资产化批自宿主 getPracticeDebtStats 移植，2026-10-14）：
 *  近 7 天作答行数与日均（按作答行计，非按文档去重）——study-reminder 保险丝的日均容量分母 */
async function getPracticeDebtStats(query) {
  const since7 = new Date(Date.now() - 7 * 86400000).toISOString()
  const rows = await query('SELECT COUNT(*) AS n FROM quiz_maker_practice_attempts WHERE answered_at >= ?', [since7])
  const attempts7d = Number(rows?.[0]?.n) || 0
  return { attempts7d, dailyAvg: Math.round((attempts7d / 7) * 10) / 10 }
}

// ============================================================
// 复习分析（pro-narrative-v2 P1，B3-1 口径单源）：Pro 复盘区块四节。
// 取数（query 注入，同上方铁律）与纯函数（可独立单测）分离。诚实口径：
// quality 二值化（对=4/错=2）+ 移动端不落库 → 保持曲线是 SM-2 推算 + 桌面样本；
// concept 层表不在插件读面白名单 → 掌握度落 KP 级（knowledge_points，与 weakKps 同维）。
// ============================================================

/** F1 记忆保持曲线取数：到期作答周桶实测正确率（was_due=1 切片）+ 文档级 SM-2 状态。
 *  docs 按 interval_days 升序（最易遗忘的文档排前），每文档附 SM-2 保持预估曲线。 */
async function getRetentionSeries(query, opts = {}) {
  const weeks = Math.min(Math.max(Number(opts.weeks) || 12, 4), 26)
  const docLimit = Math.min(Math.max(Number(opts.docLimit) || 8, 1), 20)
  const since = new Date(Date.now() - weeks * 7 * 86400000).toISOString()
  const weekly = (await query(
    `SELECT strftime('%Y-%W', answered_at, 'localtime') AS week, COUNT(*) AS n,
            SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) AS c
     FROM quiz_maker_practice_attempts
     WHERE was_due = 1 AND answered_at >= ? GROUP BY week ORDER BY week`,
    [since]
  )) || []
  const docs = (await query(
    `SELECT dr.doc_id AS docId, d.title AS title, dr.interval_days AS intervalDays,
            dr.ease_factor AS easeFactor, dr.repetition AS repetition,
            dr.next_review_at AS nextReviewAt
     FROM quiz_maker_doc_review dr JOIN documents d ON d.id = dr.doc_id
     ORDER BY dr.interval_days ASC LIMIT ?`,
    [docLimit]
  )) || []
  return {
    weekly: weekly.map((r) => ({ week: String(r.week), attempts: Number(r.n) || 0, accuracy: Number(r.n) > 0 ? Math.round((Number(r.c) / Number(r.n)) * 100) : null })),
    docs: docs.map((r) => {
      const intervalDays = Number(r.intervalDays) || 1
      return {
        docId: String(r.docId), title: String(r.title || r.docId), intervalDays,
        easeFactor: Number(r.easeFactor) || 2.5, repetition: Number(r.repetition) || 0,
        nextReviewAt: r.nextReviewAt, curve: buildRetentionCurve(intervalDays),
      }
    }),
  }
}

/** F1 纯函数：SM-2 半衰期保持预估（0..14 天逐日，半衰期 proxy=interval_days）。
 *  标注口径=「SM-2 推算」——非实测记忆拟合（quality 二值化样本不支持）。 */
function buildRetentionCurve(intervalDays, days = 14) {
  const halfLife = Math.max(Number(intervalDays) || 1, 1)
  const points = []
  for (let d = 0; d <= days; d++) points.push([d, Math.round(100 * Math.pow(2, -d / halfLife))])
  return { halfLifeDays: halfLife, points }
}

/** F2 掌握度纯函数（KP 级，0-100 归一）：SM-2 轨迹（rep/ease）× 30 天正确率 × 近练衰减。
 *  只读聚合——调度仍按题（scheduling stays per-question），消费方绝不回写。 */
function buildMasteryScore({ accuracy30, avgRep, avgEase, daysSinceLast }) {
  const acc = Number.isFinite(Number(accuracy30)) ? Math.max(0, Math.min(100, Number(accuracy30))) : 50
  const rep = Math.max(0, Math.min(3, Number(avgRep) || 0)) / 3
  const ease = Math.max(0, Math.min(1, ((Number(avgEase) || 2.5) - 1.3) / 1.5))
  const gap = Number(daysSinceLast)
  const decay = !Number.isFinite(gap) ? 0.7 : gap <= 7 ? 1 : gap <= 21 ? 0.85 : 0.7
  return Math.round((acc * 0.5 + rep * 30 + ease * 20) * decay)
}

/** F2 KP 掌握度取数：题级 SM-2 四列 + 30 天题库轨正确率（attempt 聚合下推子查询，
 *  防 join 放大 rep/ease 均值）。按掌握分升序（最薄弱在前）截 limit。 */
async function getMasteryByKp(query, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 12, 1), 50)
  const rows = (await query(
    `SELECT kp.id, kp.title,
            COUNT(DISTINCT q.id) AS questions,
            AVG(q.repetition) AS avgRep, AVG(q.ease_factor) AS avgEase,
            SUM(CASE WHEN q.repetition >= 2 THEN 1 ELSE 0 END) AS masteredQ,
            MAX(qa.lastAt) AS lastAttemptAt, SUM(qa.att30) AS att30, SUM(qa.ok30) AS ok30
     FROM knowledge_points kp
     JOIN quiz_maker_questions q ON q.knowledge_point_id = kp.id AND q.status != 'retired'
     LEFT JOIN (
       SELECT question_id, MAX(answered_at) AS lastAt,
              SUM(CASE WHEN correct IS NOT NULL AND answered_at >= datetime('now','-30 day') THEN 1 ELSE 0 END) AS att30,
              SUM(CASE WHEN correct = 1 AND answered_at >= datetime('now','-30 day') THEN 1 ELSE 0 END) AS ok30
       FROM quiz_maker_question_attempts GROUP BY question_id
     ) qa ON qa.question_id = q.id
     GROUP BY kp.id, kp.title
     ORDER BY kp.created_at LIMIT 300`
  )) || []
  const daysSince = (iso) => {
    if (!iso) return NaN
    const s = String(iso)
    const ts = Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z')
    return Number.isFinite(ts) ? Math.floor((Date.now() - ts) / 86400000) : NaN
  }
  return rows
    .map((r) => {
      const att30 = Number(r.att30) || 0
      const accuracy30 = att30 > 0 ? Math.round(((Number(r.ok30) || 0) / att30) * 100) : null
      return {
        id: String(r.id), title: String(r.title || r.id), questions: Number(r.questions) || 0,
        masteredQ: Number(r.masteredQ) || 0, att30, accuracy30,
        lastAttemptAt: r.lastAttemptAt || null,
        mastery: buildMasteryScore({ accuracy30, avgRep: Number(r.avgRep) || 0, avgEase: Number(r.avgEase) || 2.5, daysSinceLast: daysSince(r.lastAttemptAt) }),
      }
    })
    .sort((a, b) => a.mastery - b.mastery)
    .slice(0, limit)
}

/** F3 域热力取数：KP 薄弱聚合并按文档标引域上卷（与 weakDomains 同源 join 链：
 *  KP→题→快照作答→文档→taxonomy_semantics.domain），补 attempts/accuracy 供热度着色 */
async function getDomainHeatmap(query, opts = {}) {
  const days = Math.min(Math.max(Number(opts.days) || 30, 7), 90)
  const rows = (await query(
    `SELECT COALESCE(NULLIF(ts.domain,''),'(未标引)') AS domain,
            COUNT(*) AS kps,
            SUM(CASE WHEN w.acc < 60 AND w.att >= 2 THEN 1 ELSE 0 END) AS weakKps,
            SUM(w.att) AS att30, SUM(w.ok) AS ok30
     FROM (
       SELECT kp.id AS kpId, kp.document_id AS docId, COUNT(a.id) AS att,
              SUM(CASE WHEN a.correct = 1 THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN a.correct = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(a.id) AS acc
       FROM knowledge_points kp
       JOIN quiz_maker_questions q ON q.knowledge_point_id = kp.id AND q.status != 'retired'
       JOIN quiz_maker_practice_attempts a ON json_extract(a.question_snapshot, '$.id') = q.id
       WHERE a.answered_at >= datetime('now', ?)
       GROUP BY kp.id
     ) w
     LEFT JOIN taxonomy_semantics ts ON ts.doc_id = w.docId
     GROUP BY domain ORDER BY weakKps DESC, att30 DESC LIMIT 12`,
    [`-${days} day`]
  )) || []
  return rows.map((r) => {
    const att30 = Number(r.att30) || 0
    return { domain: String(r.domain), kps: Number(r.kps) || 0, weakKps: Number(r.weakKps) || 0, attempts30: att30, accuracy30: att30 > 0 ? Math.round(((Number(r.ok30) || 0) / att30) * 100) : null }
  })
}

/** F4 到期地平线取数：文档轨未来 N 天逐日到期量（规划器输入；只读，不生成任何调度） */
async function getDueHorizon(query, horizonDays = 60) {
  const h = Math.min(Math.max(Number(horizonDays) || 60, 7), 120)
  const rows = (await query(
    `SELECT date(next_review_at) AS day, COUNT(*) AS n
     FROM quiz_maker_doc_review
     WHERE next_review_at IS NOT NULL AND next_review_at > date('now') AND next_review_at <= date('now', ?)
     GROUP BY day ORDER BY day`,
    [`+${h} days`]
  )) || []
  return rows.map((r) => ({ day: String(r.day), due: Number(r.n) || 0 }))
}

/** F4 规划器纯函数：到期需求 ÷ 日容量 → 逐日计划与可行性判定（建议视图，不写调度）。
 *  backlog（neverPracticed）不在到期序列内——v1 只排已调度到期，消费方文案如实标注。 */
function buildPlannerPlan({ examDate, dueByDay, dailyAvg, today }) {
  const capacity = Math.max(Number(dailyAvg) || 0, 0)
  const base = typeof today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : new Date().toISOString().slice(0, 10)
  const exam = typeof examDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(examDate) ? examDate : null
  if (!exam || exam <= base) return { active: false }
  const dueMap = new Map((Array.isArray(dueByDay) ? dueByDay : []).map((r) => [String(r.day), Number(r.due) || 0]))
  const cursor = new Date(base + 'T00:00:00Z')
  const spanDays = Math.max(1, Math.round((new Date(exam + 'T00:00:00Z') - cursor) / 86400000))
  const days = []
  let totalDemand = 0
  for (let i = 0; i < spanDays; i++) {
    const key = cursor.toISOString().slice(0, 10)
    const due = dueMap.get(key) || 0
    totalDemand += due
    days.push({ date: key, due })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  const capacityTotal = Math.round(capacity * spanDays * 10) / 10
  const feasible = capacity > 0 && totalDemand <= capacityTotal
  const advice = capacity <= 0
    ? '近 7 天没有作答记录，先练几天建立容量基线再来规划。'
    : feasible
      ? `按近 7 天日均 ${capacity} 篇的节奏，考前可以清完 ${totalDemand} 篇到期——保持即可。`
      : `到期总量 ${totalDemand} 篇 > 容量 ${capacityTotal} 篇：把日均提到 ${Math.ceil(totalDemand / spanDays)} 篇，或优先清薄弱文档。`
  return { active: true, examDate: exam, days, totalDemand, capacityTotal, dailyCapacity: capacity, feasible, advice }
}

/** 到期文档队列（study-coach 今日集决策内核消费节）：到期时刻升序的 id/标题/到期时刻/正确率。
 *  复习态在自店表 quiz_maker_doc_review，行缺省=从未练习 → created_at 即到期（与 dueFroms 同口径）；
 *  正确率为文档维度实测（无作答为 null，消费方按最薄弱处理）。 */
async function getDueQueue(query, limit = 50, now = new Date()) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200)
  const rows = (await query(
    `SELECT d.id AS id, d.title AS title,
            COALESCE(NULLIF(dr.next_review_at, ''), d.created_at) AS dueFrom,
            (SELECT CASE WHEN COUNT(*) > 0 THEN ROUND(100.0 * SUM(CASE WHEN a.correct = 1 THEN 1 ELSE 0 END) / COUNT(*)) END
               FROM ${PA} a WHERE a.document_id = d.id) AS accuracy
     FROM documents d LEFT JOIN quiz_maker_doc_review dr ON dr.doc_id = d.id
     WHERE COALESCE(NULLIF(dr.next_review_at, ''), d.created_at) <= ?
     ORDER BY COALESCE(NULLIF(dr.next_review_at, ''), d.created_at) ASC
     LIMIT ?`,
    [now.toISOString(), cap]
  )) || []
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    dueFrom: r.dueFrom,
    accuracy: r.accuracy === null || r.accuracy === undefined ? null : Number(r.accuracy),
  }))
}

module.exports = {
  getQuestions,
  getQuestionsForReview,
  getDueBreakdown,
  getDueQueue,
  getStreak,
  getWeakDocs,
  getDocStats,
  getStudySummary,
  getQuestionBankHealth,
  getPracticeDebtStats,
  getRetentionSeries,
  buildRetentionCurve,
  getMasteryByKp,
  buildMasteryScore,
  getDomainHeatmap,
  getDueHorizon,
  buildPlannerPlan,
}
