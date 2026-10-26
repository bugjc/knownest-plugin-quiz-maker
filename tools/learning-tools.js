// ============================================================
// quiz-maker - 学习闭环工具（主流程最小闭环；2026-10-11 自 baize 内核迁入）
// get_due_questions / submit_question_answer / report_question / get_learning_stats
// 让 Agent 在对话中驱动「检验 → 反馈 → 调度」闭环
// ============================================================

const caliber = require('../lib/learning-caliber')
// 题目店自持写层（B1 片 2：作答记账/纠错回流改自持写，宿主属主 ctx 方法随属主块退役）
const qstore = require('../lib/question-store')

/**
 * 注册学习闭环工具
 * @param {object} context 宿主上下文（activate 作用域的 PluginContext）
 */
function registerLearningTools(context) {
  // 1. get_due_questions - 获取复习调度队列（B1 片 2 改道 caliber 题级队列：SM-2 到期口径，
  //    最久到期优先——原宿主 getDocsForReview 文档锚点队列随属主块退役，读链=自持 caliber）
  context.registerAgentTool(
    {
      name: 'get_due_questions',
      description: '获取复习调度队列（到期题目：SM-2 调度序，最久到期优先，默认 15 题，行携带 documentId）。用于驱动间隔重复复习闭环——逐题让用户作答并记录，或按题目所属文档即时出题扩展练习。用户说"复习/练题/今日复习"时使用。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '题目数量，默认 15' }
        }
      }
    },
    async (args) => {
      const ctx = context
      if (!ctx || !ctx.query) {
        return { output: '', error: '学习闭环上下文不可用' }
      }
      const questions = (await caliber.getQuestionsForReview(ctx.query, args.limit || 15)) || []
      if (!questions || questions.length === 0) {
        return '题目池为空或暂无到期题目。请先让 Agent 根据知识库生成题目（generate_questions），再开始复习。'
      }
      const lines = questions.map((q, i) =>
        `${i + 1}. [${q.type}] ${String(q.question || '').slice(0, 60)}\n   questionId: ${q.id}${q.documentId ? ` | documentId: ${q.documentId}` : ''}`
      )
      return `今日到期题目队列（${questions.length} 题，SM-2 调度序）:\n\n${lines.join('\n\n')}\n\n请逐题让用户作答并用 submit_question_answer 记录（回传 questionId）；需要扩展练习时可按 documentId 对所属文档即时出题。`
    }
  )

  // 2. submit_question_answer - 记录作答（客观题自动判分）
  context.registerAgentTool(
    {
      name: 'submit_question_answer',
      description: '记录用户对某道题的作答。选择题传 selectedOption（选项文本），判断题传 true/false，服务端自动判分；简答题传 quality 自评（0-5）。用于复习闭环反馈回流。',
      parameters: {
        type: 'object',
        properties: {
          questionId: { type: 'string', description: '题目 ID（来自 get_due_questions）' },
          selectedOption: { type: 'string', description: '选择题选项文本或判断题 true/false' },
          quality: { type: 'number', description: '简答题自评 0-5（主观题）' },
          reactionMs: { type: 'number', description: '作答用时毫秒' }
        },
        required: ['questionId']
      }
    },
    async (args) => {
      const ctx = context
      if (!ctx || !ctx.store) {
        return { output: '', error: '学习闭环上下文不可用' }
      }
      // 判断题布尔转换
      let selectedOption = args.selectedOption
      if (typeof args.selectedOption === 'string' && /^(true|false)$/i.test(args.selectedOption.trim())) {
        selectedOption = args.selectedOption.trim().toLowerCase() === 'true'
      }
      try {
        // B1 片 2：作答记账自持写（双轨流水 + SM-2 推进，原宿主 recordQuestionAttempt 语义）
        const attempt = await qstore.recordAttempt(ctx, {
          questionId: args.questionId,
          selectedOption,
          quality: typeof args.quality === 'number' ? args.quality : null,
          reactionMs: typeof args.reactionMs === 'number' ? args.reactionMs : null
        })
        const verdict = attempt.correct === 1 ? '✅ 回答正确' : attempt.correct === 0 ? '❌ 回答错误' : '📝 已记录自评'
        return `${verdict} | quality=${attempt.quality} | reactionMs=${attempt.reactionMs || '?'}`
      } catch (err) {
        return { output: '', error: `记录失败: ${err.message}` }
      }
    }
  )

  // 3. report_question - 用户纠错/评价回流
  context.registerAgentTool(
    {
      name: 'report_question',
      description: '对题目进行评价/纠错：bad_question（题目有问题）、wrong_answer（答案错误）、good_question（好题）。用于淘汰低质题目，保护学习闭环质量。',
      parameters: {
        type: 'object',
        properties: {
          questionId: { type: 'string', description: '题目 ID' },
          kind: { type: 'string', enum: ['bad_question', 'wrong_answer', 'good_question'], description: '评价类型' },
          note: { type: 'string', description: '说明' }
        },
        required: ['questionId', 'kind']
      }
    },
    async (args) => {
      const ctx = context
      if (!ctx || !ctx.store) {
        return { output: '', error: '学习闭环上下文不可用' }
      }
      // B1 片 2：纠错回流自持写（分型自动处置，原宿主 flagQuestionFeedback 语义）
      await qstore.flagQuestionFeedback(ctx, {
        questionId: args.questionId,
        kind: args.kind,
        note: args.note || ''
      })
      const tip = args.kind === 'bad_question' || args.kind === 'wrong_answer'
        ? '（累计差评的题目可调用 retire 下架）'
        : ''
      return `已记录「${args.kind}」${tip}`
    }
  )

  // 4. get_learning_stats - 学习统计（薄弱识别，意图协议：附带学习看板）
  context.registerAgentTool(
    {
      name: 'get_learning_stats',
      description: '获取学习统计：每篇文档的作答次数、正确率、最近作答时间（文档锚点制）。用于识别薄弱文档/主题。返回后内容区自动展示学习看板。',
      parameters: {
        type: 'object',
        properties: {
          documentId: { type: 'string', description: '可选：按文档过滤（单篇）' }
        }
      }
    },
    async (args) => {
      const ctx = context
      if (!ctx || !ctx.query) {
        return { output: '', error: '学习闭环上下文不可用' }
      }
      const stats = await caliber.getDocStats(ctx.query, {})
      const filtered = args.documentId ? stats.filter((s) => s.documentId === args.documentId) : stats
      if (!filtered || filtered.length === 0) return '暂无学习记录'
      const lines = filtered.map((s) => {
        const acc = s.accuracy === null ? '未作答' : s.accuracy + '%'
        return `- 《${s.title || s.documentId}》 作答${s.attempts}次 正确率${acc}${s.lastAttemptAt ? ' 最近:' + String(s.lastAttemptAt).substring(0, 10) : ''}`
      })
      const weak = filtered.filter((s) => s.attempts >= 2 && (s.accuracy === null || s.accuracy < 60))
      return {
        output: `学习统计（${filtered.length} 篇文档）:\n${lines.join('\n')}` +
          (weak.length > 0 ? `\n\n⚠️ 薄弱文档（作答≥2 次且正确率<60%）：${weak.length} 篇 —— 建议优先复习或回源补强。` : ''),
        ui: {
          intent: 'show_dashboard',
          stats: filtered.map((s) => ({
            id: s.documentId,
            documentTitle: s.title || null,
            attempts: s.attempts,
            correctCount: s.correctCount,
            accuracy: s.accuracy,
            lastAttemptAt: s.lastAttemptAt,
          }))
        }
      }
    }
  )
}

module.exports = { registerLearningTools }
