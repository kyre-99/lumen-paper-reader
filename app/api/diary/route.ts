import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { diaryEntries } from "../../../db/schema";
import { requireAppUser } from "../../server-user";

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// 日记列表：当前用户全部日记按 day 倒序
export async function GET() {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const db = getDb();
  const rows = await db.select({
    id: diaryEntries.id,
    day: diaryEntries.day,
    title: diaryEntries.title,
    content: diaryEntries.content,
    updatedAt: diaryEntries.updatedAt,
  }).from(diaryEntries).where(eq(diaryEntries.userId, user.id)).orderBy(desc(diaryEntries.day));
  return Response.json({ entries: rows });
}

// 按 (userId, day) upsert 一篇日记
export async function PUT(request: Request) {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const payload = await request.json().catch(() => null) as { day?: unknown; title?: unknown; content?: unknown } | null;
  const day = String(payload?.day || "");
  if (!DAY_PATTERN.test(day)) return Response.json({ error: "无效的日期格式" }, { status: 400 });
  const title = String(payload?.title || "").slice(0, 120);
  const content = String(payload?.content || "").slice(0, 100000);
  const db = getDb();
  const now = new Date().toISOString();
  const [existing] = await db.select({ id: diaryEntries.id }).from(diaryEntries).where(and(eq(diaryEntries.userId, user.id), eq(diaryEntries.day, day))).limit(1);
  if (existing) {
    await db.update(diaryEntries).set({ title, content, updatedAt: now }).where(and(eq(diaryEntries.id, existing.id), eq(diaryEntries.userId, user.id)));
    return Response.json({ entry: { id: existing.id, day, title, content, updatedAt: now } });
  }
  const id = crypto.randomUUID();
  await db.insert(diaryEntries).values({ id, userId: user.id, day, title, content, createdAt: now, updatedAt: now });
  return Response.json({ entry: { id, day, title, content, updatedAt: now } });
}

// 删除指定天的日记
export async function DELETE(request: Request) {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const day = new URL(request.url).searchParams.get("day") || "";
  if (!DAY_PATTERN.test(day)) return Response.json({ error: "无效的日期格式" }, { status: 400 });
  const db = getDb();
  await db.delete(diaryEntries).where(and(eq(diaryEntries.userId, user.id), eq(diaryEntries.day, day)));
  return Response.json({ ok: true });
}
