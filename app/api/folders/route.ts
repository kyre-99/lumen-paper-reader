import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../../../db";
import { paperFolders } from "../../../db/schema";
import { requireAppUser } from "../../server-user";

export async function POST(request: Request) {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const payload = await request.json() as { name?: unknown; parentId?: unknown };
  const name = String(payload?.name || "").trim().replace(/\s+/g, " ").slice(0, 80);
  if (!name) return Response.json({ error: "文件夹名称不能为空" }, { status: 400 });
  const db = getDb();

  // 可选父文件夹：必须存在且属于当前用户
  const parentId = payload?.parentId ? String(payload.parentId) : null;
  if (parentId) {
    const [parent] = await db.select({ id: paperFolders.id }).from(paperFolders).where(and(eq(paperFolders.id, parentId), eq(paperFolders.userId, user.id))).limit(1);
    if (!parent) return Response.json({ error: "父文件夹不存在" }, { status: 400 });
  }

  // 同名查重仅限同一父级内：兄弟不可同名，不同分支允许同名
  const siblingCondition = parentId ? eq(paperFolders.parentId, parentId) : isNull(paperFolders.parentId);
  const siblings = await db.select({ name: paperFolders.name }).from(paperFolders).where(and(eq(paperFolders.userId, user.id), siblingCondition));
  if (siblings.some((folder) => folder.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    return Response.json({ error: "已经有同名文件夹" }, { status: 409 });
  }
  const folder = { id: crypto.randomUUID(), userId: user.id, name, parentId, updatedAt: new Date().toISOString() };
  await db.insert(paperFolders).values(folder);
  return Response.json({ folder: { id: folder.id, name: folder.name, parentId: folder.parentId, updatedAt: folder.updatedAt } }, { status: 201 });
}
