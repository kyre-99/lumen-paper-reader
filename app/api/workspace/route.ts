import { and, eq } from "drizzle-orm";
import { requireAppUser } from "../../server-user";
import { getDb } from "../../../db";
import { papers, paperStates, readerStates } from "../../../db/schema";

function parseArray(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistentAnnotations(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => {
    if (!item || typeof item !== "object") return false;
    const annotation = item as { kind?: unknown; thread?: unknown };
    if (annotation.kind !== "translate") return true;
    if (!Array.isArray(annotation.thread)) return false;
    return annotation.thread.filter((message) => message && typeof message === "object" && (message as { role?: unknown }).role === "user").length > 1;
  });
}

async function requireApiUser() {
  return requireAppUser();
}

export async function GET(request: Request) {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });

  const db = getDb();
  const [state] = await db.select().from(readerStates).where(eq(readerStates.userId, user.id)).limit(1);
  const requestedPaperId = new URL(request.url).searchParams.get("paperId");
  const activePaperId = requestedPaperId || state?.activePaperId || null;
  if (!activePaperId) return Response.json({ workspace: null });

  const [paper] = await db.select().from(papers).where(and(eq(papers.id, activePaperId), eq(papers.userId, user.id))).limit(1);
  if (!paper) return Response.json({ workspace: null });
  const [paperState] = await db.select().from(paperStates).where(and(eq(paperStates.paperId, paper.id), eq(paperStates.userId, user.id))).limit(1);
  const restoredState = paperState || (state?.activePaperId === paper.id ? state : null);

  return Response.json({
    workspace: {
      paper: {
        id: paper.id,
        title: paper.title,
        meta: paper.meta,
        sourceKind: paper.sourceKind,
        sourceUrl: paper.sourceUrl,
        paperText: paper.paperText,
        pageCount: paper.pageCount,
      },
      currentPage: restoredState?.currentPage || 1,
      zoom: restoredState?.zoom || 0.88,
      rightOpen: restoredState?.rightOpen !== false,
      messages: parseArray(restoredState?.messagesJson || "[]"),
      annotations: persistentAnnotations(parseArray(restoredState?.annotationsJson || "[]")),
      updatedAt: restoredState?.updatedAt || paper.updatedAt,
    },
  });
}

export async function PUT(request: Request) {
  const user = await requireApiUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });

  const payload = await request.json() as any;
  const paper = payload.paper && typeof payload.paper === "object" ? payload.paper : null;
  const db = getDb();
  const [existingReaderState] = await db.select({ activePaperId: readerStates.activePaperId }).from(readerStates).where(eq(readerStates.userId, user.id)).limit(1);
  let activePaperId: string | null = existingReaderState?.activePaperId || null;

  // paperText 未提供时保留已有文本，避免每次保存都全量重写
  if (paper) {
    const id = String(paper.id || "").slice(0, 80);
    if (!id) return Response.json({ error: "论文记录缺少 ID" }, { status: 400 });
    const [existing] = await db.select({ userId: papers.userId }).from(papers).where(eq(papers.id, id)).limit(1);
    if (existing && existing.userId !== user.id) return Response.json({ error: "无权修改该论文" }, { status: 403 });

    const baseValues = {
      id,
      userId: user.id,
      title: String(paper.title || "未命名论文").slice(0, 300),
      meta: String(paper.meta || "").slice(0, 500),
      sourceKind: paper.sourceKind === "upload" ? "upload" as const : "remote" as const,
      sourceUrl: paper.sourceKind === "remote" ? String(paper.sourceUrl || "").slice(0, 2000) : null,
      pageCount: Math.max(1, Math.min(1000, Number(paper.pageCount) || 1)),
      updatedAt: new Date().toISOString(),
    };
    const hasText = typeof paper.paperText === "string";
    if (existing) {
      await db.update(papers).set(hasText ? { ...baseValues, paperText: String(paper.paperText).slice(0, 180000) } : baseValues).where(and(eq(papers.id, id), eq(papers.userId, user.id)));
    } else {
      await db.insert(papers).values({ ...baseValues, paperText: hasText ? String(paper.paperText).slice(0, 180000) : "" });
    }
    activePaperId = id;
  }

  const messages = Array.isArray(payload.messages) ? payload.messages.slice(-120) : [];
  const annotations = persistentAnnotations(payload.annotations).slice(-300);
  const messagesJson = JSON.stringify(messages);
  const annotationsJson = JSON.stringify(annotations);
  if (messagesJson.length > 500000 || annotationsJson.length > 750000) {
    return Response.json({ error: "同步内容过大，请删除部分历史记录后重试" }, { status: 413 });
  }
  const stateValues = {
    userId: user.id,
    activePaperId,
    currentPage: Math.max(1, Math.min(1000, Number(payload.currentPage) || 1)),
    zoom: Math.max(0.4, Math.min(2.5, Number(payload.zoom) || 0.88)),
    rightOpen: payload.rightOpen !== false,
    messagesJson,
    annotationsJson,
    updatedAt: new Date().toISOString(),
  };
  await db.insert(readerStates).values(stateValues).onConflictDoUpdate({ target: readerStates.userId, set: stateValues });
  if (activePaperId) {
    const paperStateValues = {
      paperId: activePaperId,
      userId: user.id,
      currentPage: stateValues.currentPage,
      zoom: stateValues.zoom,
      rightOpen: stateValues.rightOpen,
      messagesJson,
      annotationsJson,
      updatedAt: stateValues.updatedAt,
    };
    await db.insert(paperStates).values(paperStateValues).onConflictDoUpdate({ target: paperStates.paperId, set: paperStateValues });
  }
  return Response.json({ saved: true, updatedAt: stateValues.updatedAt });
}
