import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { papers } from "../../../db/schema";
import { requireAppUser } from "../../server-user";

export async function GET() {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const db = getDb();
  const library = await db.select({
    id: papers.id,
    title: papers.title,
    meta: papers.meta,
    sourceKind: papers.sourceKind,
    pageCount: papers.pageCount,
    createdAt: papers.createdAt,
    updatedAt: papers.updatedAt,
  }).from(papers).where(eq(papers.userId, user.id)).orderBy(desc(papers.updatedAt)).limit(200);
  return Response.json({ papers: library });
}
