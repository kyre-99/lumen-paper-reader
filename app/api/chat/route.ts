import { NextRequest, NextResponse } from "next/server";
import { requireAppUser } from "../../server-user";

function selectRelevantContext(fullText: string, question: string) {
  const text = String(fullText || "");
  if (text.length <= 42000) return text;
  const pages = text.split(/(?=--- PAGE \d+ ---)/).filter((page) => page.trim());
  if (pages.length < 3) return text.slice(0, 42000);
  const broad = /总结|全文|整体|核心贡献|主要贡献|结论|局限|summary|overview|contribution|conclusion|limitation/i.test(question);
  if (broad) {
    const indexes = new Set<number>([0, 1, pages.length - 2, pages.length - 1]);
    for (let i = 2; i < 9; i++) indexes.add(Math.floor((pages.length - 1) * i / 9));
    return [...indexes].sort((a, b) => a - b).map((index) => pages[index]).join("\n\n").slice(0, 46000);
  }
  const tokens = (question.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []).filter((token) => !["什么", "如何", "为什么", "论文", "作者", "this", "that", "what", "how", "paper"].includes(token));
  const ranked = pages.map((page, index) => {
    const lower = page.toLowerCase();
    const score = tokens.reduce((total, token) => total + Math.min(5, lower.split(token).length - 1), 0) + (index === 0 ? .5 : 0);
    return { page, index, score };
  }).sort((a, b) => b.score - a.score).slice(0, 8).sort((a, b) => a.index - b.index);
  return ranked.map((item) => item.page).join("\n\n").slice(0, 42000);
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireAppUser();
    if (!user) return NextResponse.json({ error: "需要登录" }, { status: 401 });
    const body = await request.json();
    const { endpoint, apiKey, model, paperTitle, question, paperContext = "", selectedText = "", surroundingContext = "", mode = "global", history = [] } = body;
    if (!endpoint || !apiKey || !model || !question) return NextResponse.json({ error: "模型配置不完整" }, { status: 400 });
    const target = new URL(endpoint);
    if (target.protocol !== "https:") return NextResponse.json({ error: "API 地址必须使用 HTTPS" }, { status: 400 });
    const isInline = mode === "inline";
    const retrievedContext = isInline ? "" : selectRelevantContext(String(paperContext), String(question));
    const messages = isInline ? [
      {
        role: "system",
        content: `你是论文的行间阅读助手。正在阅读《${paperTitle || "研究论文"}》。你的回答会显示在原文旁边，因此必须简洁、局部、准确。只依据“选中文字”和“相邻段落”回答；不要擅自扩展为全文总结。翻译时保留公式、符号和专业术语，解释时说明这句话在相邻段落中的作用。默认使用中文与 Markdown。`,
      },
      ...history.slice(-8).map((item: any) => ({ role: item.role, content: item.content })),
      {
        role: "user",
        content: `【选中文字】\n${String(selectedText).slice(0, 6000)}\n\n【相邻段落】\n${String(surroundingContext).slice(0, 10000)}\n\n【局部任务】\n${question}`,
      },
    ] : [
      {
        role: "system",
        content: `你是整篇论文的研究助手。正在阅读《${paperTitle || "研究论文"}》。回答总结、方法、实验、结论、局限和跨章节关系时，优先依据从全文中检索出的相关页；无法从上下文确认时明确说明，不要虚构。回答关键结论时尽量标注页码。默认使用中文与 Markdown。\n\n【从全文检索出的相关页】\n${retrievedContext}`,
      },
      ...history.slice(-6).map((item: any) => ({ role: item.role, content: item.content })),
      { role: "user", content: question },
    ];
    const response = await fetch(target.toString(), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model, messages, temperature: 0.25 }) });
    const payload: any = await response.json().catch(() => ({}));
    if (!response.ok) return NextResponse.json({ error: payload?.error?.message || `模型接口返回 ${response.status}` }, { status: 502 });
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) return NextResponse.json({ error: "模型没有返回可读取的内容" }, { status: 502 });
    return NextResponse.json({ content });
  } catch (error: any) { return NextResponse.json({ error: error?.message || "请求失败" }, { status: 500 }); }
}
