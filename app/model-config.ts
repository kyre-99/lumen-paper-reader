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

export function embeddingsUrl(input: string) {
  const target = new URL(input);
  if (target.protocol !== "https:") throw new Error("API 地址必须使用 HTTPS");
  const path = target.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/embeddings")) target.pathname = `${path}/embeddings`;
  return target;
}

// 解析模型配置，回退链：请求体 → 已存配置 → 环境变量；
// vision 为 true 时优先使用图表理解模型配置，缺省字段逐项回退到主模型配置
// 安全约束：endpoint 与 apiKey 必须同源配对（请求体配请求体、已存配已存、env 配 env），
// 防止请求体把 endpoint 指向攻击者服务器时借用已存/env 的 apiKey。
// 例外：请求体 endpoint 与已存/env endpoint 规范化后相同（客户端回显已保存配置的场景），
// 允许回退对应来源的 key —— key 只会发往它本就配置的目标地址
function normalizeEndpoint(input: string) {
  return input.trim().replace(/\/+$/, "").toLowerCase();
}

export async function resolveModelConfig(savedSettings: SavedSettings | undefined, requestFields: ModelRequestFields, options?: { vision?: boolean; embedding?: boolean }) {
  const runtime = env as unknown as Record<string, string | undefined>;
  const useVision = Boolean(options?.vision);
  const useEmbedding = Boolean(options?.embedding);
  const requestEndpoint = String(requestFields.endpoint ?? "").trim();
  const requestApiKey = String(requestFields.apiKey ?? "").trim();
  const savedEndpoint = String(savedSettings?.modelEndpoint ?? "").trim();
  const envEndpoint = String(runtime.OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || "").trim();
  let endpoint = "";
  let apiKey = "";
  if (useEmbedding) {
    // 语义检索模型（Embedding）：endpoint 留空回退主模型/env；key 遵循同样的同源配对约束。
    // 模型名只取 embedding 专用配置（测试未保存配置时允许请求体覆盖），不回退聊天模型名 —— 空模型名即语义检索未启用
    const savedEmbeddingEndpoint = String(savedSettings?.embeddingModelEndpoint ?? "").trim();
    endpoint = requestEndpoint || savedEmbeddingEndpoint || savedEndpoint || envEndpoint;
    const embeddingKey = savedSettings?.embeddingApiKeyEncrypted ? (await decryptApiKey(savedSettings.embeddingApiKeyEncrypted)).trim() : "";
    const mainKey = savedSettings?.apiKeyEncrypted ? (await decryptApiKey(savedSettings.apiKeyEncrypted)).trim() : "";
    if (requestApiKey && (!requestEndpoint || normalizeEndpoint(requestEndpoint) === normalizeEndpoint(endpoint))) {
      apiKey = requestApiKey;
    } else if (savedEmbeddingEndpoint && normalizeEndpoint(endpoint) === normalizeEndpoint(savedEmbeddingEndpoint)) {
      // embedding endpoint 与主模型同源时才允许借用主模型 key
      apiKey = embeddingKey || (savedEndpoint && normalizeEndpoint(endpoint) === normalizeEndpoint(savedEndpoint) ? mainKey : "");
    } else if (savedEndpoint && normalizeEndpoint(endpoint) === normalizeEndpoint(savedEndpoint)) {
      apiKey = mainKey;
    } else {
      apiKey = String(runtime.OPENAI_API_KEY || process.env.OPENAI_API_KEY || "").trim();
    }
    const model = String(requestFields.model || savedSettings?.embeddingModelName || "").trim();
    return { endpoint, model, apiKey };
  }
  if (useVision && savedSettings?.visionModelEndpoint) {
    // 图表理解配置属于已存配置：endpoint 固定用已存的 vision endpoint；
    // key 优先用请求体里明确给出的（设置页保存前测试新 key 的场景，仅当请求 endpoint 缺省或与已存一致时），
    // 否则用已存的 vision key；仅当 vision endpoint 与主模型 endpoint 同源时才允许回退主模型 key ——
    // 不同源时借用会把主模型（如 OpenAI）的 key 发到另一家服务商，换来莫名其妙的鉴权错误
    endpoint = String(savedSettings.visionModelEndpoint).trim();
    if (requestApiKey && (!requestEndpoint || normalizeEndpoint(requestEndpoint) === normalizeEndpoint(endpoint))) {
      apiKey = requestApiKey;
    } else {
      apiKey = savedSettings.visionApiKeyEncrypted ? (await decryptApiKey(savedSettings.visionApiKeyEncrypted)).trim() : "";
    }
    const mainEndpoint = String(savedSettings?.modelEndpoint ?? "").trim();
    if (!apiKey && savedSettings?.apiKeyEncrypted && mainEndpoint && normalizeEndpoint(endpoint) === normalizeEndpoint(mainEndpoint)) {
      apiKey = (await decryptApiKey(savedSettings.apiKeyEncrypted)).trim();
    }
  } else if (requestEndpoint) {
    endpoint = requestEndpoint;
    apiKey = requestApiKey;
    if (!apiKey && savedEndpoint && normalizeEndpoint(requestEndpoint) === normalizeEndpoint(savedEndpoint)) {
      apiKey = savedSettings?.apiKeyEncrypted ? (await decryptApiKey(savedSettings.apiKeyEncrypted)).trim() : "";
    }
    if (!apiKey && envEndpoint && normalizeEndpoint(requestEndpoint) === normalizeEndpoint(envEndpoint)) {
      apiKey = String(runtime.OPENAI_API_KEY || process.env.OPENAI_API_KEY || "").trim();
    }
  } else if (savedEndpoint) {
    endpoint = savedEndpoint;
    apiKey = savedSettings?.apiKeyEncrypted ? (await decryptApiKey(savedSettings.apiKeyEncrypted)).trim() : "";
  } else {
    endpoint = envEndpoint;
    apiKey = String(runtime.OPENAI_API_KEY || process.env.OPENAI_API_KEY || "").trim();
  }
  const model = String((useVision && savedSettings?.visionModelName) || requestFields.model || savedSettings?.modelName || runtime.OPENAI_MODEL || process.env.OPENAI_MODEL || "").trim();
  return { endpoint, model, apiKey };
}
