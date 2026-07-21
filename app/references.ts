// 参考文献解析：从整篇提取文本（含 --- PAGE N --- 分页标记）中定位文末 References 段落。
// 支持两种模式：[n] / n. 编号条目（arXiv 主流），以及无编号的作者-年份条目（NeurIPS/ICLR/ACL 风格）。
// 纯函数、无依赖，任何解析失败都返回空结果，绝不抛错。

export type ReferenceEntry = { index: number; text: string; page: number };

// 作者-年份条目：surname 已 normalize（小写、去重音、只留字母），suffix 是 2024a 的 "a"
export type AuthorYearEntry = { surname: string; year: string; suffix: string; text: string; page: number };
// 点击识别出的作者-年份引用
export type AuthorYearCitation = { surname: string; year: string; suffix: string };

const HEADING_PATTERN = /^\s*(references|bibliography|参考文献)\s*$/i;
const PAGE_MARKER_PATTERN = /^--- PAGE (\d+) ---$/;
// 文献之后的附录/致谢等段落：结束解析，避免折行逻辑把附录内容并进最后一条
const SECTION_AFTER_PATTERN = /^(appendix|appendices|acknowledgements?|acknowledgments?|supplementary)\b/i;
const BRACKET_ENTRY_PATTERN = /^\[(\d{1,4})\]\s*(.*)$/;
const NUMBERED_ENTRY_PATTERN = /^(\d{1,4})\.\s+(.*)$/;
const MAX_ENTRY_LENGTH = 600;

// 每行对应的 PDF 页码，跟随分页标记推进
function pagesOfLines(lines: string[]) {
  const pageOfLine: number[] = new Array(lines.length);
  let page = 1;
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].match(PAGE_MARKER_PATTERN);
    if (marker) page = Number(marker[1]) || page;
    pageOfLine[i] = page;
  }
  return pageOfLine;
}

// 从文末向前找最后一个合理的 References 标题。不能只看位置——附录很长的论文
// 文献区可能只在全文 40% 处；因此每个候选标题都要校验其后跟着的是不是真的文献条目，
// 目录里的 "References" 后面是章节标题，通不过密度校验
function findReferencesHeading(lines: string[]) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (HEADING_PATTERN.test(lines[i]) && looksLikeReferences(lines, i)) return i;
  }
  return -1;
}

// 校验标题后的内容密度：往后最多扫 40 个非空行，至少 3 行疑似文献条目开头才算数
function looksLikeReferences(lines: string[], headingIndex: number) {
  let score = 0;
  let checked = 0;
  for (let i = headingIndex + 1; i < lines.length && checked < 40; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || PAGE_MARKER_PATTERN.test(trimmed)) continue;
    if (SECTION_AFTER_PATTERN.test(trimmed)) break;
    checked++;
    if (BRACKET_ENTRY_PATTERN.test(trimmed) || NUMBERED_ENTRY_PATTERN.test(trimmed) || isAuthorYearEntryStart(trimmed)) score++;
    if (score >= 3) return true;
  }
  return false;
}

export function parseReferences(paperText: string): Map<number, ReferenceEntry> {
  const entries = new Map<number, ReferenceEntry>();
  try {
    if (!paperText || !paperText.trim()) return entries;
    const lines = paperText.split(/\r?\n/);
    const pageOfLine = pagesOfLines(lines);
    const headingIndex = findReferencesHeading(lines);
    if (headingIndex < 0) return entries;

    let current: { index: number; page: number; parts: string[] } | null = null;
    let sawBracket = false; // 一旦确认是 [n] 格式就停用 n. 兜底，避免折行里的 "3." 被当成新条目
    let lastNumberedIndex = 0; // n. 兜底格式要求编号连续递增，防止把正文里的年份/小数误判为条目
    const flush = () => {
      if (!current) return;
      const text = current.parts.join(" ").replace(/\s+/g, " ").trim().slice(0, MAX_ENTRY_LENGTH);
      if (text && !entries.has(current.index)) entries.set(current.index, { index: current.index, text, page: current.page });
      current = null;
    };

    for (let i = headingIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (PAGE_MARKER_PATTERN.test(line)) continue;
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (SECTION_AFTER_PATTERN.test(trimmed)) break;

      const bracket = trimmed.match(BRACKET_ENTRY_PATTERN);
      if (bracket) {
        flush();
        sawBracket = true;
        current = { index: Number(bracket[1]), page: pageOfLine[i], parts: [trimmed] };
        lastNumberedIndex = current.index;
        continue;
      }
      const numbered = sawBracket ? null : trimmed.match(NUMBERED_ENTRY_PATTERN);
      if (numbered && Number(numbered[1]) === lastNumberedIndex + 1) {
        flush();
        current = { index: Number(numbered[1]), page: pageOfLine[i], parts: [trimmed] };
        lastNumberedIndex = current.index;
        continue;
      }
      // 条目跨行折行：并入当前条目；标题前的孤立段落直接忽略
      if (current) current.parts.push(trimmed);
    }
    flush();
    // 条目太少说明不是真正的编号文献区（附录里的编号列表也可能连续），返回空让作者-年份模式接管
    if (entries.size < 3) return new Map();
    return entries;
  } catch {
    return new Map();
  }
}

// 条目开头的几种排版：a) 「姓, 首字母.,」如 "Guo, D., Yang, D., ..."；b) 全名「名 姓,」如 "Daya Guo, Dejian Yang, ..."；
// c) 全名（可含中间名首字母）直接跟年份（ACL 风格）"Jie Pang and Rui Yang. 2025." / "Taher H. Haveliwala. 2002."；d) 机构作者 "OpenAI. Gpt-4 ..."
const SURNAME_FIRST_START = /^[A-Z][\wÀ-ÿ'’-]+,\s*([A-Z]\.?,?\s*)+/;
const FULLNAME_START = /^[A-Z][\wÀ-ÿ'’.-]+\s+[A-Z][\wÀ-ÿ'’-]+,/;
const FULLNAME_YEAR_START = /^[A-Z][\wÀ-ÿ'’.-]+(\s+[A-Z]\.)?\s+[A-Z][\wÀ-ÿ'’-]+(\s+(and|&)\s+[A-Z][\wÀ-ÿ'’.-]+(\s+[A-Z]\.)?\s+[A-Z][\wÀ-ÿ'’-]+)*\.\s+(?:19|20)\d{2}/;
const ORG_START = /^[A-Z][\wÀ-ÿ'’-]*\.\s+\S/;
const YEAR_TOKEN_PATTERN = /\b((?:19|20)\d{2})([a-z])?\b/g;

function isAuthorYearEntryStart(line: string) {
  return SURNAME_FIRST_START.test(line) || FULLNAME_START.test(line) || FULLNAME_YEAR_START.test(line) || ORG_START.test(line);
}

// 姓的归一化：小写、去变音符号、去掉连字符/撇号等非字母，减少排版差异造成的失配
export function normalizeSurname(name: string) {
  return name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, "");
}

// 从条目中提取第一作者姓 + 出版年 + 字母后缀；firstLine 是条目首行，用来判定作者排版
function extractAuthorYear(text: string, firstLine: string): AuthorYearCitation | null {
  // 年份取条目里第一个 19xx/20xx：作者-年份格式出版年紧跟作者列表（"Authors. 2025. Title..."），
  // 取最后一个会把 "accessed 2026-04-01" 这类访问日期误当出版年
  YEAR_TOKEN_PATTERN.lastIndex = 0;
  const firstYear = YEAR_TOKEN_PATTERN.exec(text);
  if (!firstYear) return null;
  const year = firstYear[1];
  const suffix = firstYear[2] || "";
  let surname = "";
  if (SURNAME_FIRST_START.test(firstLine)) {
    // 姓在前排版："Guo, D., ..." 第一个逗号前整体即姓
    surname = firstLine.slice(0, firstLine.indexOf(",")).trim();
  } else {
    // 全名排版："Daya Guo, ..." / "Jie Pang and Rui Yang. 2025." 取「名（可带中间名首字母）姓」的最后一个词；
    // 机构作者："OpenAI. Gpt-4 ..." 第一个词后紧跟句点，fullname 不会命中，退化为取第一个词
    const fullname = firstLine.match(/^[A-Z][\wÀ-ÿ'’-]+\s+(?:[A-Z]\.\s+)?([A-Z][\wÀ-ÿ'’-]+)/);
    surname = fullname ? fullname[1] : (firstLine.split(/[\s.]/)[0] || "");
  }
  surname = normalizeSurname(surname);
  return surname ? { surname, year, suffix } : null;
}

export function parseAuthorYearReferences(paperText: string): AuthorYearEntry[] {
  const entries: AuthorYearEntry[] = [];
  try {
    if (!paperText || !paperText.trim()) return entries;
    const lines = paperText.split(/\r?\n/);
    const pageOfLine = pagesOfLines(lines);
    const headingIndex = findReferencesHeading(lines);
    if (headingIndex < 0) return entries;

    let current: { page: number; parts: string[] } | null = null;
    const flush = () => {
      if (!current) return;
      const text = current.parts.join(" ").replace(/\s+/g, " ").trim().slice(0, MAX_ENTRY_LENGTH);
      const meta = extractAuthorYear(text, current.parts[0] || "");
      if (meta) entries.push({ ...meta, text, page: current.page });
      current = null;
    };

    for (let i = headingIndex + 1; i < lines.length; i++) {
      if (PAGE_MARKER_PATTERN.test(lines[i])) continue;
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      if (SECTION_AFTER_PATTERN.test(trimmed)) break;
      const isEntryStart = isAuthorYearEntryStart(trimmed);
      // 年份锚点切分：当前累积里已出现出版年才允许切分——作者列表折行不会被误切，因为年份在条目末尾
      if (isEntryStart && current && /\b(?:19|20)\d{2}[a-z]?\b/.test(current.parts.join(" "))) flush();
      if (!current) current = { page: pageOfLine[i], parts: [trimmed] };
      else current.parts.push(trimmed);
      if (entries.length >= 500) break; // 防御性上限
    }
    flush();
    return entries;
  } catch {
    return [];
  }
}

// 引用匹配：归一化姓 + 年份精确匹配；带后缀优先同后缀，无后缀且同年多条时取第一条
export function matchAuthorYearEntry(entries: AuthorYearEntry[], citation: AuthorYearCitation): { entry: AuthorYearEntry | null; sameYearCount: number } {
  try {
    const surname = normalizeSurname(citation.surname);
    if (!surname || !citation.year) return { entry: null, sameYearCount: 0 };
    const candidates = entries.filter((item) => item.surname === surname && item.year === citation.year);
    if (!candidates.length) return { entry: null, sameYearCount: 0 };
    if (citation.suffix) {
      const exact = candidates.find((item) => item.suffix === citation.suffix);
      if (exact) return { entry: exact, sameYearCount: candidates.length };
    }
    return { entry: candidates[0], sameYearCount: candidates.length };
  } catch {
    return { entry: null, sameYearCount: 0 };
  }
}
