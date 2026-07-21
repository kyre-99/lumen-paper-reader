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
    apiKey: String(runtime.OPENAI_API_KEY || process.env.OPENAI_API_KEY || ""),
    hasApiKey: Boolean(runtime.OPENAI_API_KEY || process.env.OPENAI_API_KEY),
  };
}

function displayProvider(provider: string | null | undefined, endpoint: string) {
  if (provider === "智增增" || endpoint.includes("zhizengzeng")) return "OpenAI 兼容";
  return provider || "OpenAI";
}

export async function GET() {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const db = getDb();
  let [settings] = await db.select().from(userSettings).where(eq(userSettings.userId, user.id)).limit(1);
  const environment = environmentModelConfig();
  if (environment.apiKey && !settings?.apiKeyEncrypted) {
    const imported = {
      userId: user.id,
      globalSystemPrompt: settings?.globalSystemPrompt || DEFAULT_PROMPTS.global,
      inlineSystemPrompt: settings?.inlineSystemPrompt || DEFAULT_PROMPTS.inline,
      modelProvider: displayProvider(settings?.modelProvider, environment.endpoint),
      modelEndpoint: environment.endpoint,
      modelName: environment.model,
      apiKeyEncrypted: await encryptApiKey(environment.apiKey),
      updatedAt: new Date().toISOString(),
    };
    await db.insert(userSettings).values(imported).onConflictDoUpdate({ target: userSettings.userId, set: imported });
    [settings] = await db.select().from(userSettings).where(eq(userSettings.userId, user.id)).limit(1);
  }
  const hasSavedModelConfig = Boolean(settings?.apiKeyEncrypted) || Boolean(settings?.modelEndpoint && settings.modelEndpoint !== "https://api.openai.com/v1");
  return Response.json({
    prompts: {
      global: settings?.globalSystemPrompt || DEFAULT_PROMPTS.global,
      inline: settings?.inlineSystemPrompt || DEFAULT_PROMPTS.inline,
    },
    modelConfig: {
      provider: displayProvider(hasSavedModelConfig ? settings!.modelProvider : null, hasSavedModelConfig ? settings!.modelEndpoint : environment.endpoint),
      endpoint: hasSavedModelConfig ? settings!.modelEndpoint : environment.endpoint,
      model: hasSavedModelConfig ? settings!.modelName : environment.model,
      hasApiKey: Boolean(settings?.apiKeyEncrypted) || environment.hasApiKey,
    },
    // 图表理解模型：密钥只回 hasApiKey，不回明文
    visionConfig: {
      endpoint: settings?.visionModelEndpoint || "",
      model: settings?.visionModelName || "",
      hasApiKey: Boolean(settings?.visionApiKeyEncrypted),
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
  const requestedProvider = String(payload?.modelConfig?.provider || "自定义").trim().slice(0, 80);
  const modelProvider = requestedProvider === "智增增" ? "OpenAI 兼容" : requestedProvider;
  const modelEndpoint = String(payload?.modelConfig?.endpoint || "").trim().replace(/\/+$/, "").slice(0, 2000);
  const modelName = String(payload?.modelConfig?.model || "").trim().slice(0, 200);
  const apiKey = String(payload?.modelConfig?.apiKey || "").trim().slice(0, 1000);
  if (!modelEndpoint || !modelName) return Response.json({ error: "API 地址和模型不能为空" }, { status: 400 });
  try {
    const endpointUrl = new URL(modelEndpoint);
    if (endpointUrl.protocol !== "https:") throw new Error();
  } catch { return Response.json({ error: "API 地址必须是有效的 HTTPS 地址" }, { status: 400 }); }
  // 图表理解模型（多模态）：全部留空表示不配置，问答时回退主模型；请求未携带 visionConfig 时保留已有配置
  const hasVisionPayload = payload?.visionConfig !== undefined;
  const visionModelEndpoint = hasVisionPayload ? String(payload?.visionConfig?.endpoint || "").trim().replace(/\/+$/, "").slice(0, 2000) : "";
  const visionModelName = hasVisionPayload ? String(payload?.visionConfig?.model || "").trim().slice(0, 200) : "";
  const visionApiKey = hasVisionPayload ? String(payload?.visionConfig?.apiKey || "").trim().slice(0, 1000) : "";
  if (visionModelEndpoint) {
    try {
      const visionUrl = new URL(visionModelEndpoint);
      if (visionUrl.protocol !== "https:") throw new Error();
    } catch { return Response.json({ error: "图表理解模型的 API 地址必须是有效的 HTTPS 地址" }, { status: 400 }); }
  }
  const db = getDb();
  const [existing] = await db.select().from(userSettings).where(eq(userSettings.userId, user.id)).limit(1);
  const apiKeyEncrypted = apiKey ? await encryptApiKey(apiKey) : existing?.apiKeyEncrypted || "";
  // 密钥处理与主模型一致：只在新提供时重新加密；endpoint 与模型名都清空时视为取消配置，一并清掉密钥
  const visionApiKeyEncrypted = !hasVisionPayload ? existing?.visionApiKeyEncrypted || "" : visionApiKey ? await encryptApiKey(visionApiKey) : (visionModelEndpoint || visionModelName) ? existing?.visionApiKeyEncrypted || "" : "";
  const values = { userId: user.id, globalSystemPrompt, inlineSystemPrompt, modelProvider, modelEndpoint, modelName, apiKeyEncrypted, visionModelEndpoint: hasVisionPayload ? visionModelEndpoint : existing?.visionModelEndpoint || "", visionModelName: hasVisionPayload ? visionModelName : existing?.visionModelName || "", visionApiKeyEncrypted, updatedAt: new Date().toISOString() };
  await db.insert(userSettings).values(values).onConflictDoUpdate({ target: userSettings.userId, set: values });
  return Response.json({ saved: true, prompts: { global: globalSystemPrompt, inline: inlineSystemPrompt }, modelConfig: { provider: modelProvider, endpoint: modelEndpoint, model: modelName, hasApiKey: Boolean(apiKeyEncrypted) || environmentModelConfig().hasApiKey }, visionConfig: { endpoint: values.visionModelEndpoint, model: values.visionModelName, hasApiKey: Boolean(visionApiKeyEncrypted) } });
}
