// 论文全文分块：按页拆分后按 ~1100 字符切块，相邻块回叠约 160 字符。
// chunkPaper 是纯函数，同一文本的切块结果（含 chunk id）是确定性的——语义索引的向量按 chunkId 对齐存储。
export type Chunk = { id: number; page: number; heading: string; text: string };

const CHUNK_TARGET = 1100;

export function chunkPaper(fullText: string): Chunk[] {
  const pages = String(fullText || "").split(/(?=--- PAGE \d+ ---)/).filter((page) => page.trim());
  const chunks: Chunk[] = [];
  let id = 0;
  for (const pageBlock of pages) {
    const match = pageBlock.match(/^--- PAGE (\d+) ---/);
    const page = match ? Number(match[1]) : 1;
    const body = pageBlock.replace(/^--- PAGE \d+ ---\s*\n?/, "");
    const lines = body.split("\n").map((line) => line.trim()).filter(Boolean);
    let buffer: string[] = [];
    let heading = "";
    // 相邻分块回叠约 160 字符：关键句被切在两个分块边界时，两半至少有一块能完整检出
    let overlap = "";
    const flush = () => {
      const bodyText = buffer.join(" ").replace(/\s+/g, " ").trim();
      buffer = [];
      const text = (overlap + bodyText).trim();
      if (text.length > 40) chunks.push({ id: id++, page, heading, text });
      overlap = bodyText ? `${bodyText.slice(-160)} ` : "";
    };
    for (const line of lines) {
      const looksHeading = line.length <= 80 && !/[.。;；,，:：]$/.test(line) && /[A-Za-z\u4e00-\u9fff]/.test(line);
      if (looksHeading && buffer.join(" ").length > 300) flush();
      if (looksHeading) heading = line;
      buffer.push(line);
      if (buffer.join(" ").length >= CHUNK_TARGET) flush();
    }
    flush();
  }
  return chunks;
}

// 分块结果的模块级缓存：同一篇论文的重复提问不再每次重新切分全文。
// key 为 `paperId:updatedAt`（服务端从库读取时）或文本长度+首尾采样哈希（客户端直传时）。
const CHUNK_CACHE_LIMIT = 20;
const chunkCache = new Map<string, Chunk[]>();

export function chunkCacheKey(paperId: string, updatedAt: string, text: string) {
  if (paperId) return `${paperId}:${updatedAt}`;
  const sample = `${text.slice(0, 64)}${text.length}${text.slice(-64)}`;
  let hash = 0;
  for (let index = 0; index < sample.length; index++) hash = (hash * 31 + sample.charCodeAt(index)) | 0;
  return `text:${text.length}:${hash}`;
}

export function cachedChunkPaper(cacheKey: string, text: string): Chunk[] {
  const cached = chunkCache.get(cacheKey);
  if (cached) return cached;
  const chunks = chunkPaper(text);
  if (chunkCache.size >= CHUNK_CACHE_LIMIT) {
    // Map 按插入序迭代，满了就清掉最旧的一条
    const oldest = chunkCache.keys().next().value;
    if (oldest !== undefined) chunkCache.delete(oldest);
  }
  chunkCache.set(cacheKey, chunks);
  return chunks;
}
