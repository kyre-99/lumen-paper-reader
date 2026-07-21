import { desc, eq } from "drizzle-orm";
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
  const rows = await db.select().from(llmUsage).where(eq(llmUsage.userId, user.id)).orderBy(desc(llmUsage.createdAt)).limit(2000);

  let promptTokens = 0;
  let completionTokens = 0;
  let estimatedCost = 0;
  let hasPricedModel = false;
  const perModel = new Map<string, { model: string; calls: number; promptTokens: number; completionTokens: number; estimatedCost: number | null }>();

  for (const row of rows) {
    promptTokens += row.promptTokens;
    completionTokens += row.completionTokens;
    const cost = estimateCost(row.model, row.promptTokens, row.completionTokens);
    if (cost !== null) { estimatedCost += cost; hasPricedModel = true; }
    const entry = perModel.get(row.model) || { model: row.model, calls: 0, promptTokens: 0, completionTokens: 0, estimatedCost: null as number | null };
    entry.calls += 1;
    entry.promptTokens += row.promptTokens;
    entry.completionTokens += row.completionTokens;
    if (cost !== null) entry.estimatedCost = (entry.estimatedCost ?? 0) + cost;
    perModel.set(row.model, entry);
  }

  return Response.json({
    totalCalls: rows.length,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimatedCost: hasPricedModel ? estimatedCost : null,
    currency: "USD",
    perModel: [...perModel.values()].sort((a, b) => b.promptTokens + b.completionTokens - (a.promptTokens + a.completionTokens)),
    recent: rows.slice(0, 12).map((row) => ({
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
