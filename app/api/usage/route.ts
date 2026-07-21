import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { llmUsage } from "../../../db/schema";
import { requireAppUser } from "../../server-user";

// 常见模型的公开标价（美元 / 1M tokens，[输入价, 输出价]），仅用于粗略估算，实际以服务商账单为准
const MODEL_PRICES: Record<string, [number, number]> = {
  "gpt-4.1-mini": [0.4, 1.6],
  "gpt-4.1": [2, 8],
  "gpt-4o-mini": [0.15, 0.6],
  "gpt-4o": [2.5, 10],
  "o4-mini": [1.1, 4.4],
  "deepseek-chat": [0.27, 1.1],
  "deepseek-reasoner": [0.55, 2.19],
  "gemini-2.5-flash": [0.3, 2.5],
};

// 先长后短匹配，避免 gpt-4.1 抢先命中 gpt-4.1-mini
const PRICE_KEYS = Object.keys(MODEL_PRICES).sort((a, b) => b.length - a.length);

function estimateCost(model: string, promptTokens: number, completionTokens: number): number | null {
  const name = model.toLowerCase();
  const key = PRICE_KEYS.find((candidate) => name.includes(candidate));
  if (!key) return null;
  const [inputPrice, outputPrice] = MODEL_PRICES[key];
  return (promptTokens * inputPrice + completionTokens * outputPrice) / 1_000_000;
}

export async function GET() {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const db = getDb();
  // 总额与分模型统计在 SQL 侧聚合，避免把整表拉回 JS；费用按模型汇总后估算（对 tokens 是线性的，结果一致）
  const [totals] = await db.select({
    calls: sql<number>`count(*)`,
    promptTokens: sql<number>`coalesce(sum(${llmUsage.promptTokens}), 0)`,
    completionTokens: sql<number>`coalesce(sum(${llmUsage.completionTokens}), 0)`,
  }).from(llmUsage).where(eq(llmUsage.userId, user.id));
  const modelRows = await db.select({
    model: llmUsage.model,
    calls: sql<number>`count(*)`,
    promptTokens: sql<number>`coalesce(sum(${llmUsage.promptTokens}), 0)`,
    completionTokens: sql<number>`coalesce(sum(${llmUsage.completionTokens}), 0)`,
  }).from(llmUsage).where(eq(llmUsage.userId, user.id)).groupBy(llmUsage.model);
  const recent = await db.select().from(llmUsage).where(eq(llmUsage.userId, user.id)).orderBy(desc(llmUsage.createdAt)).limit(12);

  let estimatedCost = 0;
  let hasPricedModel = false;
  const perModel = modelRows.map((row) => {
    const cost = estimateCost(row.model, row.promptTokens, row.completionTokens);
    if (cost !== null) { estimatedCost += cost; hasPricedModel = true; }
    return { model: row.model, calls: row.calls, promptTokens: row.promptTokens, completionTokens: row.completionTokens, estimatedCost: cost };
  });

  return Response.json({
    totalCalls: totals?.calls || 0,
    promptTokens: totals?.promptTokens || 0,
    completionTokens: totals?.completionTokens || 0,
    totalTokens: (totals?.promptTokens || 0) + (totals?.completionTokens || 0),
    estimatedCost: hasPricedModel ? estimatedCost : null,
    currency: "USD",
    perModel: perModel.sort((a, b) => b.promptTokens + b.completionTokens - (a.promptTokens + a.completionTokens)),
    recent: recent.map((row) => ({
      id: row.id,
      model: row.model,
      mode: row.mode,
      effort: row.effort,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      createdAt: row.createdAt,
    })),
  });
}
