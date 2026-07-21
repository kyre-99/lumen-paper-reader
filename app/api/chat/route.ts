import { NextRequest, NextResponse } from "next/server";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { llmUsage, userSettings } from "../../../db/schema";
import { DEFAULT_PROMPTS, renderSystemPrompt } from "../../chat-prompts";
import { decryptApiKey } from "../../model-config-crypto";
import { requireAppUser } from "../../server-user";

const MAX_REFERENCE_CHARS = 26000;
const CHUNK_TARGET = 1100;
const AGENT_MAX_ROUNDS = 3;

type Effort = "medium" | "high" | "max";
type Chunk = { id: number; page: number; heading: string; text: string };
// 单次 /api/chat 请求内多次模型调用的 token 累计器
type TokenMeter = { prompt: number; completion: number };

function addUsage(meter: TokenMeter | undefined, usage: unknown) {
  if (!meter || !usage || typeof usage !== "object") return;
  const tokens = usage as { prompt_tokens?: unknown; completion_tokens?: unknown };
  meter.prompt += Number(tokens.prompt_tokens) || 0;
  meter.completion += Number(tokens.completion_tokens) || 0;
}

const ANSWER_CONTRACT = `

回答要求：
1. 先直接给出结论，再展开理由和细节。
2. 凡引用论文内容，在句末标注来源页码，格式【P页码】；不确定页码就不要标注，更不要编造。
3. 明确区分“原文写道”和“我的推断”，推断部分以“（推断）”开头。
4. 资料不足以回答时，直接说明缺什么信息，不要虚构内容。
5. 数学公式用 LaTeX 表示（行内 $...$，独立公式 $$...$$）。`;

const INLINE_CONTRACT = `

回答要求：先结论后展开；翻译要忠实流畅；公式用 LaTeX 表示（行内 $...$，独立公式 $$...$$）；资料不足就直说，不要编造。`;

const AGENT_SYSTEM = `你是论文研究 Agent，可以使用工具在论文中主动查找资料。每一步只输出一个 JSON，不要输出任何其他内容：
- 检索相关片段：{"action":"search","queries":["英文术语","中文词"]}（queries 给 2-4 个，英文优先）
- 阅读指定页的完整片段：{"action":"read","pages":[3,7]}（pages 最多 6 页）
- 资料足够，开始作答：{"action":"answer"}
策略：先 search 找到大致位置，再 read 关键页确认细节，确认足够后 answer。论文页码以 P数字 标注。`;

function chunkPaper(fullText: string): Chunk[] {
  const pages = String(fullText || "").split(/(?=--- PAGE \d+ ---)/).filter((page) => page.trim());
  const chunks: Chunk[] = [];
  let id = 0;
  for (const pageBlock of pages) {
    const match = pageBlock.match(/^--- PAGE (\d+) ---/);
    const page = match ? Number(match[1]) : 1;
    const body = pageBlock.replace(/^--- PAGE \d+ ---\s*\n?/, "");
    const lines = body.split("\n").map((line) => line.trim()).filter(Boolean);
    let buffer: string[] = [];
    let heading = "";
    const flush = () => {
      const text = buffer.join(" ").replace(/\s+/g, " ").trim();
      buffer = [];
      if (text.length > 40) chunks.push({ id: id++, page, heading, text });
    };
    for (const line of lines) {
      const looksHeading = line.length <= 80 && !/[.。;；,，:：]$/.test(line) && /[A-Za-z\u4e00-\u9fff]/.test(line);
      if (looksHeading && buffer.join(" ").length > 300) flush();
      if (looksHeading) heading = line;
      buffer.push(line);
      if (buffer.join(" ").length >= CHUNK_TARGET) flush();
    }
    flush();
  }
  return chunks;
}

function extractTerms(text: string): string[] {
  const latin = text.toLowerCase().match(/[a-z0-9][a-z0-9-]{1,}/g) || [];
  const cjk = text.match(/[\u4e00-\u9fff]/g) || [];
  const bigrams = cjk.slice(0, -1).map((char, index) => char + cjk[index + 1]);
  return [...latin, ...bigrams].filter((term) => term.length > 1);
}

function scoreChunk(chunk: Chunk, terms: string[]) {
  const text = chunk.text.toLowerCase();
  const heading = chunk.heading.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const hits = text.split(term).length - 1;
    if (hits) score += Math.min(5, hits) * (term.length >= 4 ? 2 : 1);
    if (heading && heading.includes(term)) score += 4;
  }
  return score / (1 + chunk.text.length / 4000);
}

function retrieveChunks(chunks: Chunk[], queries: string[], broad: boolean, k: number, exclude?: Map<number, Chunk>): Chunk[] {
  const usable = chunks.filter((chunk) => !exclude?.has(chunk.id));
  if (broad) {
    const picks = new Map<number, Chunk>();
    usable.slice(0, 2).forEach((chunk) => picks.set(chunk.id, chunk));
    usable.slice(-1).forEach((chunk) => picks.set(chunk.id, chunk));
    const step = Math.max(1, Math.floor(usable.length / Math.max(1, k - picks.size)));
    for (let index = 2; index < usable.length - 1 && picks.size < k; index += step) picks.set(usable[index].id, usable[index]);
    return [...picks.values()].sort((a, b) => a.page - b.page);
  }
  const terms = [...new Set(queries.flatMap(extractTerms))];
  if (!terms.length) return [];
  return usable
    .map((chunk) => ({ chunk, score: scoreChunk(chunk, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.page - b.chunk.page)
    .slice(0, k)
    .map((item) => item.chunk)
    .sort((a, b) => a.page - b.page);
}

function pagesLabel(chunks: Chunk[]) {
  const pages = [...new Set(chunks.map((chunk) => chunk.page))].sort((a, b) => a - b);
  return pages.length ? pages.map((page) => `P${page}`).join("、") : "无匹配页";
}

function isBroadQuestion(question: string) {
  return /总结|全文|整体|核心贡献|主要贡献|结论|局限|框架|结构|summary|overview|contribution|conclusion|limitation/i.test(question);
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
  } catch {
    return {};
  }
}

function cleanHistory(history: unknown, limit: number) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((item) => item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
    .slice(-limit)
    .map((item) => ({ role: item.role, content: item.content.slice(0, 12000) }));
}

function chatCompletionsUrl(input: string) {
  const target = new URL(input);
  if (target.protocol !== "https:") throw new Error("API 地址必须使用 HTTPS");
  const path = target.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/chat/completions")) target.pathname = `${path}/chat/completions`;
  return target;
}

async function complete(target: URL, apiKey: string, payload: Record<string, unknown>, meter?: TokenMeter): Promise<string> {
  const response = await fetch(target.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ ...payload, stream: false }),
  });
  const data = await response.json().catch(() => ({})) as { error?: { message?: string }; choices?: Array<{ message?: { content?: unknown } }>; usage?: unknown };
  if (!response.ok) throw new Error(data?.error?.message || `模型接口返回 ${response.status}`);
  addUsage(meter, data.usage);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("模型没有返回可读取的内容");
  return content;
}

async function* streamCompletion(target: URL, apiKey: string, payload: Record<string, unknown>, meter?: TokenMeter): AsyncGenerator<string> {
  const post = (body: Record<string, unknown>) => fetch(target.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  // include_usage 让流式响应在末尾携带 token 统计；部分兼容端点不支持该参数时退回普通流式请求
  let response = await post({ ...payload, stream: true, stream_options: { include_usage: true } });
  if (!response.ok || !response.body) response = await post({ ...payload, stream: true });
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(data?.error?.message || `模型接口返回 ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const chunk = JSON.parse(data);
        addUsage(meter, chunk?.usage);
        const delta = chunk?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) yield delta;
      } catch { /* 忽略不完整的分片 */ }
    }
  }
}

async function planRetrieval(target: URL, apiKey: string, model: string, question: string, meter?: TokenMeter) {
  const content = await complete(target, apiKey, {
    model,
    temperature: 0,
    max_tokens: 220,
    messages: [
      { role: "system", content: `你是检索规划器。用户正在阅读一篇英文论文并提问。输出 JSON：{"queries":["..."],"broad":false}。queries 给 3-5 个检索词，中英文都要有，英文用论文中最可能出现的专业术语；broad 仅当问题要求总结/概括/评价整篇论文时为 true。只输出 JSON。` },
      { role: "user", content: question },
    ],
  }, meter);
  const parsed = parseJsonObject(content);
  return {
    queries: Array.isArray(parsed.queries) ? parsed.queries.map(String).filter(Boolean).slice(0, 6) : [],
    broad: Boolean(parsed.broad),
  };
}

async function planSecondRound(target: URL, apiKey: string, model: string, question: string, previews: string, meter?: TokenMeter) {
  const content = await complete(target, apiKey, {
    model,
    temperature: 0,
    max_tokens: 180,
    messages: [
      { role: "system", content: `你是检索审查员。根据已有资料预览判断是否足以充分回答问题。输出 JSON {"needMore":false,"queries":[]}；若关键信息缺失，needMore 为 true 并给 2-3 个补充检索词（英文专业术语优先）。只输出 JSON。` },
      { role: "user", content: `问题：${question}\n\n已有资料预览：\n${previews}` },
    ],
  }, meter);
  const parsed = parseJsonObject(content);
  return {
    needMore: Boolean(parsed.needMore),
    queries: Array.isArray(parsed.queries) ? parsed.queries.map(String).filter(Boolean).slice(0, 4) : [],
  };
}

async function runAgentLoop(
  target: URL,
  apiKey: string,
  model: string,
  question: string,
  chunks: Chunk[],
  gathered: Map<number, Chunk>,
  send: (payload: Record<string, unknown>) => void,
  meter?: TokenMeter,
) {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: AGENT_SYSTEM },
    { role: "user", content: `论文共 ${chunks.length} 个片段。已收集的片段页码：${pagesLabel([...gathered.values()])}。\n\n用户问题：${question}` },
  ];
  for (let round = 0; round < AGENT_MAX_ROUNDS; round++) {
    let reply = "";
    try {
      reply = await complete(target, apiKey, { model, messages, temperature: 0, max_tokens: 300 }, meter);
    } catch {
      return;
    }
    const action = parseJsonObject(reply);
    const kind = String(action.action || "answer");
    if (kind === "search" && Array.isArray(action.queries)) {
      const queries = action.queries.map(String).filter(Boolean).slice(0, 4);
      const found = retrieveChunks(chunks, queries, false, 5, gathered);
      found.forEach((chunk) => gathered.set(chunk.id, chunk));
      send({ type: "step", label: `主动检索“${queries.slice(0, 2).join(" / ")}” → ${found.length ? pagesLabel(found) : "无新结果"}` });
      messages.push({ role: "assistant", content: reply });
      messages.push({
        role: "user",
        content: found.length
          ? `检索结果预览：\n${found.map((chunk) => `#${chunk.id} P${chunk.page} ${chunk.heading || ""}\n${chunk.text.slice(0, 240)}`).join("\n")}\n\n需要看完整内容用 read，足够了用 answer。`
          : "没有新结果。换个关键词，或者用 read 看已定位的页，或者直接 answer。",
      });
    } else if (kind === "read" && Array.isArray(action.pages)) {
      const wanted = action.pages.map(Number).filter((page) => Number.isFinite(page)).slice(0, 6);
      const found = chunks.filter((chunk) => wanted.includes(chunk.page) && !gathered.has(chunk.id)).slice(0, 8);
      found.forEach((chunk) => gathered.set(chunk.id, chunk));
      send({ type: "step", label: `阅读 ${wanted.map((page) => `P${page}`).join("、")} 的完整内容` });
      messages.push({ role: "assistant", content: reply });
      messages.push({ role: "user", content: found.length ? `已把 ${pagesLabel(found)} 的完整片段加入资料。继续 search/read，或 answer。` : "这些页已经在资料里了。继续 search/read，或 answer。" });
    } else {
      return;
    }
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireAppUser();
    if (!user) return NextResponse.json({ error: "需要登录" }, { status: 401 });
    const body = await request.json();
    const { endpoint, apiKey, model, paperTitle, question, paperContext = "", selectedText = "", surroundingContext = "", mode = "global", history = [], systemPrompts = {}, effort = "medium" } = body;
    const db = getDb();
    const [savedSettings] = await db.select().from(userSettings).where(eq(userSettings.userId, user.id)).limit(1);
    const runtime = env as unknown as Record<string, string | undefined>;
    const resolvedEndpoint = String(endpoint || savedSettings?.modelEndpoint || runtime.OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || "").trim();
    const resolvedModel = String(model || savedSettings?.modelName || runtime.OPENAI_MODEL || process.env.OPENAI_MODEL || "").trim();
    const resolvedApiKey = String(apiKey || (savedSettings?.apiKeyEncrypted ? await decryptApiKey(savedSettings.apiKeyEncrypted) : "") || runtime.OPENAI_API_KEY || process.env.OPENAI_API_KEY || "").trim();
    if (!resolvedEndpoint || !resolvedApiKey || !resolvedModel || !question) return NextResponse.json({ error: "模型配置不完整，请先在 AI 设置中保存" }, { status: 400 });
    const target = chatCompletionsUrl(resolvedEndpoint);
    const isInline = mode === "inline";
    const level: Effort = effort === "high" || effort === "max" ? effort : "medium";
    const title = String(paperTitle || "研究论文").slice(0, 300);
    const globalPrompt = String(systemPrompts?.global || savedSettings?.globalSystemPrompt || DEFAULT_PROMPTS.global).trim().slice(0, 12000) || DEFAULT_PROMPTS.global;
    const inlinePrompt = String(systemPrompts?.inline || savedSettings?.inlineSystemPrompt || DEFAULT_PROMPTS.inline).trim().slice(0, 12000) || DEFAULT_PROMPTS.inline;
    const historyMessages = cleanHistory(history, 10);
    const meter: TokenMeter = { prompt: 0, completion: 0 };

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (payload: Record<string, unknown>) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        try {
          if (isInline) {
            // 划词问答：medium 只用选区和相邻原文（零额外调用）；high/max 会从全论文检索补充上下文
            const questionText = String(question);
            const chunks = chunkPaper(String(paperContext));
            const gathered = new Map<number, Chunk>();
            if (chunks.length && level !== "medium") {
              let queries = [questionText, String(selectedText).slice(0, 120)];
              try {
                const plan = await planRetrieval(target, resolvedApiKey, resolvedModel, questionText, meter);
                if (plan.queries.length) queries = plan.queries;
              } catch { /* 检索规划失败时退回原问题 */ }
              send({ type: "step", label: `在全文中检索：${queries.slice(0, 2).join(" / ")}` });
              const first = retrieveChunks(chunks, queries, false, 6);
              first.forEach((chunk) => gathered.set(chunk.id, chunk));
              if (first.length) send({ type: "step", label: `找到 ${first.length} 个相关片段（${pagesLabel(first)}）` });
              if (level === "max") {
                await runAgentLoop(target, resolvedApiKey, resolvedModel, questionText, chunks, gathered, send, meter);
              }
            }
            const reference = [...gathered.values()]
              .sort((a, b) => a.page - b.page || a.id - b.id)
              .map((chunk) => `【P${chunk.page}${chunk.heading ? ` · ${chunk.heading}` : ""}】${chunk.text}`)
              .join("\n\n")
              .slice(0, MAX_REFERENCE_CHARS);
            const referenceBlock = reference ? `\n\n另外，我还从论文其他位置检索到这些相关内容：\n<paper_reference>\n${reference}\n</paper_reference>` : "";
            const messages = [
              { role: "system", content: renderSystemPrompt(inlinePrompt, title) + INLINE_CONTRACT },
              ...historyMessages,
              { role: "user", content: `我正在看下面这段论文。\n\n<selected_text>\n${String(selectedText).slice(0, 6000)}\n</selected_text>\n\n<nearby_text>\n${String(surroundingContext).slice(0, 10000)}\n</nearby_text>${referenceBlock}\n\n我的问题是：\n${questionText}` },
            ];
            for await (const delta of streamCompletion(target, resolvedApiKey, { model: resolvedModel, messages, temperature: 0.3 }, meter)) send({ type: "delta", text: delta });
          } else {
            const questionText = String(question);
            const chunks = chunkPaper(String(paperContext));
            const gathered = new Map<number, Chunk>();

            let queries = [questionText];
            let broad = isBroadQuestion(questionText);
            if (chunks.length) {
              // medium（快速档）：零额外模型调用，直接用原问题做本地检索，保证最快最便宜
              if (level !== "medium") {
                try {
                  const plan = await planRetrieval(target, resolvedApiKey, resolvedModel, questionText, meter);
                  if (plan.queries.length) queries = plan.queries;
                  broad = broad || plan.broad;
                } catch { /* 检索规划失败时退回原问题 */ }
                send({ type: "step", label: broad ? "全文型问题，按章节均匀取样" : `生成检索词：${queries.slice(0, 3).join(" / ")}` });
              }
              let first = retrieveChunks(chunks, queries, broad, level === "medium" ? 6 : 8);
              // 本地检索没有命中时兜底：按章节均匀取样，保证模型始终有上下文
              if (!first.length && !broad) {
                first = retrieveChunks(chunks, queries, true, 6);
                if (first.length) send({ type: "step", label: `关键词未命中，按章节取样 ${first.length} 个片段（${pagesLabel(first)}）` });
              }
              first.forEach((chunk) => gathered.set(chunk.id, chunk));
              if (first.length) send({ type: "step", label: `找到 ${first.length} 个相关片段（${pagesLabel(first)}）` });

              if (level === "high" && !broad && first.length) {
                try {
                  const previews = first.map((chunk) => `P${chunk.page} ${chunk.heading || ""}：${chunk.text.slice(0, 160)}`).join("\n");
                  const gap = await planSecondRound(target, resolvedApiKey, resolvedModel, questionText, previews, meter);
                  if (gap.needMore && gap.queries.length) {
                    const more = retrieveChunks(chunks, gap.queries, false, 6, gathered);
                    more.forEach((chunk) => gathered.set(chunk.id, chunk));
                    if (more.length) send({ type: "step", label: `第 2 轮检索补充 ${more.length} 个片段（${pagesLabel(more)}）` });
                    else send({ type: "step", label: "第 2 轮检索：资料已覆盖问题" });
                  }
                } catch { /* 第二轮失败不阻塞回答 */ }
              }
              if (level === "max") {
                await runAgentLoop(target, resolvedApiKey, resolvedModel, questionText, chunks, gathered, send, meter);
              }
            }

            const reference = [...gathered.values()]
              .sort((a, b) => a.page - b.page || a.id - b.id)
              .map((chunk) => `【P${chunk.page}${chunk.heading ? ` · ${chunk.heading}` : ""}】${chunk.text}`)
              .join("\n\n")
              .slice(0, MAX_REFERENCE_CHARS);
            const messages = [
              { role: "system", content: renderSystemPrompt(globalPrompt, title) + ANSWER_CONTRACT },
              ...historyMessages,
              { role: "user", content: `下面是从论文中检索到的参考片段，页码以【P数字】标注：\n\n<paper_reference>\n${reference || "（未检索到可参考的论文内容）"}\n</paper_reference>\n\n我的问题是：\n${questionText}` },
            ];
            send({ type: "step", label: "整理回答…" });
            for await (const delta of streamCompletion(target, resolvedApiKey, { model: resolvedModel, messages, temperature: 0.3 }, meter)) send({ type: "delta", text: delta });
          }
          if (meter.prompt || meter.completion) {
            try {
              await db.insert(llmUsage).values({ id: crypto.randomUUID(), userId: user.id, model: resolvedModel, mode: isInline ? "inline" : "global", effort: level, promptTokens: meter.prompt, completionTokens: meter.completion, createdAt: new Date().toISOString() });
            } catch { /* 用量写入失败不影响回答 */ }
          }
          send({ type: "done", usage: { promptTokens: meter.prompt, completionTokens: meter.completion } });
        } catch (error: unknown) {
          send({ type: "error", message: error instanceof Error ? error.message : "请求失败" });
        }
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform" },
    });
  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "请求失败" }, { status: 500 });
  }
}
