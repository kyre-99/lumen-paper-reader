import { and, desc, eq, gte, lte } from "drizzle-orm";
import { getDb } from "../../../../db";
import { papers, paperStates, readingSessions } from "../../../../db/schema";
import { requireAppUser } from "../../../server-user";

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function shiftDay(day: string, offset: number) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

// 阅读统计：from 为客户端本地的本周一，返回本周 7 天时长、周合计、连续天数与在读列表
export async function GET(request: Request) {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const params = new URL(request.url).searchParams;
  const from = params.get("from") || "";
  if (!DAY_PATTERN.test(from)) return Response.json({ error: "无效的起始日期" }, { status: 400 });
  // today 由客户端按本地时区提供（连读天数的基准）；缺省时退化为 UTC 今天
  const todayParam = params.get("today") || "";
  const today = DAY_PATTERN.test(todayParam) ? todayParam : new Date().toISOString().slice(0, 10);

  const weekDays = Array.from({ length: 7 }, (_, index) => shiftDay(from, index));
  const db = getDb();
  const sessions = await db.select({
    day: readingSessions.day,
    paperId: readingSessions.paperId,
    activeSeconds: readingSessions.activeSeconds,
  }).from(readingSessions).where(and(eq(readingSessions.userId, user.id), gte(readingSessions.day, from), lte(readingSessions.day, weekDays[6])));

  const secondsByDay = new Map<string, number>();
  const paperIds = new Set<string>();
  let weekSeconds = 0;
  for (const session of sessions) {
    secondsByDay.set(session.day, (secondsByDay.get(session.day) || 0) + session.activeSeconds);
    paperIds.add(session.paperId);
    weekSeconds += session.activeSeconds;
  }

  // 连读天数：从“今天或昨天”出发逐日回溯，统计有阅读记录的连续自然日
  const allDays = await db.selectDistinct({ day: readingSessions.day }).from(readingSessions).where(eq(readingSessions.userId, user.id));
  const activeDays = new Set(allDays.map((row) => row.day));
  let streakDays = 0;
  let cursor = activeDays.has(today) ? today : shiftDay(today, -1);
  while (activeDays.has(cursor)) {
    streakDays += 1;
    cursor = shiftDay(cursor, -1);
  }

  const readingRows = await db.select({
    id: papers.id,
    title: papers.title,
    pageCount: papers.pageCount,
    currentPage: paperStates.currentPage,
    updatedAt: paperStates.updatedAt,
  }).from(papers)
    .leftJoin(paperStates, and(eq(paperStates.paperId, papers.id), eq(paperStates.userId, user.id)))
    .where(and(eq(papers.userId, user.id), eq(papers.status, "reading")))
    .orderBy(desc(paperStates.updatedAt));

  return Response.json({
    days: weekDays.map((day) => ({ day, activeSeconds: secondsByDay.get(day) || 0 })),
    totals: { weekSeconds, paperCount: paperIds.size, streakDays },
    reading: readingRows.map((row) => ({ id: row.id, title: row.title, currentPage: row.currentPage || 1, pageCount: row.pageCount })),
  });
}
