// ============================================================
// quiz-maker - 做题闭环工具（意图协议 v1，UX-DESIGN）
// generate_questions / expand_question_bank / focus_object / start_practice_session
// （2026-10-11 学习闭环插件化迁移：自 baize 内核迁入——工具所有者=quiz-maker，
//  停用即学习工具面整体消失；底座仍为平台 PluginContext 面见 plugin-host sandboxRpc）
//
// 双写：题目 MD 文件（知识库可见，含 knownest-question-id 锚点）
//      + 题目池入库（SM-2 复习闭环，source_snippet 强制原文引用）
// 返回 { output, ui } —— ui 声明 start_practice 意图，渲染进程据此
// 将内容区切换为做题模式，用户可直接作答（确定性联动，不依赖 LLM 措辞）。
// ============================================================

const caliber = require('../lib/learning-caliber')
// 题目店自持写层（B1 片 2：入库/嵌入缓存/语义去重检索改自持，宿主属主 ctx 方法随属主块退役）
const qstore = require('../lib/question-store')

const path = require('path')

// 平台共享纯函数库（B1' T1：knownest.stdlib 只读命名空间，key=文件名去 .js）；
// 缺面软降级（旧平台+新插件窗口）：接地放行+宿主终检兜底、文档索引内联简版兜底
const std = (typeof knownest !== 'undefined' && knownest.stdlib) || null
const _grounding = (std && (std['quiz-grounding'] || std.grounding)) || null
const isGroundedIn = (_grounding && _grounding.isGroundedIn) || (() => true)
const _docRef = (std && (std['doc-ref'] || std.docRef)) || null
function buildDocIndex(docs) {
  if (_docRef && _docRef.buildDocIndex) return _docRef.buildDocIndex(docs)
  const byId = new Map(); const byPath = new Map(); const byTitle = new Map()
  for (const d of docs || []) {
    if (!d) continue
    if (d.id) byId.set(String(d.id), d)
    if (d.filePath) byPath.set(String(d.filePath), d)
    if (d.title) byTitle.set(String(d.title), d)
  }
  return { byId, byPath, byTitle }
}
function resolveDocRef(index, ref) {
  if (_docRef && _docRef.resolveDocRef) return _docRef.resolveDocRef(index, ref)
  const r = String(ref || '').trim()
  return { doc: index.byId.get(r) || index.byPath.get(r) || index.byTitle.get(r) || null }
}

/** 合法题型（与 core/knowledge/question-types.ts 注册表一致；此前只放行 4 种，
 *  multi_choice/fill_blank/ordering 被静默降级且判分器错配——2026-09-18 修复对齐）。
 *  fill_blank 2026-09-26 退役（用户反馈：LLM 自由填空答案无逻辑——精确匹配判分无容错，
 *  出题随意性大），显式拒收不再静默降级 short_answer */
const VALID_TYPES = ['single_choice', 'multi_choice', 'true_false', 'ordering', 'short_answer', 'mixed']

/** answer 归一为入库文本：multi_choice/ordering 的 answer 按工具规范是 JSON 数组——真数组
 *  转 JSON 文本（裸 String() 会逗号拼接成 "A,C" 破坏判分语义），标量转文本。
 *  遥测实证：q.answer.trim() 对非字符串 answer 直接 TypeError（2026-09-25 会话失败） */
function normalizeAnswer(v) {
  if (Array.isArray(v)) return JSON.stringify(v)
  return String(v ?? '').trim()
}

/** 判分策略表（与 storage-service recordQuestionAttempt 的 AUTO_GRADED_TYPES 同源；
 *  保留 fill_blank——存量题作答判分仍需，只是不再新生） */
const AUTO_GRADED_TYPES = ['single_choice', 'multi_choice', 'true_false', 'fill_blank', 'ordering']

/** 序列解析（与渲染端 QuestionCard 排序兜底同口径）：JSON 数组优先，兜底分隔符切分 */
function parseSequence(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  } catch { /* 非 JSON，走分隔符兜底 */ }
  return raw.split(/→|->|;|；|,|，|、|\n/).map((x) => x.trim()).filter(Boolean)
}

/** 拒收原因 → 用户语言（B6：内部判定不外泄机器术语） */
function humanizeRejection(reason) {
  const map = {
    missing_field: '题目字段缺失',
    doc_not_found: '来源文档无法定位',
    doc_unreadable: '来源文档不可读，无法校验引用',
    duplicate: '与既有题目重复',
    semantic_duplicate: '与既有题目语义重复',
    not_grounded: '答案在原文中找不到依据',
    unanswerable: '凭题干无法作答',
    ambiguous: '题目有歧义（答案不唯一）',
    not_faithful: '答案无法由原文片段支撑',
    answer_mismatch: '独立作答与标准答案不一致',
    insert_failed: '入库失败',
    type_retired: '填空题已退役（自由填空答案无判分容错），请改用单选/判断/排序/简答',
    ordering_structure: '排序题缺少可解析的顺序答案（answer 须为正确顺序的 JSON 数组，至少 2 项）',
    sys_hub_source: '来源是系统产物（sys-hub 工作空间的晨报/收件箱/题组等），不是学习材料——请改用用户知识库文档出题',
  }
  return map[reason] || reason
}

/** sys-hub 来源判定：来源文档是否落在系统产物仓（sys-hub 工作空间）内。
 *  绝对路径按 sys-hub 仓 localPath 前缀判定（正斜杠归一，权威）；仓库相对路径按首段
 *  'sys-hub' 兼容判定（工作空间契约保留段）。挂账清偿 2026-10-15：晨报/收件箱产物曾被
 *  当出题素材入库 11 题后手工清库——系统产物不是学习材料，出题链路一律排除。 */
function isSysHubDocPath(filePath, hubLocalPath) {
  const p = String(filePath || '').replace(/\\/g, '/')
  if (!p) return false
  const prefix = String(hubLocalPath || '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (prefix && (p === prefix || p.startsWith(prefix + '/'))) return true
  return p === 'sys-hub' || p.startsWith('sys-hub/')
}

/** 文件名净化：只保留安全字符 */
function sanitizeFileName(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return cleaned || 'questions'
}

/** 时间戳（YYYYMMDD-HHmmss） */
function timestamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 题目 MD 落盘目录：sys-hub 内 baize 工作空间「baize/questions/」（收敛点批 2026-10-10，
 *  规则 sys-hub/<ownerId>/<spaceKey>/：owner=插件 id，内置 baize 同规则）。
 *  storage-service.ensureSystemRepo 保证 sys-hub 存在——不回退第一仓（收敛点批删除
 *  回退分支：系统产物只认 sys-hub，缺仓即只入库不写 MD）。 */
async function resolveQuestionHubDir(ctx) {
  try {
    const repos = (typeof ctx.listRepositories === 'function' ? await ctx.listRepositories() : null) || []
    const hub = repos.find((r) => r && r.name === 'sys-hub' && r.localPath)
    return hub ? path.join(hub.localPath, 'quiz-maker', 'questions') : null
  } catch {
    return null
  }
}

/** 安全解析 optionsJson（兼容字符串/数组两种形态） */
function safeParseOptions(raw) {
  if (Array.isArray(raw)) return raw.map((o) => String(o))
  if (typeof raw === 'string' && raw) {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.map((o) => String(o)) : undefined
    } catch { /* 非 JSON，忽略 */ }
  }
  return undefined
}

/**
 * 注册做题闭环工具（quiz-maker 侧；api=index.js 注入的同插件引擎，免循环 require）
 * @param {object} context 宿主上下文（activate 作用域的 PluginContext）
 * @param {{practiceInstant: Function, selectExpansionTargets: Function}} api 同插件引擎直调
 */
function registerPracticeTools(context, api) {
  // 1. generate_questions - 生成题目并双写（MD 文件 + 题目池），自动开启内容区做题
  context.registerAgentTool(
    {
      name: 'generate_questions',
      description: '将你（LLM）生成的一组题目写入目标目录（双写：Markdown 文件进知识库 + 题目池入库进 SM-2 复习闭环），并自动在右侧内容区开启做题会话。质量闸门（2026-09-18）：每题 sourceSnippet 经接地校验（必须真实摘自来源文档，禁止编造/改写）+ 盲答验证（独立判卷：答不出/歧义/无支撑/答案不一致的题会被拒收，不污染题库）；请按出题官规范出题——答案先行、题型覆盖 记忆/理解/应用 三层、干扰项取同概念域、每题尽量提供 knowledgePointTitle 挂接知识体系。支持题型：single_choice / multi_choice（answer 为 JSON 数组）/ true_false / ordering（answer 传正确顺序的 JSON 数组，做题卡展示时自动打乱）/ short_answer / mixed；禁止生成填空题（fill_blank 已退役，提交会被拒收），documentId 或 documentPath 指定来源文档（必须是用户知识库的学习材料——sys-hub 系统产物如晨报/收件箱产物会被拒收，不入库）；题目是系统产物，缺省强制落 sys-hub 内 baize 工作空间「baize/questions/」，仅当用户消息中明确说了落盘目录才把该路径作为 dirPath 传入（优先级：消息内 dirPath > sys-hub「baize/questions/」；目标目录芯片不参与——2026-09-26 用户反馈题组曾随芯片散落用户仓库污染其 git 同步）。题目按"同文档同题干"自动去重。生成后内容区立即进入做题模式。',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: '题目数组。每项: { documentId 或 documentPath(来源文档), knowledgePointId 或 knowledgePointTitle(强烈建议，挂接到知识点), type(single_choice/multi_choice/true_false/ordering/short_answer/mixed；fill_blank 已退役禁止生成), question(题干), options?(选择题选项数组；ordering 可省), answer(答案；ordering 为正确顺序的 JSON 数组), explanation?(解析), sourceSnippet(必填，逐字引用原文片段), cognitiveLevel(认知层级：记忆/理解/应用 三选一，健康度分层度量依据——必须自报) }'
          },
          dirPath: { type: 'string', description: '题目 Markdown 文件落盘目录（绝对路径）。缺省统一落 sys-hub「baize/questions/」' },
          topic: { type: 'string', description: '题目主题（用于标题，如 "TCP 三次握手"）' },
          generator: { type: 'string', description: '出题者署名（如「出题官」），缺省「白泽」；委派出题官子代理出题时必须传「出题官」' }
        },
        required: ['questions']
      }
    },
    async (args) => {
      const ctx = context
      // 2026-09-25 题库回流恢复（用户决策撤销 P3-S3b 恒即时）：出题入库进 SM-2 复习闭环——
      // 入库 + MD 双写，作答双轨记账（practice_attempts 文档轨 + question_attempts/questions 题库轨）
      if (!ctx || !ctx.store) return { output: '', error: '题目池上下文不可用' }
      const questions = Array.isArray(args.questions) ? args.questions : []
      if (questions.length === 0) return { output: '', error: 'questions 不能为空' }

      // 文档索引：id/路径/标题统一解析（shared/plugin-stdlib/doc-ref，一次构建按题查询）
      let docs = []
      try { docs = (await ctx.getDocuments()) || [] } catch { docs = [] }
      const docIndex = buildDocIndex(docs)

      // sys-hub 系统产物仓定位（来源排除用）；仓库面不可用按无排除——诚实降级不假装拦截
      let sysHubPrefix = ''
      try {
        const repos = (typeof ctx.listRepositories === 'function' ? await ctx.listRepositories() : null) || []
        const hub = repos.find((r) => r && r.name === 'sys-hub' && r.localPath)
        if (hub) sysHubPrefix = hub.localPath
      } catch { /* 仓库面不可用按无排除 */ }

      // 同文档既有题干集合（真实环境回归：LLM 重复生成相似题时按题干去重，避免题库重复）
      const existingByDoc = new Map()
      try {
        const allQuestions = (await caliber.getQuestions(ctx.query, { limit: 500 })) || []
        for (const eq of allQuestions) {
          if (!existingByDoc.has(eq.documentId)) existingByDoc.set(eq.documentId, new Set())
          existingByDoc.get(eq.documentId).add(String(eq.question || '').trim())
        }
      } catch { /* 查重失败不阻塞 */ }

      // 文档原文缓存（接地校验用：每文档只读一次）
      const contentByDoc = new Map()
      const readDocContent = async (doc) => {
        if (contentByDoc.has(doc.id)) return contentByDoc.get(doc.id)
        let content = ''
        try { content = (await ctx.readFile(doc.filePath)) || '' } catch { content = '' }
        contentByDoc.set(doc.id, content)
        return content
      }

      // ---- Phase A：结构校验 + 去重 + 接地校验（确定性闸门，不依赖 LLM） ----
      // TODO:REFACTOR: answer 已归一（normalizeAnswer），但 q.question/q.sourceSnippet 对
      // 非字符串 LLM 入参仍裸调 .trim()——同类崩溃面，宜在 Phase A 入口统一 coerce
      const candidates = [] // { srcIndex, q, doc, type, qText }
      const rejected = [] // { label, reason(机器码), question? }
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i] || {}
        const label = `第 ${i + 1} 题`
        if (!q.question || !q.question.trim() || !q.answer || !normalizeAnswer(q.answer) || !q.sourceSnippet || !q.sourceSnippet.trim()) {
          rejected.push({ label, reason: 'missing_field' }); continue
        }
        // fill_blank 退役（2026-09-26 用户反馈）：显式拒收给 LLM 明确反馈，不静默降级
        if (String(q.type || '') === 'fill_blank') {
          rejected.push({ label, reason: 'type_retired', question: String(q.question).trim() }); continue
        }
        const type = VALID_TYPES.includes(q.type)
          ? q.type
          : (Array.isArray(q.options) && q.options.length > 0 ? 'single_choice' : 'short_answer')
        // 排序结构闸：answer 必须可解析出 ≥2 项的顺序序列，否则做题卡无可排序项无法作答
        // （2026-09-26 用户实证：ordering 题答案序列残缺导致卡死在提交按钮）
        if (type === 'ordering' && parseSequence(normalizeAnswer(q.answer)).length < 2) {
          rejected.push({ label, reason: 'ordering_structure', question: String(q.question).trim() }); continue
        }

        // 解析来源文档（路径 → 文件名 → 标题兜底）
        let doc = null
        if (q.documentId) doc = docIndex.byId.get(String(q.documentId)) || null
        if (!doc && q.documentPath) doc = resolveDocRef(docIndex, q.documentPath).doc
        if (!doc) {
          rejected.push({ label, reason: 'doc_not_found' }); continue
        }

        // 来源排除闸：sys-hub 系统产物（晨报/收件箱/题组等）不是学习材料，不入库不写 MD
        if (isSysHubDocPath(doc.filePath, sysHubPrefix)) {
          rejected.push({ label, reason: 'sys_hub_source', question: String(q.question).trim() }); continue
        }

        // 同文档同题干去重（相似题跳过，避免题库重复）
        const qText = String(q.question).trim()
        const docExisting = existingByDoc.get(doc.id)
        if (docExisting && docExisting.has(qText)) {
          rejected.push({ label, reason: 'duplicate', question: qText }); continue
        }

        // 质量闸门①接地校验：sourceSnippet 归一化后必须真存在于原文（拦截编造/改写引用）
        const content = await readDocContent(doc)
        if (!content) {
          rejected.push({ label, reason: 'doc_unreadable' }); continue
        }
        if (!isGroundedIn(String(q.sourceSnippet), content)) {
          rejected.push({ label, reason: 'not_grounded', question: qText }); continue
        }

        // 质量闸门③语义去重（2026-09-19 收口：跨文档向量相似；B1 片 2 改自持——嵌入经 ctx.embed
        // 平台能力面（ai:chat 按调用方计费）+ 自持 lib/semantic-dedup 比对自店嵌入缓存）：
        // 嵌入服务不可用 → 跳过（去重是增强不是硬门，与接地的零容忍不同级）；
        // 命中相似题 → 拒收；向量随候选携带，入库成功后落缓存供后续比对。
        let dupVector = []
        let dupModel = ''
        if (typeof ctx.embed === 'function') {
          try {
            const sd = await qstore.findSemanticDuplicates(ctx, qText)
            if (sd && sd.available !== false) {
              dupModel = sd.model || ''
              dupVector = Array.isArray(sd.vector) ? sd.vector : []
              if (sd.similar && sd.similar.length > 0) {
                rejected.push({ label, reason: 'semantic_duplicate', question: qText }); continue
              }
            }
          } catch { /* 去重失败不阻塞出题 */ }
        }
        candidates.push({ srcIndex: i, q, doc, type, qText, dupVector, dupModel })
      }

      // ---- Phase B：盲答验证（生成-判卷分离；独立判卷逐题过堂） ----
      // 验证不可用（无 Provider/调用失败）→ 全部按 verified=0 入库并在结果中说明，不静默。
      const verdictByIndex = new Map()
      let verifyAvailable = candidates.length > 0
      if (typeof ctx.verifyQuestions === 'function' && candidates.length > 0) {
        try {
          const vr = await ctx.verifyQuestions(candidates.map(({ q, type }) => ({
            type,
            question: String(q.question).trim(),
            options: Array.isArray(q.options) ? q.options.map((o) => String(o)) : undefined,
            answer: normalizeAnswer(q.answer),
            sourceSnippet: String(q.sourceSnippet).trim(),
          })))
          if (!vr || vr.available === false) {
            verifyAvailable = false
          } else {
            for (const v of (vr.verdicts || [])) {
              const idx = Number(v && v.index)
              if (idx >= 1 && idx <= candidates.length) verdictByIndex.set(idx - 1, v)
            }
          }
        } catch { verifyAvailable = false }
      }

      // ---- Phase C：入库（verified 置位 + 出题者署名 + 嵌入缓存） ----
      const generator = String(args.generator || '').trim() || '白泽'
      const inserted = []
      let kpAttachFailed = 0 // 知识点/概念挂接失败计数（评审 #6：产出率漏损可观测，不阻塞出题）
      for (let i = 0; i < candidates.length; i++) {
        const { srcIndex, q, doc, type, qText, dupVector, dupModel } = candidates[i]
        const label = `第 ${srcIndex + 1} 题`
        const verdict = verdictByIndex.get(i)
        if (verifyAvailable && verdict && verdict.verdict && verdict.verdict !== 'pass') {
          rejected.push({ label, reason: verdict.verdict, question: qText }); continue
        }
        const verified = verifyAvailable && verdict && verdict.verdict === 'pass' ? 1 : 0

        // 知识点挂接（knowledgePointId 或 knowledgePointTitle；按标题自动查找/创建，让题目进入知识体系）
        // 挂接失败不再静默吞错：计数进返回契约（kpAttachFailed）——题目入库不受阻，漏损可见（评审 #6）
        let knowledgePointId = null
        if (q.knowledgePointId) {
          knowledgePointId = q.knowledgePointId
        } else if (q.knowledgePointTitle) {
          try {
            const kps = (await ctx.getKnowledgePoints(doc.id)) || []
            const found = kps.find((k) => k.title === String(q.knowledgePointTitle).trim())
            if (found) {
              knowledgePointId = found.id
            } else {
              const kp = await ctx.insertKnowledgePoint({ documentId: doc.id, title: String(q.knowledgePointTitle).trim() })
              knowledgePointId = kp.id
            }
            // 概念候选挂接（本体层 P1）：按 KP 标题 find-or-create 概念（draft 候选进确认队列，变体自动合并）
            if (knowledgePointId && typeof ctx.attachKpToConceptByTitle === 'function') {
              await ctx.attachKpToConceptByTitle({ kpId: knowledgePointId, title: String(q.knowledgePointTitle).trim(), source: 'llm' })
            }
          } catch { kpAttachFailed += 1 }
        }

        // 入库（防御：异常捕获为带原因的错误，绝不出现"未知原因"）——题目池入库进 SM-2 复习闭环
        // （B1 片 2：自店写经 lib/question-store，ADR-102 校验/content_hash 去重/日配额语义自持）
        let result
        try {
          result = await qstore.insertQuestion(ctx, {
            documentId: doc.id,
            knowledgePointId,
            type,
            question: qText,
            options: Array.isArray(q.options) ? q.options.map((o) => String(o)) : undefined,
            answer: normalizeAnswer(q.answer),
            explanation: q.explanation ? String(q.explanation).trim() : undefined,
            sourceSnippet: String(q.sourceSnippet).trim(),
            pluginId: 'quiz-maker',
            verified,
            generator,
            cognitiveLevel: ['记忆', '理解', '应用'].includes(String(q.cognitiveLevel || '').trim()) ? String(q.cognitiveLevel).trim() : undefined,
          })
        } catch (err) {
          result = { id: '', created: false, duplicate: false, reason: `入库异常: ${(err && err.message) ? err.message : String(err)}` }
        }
        if (result.created || result.duplicate) {
          // 嵌入缓存（fire-and-forget）：供后续语义去重比对；失败不影响入库
          if (result.created && dupVector.length > 0) {
            try { await qstore.saveEmbedding(ctx, result.id, dupVector, dupModel) } catch { /* 缓存失败不阻塞 */ }
          }
          inserted.push({
            id: result.id,
            documentId: doc.id,
            documentPath: doc.filePath,
            documentTitle: doc.title || path.basename(doc.filePath || ''),
            knowledgePointId: knowledgePointId || null,
            knowledgePointTitle: knowledgePointId
              ? (q.knowledgePointTitle ? String(q.knowledgePointTitle) : null)
              : null,
            type,
            question: q.question.trim(),
            options: Array.isArray(q.options) ? q.options.map((o) => String(o)) : undefined,
            answer: normalizeAnswer(q.answer),
            explanation: q.explanation ? String(q.explanation).trim() : undefined,
            sourceSnippet: String(q.sourceSnippet).trim(),
            verified,
            generator,
            cognitiveLevel: ['记忆', '理解', '应用'].includes(String(q.cognitiveLevel || '').trim()) ? String(q.cognitiveLevel).trim() : '',
            duplicate: result.duplicate
          })
        } else {
          rejected.push({ label, reason: 'insert_failed', question: qText })
        }
      }

      // 结果契约（用户可见）：生成 N → 通过校验 M → 入库 M；拒收逐题给用户语言原因
      const totalGenerated = questions.length
      if (inserted.length === 0) {
        const detail = rejected.map((r) => `${r.label}：${humanizeRejection(r.reason)}`).join('\n')
        return {
          output: `❌ 生成 ${totalGenerated} 题，0 题通过质量闸门，未入库（题库零污染）：\n${detail}\n请修正后重新提交。`,
          error: '全部题目未通过质量校验',
          result: { generated: totalGenerated, passed: 0, rejected, kpAttachFailed }
        }
      }

      const verifiedCount = inserted.filter((q) => q.verified).length
      const verifyLine = !verifyAvailable
        ? '⚠️ 盲答验证服务不可用，本轮题目已标注「未验证」（不做静默降级）。'
        : (verifiedCount === inserted.length
          ? `✅ ${inserted.length} 题全部通过接地校验 + 盲答验证。`
          : `⚠️ ${inserted.length - verifiedCount} 题未取得验证结论，已如实标注「未验证」。`)
      const rejectedLine = rejected.length > 0
        ? `\n🚫 ${rejected.length} 题被质量闸门拒收（不污染题库）：\n${rejected.slice(0, 5).map((r) => `- ${r.label}：${humanizeRejection(r.reason)}${r.question ? `（${String(r.question).slice(0, 30)}…）` : ''}`).join('\n')}${rejected.length > 5 ? `\n…等共 ${rejected.length} 题` : ''}`
        : ''
      const retryHint = rejected.length >= 2
        ? '\n💡 被拒题目较多。请针对上述拒收原因补充生成一轮（至多一轮），只提交新题，再次调用本工具。'
        : ''
      const kpLine = kpAttachFailed > 0
        ? `\n⚠️ ${kpAttachFailed} 题知识点/概念挂接失败（题目已入库不受阻，可稍后在知识体系页手动绑定）。`
        : ''

      // ---- 双写：生成 Markdown 文件（知识库可见，含 knownest-question-id 锚点） ----
      // 落盘目录优先级：args.dirPath（用户消息明确指定）> sys-hub「baize/questions/」。
      // 目标目录芯片不参与（2026-09-26 用户反馈：芯片常指向用户仓库，题组随之散落污染
      // 其 git 同步——题目是系统产物，与晨报「白泽晨报/」同约定统一落 sys-hub）
      // 真实环境回归：写入失败必须反馈给用户（此前静默吞掉，用户看不到 MD 未落盘）
      let mdPath = null
      let mdError = null
      let dirPath = args.dirPath ? String(args.dirPath) : null
      if (!dirPath) dirPath = await resolveQuestionHubDir(ctx)
      if (dirPath) {
        try {
          const fileName = `${sanitizeFileName(args.topic || 'questions')}-${timestamp()}.md`
          mdPath = path.join(dirPath, fileName)
      // 题组文件 = 规范资产（R4 转正）：frontmatter knownest 容器供知识库元数据渲染
      const lines = []
      lines.push('---')
      lines.push('knownest:')
      lines.push('  type: question-set')
      lines.push('  schemaVersion: 1')
      lines.push('  provenance:')
      lines.push('    generated_by: quiz-maker')
      lines.push(`    generator: ${JSON.stringify(generator)}`)
      lines.push(`    generated_at: ${new Date().toISOString()}`)
      lines.push('    sourceRefs:')
      if (inserted[0]?.documentPath) lines.push(`      - ${inserted[0].documentPath}`)
      lines.push('  questions:')
      inserted.forEach((q) => {
        lines.push(`    - id: ${q.id}`)
        lines.push(`      type: ${q.type}`)
        lines.push(`      question: ${JSON.stringify(q.question)}`)
        if (q.options) lines.push(`      options: ${JSON.stringify(q.options)}`)
        lines.push(`      answer: ${JSON.stringify(q.answer)}`)
        if (q.explanation) lines.push(`      explanation: ${JSON.stringify(q.explanation)}`)
        lines.push(`      sourceSnippet: ${JSON.stringify(q.sourceSnippet)}`)
      })
      if (args.topic) lines.push(`      topic: ${String(args.topic)}`)
      lines.push('---')
          lines.push('')
          lines.push(`# ${args.topic || '题目集'}（${inserted.length} 题）`)
          lines.push('')
          inserted.forEach((q, i) => {
            lines.push(`## Q${i + 1}. ${q.question}`)
            if (q.type === 'true_false') {
              lines.push('')
              lines.push('- [ ] 正确')
              lines.push('- [ ] 错误')
            } else if (q.options && q.options.length > 0) {
              lines.push('')
              q.options.forEach((opt) => lines.push(`- [ ] ${opt}`))
            }
            lines.push('')
            lines.push('<details>')
            lines.push('<summary>参考答案</summary>')
            lines.push('')
            lines.push(`**答案**: ${q.answer}`)
            if (q.explanation) lines.push(`\n**解析**: ${q.explanation}`)
            lines.push('')
            lines.push(`**原文引用**: ${q.sourceSnippet}`)
            lines.push('</details>')
            lines.push('')
            lines.push(`<!-- knownest-question-id: ${q.id} -->`)
            lines.push('')
          })
          await ctx.writeFile(mdPath, lines.join('\n'), 'utf-8')
        } catch (err) {
          mdError = (err && err.message) ? err.message : String(err)
          console.error('[practice-tools] 题目文件写入失败:', mdError)
        }
      }

      const summary = [
        `✅ 已生成 ${totalGenerated} 道题，其中 ${inserted.length} 道通过质量闸门，已开启做题会话：`,
        ...inserted.map((q, i) => `${i + 1}. [${q.type}] ${q.question}（来源: ${q.documentTitle}${q.duplicate ? '，已存在去重' : ''}${q.verified ? '，✅盲答验证' : '，⚠️未验证'}）`),
        verifyLine,
        mdPath ? `\n📄 题目已双写至: ${mdPath}` : (mdError ? `\n⚠️ 题目已入库但 MD 落盘失败: ${mdError}` : `\nℹ️ 未指定落盘目录（dirPath），题目仅入库，未写 MD 文件`),
        rejectedLine,
        retryHint,
        kpLine,
      ].filter(Boolean).join('\n')

      return {
        output: summary,
        result: { generated: totalGenerated, passed: inserted.length, rejected, kpAttachFailed },
        ui: {
          intent: 'start_practice',
          questions: inserted.map(({ duplicate, documentTitle, ...q }) => q),
          title: args.topic ? `${args.topic}（${inserted.length} 题）` : `做题会话（${inserted.length} 题）`,
          sourceDir: dirPath || undefined,
          sourceFile: mdPath || undefined,
        }
      }
    }
  )

  // 1.4 expand_question_bank - 题库补题（批次 A，2026-09-25 迭代计划 §2）：
  // 选取器在 quiz-maker（补题域所有者，Phase 2 题源雷达共用）；本工具经插件互调取任务书，
  // 出题仍走 generate_questions 三闸门（接地按宿主文档逐字比对——材料支撑闸已由选取器前置把关）
  context.registerAgentTool(
    {
      name: 'expand_question_bank',
      description: '题库补题：自动选取未覆盖/薄弱的知识点（单次最多 3 个），定位宿主文档材料并校验可考性（无材料支撑的知识点会如实跳过），返回逐知识点出题任务书。收到任务书后：逐知识点委派「出题官」专家（launch_subagent, preset=出题官）出题，出题官不可用则按任务书直接出题；每个知识点出 3~5 题后调用 generate_questions 入库——每题必带该知识点的 documentId 与 knowledgePointTitle（与任务书一致，不得改动），sourceSnippet 逐字摘自任务书材料。用户说「补题 / 扩充题库 / 覆盖没练过的知识点」时使用。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '本次补题知识点数上限，默认 3（硬上限 3）' }
        }
      }
    },
    async (args) => {
      const sel = await api.selectExpansionTargets({ limit: args && args.limit })
      if (!sel || sel.error) return { output: '', error: String((sel && sel.error) || '补题选取器不可用（quiz-maker 未激活？）') }
      const c = sel.coverage || {}
      const coverageLine = `覆盖现状：未覆盖知识点 ${c.uncoveredTotal ?? 0} 个，薄弱知识点 ${c.weakTotal ?? 0} 个；本次选取 ${sel.targets.length} 个（无材料支撑跳过 ${c.skippedNoMaterial ?? 0}，7 天冷却中 ${c.skippedCooldown ?? 0}）。`
      if (!sel.targets || sel.targets.length === 0) {
        return { output: `题库无需补题。${coverageLine}` }
      }
      const lines = [`题库补题任务书（${sel.targets.length} 个知识点）。${coverageLine}`]
      sel.targets.forEach((t, i) => {
        lines.push('')
        lines.push(`## 知识点 ${i + 1}：${t.kpTitle}（${t.reason === 'uncovered' ? '0 题覆盖，优先建立' : '薄弱：作答正确率低于 60%'}）`)
        lines.push(`宿主文档：${t.documentTitle || t.documentPath}（documentId=${t.documentId}，knowledgePointTitle 必须传「${t.kpTitle}」）`)
        lines.push('材料（sourceSnippet 必须逐字摘自以下原文，禁止改写拼接）：')
        for (const sec of t.sections) lines.push(sec)
        lines.push(`出题要求：针对「${t.kpTitle}」出 3~5 题（记忆/理解/应用三层），documentId 传 ${t.documentId}。`)
      })
      lines.push('')
      lines.push('执行方式：优先逐知识点委派「出题官」专家（launch_subagent, preset=出题官），出题官不可用则按上方任务书直接出题；全部生成后调用 generate_questions 入库并开练。')
      if (sel.skipped && sel.skipped.length > 0) {
        lines.push(`已跳过：${sel.skipped.map((x) => `「${x.kpTitle}」${x.reason}`).join('；')}。`)
      }
      return { output: lines.join('\n'), result: { coverage: sel.coverage, targets: sel.targets } }
    }
  )

  // 1.5 focus_object - 对象送达（统一导航 L1）：concept 定位知识体系概念视图 / doc 编辑器打开
  context.registerAgentTool(
    {
      name: 'focus_object',
      description: '把学习对象送达用户眼前（定位，不是回答内容）。用户说「带我去看看X / 定位到X / 打开X看看 / 看看我的薄弱概念」时**直接调用本工具，不要搜索代码验证、不要询问**。objectType=concept：objectId 传概念名或 id（如「二次函数」）→ 知识体系概念视图展开选中该概念；objectType=doc：objectId 传文档真实路径（先用 search_docs 确认）→ 编辑器打开。',
      parameters: {
        type: 'object',
        properties: {
          objectType: { type: 'string', enum: ['concept', 'doc'], description: '对象类型：concept=知识概念 / doc=文档' },
          objectId: { type: 'string', description: '概念名或 id（concept）；文档绝对路径（doc，先经 search_docs 确认）' }
        },
        required: ['objectType', 'objectId']
      }
    },
    async (args) => {
      const ctx = context
      const type = String(args?.objectType || '') === 'doc' ? 'doc' : 'concept'
      const raw = String(args?.objectId || '').trim()
      if (!raw) return { output: '', error: 'objectId 必填（概念名或文档路径）' }
      if (type === 'concept') {
        // 名称 → 规范概念 id 解析（活跃概念；找不到不送达，避免死跳转）
        if (ctx && typeof ctx.findConcept === 'function') {
          const found = await ctx.findConcept(raw)
          if (!found) return { output: `知识体系中没有找到「${raw}」对应的概念（可先出题或绑定产生）。未执行定位。` }
          return {
            output: `已在知识体系中定位概念「${found.title}」。`,
            ui: { intent: 'focus_object', objectType: 'concept', objectId: found.id, label: found.title }
          }
        }
        return { output: '', error: '概念查询能力不可用（ctx.findConcept 缺失）' }
      }
      return {
        output: `已在编辑器打开文档：${raw}`,
        ui: { intent: 'focus_object', objectType: 'doc', objectId: raw, label: raw }
      }
    }
  )

  // 2. start_practice_session - 开启做题会话（到期队列或指定题目）
  context.registerAgentTool(
    {
      name: 'start_practice_session',
      description: '在右侧内容区开启做题会话。三种模式：① documentPath/documentId 指定文档 → 对该文档即时生成挖空题入库直接练；② questionIds 指定题目；③ 缺省取复习调度队列（SM-2 到期优先）。用于"开始做题 / 练一练 / 练习这篇文档 / 今日复习"。',
      parameters: {
        type: 'object',
        properties: {
          documentPath: { type: 'string', description: '目标文档路径：对该文档即时出题并开练（优先模式）' },
          documentId: { type: 'string', description: '目标文档 ID（与 documentPath 二选一）' },
          count: { type: 'number', description: '即时出题题数，默认 5，上限 15' },
          questionIds: { type: 'array', items: { type: 'string' }, description: '指定题库题目 ID 列表' },
          limit: { type: 'number', description: '缺省模式下的题目数量，默认 10' }
        }
      }
    },
    async (args) => {
      const ctx = context
      if (!ctx) return { output: '', error: '学习闭环上下文不可用' }

      // 即时出题模式（P2）：经宿主 invoke 通道调 quiz-maker 即时引擎（生成→闸1→入库直接练）
      if (args.documentPath || args.documentId) {
        const target = args.documentPath ? { documentPath: args.documentPath } : { documentId: args.documentId }
        if (args.count) target.count = args.count
        const r = await api.practiceInstant(target)
        if (r && r.error) return { output: '', error: String(r.error) }
        const firstLine = String(r.output || '').split('\n')[0]
        return {
          output: `${firstLine}\n用户可直接在右侧内容区作答，作答回流题库 SM-2 调度（今日复习可见）。`,
          ui: r.ui,
        }
      }

      let rows = []
      let mode = 'due'
      if (Array.isArray(args.questionIds) && args.questionIds.length > 0) {
        mode = 'ids'
        const all = (await caliber.getQuestions(ctx.query, { limit: 500 })) || []
        const idSet = new Set(args.questionIds)
        rows = all.filter((q) => idSet.has(q.id))
      } else {
        // 真机实证修复（P2 走查）：宿主 ctx 方法为 async——缺 await 时 rows=Promise，
        // rows.map 直接 TypeError（旧 mock 同步返回掩盖了它）
        // 残表迁店批（2026-10-12）：题级到期队列自店 SQL 直取（原 ctx.getQuestionsForReview 已下线）
        rows = (await ctx.query(
          `SELECT q.*, MAX(a.answered_at) AS lastAttemptAt, COUNT(a.id) AS attemptCount
           FROM quiz_maker_questions q
           LEFT JOIN quiz_maker_question_attempts a ON a.question_id = q.id
           WHERE q.status = 'confirmed'
             AND (q.next_review_at IS NULL OR q.next_review_at <= ?)
           GROUP BY q.id
           ORDER BY (q.next_review_at IS NULL) ASC, q.next_review_at ASC, q.created_at ASC
           LIMIT ?`,
          [new Date().toISOString(), Math.max(1, Number(args.limit) || 10)]
        )) || []
      }
      if (!rows || rows.length === 0) {
        return {
          output: mode === 'ids'
            ? '未找到指定题目（ID 可能无效）'
            : '题目池为空。请先让 Agent 根据知识库生成并保存题目（generate_questions），再开始做题。'
        }
      }

      // 附加来源文档路径与知识点（做题时"查看原文"/错题归因用）
      let docs = []
      try { docs = (await ctx.getDocuments()) || [] } catch { docs = [] }
      const docPathById = new Map(docs.map((d) => [d.id, d.filePath]))

      // 知识点 id → 标题 映射（全量拉取一次）
      let kpTitleById = new Map()
      try {
        const allKps = (await ctx.getKnowledgePoints()) || []
        kpTitleById = new Map(allKps.map((k) => [k.id, k.title]))
      } catch { /* 知识点不可用不阻塞 */ }

      const questions = rows.map((r) => ({
        id: r.id,
        documentId: r.documentId,
        documentPath: docPathById.get(r.documentId) || undefined,
        knowledgePointId: r.knowledgePointId || null,
        knowledgePointTitle: r.knowledgePointId ? (kpTitleById.get(r.knowledgePointId) || null) : null,
        type: r.type,
        question: r.question,
        options: safeParseOptions(r.optionsJson),
        answer: r.answer,
        explanation: r.explanation || undefined,
        sourceSnippet: r.sourceSnippet || undefined,
        pluginId: r.pluginId || undefined,
        verified: Number(r.verified) === 1,
        generator: r.generator || undefined
      }))

      return {
        output: `已开启做题会话（${questions.length} 道，模式: ${mode === 'ids' ? '指定题目' : '到期队列'}）。用户可直接在右侧内容区作答，作答结果自动回流判分与 SM-2 调度。`,
        ui: {
          intent: 'start_practice',
          questions,
          title: mode === 'ids' ? `指定练习（${questions.length} 题）` : `今日复习（${questions.length} 题）`
        }
      }
    }
  )
}

module.exports = { registerPracticeTools, isSysHubDocPath }
