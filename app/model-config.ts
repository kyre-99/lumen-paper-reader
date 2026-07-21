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
// 安全约束：endpoint 与 apiKey 必须同源配对（请求体配请求体、已存配已存、env 配 env），
// 防止请求体把 endpoint 指向攻击者服务器时借用已存/env 的 apiKey
export async function resolveModelConfig(savedSettings: SavedSettings | undefined, requestFields: ModelRequestFields, options?: { vision?: boolean }) {
  const runtime = env as unknown as Record<string, string | undefined>;
  const useVision = Boolean(options?.vision);
  const requestEndpoint = String(requestFields.endpoint ?? "").trim();
  const requestApiKey = String(requestFields.apiKey ?? "").trim();
  let endpoint = "";
  let apiKey = "";
  if (useVision && savedSettings?.visionModelEndpoint) {
    // 图表理解配置属于已存配置：配已存的 vision key，缺省回退到已存主模型 key
    endpoint = String(savedSettings.visionModelEndpoint).trim();
    apiKey = savedSettings.visionApiKeyEncrypted ? (await decryptApiKey(savedSettings.visionApiKeyEncrypted)).trim() : "";
    if (!apiKey && savedSettings.apiKeyEncrypted) apiKey = (await decryptApiKey(savedSettings.apiKeyEncrypted)).trim();
  } else if (requestEndpoint) {
    endpoint = requestEndpoint;
    apiKey = requestApiKey;
  } else if (savedSettings?.modelEndpoint) {
    endpoint = String(savedSettings.modelEndpoint).trim();
    apiKey = savedSettings.apiKeyEncrypted ? (await decryptApiKey(savedSettings.apiKeyEncrypted)).trim() : "";
  } else {
    endpoint = String(runtime.OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || "").trim();
    apiKey = String(runtime.OPENAI_API_KEY || process.env.OPENAI_API_KEY || "").trim();
  }
  const model = String((useVision && savedSettings?.visionModelName) || requestFields.model || savedSettings?.modelName || runtime.OPENAI_MODEL || process.env.OPENAI_MODEL || "").trim();
  return { endpoint, model, apiKey };
}
