// quiz-maker 自持店表 schema 的宿主侧类型声明（类型面；运行时权威文本在 schema.js）
// storage-service 机器段构建期 import DOC_REVIEW_DDL 时经本声明取得类型（plugins/ 不在
// tsconfig include 内，.js 无法直接推导类型）。
export interface PluginStoreSchemaMigration {
  version: number
  statements: string[]
}
// 执行器契约形态（{ version, migrations }）+ 具名单源符号，schema.js 双形态同导出
export declare const version: number
export declare const migrations: PluginStoreSchemaMigration[]
export declare const STORE_SCHEMA_VERSION: number
export declare const MIGRATIONS: PluginStoreSchemaMigration[]
export declare const DOC_REVIEW_DDL: string
