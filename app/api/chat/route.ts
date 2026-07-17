import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_PROMPTS, renderSystemPrompt } from "../../chat-prompts";
import { requireAppUser } from "../../server-user";

const MAX_REFERENCE_CHARS = 24000;

function selectRelevantContext(fullText: string, question: string) {
  const text = String(fullText || "");
  if (text.length <= MAX_REFERENCE_CHARS) return text;
  const pages = text.split(/(?=--- PAGE \d+ ---)/).filter((page) => page.trim());
  if (pages.length < 3) return text.slice(0, MAX_REFERENCE_CHARS);
  const broad = /总结|全文|整体|核心贡献|主要贡献|结论|局限|summary|overview|contribution|conclusion|limitation/i.test(question);
  if (broad) {
    const indexes = new Set<number>([0, 1, Math.floor((pages.length - 1) / 2), pages.length - 2, pages.length - 1]);
    return [...indexes].sort((a, b) => a - b).map((index) => pages[index]).join("\n\n").slice(0, MAX_REFERENCE_CHARS);
  }
  const tokens = (question.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []).filter((token) => !["什么", "如何", "为什么", "论文", "作者", "this", "that", "what", "how", "paper"].includes(token));
  const ranked = pages.map((page, index) => {
    const lower = page.toLowerCase();
    const score = tokens.reduce((total, token) => total + Math.min(5, lower.split(token).length - 1), 0) + (index === 0 ? .5 : 0);
    return { page, index, score };
  }).sort((a, b) => b.score - a.score).slice(0, 5).sort((a, b) => a.index - b.index);
  return ranked.map((item) => item.page).join("\n\n").slice(0, MAX_REFERENCE_CHARS);
}

function cleanHistory(history: unknown, limit: number) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((item) => item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
    .slice(-limit)
    .map((item) => ({ role: item.role, content: item.content.slice(0, 12000) }));
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireAppUser();
    if (!user) return NextResponse.json({ error: "需要登录" }, { status: 401 });
    const body = await request.json();
    const { endpoint, apiKey, model, paperTitle, question, paperContext = "", selectedText = "", surroundingContext = "", mode = "global", history = [], systemPrompts = {} } = body;
    if (!endpoint || !apiKey || !model || !question) return NextResponse.json({ error: "模型配置不完整" }, { status: 400 });
    const target = new URL(endpoint);
    if (target.protocol !== "https:") return NextResponse.json({ error: "API 地址必须使用 HTTPS" }, { status: 400 });
    const isInline = mode === "inline";
    const title = String(paperTitle || "研究论文").slice(0, 300);
    const globalPrompt = String(systemPrompts?.global || DEFAULT_PROMPTS.global).trim().slice(0, 12000) || DEFAULT_PROMPTS.global;
    const inlinePrompt = String(systemPrompts?.inline || DEFAULT_PROMPTS.inline).trim().slice(0, 12000) || DEFAULT_PROMPTS.inline;
    const retrievedContext = isInline ? "" : selectRelevantContext(String(paperContext), String(question));
    const messages = isInline ? [
      {
        role: "system",
        content: renderSystemPrompt(inlinePrompt, title),
      },
      ...cleanHistory(history, 10),
      {
        role: "user",
        content: `我正在看下面这段论文。\n\n<selected_text>\n${String(selectedText).slice(0, 6000)}\n</selected_text>\n\n<nearby_text>\n${String(surroundingContext).slice(0, 10000)}\n</nearby_text>\n\n我的问题是：\n${question}`,
      },
    ] : [
      {
        role: "system",
        content: renderSystemPrompt(globalPrompt, title),
      },
      ...cleanHistory(history, 10),
      {
        role: "user",
        content: `下面是从论文中找到的参考内容：\n\n<paper_reference>\n${retrievedContext}\n</paper_reference>\n\n我的问题是：\n${question}`,
      },
    ];
    const response = await fetch(target.toString(), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model, messages, temperature: 0.3 }) });
    const payload: any = await response.json().catch(() => ({}));
    if (!response.ok) return NextResponse.json({ error: payload?.error?.message || `模型接口返回 ${response.status}` }, { status: 502 });
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) return NextResponse.json({ error: "模型没有返回可读取的内容" }, { status: 502 });
    return NextResponse.json({ content });
  } catch (error: any) { return NextResponse.json({ error: error?.message || "请求失败" }, { status: 500 }); }
}
