import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { userSettings } from "../../../db/schema";
import { DEFAULT_PROMPTS } from "../../chat-prompts";
import { encryptApiKey } from "../../model-config-crypto";
import { requireAppUser } from "../../server-user";

function environmentModelConfig() {
  const runtime = env as any;
  return {
    endpoint: String(runtime.OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"),
    model: String(runtime.OPENAI_MODEL || process.env.OPENAI_MODEL || "gpt-4.1-mini"),
    hasApiKey: Boolean(runtime.OPENAI_API_KEY || process.env.OPENAI_API_KEY),
  };
}

export async function GET() {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const db = getDb();
  const [settings] = await db.select().from(userSettings).where(eq(userSettings.userId, user.id)).limit(1);
  const environment = environmentModelConfig();
  const hasSavedModelConfig = Boolean(settings?.apiKeyEncrypted) || Boolean(settings?.modelEndpoint && settings.modelEndpoint !== "https://api.openai.com/v1");
  return Response.json({
    prompts: {
      global: settings?.globalSystemPrompt || DEFAULT_PROMPTS.global,
      inline: settings?.inlineSystemPrompt || DEFAULT_PROMPTS.inline,
    },
    modelConfig: {
      provider: hasSavedModelConfig ? settings!.modelProvider : environment.endpoint.includes("zhizengzeng") ? "智增增" : "OpenAI",
      endpoint: hasSavedModelConfig ? settings!.modelEndpoint : environment.endpoint,
      model: hasSavedModelConfig ? settings!.modelName : environment.model,
      hasApiKey: Boolean(settings?.apiKeyEncrypted) || environment.hasApiKey,
    },
  });
}

export async function PUT(request: Request) {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const payload = await request.json() as any;
  const globalSystemPrompt = String(payload?.prompts?.global || "").trim().slice(0, 12000);
  const inlineSystemPrompt = String(payload?.prompts?.inline || "").trim().slice(0, 12000);
  if (!globalSystemPrompt || !inlineSystemPrompt) return Response.json({ error: "两处 System Prompt 都不能为空" }, { status: 400 });
  const modelProvider = String(payload?.modelConfig?.provider || "自定义").trim().slice(0, 80);
  const modelEndpoint = String(payload?.modelConfig?.endpoint || "").trim().replace(/\/+$/, "").slice(0, 2000);
  const modelName = String(payload?.modelConfig?.model || "").trim().slice(0, 200);
  const apiKey = String(payload?.modelConfig?.apiKey || "").trim().slice(0, 1000);
  if (!modelEndpoint || !modelName) return Response.json({ error: "API 地址和模型不能为空" }, { status: 400 });
  try {
    const endpointUrl = new URL(modelEndpoint);
    if (endpointUrl.protocol !== "https:") throw new Error();
  } catch { return Response.json({ error: "API 地址必须是有效的 HTTPS 地址" }, { status: 400 }); }
  const db = getDb();
  const [existing] = await db.select().from(userSettings).where(eq(userSettings.userId, user.id)).limit(1);
  const apiKeyEncrypted = apiKey ? await encryptApiKey(apiKey) : existing?.apiKeyEncrypted || "";
  const values = { userId: user.id, globalSystemPrompt, inlineSystemPrompt, modelProvider, modelEndpoint, modelName, apiKeyEncrypted, updatedAt: new Date().toISOString() };
  await db.insert(userSettings).values(values).onConflictDoUpdate({ target: userSettings.userId, set: values });
  return Response.json({ saved: true, prompts: { global: globalSystemPrompt, inline: inlineSystemPrompt }, modelConfig: { provider: modelProvider, endpoint: modelEndpoint, model: modelName, hasApiKey: Boolean(apiKeyEncrypted) || environmentModelConfig().hasApiKey } });
}
