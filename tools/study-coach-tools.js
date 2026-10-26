// ============================================================
// Baize - 学习教练（M13：认知四力编排）
//
// 管什么：study_coach 聚合四力数据——薄弱缺口图谱（M9）/ 到期复习（M6 骨架）/
//         偏好记忆（M10 核心层）/ 工具健康（M11）——输出结构化「学习现状」
//         供 LLM 做个性化规划（"我该学什么/帮我规划"类问题的综合素材）。
// 不管什么：规划推理由 LLM 完成（本工具只供数据与结构）、提醒触达（study-reminder）、
//          题目调度。
// 被谁调用：tool-registry（LLM 编排）。
// ============================================================

const caliber = require('../lib/learning-caliber')

// 薄弱文档查询（原 knowledge-graph-tools 共享实现随迁：纯 SQL，ctx.query 白名单面）
function getWeakDocuments(ctx, limit = 5) {
  return ctx.query(
    `SELECT DISTINCT d.id, d.title FROM quiz_maker_questions q
     JOIN documents d ON q.document_id = d.id
     WHERE q.status = 'confirmed' AND (
       SELECT AVG(CASE WHEN a.correct = 1 THEN 100.0 ELSE 0 END)
       FROM quiz_maker_question_attempts a WHERE a.question_id = q.id
     ) < 60 LIMIT ${limit}`,
  )
}

/**
 * 注册学习教练工具
 * @param {import('../tool-registry').ToolRegistry} registry
 */
function registerLearningCoachTools(context) {
  context.registerAgentTool(
    {
      name: 'study_coach',
      description: '聚合学习现状四维数据（薄弱缺口图谱/到期复习/用户偏好记忆/工具健康）生成结构化现状报告，作为个性化学习规划的素材。用户问「我该学什么/帮我规划学习/我现在什么水平/下一步学哪块」时必须先用本工具取数再做规划——禁止凭感觉规划。',
      parameters: {
        type: 'object',
        properties: {
          focus: { type: 'string', description: '可选：用户当前关注的主题/关键词（会尝试匹配薄弱文档的关联知识）' }
        }
      }
    },
    async (args) => {
      const ctx = context
      if (!ctx) return { output: '', error: '插件上下文不可用' }
      const sections = []
      try {
        // 维度1 薄弱缺口（M9 图谱传播）
        try {
          const weakDocs = await getWeakDocuments(ctx) || []
          const weakParts = []
          for (const wd of weakDocs.slice(0, 3)) {
            const neighbors = await ctx.query(
              `SELECT d.title FROM document_relations dr
               JOIN documents d ON dr.target_id = d.id WHERE dr.source_id = ?
               UNION ALL
               SELECT d.title FROM document_relations dr
               JOIN documents d ON dr.source_id = d.id WHERE dr.target_id = ? LIMIT 5`,
              [wd.id, wd.id],
            )
            weakParts.push({ title: wd.title, related: (neighbors || []).map((n) => n.title) })
          }
          sections.push({
            title: '① 薄弱缺口（正确率<60% 的文档及其关联前置）',
            body: weakParts.length
              ? weakParts.map((p) => `- 「${p.title}」关联：${p.related.length ? p.related.join('、') : '（无关联文档）'}`).join('\n')
              : '当前无薄弱文档',
          })
        } catch (e) { sections.push({ title: '① 薄弱缺口', body: `(查询失败: ${e.message})` }) }

        // 维度2 待复习（口径统一批 D2：getDueBreakdown 单源清偿面总账,禁 LIMIT 截断）
        let due = 0
        let neverPracticed = 0
        try {
          const b = (await caliber.getDueBreakdown(ctx.query)) || {}
          due = Number(b.dueAll) || 0
          neverPracticed = Number(b.neverPracticed) || 0
        } catch { /* 降级 */ }
        sections.push({ title: '② 待复习', body: `${due} 篇待复习${neverPracticed > 0 ? `（含 ${neverPracticed} 篇未开始）` : ''}${due > 0 ? '——建议规划里优先安排' : ''}` })

        // 维度3 用户偏好与目标（M10 核心层记忆——规划必须尊重的约束）
        try {
          const mems = (context._memoryStore ? context._memoryStore.getRecent(50) : [])
            .filter((m) => m.category === 'user_preference' || m.category === 'user_profile')
            .slice(0, 5)
          sections.push({
            title: '③ 用户偏好与目标（规划必须遵守的约束）',
            body: mems.length ? mems.map((m) => `- [${m.category}] ${m.title}: ${String(m.content || '').slice(0, 60)}`).join('\n') : '（暂无核心记忆）',
          })
        } catch (e) { sections.push({ title: '③ 用户偏好与目标', body: `(查询失败: ${e.message})` }) }

        // 维度4 白泽自身状态（M11 自省——工具故障会影响执行规划的能力）
        // 沙箱 ctx 无 toolHealth 面（自省力是内核工具面）：该维降级为平台提示（原容错语义）
        sections.push({ title: '④ 工具状态', body: '（工具健康遥测在内核工具面，此处不可用）' })
      } catch (err) {
        return { output: '', error: `学习现状聚合失败: ${(err && err.message) || err}` }
      }

      const focus = String(args?.focus || '').trim()
      const output = [
        `=== 学习现状报告（${new Date().toISOString().slice(0, 10)}）${focus ? `｜关注: ${focus}` : ''} ===`,
        ...sections.map((s) => `\n${s.title}\n${s.body}`),
        '\n=== 请基于以上四维数据生成学习规划：优先级（薄弱×到期）、每天节奏（尊重偏好）、先用哪些关联文档补前置。规划要具体到文档名与题目数，不要泛泛而谈。 ===',
      ].join('\n')
      return { output }
    }
  )
}

module.exports = { registerLearningCoachTools }
