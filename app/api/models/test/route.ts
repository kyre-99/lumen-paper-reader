import { NextRequest, NextResponse } from "next/server";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { userSettings } from "../../../../db/schema";
import { decryptApiKey } from "../../../model-config-crypto";
import { requireAppUser } from "../../../server-user";

function chatCompletionsUrl(input: string) {
  const target = new URL(input);
  if (target.protocol !== "https:") throw new Error("API 地址必须使用 HTTPS");
  const path = target.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/chat/completions")) target.pathname = `${path}/chat/completions`;
  return target;
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireAppUser();
    if (!user) return NextResponse.json({ ok: false, error: "需要登录" }, { status: 401 });
    const body = await request.json();
    const { endpoint, apiKey, model } = body;
    const db = getDb();
    const [savedSettings] = await db.select().from(userSettings).where(eq(userSettings.userId, user.id)).limit(1);
    const runtime = env as unknown as Record<string, string | undefined>;
    const resolvedEndpoint = String(endpoint || savedSettings?.modelEndpoint || runtime.OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || "").trim();
    const resolvedModel = String(model || savedSettings?.modelName || runtime.OPENAI_MODEL || process.env.OPENAI_MODEL || "").trim();
    const resolvedApiKey = String(apiKey || (savedSettings?.apiKeyEncrypted ? await decryptApiKey(savedSettings.apiKeyEncrypted) : "") || runtime.OPENAI_API_KEY || process.env.OPENAI_API_KEY || "").trim();
    if (!resolvedEndpoint || !resolvedModel) return NextResponse.json({ ok: false, error: "请先填写 Base URL 和模型" }, { status: 400 });
    if (!resolvedApiKey) return NextResponse.json({ ok: false, error: "请先填写 API Key" }, { status: 400 });
    let target: URL;
    try {
      target = chatCompletionsUrl(resolvedEndpoint);
    } catch (error: unknown) {
      return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Base URL 无效" }, { status: 400 });
    }
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(target.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${resolvedApiKey}` },
        body: JSON.stringify({ model: resolvedModel, messages: [{ role: "user", content: "ping" }], max_tokens: 1, temperature: 0 }),
        signal: controller.signal,
      });
      const latencyMs = Date.now() - started;
      const data = await response.json().catch(() => ({})) as { error?: { message?: string } };
      if (!response.ok) return NextResponse.json({ ok: false, error: data?.error?.message || `接口返回 ${response.status}` });
      return NextResponse.json({ ok: true, latencyMs, model: resolvedModel });
    } catch (error: unknown) {
      const message = error instanceof Error && error.name === "AbortError" ? "连接超时（20 秒无响应）" : error instanceof Error ? error.message : "连接失败";
      return NextResponse.json({ ok: false, error: message });
    } finally {
      clearTimeout(timer);
    }
  } catch (error: unknown) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "请求失败" }, { status: 500 });
  }
}
