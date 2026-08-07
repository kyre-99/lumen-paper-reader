import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../db";
import { llmUsage, papers, paperStates, readingSessions, userSettings } from "../../../../db/schema";
import { DIARY_SYSTEM_PROMPT } from "../../../chat-prompts";
import { chatCompletionsUrl, resolveModelConfig } from "../../../model-config";
import { requireAppUser } from "../../../server-user";
import { streamCompletion, type TokenMeter } from "../../chat/completions";

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// 入选门槛：当天停留至少 10 分钟
const MIN_ACTIVE_SECONDS = 600;
// 材料预算：每篇约 3000 字，总量约 12000 字，超出从最早内容丢弃
const PER_PAPER_BUDGET = 3000;
const TOTAL_BUDGET = 12000;

function shiftDay(day: string, offset: number) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function parseJsonArray(raw: string): Array<Record<string, unknown>> {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

// ChatMessage 形如 { id, role: "user"|"assistant", content }
function renderMessages(messages: Array<Record<string, unknown>>) {
  return messages
    .filter((item) => item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string" && item.content.trim())
    .map((item) => `${item.role === "user" ? "问" : "答"}：${String(item.content).slice(0, 2000)}\n`)
    .join("\n");
}

type PaperMaterial = { header: string; blocks: string[] };

// 与 app/page.tsx 的 ANNOTATION_KIND_LABELS 对应（客户端文件不便在服务端引用，此处单独维护）
const ANNOTATION_KIND_LABELS: Record<string, string> = { translate: "翻译", explain: "解释", ask: "提问", formula: "公式", figure: "图表", highlight: "高亮", "text-note": "批注" };

function renderPaper(item: PaperMaterial) {
  return item.header + item.blocks.join("");
}

export async function POST(request: Request) {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const payload = await request.json().catch(() => null) as { day?: unknown } | null;
  const requestedDay = String(payload?.day || "");
  // day 为客户端本地日期；缺省或非法时退化为 UTC 今天
  const day = DAY_PATTERN.test(requestedDay) ? requestedDay : new Date().toISOString().slice(0, 10);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (body: Record<string, unknown>) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(body)}\n\n`));
      try {
        const db = getDb();
        // 当天阅读会话按论文聚合：累计时长、起止页
        const sessions = await db.select({
          paperId: readingSessions.paperId,
          activeSeconds: readingSessions.activeSeconds,
          startPage: readingSessions.startPage,
          endPage: readingSessions.endPage,
        }).from(readingSessions).where(and(eq(readingSessions.userId, user.id), eq(readingSessions.day, day)));
        const byPaper = new Map<string, { seconds: number; startPage: number | null; endPage: number | null }>();
        for (const session of sessions) {
          const entry = byPaper.get(session.paperId) || { seconds: 0, startPage: null, endPage: null };
          entry.seconds += session.activeSeconds;
          if (session.startPage != null) entry.startPage = entry.startPage == null ? session.startPage : Math.min(entry.startPage, session.startPage);
          if (session.endPage != null) entry.endPage = entry.endPage == null ? session.endPage : Math.max(entry.endPage, session.endPage);
          byPaper.set(session.paperId, entry);
        }
        const candidateIds = [...byPaper.entries()].filter(([, entry]) => entry.seconds >= MIN_ACTIVE_SECONDS).map(([paperId]) => paperId);

        const materials: PaperMaterial[] = [];
        if (candidateIds.length) {
          const [paperRows, stateRows] = await Promise.all([
            db.select({ id: papers.id, title: papers.title, meta: papers.meta }).from(papers).where(and(eq(papers.userId, user.id), inArray(papers.id, candidateIds))),
            db.select({ paperId: paperStates.paperId, messagesJson: paperStates.messagesJson, conversationsJson: paperStates.conversationsJson, annotationsJson: paperStates.annotationsJson }).from(paperStates).where(and(eq(paperStates.userId, user.id), inArray(paperStates.paperId, candidateIds))),
          ]);
          const stateByPaper = new Map(stateRows.map((row) => [row.paperId, row]));
          // 会话 createdAt 是客户端本地毫秒时间戳，服务端按时区粗判：日期串等于当天或前后一天都纳入（宁宽勿严）
          const dayWindow = new Set([shiftDay(day, -1), day, shiftDay(day, 1)]);
          const inWindow = (createdAt: unknown) => {
            const ts = Number(createdAt);
            if (!Number.isFinite(ts) || ts <= 0) return false;
            return dayWindow.has(new Date(ts).toISOString().slice(0, 10));
          };
          // 阅读时长最长的排前面；截断时从最早的内容块开始丢弃
          paperRows.sort((a, b) => (byPaper.get(b.id)?.seconds || 0) - (byPaper.get(a.id)?.seconds || 0));
          for (const paper of paperRows) {
            const state = stateByPaper.get(paper.id);
            const messages = state ? parseJsonArray(state.messagesJson) : [];
            const conversations = state ? parseJsonArray(state.conversationsJson) : [];
            const annotations = state ? parseJsonArray(state.annotationsJson) : [];
            // 有具体交互才入选：当前对话至少一条 user 消息，或有历史会话，或有批注
            const hasUserMessage = messages.some((item) => item && item.role === "user" && typeof item.content === "string" && item.content.trim());
            if (!hasUserMessage && !conversations.length && !annotations.length) continue;
            const stats = byPaper.get(paper.id)!;
            const minutes = Math.round(stats.seconds / 60);
            const pageRange = stats.startPage != null && stats.endPage != null ? `，阅读范围第 ${stats.startPage}–${stats.endPage} 页` : "";
            const header = `=== 论文：${String(paper.title).slice(0, 300)} ===\n${paper.meta ? `元信息：${String(paper.meta).slice(0, 500)}\n` : ""}当天累计阅读约 ${minutes} 分钟${pageRange}。\n`;
            const blocks: string[] = [];
            // 历史会话只取当天（按上面的宽窗口过滤）；当前对话无时间戳，全量纳入
            const dayConversations = conversations.filter((item) => inWindow(item?.createdAt));
            for (const conversation of dayConversations) {
              const rendered = renderMessages(Array.isArray(conversation?.messages) ? conversation.messages : []);
              if (rendered) blocks.push(`\n【历史问答：${String(conversation?.title || "未命名会话").slice(0, 120)}】\n${rendered}`);
            }
            const current = renderMessages(messages);
            if (current) blocks.push(`\n【当前问答】\n${current}`);
            for (const annotation of annotations) {
              const quote = String(annotation?.text || "").trim().slice(0, 800);
              if (!quote) continue;
              const page = Number(annotation?.pageNumber);
              const kind = ANNOTATION_KIND_LABELS[String(annotation?.kind || "")] || "批注";
              let block = `\n【${kind}${Number.isFinite(page) && page > 0 ? `（P${page}）` : ""}】引用：“${quote}”\n`;
              // result 是划词翻译/解释/公式/图表的首轮回答；note 是高亮上的个人批注
              const result = String(annotation?.result || "").trim().slice(0, 2000);
              if (result) block += `答：${result}\n`;
              const note = String(annotation?.note || "").trim().slice(0, 500);
              if (note) block += `我的笔记：${note}\n`;
              const thread = renderMessages(Array.isArray(annotation?.thread) ? annotation.thread : []);
              if (thread) block += thread;
              blocks.push(block);
            }
            materials.push({ header, blocks });
          }
        }

        if (!materials.length) {
          send({ type: "error", code: "no_material" });
          send({ type: "done" });
          controller.close();
          return;
        }

        for (const item of materials) {
          while (item.blocks.length > 1 && renderPaper(item).length > PER_PAPER_BUDGET) item.blocks.shift();
        }
        while (materials.reduce((sum, item) => sum + renderPaper(item).length, 0) > TOTAL_BUDGET) {
          const target = materials.find((item) => item.blocks.length);
          if (!target) break;
          target.blocks.shift();
        }
        const material = materials.map(renderPaper).join("\n").slice(0, TOTAL_BUDGET);

        const [savedSettings] = await db.select().from(userSettings).where(eq(userSettings.userId, user.id)).limit(1);
        const { endpoint, model, apiKey } = await resolveModelConfig(savedSettings, {});
        if (!endpoint || !apiKey || !model) {
          send({ type: "error", code: "llm_error", message: "模型配置不完整，请先在 AI 设置中保存" });
          send({ type: "done" });
          controller.close();
          return;
        }
        const target = chatCompletionsUrl(endpoint);
        const meter: TokenMeter = { prompt: 0, completion: 0 };
        try {
          const llmMessages = [
            { role: "system", content: DIARY_SYSTEM_PROMPT },
            { role: "user", content: `以下是 ${day} 这一天的阅读记录材料，请据此以我的第一人称写今天的学术日记。\n\n${material}` },
          ];
          for await (const delta of streamCompletion(target, apiKey, { model, messages: llmMessages, temperature: 0.5 }, meter)) send({ type: "delta", text: delta });
        } catch (error: unknown) {
          send({ type: "error", code: "llm_error", message: error instanceof Error ? error.message : "模型请求失败" });
          send({ type: "done" });
          controller.close();
          return;
        }
        if (meter.prompt || meter.completion) {
          try {
            await db.insert(llmUsage).values({ id: crypto.randomUUID(), userId: user.id, model, mode: "global", effort: "medium", promptTokens: meter.prompt, completionTokens: meter.completion, createdAt: new Date().toISOString() });
          } catch { /* 用量写入失败不影响生成结果 */ }
        }
        send({ type: "done" });
      } catch (error: unknown) {
        send({ type: "error", code: "llm_error", message: error instanceof Error ? error.message : "请求失败" });
        send({ type: "done" });
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform" },
  });
}
