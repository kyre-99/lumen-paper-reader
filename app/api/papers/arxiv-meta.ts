// arXiv 元数据辅助：从 URL 提取 arXiv id，并从 export.arxiv.org Atom API 抓取标题/作者/发表日期。
// 所有失败路径静默返回空值，绝不抛错阻塞主流程。

const ARXIV_ID_PATTERN = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})$/i;

// 从 arxiv.org 的 abs/pdf 链接提取去版本号的 id；非 arXiv 链接返回 null
export function extractArxivId(url: string): string | null {
  if (!url) return null;
  let pathname: string;
  try {
    const parsed = new URL(url);
    if (!/(^|\.)arxiv\.org$/i.test(parsed.hostname)) return null;
    pathname = parsed.pathname;
  } catch {
    return null;
  }
  const match = pathname.match(/^\/(abs|pdf)\/(.+)$/i);
  if (!match) return null;
  // 去掉尾部 .pdf 与 vN 版本号
  let id = decodeURIComponent(match[2]).replace(/\.pdf$/i, "").replace(/v\d+$/i, "").trim();
  // 新版格式结尾可能跟路径噪声，取首个空白前的部分
  id = id.split(/[\s?#]/)[0];
  return ARXIV_ID_PATTERN.test(id) ? id : null;
}

export type ArxivMeta = { title: string; authors: string; publishedAt: string };

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tagText(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? decodeXmlEntities(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).replace(/\s+/g, " ").trim() : "";
}

// 批量抓取 arXiv 元数据。返回值区分两种"空"：
// - null：整体失败（超时/网络/非 2xx/解析异常），调用方不应做任何标记，下次重试
// - Map（可能为空）：请求成功。空 Map 表示 arXiv 上确实没有这些 id（export.arxiv.org 对全不存在的 id_list 也返回 200 + 空 feed）
export async function fetchArxivMeta(ids: string[]): Promise<Map<string, ArxivMeta> | null> {
  const result = new Map<string, ArxivMeta>();
  const unique = [...new Set(ids.filter(Boolean))].slice(0, 50);
  if (unique.length === 0) return result;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(
      `https://export.arxiv.org/api/query?id_list=${unique.join(",")}&max_results=${unique.length}`,
      { signal: controller.signal, headers: { "User-Agent": "lumen-paper-reader/0.1" } },
    );
    if (!response.ok) return null;
    const xml = await response.text();
    const entries = xml.match(/<entry>[\s\S]*?<\/entry>/gi) || [];
    for (const entry of entries) {
      const rawId = tagText(entry, "id");
      const idMatch = rawId.match(/\/abs\/(.+)$/i);
      if (!idMatch) continue;
      const id = idMatch[1].replace(/v\d+$/i, "");
      const title = tagText(entry, "title");
      const published = tagText(entry, "published").slice(0, 10);
      const authorNames = [...entry.matchAll(/<author>[\s\S]*?<\/author>/gi)]
        .map((author) => tagText(author[0], "name"))
        .filter(Boolean);
      result.set(id, {
        title,
        authors: authorNames.join(", ").slice(0, 300),
        publishedAt: /^\d{4}-\d{2}-\d{2}$/.test(published) ? published : "",
      });
    }
    return result;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
