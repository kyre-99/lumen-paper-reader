import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { paperFolders } from "../../../db/schema";
import { requireAppUser } from "../../server-user";

export async function POST(request: Request) {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const payload = await request.json() as { name?: unknown };
  const name = String(payload?.name || "").trim().replace(/\s+/g, " ").slice(0, 80);
  if (!name) return Response.json({ error: "文件夹名称不能为空" }, { status: 400 });
  const db = getDb();
  const existing = await db.select({ name: paperFolders.name }).from(paperFolders).where(eq(paperFolders.userId, user.id));
  if (existing.some((folder) => folder.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    return Response.json({ error: "已经有同名文件夹" }, { status: 409 });
  }
  const folder = { id: crypto.randomUUID(), userId: user.id, name, updatedAt: new Date().toISOString() };
  await db.insert(paperFolders).values(folder);
  return Response.json({ folder: { id: folder.id, name: folder.name, updatedAt: folder.updatedAt } }, { status: 201 });
}
