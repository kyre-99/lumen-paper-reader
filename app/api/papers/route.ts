import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { paperFolders, papers } from "../../../db/schema";
import { requireAppUser } from "../../server-user";

export async function GET() {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const db = getDb();
  const [library, folders] = await Promise.all([
    db.select({
      id: papers.id,
      folderId: papers.folderId,
      title: papers.title,
      meta: papers.meta,
      sourceKind: papers.sourceKind,
      pageCount: papers.pageCount,
      createdAt: papers.createdAt,
      updatedAt: papers.updatedAt,
    }).from(papers).where(eq(papers.userId, user.id)).orderBy(desc(papers.updatedAt)).limit(500),
    db.select({
      id: paperFolders.id,
      name: paperFolders.name,
      createdAt: paperFolders.createdAt,
      updatedAt: paperFolders.updatedAt,
    }).from(paperFolders).where(eq(paperFolders.userId, user.id)).orderBy(desc(paperFolders.updatedAt)).limit(100),
  ]);
  return Response.json({ papers: library, folders });
}
