import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { endpoint, apiKey, model, paperTitle, question, context, history = [] } = body;
    if (!endpoint || !apiKey || !model || !question) return NextResponse.json({ error: "模型配置不完整" }, { status: 400 });
    const target = new URL(endpoint);
    if (target.protocol !== "https:") return NextResponse.json({ error: "API 地址必须使用 HTTPS" }, { status: 400 });
    const messages = [
      { role: "system", content: `你是一个严谨、善于解释的论文阅读助手。正在阅读的论文是《${paperTitle || "研究论文"}》。默认使用中文回答，使用 Markdown 排版；不要虚构论文中不存在的信息。` },
      ...history.slice(-6).map((item: any) => ({ role: item.role, content: item.content })),
      { role: "user", content: context ? `论文选区：\n${String(context).slice(0, 8000)}\n\n问题：${question}` : question },
    ];
    const response = await fetch(target.toString(), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model, messages, temperature: 0.25 }) });
    const payload: any = await response.json().catch(() => ({}));
    if (!response.ok) return NextResponse.json({ error: payload?.error?.message || `模型接口返回 ${response.status}` }, { status: 502 });
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) return NextResponse.json({ error: "模型没有返回可读取的内容" }, { status: 502 });
    return NextResponse.json({ content });
  } catch (error: any) { return NextResponse.json({ error: error?.message || "请求失败" }, { status: 500 }); }
}
