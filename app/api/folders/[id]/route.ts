import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { paperFolders } from "../../../../db/schema";
import { requireAppUser } from "../../../server-user";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const { id } = await params;
  const payload = await request.json() as { name?: unknown };
  const name = String(payload?.name || "").trim().replace(/\s+/g, " ").slice(0, 80);
  if (!name) return Response.json({ error: "文件夹名称不能为空" }, { status: 400 });
  const db = getDb();
  const [folder] = await db.select({ id: paperFolders.id }).from(paperFolders).where(and(eq(paperFolders.id, id), eq(paperFolders.userId, user.id))).limit(1);
  if (!folder) return Response.json({ error: "文件夹不存在" }, { status: 404 });
  const existing = await db.select({ id: paperFolders.id, name: paperFolders.name }).from(paperFolders).where(eq(paperFolders.userId, user.id));
  if (existing.some((item) => item.id !== id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    return Response.json({ error: "已经有同名文件夹" }, { status: 409 });
  }
  const updatedAt = new Date().toISOString();
  await db.update(paperFolders).set({ name, updatedAt }).where(and(eq(paperFolders.id, id), eq(paperFolders.userId, user.id)));
  return Response.json({ saved: true, folder: { id, name, updatedAt } });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const { id } = await params;
  const db = getDb();
  const [folder] = await db.select({ id: paperFolders.id }).from(paperFolders).where(and(eq(paperFolders.id, id), eq(paperFolders.userId, user.id))).limit(1);
  if (!folder) return Response.json({ error: "文件夹不存在" }, { status: 404 });

  // papers.folderId 是 onDelete "set null"，直接删文件夹，论文保留变为无文件夹
  await db.delete(paperFolders).where(and(eq(paperFolders.id, id), eq(paperFolders.userId, user.id)));
  return Response.json({ ok: true });
}
