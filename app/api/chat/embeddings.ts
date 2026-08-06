import { and, eq } from "drizzle-orm";
import type { getDb } from "../../../db";
import { paperChunks, paperIndexes } from "../../../db/schema";
import { embeddingsUrl } from "../../model-config";

// 语义检索（Embedding）：向量以 base64 编码的 Float32 存 D1，余弦相似度在 Worker 内计算。
// chunkId 与 route.ts 中 chunkPaper 的确定性分块结果一一对应，因此不冗余存文本。
// 索引按批增量写入并记录 doneCount：中断后可从断点续建，不整批重来。

type Db = ReturnType<typeof getDb>;
type Chunk = { id: number; page: number; heading: string; text: string };
type TokenMeter = { prompt: number; completion: number };
export type IndexState = "ready" | "building" | "missing";

// 单批 16 块：中转/代理接口常限制单批条数或响应较慢，小批次更不容易超时，进度粒度也更细
const EMBED_BATCH = 16;
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

// 批量调用 /embeddings；usage 计入 token 表（embedding 费用纳入用量统计）。
// 每批 45 秒超时、失败最多重试 2 次（指数退避）：中转接口偶发慢响应/断连时建索引不会整批报废
async function embedBatch(target: URL, apiKey: string, model: string, batch: string[]): Promise<{ items: Array<{ embedding?: number[] }>; promptTokens: number }> {
  let lastError: Error = new Error("Embedding 请求失败");
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, attempt * 2500));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(target.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input: batch }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({})) as { error?: { message?: string }; data?: Array<{ embedding?: number[] }>; usage?: { prompt_tokens?: number } };
      if (!response.ok) throw new Error(data?.error?.message || `Embedding 接口返回 ${response.status}`);
      if (!Array.isArray(data.data) || data.data.length !== batch.length) throw new Error("Embedding 接口返回的数据不完整");
      return { items: data.data, promptTokens: Number(data.usage?.prompt_tokens) || 0 };
    } catch (error: unknown) {
      lastError = error instanceof Error && error.name === "AbortError" ? new Error("Embedding 接口响应超时（45 秒）") : error instanceof Error ? error : new Error("Embedding 请求失败");
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export async function embedTexts(endpoint: string, apiKey: string, model: string, texts: string[], meter?: TokenMeter): Promise<Float32Array[]> {
  const target = embeddingsUrl(endpoint);
  const vectors: Float32Array[] = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH) {
    const batch = texts.slice(start, start + EMBED_BATCH);
    const { items, promptTokens } = await embedBatch(target, apiKey, model, batch);
    if (meter && promptTokens) meter.prompt += promptTokens;
    for (const item of items) {
      if (!Array.isArray(item.embedding) || !item.embedding.length) throw new Error("Embedding 接口返回了空向量");
      vectors.push(new Float32Array(item.embedding));
    }
  }
  return vectors;
}

// 查询索引状态：模型或文本版本不匹配即视为 missing（调用方决定是否重建）；
// 传入 chunkCount 时做权威校验（分块数不一致 = 分块器或文本变了）
export async function getIndexState(db: Db, userId: string, paperId: string, textStamp: string, model: string, chunkCount?: number): Promise<IndexState> {
  if (!model) return "missing";
  const [row] = await db.select().from(paperIndexes).where(and(eq(paperIndexes.paperId, paperId), eq(paperIndexes.userId, userId))).limit(1);
  if (!row || row.embeddingModel !== model || row.textStamp !== textStamp) return "missing";
  if (chunkCount !== undefined && row.chunkCount !== chunkCount) return "missing";
  return row.status === "ready" ? "ready" : "building";
}

// 增量建立/续建语义索引：每批向量写库并更新 doneCount，中断或超时后可从断点继续。
// budgetMs 控制单次调用的工作时长，超出即返回 building，由调用方稍后再次调用续建。
export async function buildPaperIndex(
  db: Db,
  userId: string,
  paperId: string,
  chunks: Chunk[],
  textStamp: string,
  emb: { endpoint: string; apiKey: string; model: string },
  opts?: { meter?: TokenMeter; budgetMs?: number },
): Promise<{ status: "building" | "ready"; doneCount: number; chunkCount: number }> {
  const budgetMs = opts?.budgetMs ?? 25000;
  const started = Date.now();
  const [existing] = await db.select().from(paperIndexes).where(and(eq(paperIndexes.paperId, paperId), eq(paperIndexes.userId, userId))).limit(1);
  const sameTarget = existing && existing.embeddingModel === emb.model && existing.textStamp === textStamp && existing.chunkCount === chunks.length;
  if (sameTarget && existing.status === "ready") return { status: "ready", doneCount: chunks.length, chunkCount: chunks.length };
  let done = 0;
  if (sameTarget) {
    // 续建：从上次进度继续
    done = Math.min(existing.doneCount, chunks.length);
  } else {
    // 首次或失效：清掉旧块从头建
    await db.delete(paperChunks).where(and(eq(paperChunks.paperId, paperId), eq(paperChunks.userId, userId)));
  }
  const stamp = { embeddingModel: emb.model, textStamp, chunkCount: chunks.length, status: "building" as const, doneCount: done };
  await db.insert(paperIndexes).values({ paperId, userId, ...stamp, createdAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: paperIndexes.paperId, set: stamp });
  const embedInput = (chunk: Chunk) => `${chunk.heading ? `${chunk.heading}\n` : ""}${chunk.text}`;
  while (done < chunks.length) {
    if (Date.now() - started > budgetMs) break;
    const batch = chunks.slice(done, done + EMBED_BATCH);
    const vectors = await embedTexts(emb.endpoint, emb.apiKey, emb.model, batch.map(embedInput), opts?.meter);
    if (vectors.length !== batch.length) throw new Error("Embedding 数量与分块数不一致");
    const rows = batch.map((chunk, index) => ({ paperId, chunkId: chunk.id, userId, page: chunk.page, vector: toBase64(vectors[index]) }));
    for (let start = 0; start < rows.length; start += WRITE_BATCH) {
      // 续建时同一块可能已在上次中断前写入（内容相同），冲突跳过即可
      await db.insert(paperChunks).values(rows.slice(start, start + WRITE_BATCH)).onConflictDoNothing();
    }
    done += batch.length;
    await db.update(paperIndexes).set({ doneCount: done }).where(and(eq(paperIndexes.paperId, paperId), eq(paperIndexes.userId, userId)));
  }
  if (done >= chunks.length) {
    await db.update(paperIndexes).set({ status: "ready", doneCount: chunks.length }).where(and(eq(paperIndexes.paperId, paperId), eq(paperIndexes.userId, userId)));
    return { status: "ready", doneCount: chunks.length, chunkCount: chunks.length };
  }
  return { status: "building", doneCount: done, chunkCount: chunks.length };
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
