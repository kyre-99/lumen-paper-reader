import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { papers, userSettings } from "../../../../../db/schema";
import { resolveModelConfig } from "../../../../model-config";
import { requireAppUser } from "../../../../server-user";
import { chunkPaper } from "../../../chat/chunks";
import { buildPaperIndex, getIndexState } from "../../../chat/embeddings";

// 语义索引的建立/续建与状态查询。建索引是增量可断点续传的：
// POST 在时间预算内尽可能多建，超时或中断后再次调用即可续建；GET 返回当前进度供前端轮询。

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const { id } = await params;
  const db = getDb();
  const [paper] = await db.select({ updatedAt: papers.updatedAt }).from(papers).where(and(eq(papers.id, id), eq(papers.userId, user.id))).limit(1);
  if (!paper) return Response.json({ error: "论文不存在" }, { status: 404 });
  const [settings] = await db.select({ embeddingModelName: userSettings.embeddingModelName }).from(userSettings).where(eq(userSettings.userId, user.id)).limit(1);
  const model = String(settings?.embeddingModelName || "").trim();
  const state = await getIndexState(db, user.id, id, paper.updatedAt, model);
  return Response.json({ state, model });
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const { id } = await params;
  const db = getDb();
  const [paper] = await db.select({ paperText: papers.paperText, updatedAt: papers.updatedAt }).from(papers).where(and(eq(papers.id, id), eq(papers.userId, user.id))).limit(1);
  if (!paper) return Response.json({ error: "论文不存在" }, { status: 404 });
  if (!paper.paperText) return Response.json({ error: "论文文本尚未提取完成，稍后再试" }, { status: 400 });
  const [savedSettings] = await db.select().from(userSettings).where(eq(userSettings.userId, user.id)).limit(1);
  const embeddingConfig = await resolveModelConfig(savedSettings, {}, { embedding: true });
  if (!embeddingConfig.model) return Response.json({ error: "尚未配置语义检索模型，请在设置的「语义检索模型」中填写模型名" }, { status: 400 });
  if (!embeddingConfig.endpoint || !embeddingConfig.apiKey) return Response.json({ error: "语义检索模型缺少可用的接口地址或密钥" }, { status: 400 });
  try {
    const chunks = chunkPaper(paper.paperText);
    const result = await buildPaperIndex(db, user.id, id, chunks, paper.updatedAt, embeddingConfig);
    return Response.json(result);
  } catch (error: unknown) {
    return Response.json({ error: error instanceof Error ? error.message : "索引建立失败" }, { status: 502 });
  }
}
