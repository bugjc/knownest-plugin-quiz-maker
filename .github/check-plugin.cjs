// 插件仓门禁：清单必需字段 + i18n en 完整性（zh-CN 声明键必须被 en-US 覆盖；镜像主仓 kernel-i18n 门禁口径的最小版）
const fs = require("fs")
const m = JSON.parse(fs.readFileSync("plugin.json", "utf8"))
for (const k of ["id", "name", "version", "entry"]) {
  if (typeof m[k] !== "string" || !m[k]) { console.error("plugin.json 缺必需字段: " + k); process.exit(1) }
}
const zh = (m.i18n && m.i18n["zh-CN"]) || {}
const en = (m.i18n && m.i18n["en-US"]) || {}
const missing = Object.keys(zh).filter((k) => !(k in en))
if (missing.length) { console.error("en-US 词典缺键: " + missing.join(", ")); process.exit(1) }
console.log("ok: " + m.id + "@" + m.version + "（zh " + Object.keys(zh).length + " 键 en 覆盖完整）")
