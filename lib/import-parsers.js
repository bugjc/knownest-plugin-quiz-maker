'use strict'
// Knownest quiz-maker - 题目导入解析器（B0，计划 2026-10-03-question-import-and-bank-lean-plan §3.2.3）
// 管什么：外部通用格式（Knownest JSON / Anki TSV / CSV）→ 归一化题目 + 逐行错误披露 + 承载文档底稿。
// 不管什么：文件读取与编码嗅探（Deck file 通道负责）、落库（importBank/confirmBankImport 负责）、xlsx 解包（渲染层归一为 CSV 后进本模块）。
// 判分约定对齐：core/knowledge/question-types.ts gradeResponse——单选 answer=选项文本；多选 answer=JSON 数组字符串；
//               判断 answer∈{对,错}（grader 按 正确/true/对 归侧）；填空/简答 answer=原文。
// 纪律：本模块被 vm 沙箱相对 require 加载——纯函数、禁止 require 任何外部模块。

// ---- 题型（MVP 五类；排序/材料共享题干/图题明确不支持，§3.2.3）----
var SUPPORTED_TYPES = ['single_choice', 'multi_choice', 'true_false', 'fill_blank', 'short_answer']
var TYPE_LABELS = { single_choice: '单选', multi_choice: '多选', true_false: '判断', fill_blank: '填空', short_answer: '简答' }

// 题型同义词（列值命中即映射；含「排序/材料/听力」等显式不支持型，命中即逐行披露不静默转换）
var TYPE_WORDS = [
  { re: /单选|单项选择|single/i, type: 'single_choice' },
  { re: /多选|多项选择|multi/i, type: 'multi_choice' },
  { re: /判断|是非|true.?false|对错/i, type: 'true_false' },
  { re: /填空|fill/i, type: 'fill_blank' },
  { re: /简答|问答|简述|论述|short|essay/i, type: 'short_answer' },
]
var UNSUPPORTED_TYPE_RE = /排序|材料题|听力|阅读理解|完形|ordering|listening/i

// 表头同义词（§3.2.3：题干/题目/question…表头行可选）
var HEADER_WORDS = {
  type: ['题型', '类型', 'type'],
  question: ['题干', '题目', '问题', 'question', 'stem'],
  options: ['选项', 'options'],
  answer: ['答案', '正确答案', 'answer', 'key'],
  explanation: ['解析', '解释', '说明', 'explanation', 'analysis'],
  optionLetter: /^选项\s*[a-fA-F]$|^[a-fA-F][.、:：]?$/,
}
var TRUE_WORDS = ['√', '对', '正确', 'true', 't', 'y', 'yes', '是']
var FALSE_WORDS = ['×', 'x', '错', '错误', 'false', 'f', 'n', 'no', '否']

function text(v) { return v === null || v === undefined ? '' : String(v).trim() }
function hasWord(cell, words) { var c = text(cell).toLowerCase().replace(/\s/g, ''); return words.some(function (w) { return c === w || c.replace(/[.:：、]/g, '') === w }) }

// ---- 格式嗅探（§3.2 编码嗅探在 Deck file 通道；这里只认文本形态）----
function detectFormat(content, filename) {
  var c = text(content)
  var name = text(filename).toLowerCase()
  if (c[0] === '{' || c[0] === '[') return 'json'
  if (/^#separator/m.test(c) || /^#[\w-]+:/m.test(c) || /\.tsv$|\.txt$/.test(name)) {
    if (/^#separator/m.test(c) || /\t/.test(c.split(/\r?\n/)[0] || '')) return 'anki-tsv'
    if (/\.tsv$/.test(name)) return 'anki-tsv'
  }
  return 'csv'
}

// ---- RFC4180 CSV/TSV 解析（引号/转义引号/CRLF；分隔符嗅探：首行 tab 多于逗号则 tab）----
function splitTable(content, forcedDelim) {
  var firstLine = (content.split(/\r?\n/)[0] || '')
  var delim = forcedDelim || ((firstLine.split('\t').length > firstLine.split(',').length) ? '\t' : ',')
  var rows = []
  var row = []
  var cell = ''
  var inQuotes = false
  for (var i = 0; i < content.length; i++) {
    var ch = content[i]
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') { cell += '"'; i++ } else { inQuotes = false }
      } else { cell += ch }
    } else if (ch === '"' && cell === '') {
      inQuotes = true
    } else if (ch === delim) {
      row.push(cell); cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && content[i + 1] === '\n') i++
      row.push(cell); cell = ''
      if (row.some(function (c) { return text(c) !== '' })) rows.push(row)
      row = []
    } else { cell += ch }
  }
  row.push(cell)
  if (row.some(function (c) { return text(c) !== '' })) rows.push(row)
  return rows
}

// ---- 归一化 ----
function normalizeType(raw) {
  var v = text(raw)
  if (!v) return { type: null }
  if (UNSUPPORTED_TYPE_RE.test(v)) return { type: null, unsupported: '题型「' + v + '」暂不支持（支持：单选/多选/判断/填空/简答）' }
  for (var i = 0; i < TYPE_WORDS.length; i++) if (TYPE_WORDS[i].re.test(v)) return { type: TYPE_WORDS[i].type }
  return { type: null, unsupported: '无法识别的题型「' + v + '」' }
}

function isBooleanAnswer(v) {
  var c = text(v).toLowerCase()
  return TRUE_WORDS.indexOf(c) >= 0 || FALSE_WORDS.indexOf(c) >= 0
}

function normalizeBoolAnswer(raw) {
  var c = text(raw).toLowerCase()
  if (TRUE_WORDS.indexOf(c) >= 0) return '对'
  if (FALSE_WORDS.indexOf(c) >= 0) return '错'
  return null
}

function toAsciiLetter(ch) {
  var c = text(ch)
  if (c.length !== 1) return ''
  var code = c.charCodeAt(0)
  if (code >= 65 && code <= 90) return c
  if (code >= 97 && code <= 122) return c.toUpperCase()
  if (code >= 0xff21 && code <= 0xff3a) return String.fromCharCode(code - 0xff21 + 65)
  if (code >= 0xff41 && code <= 0xff5a) return String.fromCharCode(code - 0xff41 + 65)
  return ''
}

// 答案归一（§3.2.3）：单选 字母→选项文本；多选 AB/A,B/A|B→JSON 数组（判分 parseArray 契约）；判断 √/×/对/错→对/错
function normalizeAnswer(type, raw, options) {
  var v = text(raw)
  if (!v) return { error: '答案为空' }
  if (type === 'true_false') {
    var b = normalizeBoolAnswer(v)
    return b ? { answer: b } : { error: '无法识别的判断题答案「' + v.slice(0, 12) + '」（支持 √/×/对/错/正确/错误/true/false）' }
  }
  if (type === 'single_choice' || type === 'multi_choice') {
    if (!options || options.length === 0) return { error: '选择题缺少选项' }
    var letters = []
    if (type === 'multi_choice') {
      var cleaned = v.replace(/[,，、|/\s+;；]+/g, '')
      for (var i = 0; i < cleaned.length; i++) { var L = toAsciiLetter(cleaned[i]); if (L) letters.push(L) }
    } else {
      var L1 = toAsciiLetter(v.slice(0, 1))
      var rest = v.length > 1 ? text(v.slice(1)) : ''
      if (L1 && (rest === '' || /^[.、:：)）]/.test(rest))) letters = [L1]
    }
    var byIdx = letters.map(function (L) {
      var idx = L.charCodeAt(0) - 65
      if (idx < 0 || idx >= options.length) return { error: '答案选项 ' + L + ' 超出选项数（共 ' + options.length + ' 项）' }
      return { answer: options[idx] }
    })
    if (letters.length > 0) {
      if (byIdx[0].error) return byIdx[0]
      if (type === 'multi_choice') {
        if (letters.length < 2) return { error: '多选题答案至少两个选项字母' }
        return { answer: JSON.stringify(byIdx.map(function (x) { return x.answer })) }
      }
      return byIdx[0]
    }
    // 非字母：按选项原文匹配
    var hit = options.filter(function (o) { return text(o) === v })
    if (hit.length > 0) return type === 'multi_choice' ? { answer: JSON.stringify([hit[0]]) } : { answer: hit[0] }
    return { error: '答案「' + v.slice(0, 12) + '」既非选项字母也与选项原文不匹配' }
  }
  return { answer: v }
}

// ---- CSV/TSV 行 → 题目（表头同义词识别；无表头按模板位序 题型,题干,选项,答案,解析）----
function parseTableQuestions(rows) {
  var questions = []
  var errors = []
  if (rows.length === 0) return { questions: questions, errors: [{ line: 1, reason: '文件为空' }] }
  // 表头探测：首行命中任一命名同义词（题干/答案等五组）即表头行——选项字母列（A/选项A）单独出现不算表头信号，
  // 否则答案列为裸字母的模板位序文件（如「单选,q,甲|乙,B」）会被整表误判为表头（实测教训）
  var head = rows[0]
  var HEADER_KEYS = ['type', 'question', 'options', 'answer', 'explanation']
  var isHeader = head.some(function (cell) {
    var c = text(cell).toLowerCase().replace(/\s/g, '')
    return HEADER_KEYS.some(function (k) {
      return HEADER_WORDS[k].some(function (w) { return c === w })
    })
  })
  var col = { type: -1, question: -1, options: -1, answer: -1, explanation: -1, letters: {} }
  var dataRows = rows
  var letterCols = [] // [{idx, letter}]
  if (isHeader) {
    dataRows = rows.slice(1)
    head.forEach(function (cell, idx) {
      var label = text(cell)
      var c = label.toLowerCase().replace(/\s/g, '')
      if (HEADER_WORDS.optionLetter.test(label)) {
        var m = label.match(/[a-fA-F]/)
        if (m) { col.letters[m[0].toUpperCase()] = idx; letterCols.push({ idx: idx, letter: m[0].toUpperCase() }) }
        return
      }
      for (var k in HEADER_WORDS) {
        if (k === 'optionLetter') continue
        var hitW = HEADER_WORDS[k].some(function (w) { return c === w })
        // 「选项(|分隔)」等带说明后缀的表头：options 列按「选项」前缀兜底
        if (!hitW && k === 'options' && c.indexOf('选项') === 0) hitW = true
        if (hitW && col[k] === -1) { col[k] = idx; return }
      }
    })
    if (col.question === -1) return { questions: [], errors: [{ line: 1, reason: '表头缺少「题干/题目」列（可用列名：题干、选项、答案、解析、题型）' }] }
    if (col.answer === -1) return { questions: [], errors: [{ line: 1, reason: '表头缺少「答案」列' }] }
  }
  var baseLine = isHeader ? 2 : 1
  for (var r = 0; r < dataRows.length; r++) {
    var line = baseLine + r
    var cells = dataRows[r].map(text)
    var allEmpty = cells.every(function (c) { return c === '' })
    if (allEmpty) continue
    var typeRaw = isHeader ? (col.type >= 0 ? cells[col.type] : '') : cells[0]
    var qRaw = isHeader ? cells[col.question] : cells[1]
    var optRaw = isHeader ? (col.options >= 0 ? cells[col.options] : '') : cells[2]
    var ansRaw = isHeader ? cells[col.answer] : cells[3]
    var expRaw = isHeader ? (col.explanation >= 0 ? cells[col.explanation] : '') : cells[4]
    if (text(qRaw) === '') { errors.push({ line: line, reason: '题干为空' }); continue }
    var t = normalizeType(typeRaw)
    if (t.unsupported) { errors.push({ line: line, reason: t.unsupported }); continue }
    // 选项：单列 |分隔；或 表头 选项A~F 多列
    var options = []
    if (letterCols.length > 0) {
      options = letterCols.map(function (lc) { return cells[lc.idx] }).filter(function (o) { return text(o) !== '' })
    } else if (text(optRaw) !== '') {
      options = optRaw.split(/[|｜]/).map(text).filter(function (o) { return o !== '' })
    }
    var inferred = t.type
    if (!inferred) {
      if (options.length >= 2 && isBooleanAnswer(ansRaw)) inferred = 'true_false'
      else if (options.length >= 2) inferred = 'single_choice'
      else inferred = 'short_answer'
      // 多字母答案 → 多选
      if (options.length >= 2 && !isBooleanAnswer(ansRaw)) {
        var cleaned = text(ansRaw).replace(/[,，、|/\s+;；]+/g, '')
        var letterCount = 0
        for (var ci = 0; ci < cleaned.length; ci++) if (toAsciiLetter(cleaned[ci])) letterCount++
        if (letterCount >= 2) inferred = 'multi_choice'
      }
    }
    if (inferred === 'true_false') options = []
    if ((inferred === 'single_choice' || inferred === 'multi_choice') && options.length < 2) {
      errors.push({ line: line, reason: '选择题选项不足 2 项' }); continue
    }
    var a = normalizeAnswer(inferred, ansRaw, options)
    if (a.error) { errors.push({ line: line, reason: a.error }); continue }
    questions.push({ type: inferred, question: text(qRaw), options: options.length ? options : undefined, answer: a.answer, explanation: text(expRaw) || undefined, line: line })
  }
  if (questions.length === 0 && errors.length === 0) errors.push({ line: baseLine, reason: '没有可识别的题目行' })
  return { questions: questions, errors: errors }
}

// ---- Anki TSV（导出对称：#separator 指令行 + front/back/tags；卡片型题目记简答）----
function parseAnkiTsv(content) {
  var lines = content.split(/\r?\n/)
  var questions = []
  var errors = []
  var line = 0
  for (var i = 0; i < lines.length; i++) {
    line = i + 1
    var raw = lines[i]
    if (text(raw) === '' || /^#/.test(raw)) continue
    var cells = raw.split('\t')
    var front = text(cells[0]).replace(/<[^>]+>/g, '').trim()
    var back = text(cells[1]).replace(/<[^>]+>/g, '').trim()
    if (front === '') { errors.push({ line: line, reason: '正面（题干）为空' }); continue }
    if (back === '') { errors.push({ line: line, reason: '背面（答案）为空' }); continue }
    questions.push({ type: 'short_answer', question: front, answer: back, explanation: text(cells[2]) || undefined, line: line })
  }
  if (questions.length === 0 && errors.length === 0) errors.push({ line: 1, reason: '没有可识别的 Anki 卡片行（正面[Tab]背面）' })
  return { questions: questions, errors: errors }
}

// ---- Knownest JSON（v1 导入文件超集兼容：documentId/sourceSnippet 不再必需——承载文档供给）----
function parseKnownestJson(content) {
  var parsed
  try { parsed = JSON.parse(content) } catch (e) { return { questions: [], errors: [{ line: 1, reason: 'JSON 解析失败：不是有效的题库文件' }] } }
  var list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.questions) ? parsed.questions : null)
  if (!list) return { questions: [], errors: [{ line: 1, reason: '文件中没有题目（需要数组或 {questions:[...]}）' }]
  }
  var questions = []
  var errors = []
  for (var i = 0; i < list.length; i++) {
    var q = list[i]
    var line = i + 1
    if (!q || text(q.question) === '') { errors.push({ line: line, reason: '题干为空' }); continue }
    if (text(q.answer) === '') { errors.push({ line: line, reason: '答案为空' }); continue }
    var type = SUPPORTED_TYPES.indexOf(q.type) >= 0 ? q.type : 'short_answer'
    questions.push({
      type: type,
      question: text(q.question),
      options: Array.isArray(q.options) ? q.options.map(text).filter(function (o) { return o !== '' }) : undefined,
      answer: text(q.answer),
      explanation: text(q.explanation) || undefined,
      line: line,
    })
  }
  if (questions.length === 0 && errors.length === 0) errors.push({ line: 1, reason: '文件中没有题目' })
  return { questions: questions, errors: errors }
}

// ---- 入口：格式嗅探 → 分发 → 统一产出 { format, questions, errors } ----
function parseImport(content, filename) {
  var format = detectFormat(content, filename)
  var out
  if (format === 'json') out = parseKnownestJson(content)
  else if (format === 'anki-tsv') out = parseAnkiTsv(content)
  else out = parseTableQuestions(splitTable(content))
  return { format: format, questions: out.questions, errors: out.errors }
}

// ---- 承载文档（§3.1：正文分节=原文底稿，sourceSnippet 锚定分节正文；D4 同名追加=分节带时间戳重排由调用方处理）----
function qSection(q, i) {
  var lines = []
  lines.push('【题 ' + (i + 1) + '·' + (TYPE_LABELS[q.type] || q.type) + '】')
  lines.push(q.question)
  if (q.options && q.options.length) q.options.forEach(function (o, oi) { lines.push(String.fromCharCode(65 + oi) + '. ' + o) })
  lines.push('答案：' + (q.type === 'multi_choice' ? (function () { try { return JSON.parse(q.answer).join('；') } catch (e) { return q.answer } })() : q.answer))
  if (q.explanation) lines.push('解析：' + q.explanation)
  return lines.join('\n')
}

function buildCarrierMarkdown(filename, questions, importedAt) {
  var head = [
    '---',
    'source: import',
    'source_file: ' + text(filename).replace(/\r?\n/g, ' '),
    'imported_at: ' + (importedAt || new Date().toISOString()),
    '---',
    '',
    '# ' + text(filename).replace(/\.md$/i, '') + '（导入题目）',
    '',
    '> 本文档由题库导入自动生成：下列分节为导入题目原文底稿，题库中每道导入题的「原文引用」锚定对应分节；删除本文档将级联移除对应题目。',
    '',
  ]
  var body = questions.map(function (q, i) { return qSection(q, i) })
  return { markdown: head.join('\n') + body.join('\n\n') + '\n', sections: body }
}

// ---- 导入模板（CSV；Excel 可直接打开编辑后另存）----
function buildTemplateCsv() {
  return [
    '题型,题干,选项(|分隔),答案,解析',
    '单选,Knownest 的题目导入支持以下哪种格式？,Anki TSV|PDF|Word 截图,A,通用文本格式可无损往返',
    '判断,导入的题目必须锚定承载文档。,,对,无锚点题目不允许入库（ADR-102）',
    '多选,导入时会披露哪些对账信息？,解析成功数|识别失败行|库内疑似重复|AI 出题成本,ABC,失败行逐行列出原因',
  ].join('\n') + '\n'
}

module.exports = {
  SUPPORTED_TYPES: SUPPORTED_TYPES,
  TYPE_LABELS: TYPE_LABELS,
  detectFormat: detectFormat,
  splitTable: splitTable,
  parseImport: parseImport,
  parseKnownestJson: parseKnownestJson,
  parseAnkiTsv: parseAnkiTsv,
  normalizeType: normalizeType,
  normalizeAnswer: normalizeAnswer,
  buildCarrierMarkdown: buildCarrierMarkdown,
  buildTemplateCsv: buildTemplateCsv,
}
