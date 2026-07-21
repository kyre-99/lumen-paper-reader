import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { papers, readingSessions } from "../../../../db/schema";
import { requireAppUser } from "../../../server-user";

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// 阅读心跳：每 30 秒一次。同一用户+论文+自然日内，2 分钟内有心跳的会话直接续时长，否则开新会话
export async function POST(request: Request) {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const payload = await request.json() as { paperId?: unknown; currentPage?: unknown; deltaSeconds?: unknown; day?: unknown };
  const paperId = String(payload.paperId || "").slice(0, 80);
  const day = String(payload.day || "");
  const deltaSeconds = Number(payload.deltaSeconds);
  if (!paperId || !DAY_PATTERN.test(day) || !Number.isInteger(deltaSeconds) || deltaSeconds < 1 || deltaSeconds > 60) {
    return Response.json({ error: "无效的心跳参数" }, { status: 400 });
  }
  const currentPage = Math.max(1, Math.min(1000, Math.floor(Number(payload.currentPage)) || 1));

  const db = getDb();
  const [paper] = await db.select({ id: papers.id }).from(papers).where(and(eq(papers.id, paperId), eq(papers.userId, user.id))).limit(1);
  if (!paper) return Response.json({ error: "论文不存在" }, { status: 404 });

  const [session] = await db.select().from(readingSessions)
    .where(and(
      eq(readingSessions.userId, user.id),
      eq(readingSessions.paperId, paperId),
      eq(readingSessions.day, day),
      gte(readingSessions.lastPingAt, sql`datetime('now', '-2 minutes')`),
    ))
    .orderBy(desc(readingSessions.lastPingAt))
    .limit(1);

  if (session) {
    await db.update(readingSessions).set({
      activeSeconds: session.activeSeconds + deltaSeconds,
      endPage: currentPage,
      lastPingAt: sql`CURRENT_TIMESTAMP`,
    }).where(eq(readingSessions.id, session.id));
  } else {
    await db.insert(readingSessions).values({
      id: crypto.randomUUID(),
      userId: user.id,
      paperId,
      day,
      startPage: currentPage,
      endPage: currentPage,
      activeSeconds: deltaSeconds,
      lastPingAt: sql`CURRENT_TIMESTAMP`,
    });
  }
  return Response.json({ ok: true });
}
