'use strict'

// ============================================================
// quiz-maker 自持店表 schema（声明式迁移单源，题域退役批次收尾 B1）
// 管什么：本插件全部自店表（6 张）的建表 DDL 与基线索引，按版本递增的迁移清单——
//   宿主（plugin-host 四挂点：loadAllPlugins 扫描面 / activate 兜底 / first-party-seed 后 /
//   市场安装更新后）经通用执行器（storage-plugin-store PluginStore.runStoreMigrations）
//   读取 plugin_kv (pluginId, platform, store_schema_version) 版本位，顺序执行未执行迁移项并记账。
// 不管什么：版本位记账与逐条执行（宿主职责，本文件纯声明）；运行期数据读写（index.js ctx.store）；
//   内核 legacy 搬迁机器段（storage-service handover/replay/restore——经下方 DOC_REVIEW_DDL
//   导入共享同一份 DDL 文本，单源不双写）。
// 被谁调用：宿主执行器（经 require 本文件，CJS 与插件既有模块形态一致）；
//   storage-service 机器段（构建期 import DOC_REVIEW_DDL，单一权威文本）。
// 纪律：
//   1. 迁移项只增不改：新版本一律 append（version 严格递增），已发布项禁止修改——版本位
//      只进不退（更新回滚场景下旧代码面对新版本位会跳过已执行项，依赖项内语句幂等收敛）；
//   2. 每条语句须单语句（内部禁分号）且全部表引用自 "<规范化插件id>_" 前缀（执行器词法钳制）；
//   3. 语句幂等（IF NOT EXISTS / 守卫式），单项执行失败即停且不记账，可安全重试；
//   4. 本文件零依赖（不 require 任何模块）——宿主加载器与构建期 import 共用，保持可静态打包。
// ============================================================

/** 当前店表 schema 版本（与 MIGRATIONS 末项 version 一致；宿主记账目标位） */
const STORE_SCHEMA_VERSION = 1

/** 文档复习店表 DDL（P1c 起复习态唯一权威源；稀疏表不变式：只存非默认行，行缺省=从未练习=立即到期）。
 *  单源导出：内核 legacy 搬迁/回放/恢复机器段经构建期 import 共用本文本，禁止在内核侧复制 */
const DOC_REVIEW_DDL =
  'CREATE TABLE IF NOT EXISTS quiz_maker_doc_review (doc_id TEXT PRIMARY KEY, ease_factor REAL DEFAULT 2.5, interval_days INTEGER DEFAULT 1, repetition INTEGER DEFAULT 0, next_review_at DATETIME)'

/**
 * 迁移清单（宿主只逐条执行，不解释语义）。
 * v1（B1 收权批）：内核 init 早期幂等建表面摘除后，全部 6 张自店表 + 基线索引的
 * 建表责任收编本清单——含此前无显式建表入口的嵌入缓存表（原经内核 SCHEMA 建内核名后
 * 残表迁店改名产生）与文档复习店表（原由内核机器段 DOC_REVIEW_DDL 建表）。
 */
const MIGRATIONS = [
  {
    version: 1,
    statements: [
      // 题目主表：原内核 questions 全列（含 SM-2 题级四列 / cognitive_level / verified / generator）
      `CREATE TABLE IF NOT EXISTS quiz_maker_questions (
        id TEXT PRIMARY KEY,
        document_id TEXT,
        repo_id TEXT,
        knowledge_point_id TEXT,
        type TEXT NOT NULL,
        question TEXT NOT NULL,
        options_json TEXT NOT NULL DEFAULT '[]',
        answer TEXT NOT NULL,
        explanation TEXT NOT NULL DEFAULT '',
        source_snippet TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        plugin_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'confirmed',
        schema_version INTEGER NOT NULL DEFAULT 1,
        ease_factor REAL NOT NULL DEFAULT 2.5,
        interval_days INTEGER NOT NULL DEFAULT 1,
        repetition INTEGER NOT NULL DEFAULT 0,
        next_review_at DATETIME,
        verified INTEGER NOT NULL DEFAULT 0,
        generator TEXT NOT NULL DEFAULT '',
        cognitive_level TEXT NOT NULL DEFAULT '',
        created_at DATETIME NOT NULL DEFAULT '',
        updated_at DATETIME NOT NULL DEFAULT ''
      )`,
      // 题级作答流水
      `CREATE TABLE IF NOT EXISTS quiz_maker_question_attempts (
        id TEXT PRIMARY KEY,
        question_id TEXT,
        correct INTEGER,
        quality INTEGER,
        reaction_ms INTEGER,
        was_due INTEGER,
        response_text TEXT,
        answered_at DATETIME NOT NULL DEFAULT ''
      )`,
      // 题反馈（题库题走 question_id；即时题走文档锚点 document_id + attempt_id）
      `CREATE TABLE IF NOT EXISTS quiz_maker_question_feedback (
        id TEXT PRIMARY KEY,
        question_id TEXT,
        document_id TEXT,
        attempt_id TEXT,
        kind TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at DATETIME NOT NULL DEFAULT ''
      )`,
      // 文档级练习会话流水（文档锚点制主轨）
      `CREATE TABLE IF NOT EXISTS quiz_maker_practice_attempts (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        question_snapshot TEXT NOT NULL,
        question_type TEXT,
        plugin_id TEXT,
        correct INTEGER,
        quality INTEGER,
        reaction_ms INTEGER,
        was_due INTEGER,
        response_text TEXT,
        answered_at DATETIME NOT NULL DEFAULT ''
      )`,
      // 语义去重嵌入缓存（model 入键，不同模型向量空间不可比；原内核 SCHEMA 名随 B1 移交）
      `CREATE TABLE IF NOT EXISTS quiz_maker_question_embeddings (
        question_id TEXT PRIMARY KEY,
        model TEXT NOT NULL DEFAULT '',
        dim INTEGER NOT NULL DEFAULT 0,
        vector BLOB NOT NULL,
        created_at DATETIME NOT NULL DEFAULT ''
      )`,
      // 文档复习店表（P1c 摘列后的复习态唯一权威源）
      DOC_REVIEW_DDL,
      // 基线索引（原内核 init 题域索引块随 B1 移交；旧库已建同名索引由 IF NOT EXISTS 收敛）
      'CREATE INDEX IF NOT EXISTS idx_q_doc ON quiz_maker_questions(document_id)',
      'CREATE INDEX IF NOT EXISTS idx_q_kp ON quiz_maker_questions(knowledge_point_id)',
      'CREATE INDEX IF NOT EXISTS idx_q_hash ON quiz_maker_questions(document_id, content_hash)',
      'CREATE INDEX IF NOT EXISTS idx_q_next ON quiz_maker_questions(next_review_at)',
      'CREATE INDEX IF NOT EXISTS idx_pa_document ON quiz_maker_practice_attempts(document_id)',
      'CREATE INDEX IF NOT EXISTS idx_pa_answered ON quiz_maker_practice_attempts(answered_at)',
      'CREATE INDEX IF NOT EXISTS idx_qa_question ON quiz_maker_question_attempts(question_id)',
      'CREATE INDEX IF NOT EXISTS idx_qf_question ON quiz_maker_question_feedback(question_id)',
    ],
  },
]

// 导出用 exports.X 逐个具名形态（禁 module.exports 整体赋值）——内核构建链
// （electron-vite/rollup SSR）对 CJS 整体赋值的 named import 静态识别失败会炸主进程构建
// （真机门实证：storage-service import { DOC_REVIEW_DDL } 报 not exported）；
// 宿主执行器 require 消费在两种形态下语义等价。
exports.version = STORE_SCHEMA_VERSION
exports.migrations = MIGRATIONS
exports.STORE_SCHEMA_VERSION = STORE_SCHEMA_VERSION
exports.MIGRATIONS = MIGRATIONS
exports.DOC_REVIEW_DDL = DOC_REVIEW_DDL
