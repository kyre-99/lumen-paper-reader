import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { paperFolders } from "../../../../db/schema";
import { requireAppUser } from "../../../server-user";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const { id } = await params;
  const payload = await request.json() as { name?: unknown; parentId?: unknown };
  // name 与 parentId 至少给一个；parentId 显式传 null 表示移到顶层
  const hasName = payload != null && typeof payload === "object" && "name" in payload;
  const hasParent = payload != null && typeof payload === "object" && "parentId" in payload;
  if (!hasName && !hasParent) return Response.json({ error: "name 和 parentId 至少提供一个" }, { status: 400 });
  const name = hasName ? String(payload?.name || "").trim().replace(/\s+/g, " ").slice(0, 80) : null;
  if (hasName && !name) return Response.json({ error: "文件夹名称不能为空" }, { status: 400 });
  const db = getDb();
  const [folder] = await db.select({ id: paperFolders.id, name: paperFolders.name, parentId: paperFolders.parentId }).from(paperFolders).where(and(eq(paperFolders.id, id), eq(paperFolders.userId, user.id))).limit(1);
  if (!folder) return Response.json({ error: "文件夹不存在" }, { status: 404 });

  // 移动校验：父级存在且属于本用户；不能移到自己或自己的后代里
  let targetParentId = folder.parentId;
  if (hasParent) {
    targetParentId = payload?.parentId ? String(payload.parentId) : null;
    if (targetParentId === id) return Response.json({ error: "不能移动到文件夹自身" }, { status: 400 });
    if (targetParentId) {
      const all = await db.select({ id: paperFolders.id, parentId: paperFolders.parentId }).from(paperFolders).where(eq(paperFolders.userId, user.id));
      const parentById = new Map(all.map((item) => [item.id, item.parentId]));
      if (!parentById.has(targetParentId)) return Response.json({ error: "父文件夹不存在" }, { status: 400 });
      // 从目标父级沿 parentId 链向上爬，遇到自己说明目标是自己的后代
      for (let cursor: string | null = targetParentId; cursor; cursor = parentById.get(cursor) ?? null) {
        if (cursor === id) return Response.json({ error: "不能移动到子文件夹内" }, { status: 400 });
      }
    }
  }

  // 改名时才查重，范围为目标父级内（同时移动则以新父级为准）的兄弟文件夹
  if (name) {
    const siblings = await db.select({ id: paperFolders.id, name: paperFolders.name, parentId: paperFolders.parentId }).from(paperFolders).where(eq(paperFolders.userId, user.id));
    if (siblings.some((item) => item.id !== id && item.parentId === targetParentId && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      return Response.json({ error: "已经有同名文件夹" }, { status: 409 });
    }
  }
  const updatedAt = new Date().toISOString();
  const finalName = name ?? folder.name;
  await db.update(paperFolders).set({ name: finalName, parentId: targetParentId, updatedAt }).where(and(eq(paperFolders.id, id), eq(paperFolders.userId, user.id)));
  return Response.json({ saved: true, folder: { id, name: finalName, parentId: targetParentId, updatedAt } });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const { id } = await params;
  const db = getDb();
  const [folder] = await db.select({ id: paperFolders.id, parentId: paperFolders.parentId }).from(paperFolders).where(and(eq(paperFolders.id, id), eq(paperFolders.userId, user.id))).limit(1);
  if (!folder) return Response.json({ error: "文件夹不存在" }, { status: 404 });

  // 删除前把子文件夹重挂到被删文件夹的父级，保留层级；
  // papers.folderId 是 onDelete "set null"，直接删文件夹，论文保留变为无文件夹
  await db.update(paperFolders).set({ parentId: folder.parentId }).where(and(eq(paperFolders.parentId, id), eq(paperFolders.userId, user.id)));
  await db.delete(paperFolders).where(and(eq(paperFolders.id, id), eq(paperFolders.userId, user.id)));
  return Response.json({ ok: true });
}
