import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { userSettings } from "../../../../db/schema";
import { chatCompletionsUrl, embeddingsUrl, resolveModelConfig } from "../../../model-config";
import { requireAppUser } from "../../../server-user";

export async function POST(request: NextRequest) {
  try {
    const user = await requireAppUser();
    if (!user) return NextResponse.json({ ok: false, error: "需要登录" }, { status: 401 });
    const body = await request.json();
    const { endpoint, apiKey, model, vision, embedding } = body;
    const db = getDb();
    const [savedSettings] = await db.select().from(userSettings).where(eq(userSettings.userId, user.id)).limit(1);
    const { endpoint: resolvedEndpoint, model: resolvedModel, apiKey: resolvedApiKey } = await resolveModelConfig(savedSettings, { endpoint, apiKey, model }, { vision: Boolean(vision), embedding: Boolean(embedding) });
    if (!resolvedEndpoint || !resolvedModel) return NextResponse.json({ ok: false, error: "请先填写 Base URL 和模型" }, { status: 400 });
    if (!resolvedApiKey) return NextResponse.json({ ok: false, error: "请先填写 API Key" }, { status: 400 });
    let target: URL;
    try {
      target = embedding ? embeddingsUrl(resolvedEndpoint) : chatCompletionsUrl(resolvedEndpoint);
    } catch (error: unknown) {
      return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Base URL 无效" }, { status: 400 });
    }
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      // embedding 测试发一条极短文本，返回向量维度数；聊天模型维持原有 ping
      const response = await fetch(target.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${resolvedApiKey}` },
        body: JSON.stringify(embedding ? { model: resolvedModel, input: "ping" } : { model: resolvedModel, messages: [{ role: "user", content: "ping" }], max_tokens: 1, temperature: 0 }),
        signal: controller.signal,
      });
      const latencyMs = Date.now() - started;
      const data = await response.json().catch(() => ({})) as { error?: { message?: string }; data?: Array<{ embedding?: number[] }> };
      if (!response.ok) return NextResponse.json({ ok: false, error: data?.error?.message || `接口返回 ${response.status}` });
      const dimensions = embedding ? data?.data?.[0]?.embedding?.length || 0 : 0;
      if (embedding && !dimensions) return NextResponse.json({ ok: false, error: "接口没有返回向量，请确认这是 Embedding 模型" });
      return NextResponse.json({ ok: true, latencyMs, model: resolvedModel, ...(dimensions ? { dimensions } : {}) });
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
