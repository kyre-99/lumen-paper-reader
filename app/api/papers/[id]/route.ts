import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { paperFolders, papers } from "../../../../db/schema";
import { requireAppUser } from "../../../server-user";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const { id } = await params;
  const payload = await request.json() as { folderId?: unknown; title?: unknown; status?: unknown };
  const db = getDb();
  const [paper] = await db.select({ id: papers.id }).from(papers).where(and(eq(papers.id, id), eq(papers.userId, user.id))).limit(1);
  if (!paper) return Response.json({ error: "论文不存在" }, { status: 404 });

  const updates: { folderId?: string | null; title?: string; status?: "unread" | "reading" | "done"; updatedAt: string } = { updatedAt: new Date().toISOString() };
  if (Object.prototype.hasOwnProperty.call(payload, "folderId")) {
    const folderId = payload.folderId ? String(payload.folderId).slice(0, 80) : null;
    if (folderId) {
      const [folder] = await db.select({ id: paperFolders.id }).from(paperFolders).where(and(eq(paperFolders.id, folderId), eq(paperFolders.userId, user.id))).limit(1);
      if (!folder) return Response.json({ error: "文件夹不存在" }, { status: 404 });
    }
    updates.folderId = folderId;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "title")) {
    const title = String(payload.title || "").trim().replace(/\s+/g, " ").slice(0, 300);
    if (!title) return Response.json({ error: "论文名称不能为空" }, { status: 400 });
    updates.title = title;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "status")) {
    const status = String(payload.status || "");
    if (status !== "unread" && status !== "reading" && status !== "done") return Response.json({ error: "无效的阅读状态" }, { status: 400 });
    updates.status = status;
  }
  await db.update(papers).set(updates).where(and(eq(papers.id, id), eq(papers.userId, user.id)));
  return Response.json({ saved: true, paper: { id, ...updates } });
}
