import { and, eq, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { getDb } from "../../../db";
import { paperChunks, paperIndexes } from "../../../db/schema";
import { embeddingsUrl } from "../../model-config";

// 语义检索（Embedding）：向量以 base64 编码的 Float32 存 D1，余弦相似度在 Worker 内计算。
// chunkId 与 route.ts 中 chunkPaper 的确定性分块结果一一对应，因此不冗余存文本。

type Db = ReturnType<typeof getDb>;
type Chunk = { id: number; page: number; heading: string; text: string };
type TokenMeter = { prompt: number; completion: number };

const EMBED_BATCH = 64;
// D1 单条语句的绑定参数与体积有限，分块写入每批 40 行（每行向量约 8KB）
const WRITE_BATCH = 40;

export function toBase64(vector: Float32Array): string {
  const bytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
  let binary = "";
  const slice = 0x8000;
  for (let index = 0; index < bytes.length; index += slice) binary += String.fromCharCode(...bytes.subarray(index, index + slice));
  return btoa(binary);
}

export function fromBase64(payload: string): Float32Array {
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Float32Array(bytes.buffer);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

// 批量调用 /embeddings；usage 计入 token 表（embedding 费用纳入用量统计）
export async function embedTexts(endpoint: string, apiKey: string, model: string, texts: string[], meter?: TokenMeter): Promise<Float32Array[]> {
  const target = embeddingsUrl(endpoint);
  const vectors: Float32Array[] = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH) {
    const batch = texts.slice(start, start + EMBED_BATCH);
    const response = await fetch(target.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: batch }),
    });
    const data = await response.json().catch(() => ({})) as { error?: { message?: string }; data?: Array<{ embedding?: number[] }>; usage?: { prompt_tokens?: number } };
    if (!response.ok) throw new Error(data?.error?.message || `Embedding 接口返回 ${response.status}`);
    if (!Array.isArray(data.data) || data.data.length !== batch.length) throw new Error("Embedding 接口返回的数据不完整");
    if (meter && data.usage?.prompt_tokens) meter.prompt += Number(data.usage.prompt_tokens) || 0;
    for (const item of data.data) {
      if (!Array.isArray(item.embedding) || !item.embedding.length) throw new Error("Embedding 接口返回了空向量");
      vectors.push(new Float32Array(item.embedding));
    }
  }
  return vectors;
}

// 确保论文的语义索引存在且未失效（模型或文本版本不匹配则重建）。
// 返回 true 表示索引可用；embedding 调用失败等异常向上抛，由调用方降级为纯关键词检索。
export async function ensurePaperIndex(
  db: Db,
  userId: string,
  paperId: string,
  chunks: Chunk[],
  textStamp: string,
  emb: { endpoint: string; apiKey: string; model: string },
  onStep?: (label: string) => void,
  meter?: TokenMeter,
): Promise<boolean> {
  if (!chunks.length) return false;
  const [existing] = await db.select().from(paperIndexes).where(and(eq(paperIndexes.paperId, paperId), eq(paperIndexes.userId, userId))).limit(1);
  if (existing && existing.embeddingModel === emb.model && existing.textStamp === textStamp && existing.chunkCount === chunks.length) return true;
  onStep?.(`正在为本文建立语义索引（${chunks.length} 块）…`);
  const headingPrefix = (chunk: Chunk) => (chunk.heading ? `${chunk.heading}\n` : "");
  const vectors = await embedTexts(emb.endpoint, emb.apiKey, emb.model, chunks.map((chunk) => `${headingPrefix(chunk)}${chunk.text}`), meter);
  if (vectors.length !== chunks.length) throw new Error("Embedding 数量与分块数不一致");
  const rows = chunks.map((chunk, index) => ({ paperId, chunkId: chunk.id, userId, page: chunk.page, vector: toBase64(vectors[index]) }));
  // 先删后写 + 索引行最后 upsert：中途失败时索引行保持旧值或不存在，下次提问会因不匹配而自动重建
  const statements: BatchItem<"sqlite">[] = [db.delete(paperChunks).where(and(eq(paperChunks.paperId, paperId), eq(paperChunks.userId, userId)))];
  for (let start = 0; start < rows.length; start += WRITE_BATCH) statements.push(db.insert(paperChunks).values(rows.slice(start, start + WRITE_BATCH)));
  statements.push(
    db.insert(paperIndexes)
      .values({ paperId, userId, embeddingModel: emb.model, textStamp, chunkCount: chunks.length, createdAt: new Date().toISOString() })
      .onConflictDoUpdate({ target: paperIndexes.paperId, set: { embeddingModel: emb.model, textStamp, chunkCount: chunks.length } }),
  );
  await db.batch(statements as unknown as [BatchItem<"sqlite">, ...Array<BatchItem<"sqlite">>]);
  onStep?.(`语义索引已建立（${chunks.length} 块）`);
  return true;
}

// 向量召回：查询向量与全部块向量取 max 余弦，top-k 返回
export async function vectorRetrieve(db: Db, userId: string, paperId: string, chunks: Chunk[], queryVectors: Float32Array[], k: number, exclude?: Map<number, Chunk>): Promise<Chunk[]> {
  if (!queryVectors.length) return [];
  const rows = await db.select({ chunkId: paperChunks.chunkId, vector: paperChunks.vector }).from(paperChunks).where(and(eq(paperChunks.paperId, paperId), eq(paperChunks.userId, userId)));
  if (!rows.length) return [];
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  return rows
    .filter((row) => !exclude?.has(row.chunkId) && byId.has(row.chunkId))
    .map((row) => {
      const vector = fromBase64(row.vector);
      return { chunk: byId.get(row.chunkId)!, score: Math.max(...queryVectors.map((query) => cosine(query, vector))) };
    })
    .sort((a, b) => b.score - a.score || a.chunk.page - b.chunk.page)
    .slice(0, k)
    .map((item) => item.chunk);
}

// 关键词命中优先、向量召回补满，按 chunkId 去重
export function mergeHits(keywordHits: Chunk[], vectorHits: Chunk[], cap: number): Chunk[] {
  const merged = new Map<number, Chunk>();
  for (const chunk of keywordHits) merged.set(chunk.id, chunk);
  for (const chunk of vectorHits) {
    if (merged.size >= cap) break;
    if (!merged.has(chunk.id)) merged.set(chunk.id, chunk);
  }
  return [...merged.values()].sort((a, b) => a.page - b.page);
}

// 供状态展示：当前论文是否已有有效语义索引
export async function hasPaperIndex(db: Db, userId: string, paperId: string): Promise<boolean> {
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(paperIndexes).where(and(eq(paperIndexes.paperId, paperId), eq(paperIndexes.userId, userId))).limit(1);
  return Boolean(row && row.count > 0);
}
