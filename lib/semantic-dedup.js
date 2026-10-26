// ============================================================
// quiz-maker - 语义去重纯函数（题域退役批次收尾 B1 迁自持，D2 连带修正）
//
// 管什么：余弦相似度与阈值检索（topSimilar）——出题入库跨文档语义去重的比对内核。
// 来源：自 electron/plugins/baize/tools/semantic-dedup.js 逐字迁移（原 D2 拍板「原位保留」
//   的前提=宿主属主块唯一消费，随 B1 属主块退役消失；grep 实证 baize 侧文件仍有另一消费方
//   =宿主概念语义查重 plugin-host _findSemanticallySimilarConcepts，故原文件保留不删——
//   本副本按 stdlib 准入判据①「单侧需要留该侧」落在唯一题域消费方 quiz-maker 自持）。
// 嵌入向量经 ctx.embed（平台能力面，ai:chat 按调用方计费）取得，缓存在自店表
//   quiz_maker_question_embeddings（写读经 lib/question-store）。
// 纯函数零 IO 零域语义：与本插件其余 lib 同纪律，公式漂移须与来源文件双侧同步。
// ============================================================

/**
 * 余弦相似度。零向量返回 0（无方向不可比，不参与"重复"判定）。
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number} [-1, 1]
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * 阈值检索：与候选向量比相似度，返回 ≥threshold 的 Top（降序）。
 * 维度不匹配的候选直接跳过（不同模型/截断的向量不可比）。
 * @param {ArrayLike<number>} vector 查询向量
 * @param {Array<{questionId: string, vector: ArrayLike<number>}>} candidates
 * @param {{threshold?: number, limit?: number}} [opts] threshold 默认 0.92，limit 默认 3
 * @returns {Array<{questionId: string, score: number}>}
 */
function topSimilar(vector, candidates, opts) {
  const threshold = opts && typeof opts.threshold === 'number' ? opts.threshold : 0.92
  const limit = opts && typeof opts.limit === 'number' ? opts.limit : 3
  const scored = []
  for (const c of candidates || []) {
    if (!c || !c.vector || c.vector.length !== vector.length) continue
    const score = cosineSimilarity(vector, c.vector)
    if (score >= threshold) scored.push({ questionId: c.questionId, score })
  }
  scored.sort((x, y) => y.score - x.score)
  return scored.slice(0, limit)
}

module.exports = { cosineSimilarity, topSimilar }
