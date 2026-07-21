import { env } from "cloudflare:workers";
import { userSettings } from "../db/schema";
import { decryptApiKey } from "./model-config-crypto";

type SavedSettings = typeof userSettings.$inferSelect;

// 请求体里可覆盖模型配置的字段（未提供时回退到已存配置与环境变量）
export type ModelRequestFields = { endpoint?: unknown; apiKey?: unknown; model?: unknown };

export function chatCompletionsUrl(input: string) {
  const target = new URL(input);
  if (target.protocol !== "https:") throw new Error("API 地址必须使用 HTTPS");
  const path = target.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/chat/completions")) target.pathname = `${path}/chat/completions`;
  return target;
}

// 解析模型配置，回退链：请求体 → 已存配置 → 环境变量；
// vision 为 true 时优先使用图表理解模型配置，缺省字段逐项回退到主模型配置
export async function resolveModelConfig(savedSettings: SavedSettings | undefined, requestFields: ModelRequestFields, options?: { vision?: boolean }) {
  const runtime = env as unknown as Record<string, string | undefined>;
  const useVision = Boolean(options?.vision);
  const visionKey = useVision && savedSettings?.visionApiKeyEncrypted ? await decryptApiKey(savedSettings.visionApiKeyEncrypted) : "";
  const endpoint = String((useVision && savedSettings?.visionModelEndpoint) || requestFields.endpoint || savedSettings?.modelEndpoint || runtime.OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || "").trim();
  const model = String((useVision && savedSettings?.visionModelName) || requestFields.model || savedSettings?.modelName || runtime.OPENAI_MODEL || process.env.OPENAI_MODEL || "").trim();
  const apiKey = String(visionKey || requestFields.apiKey || (savedSettings?.apiKeyEncrypted ? await decryptApiKey(savedSettings.apiKeyEncrypted) : "") || runtime.OPENAI_API_KEY || process.env.OPENAI_API_KEY || "").trim();
  return { endpoint, model, apiKey };
}
