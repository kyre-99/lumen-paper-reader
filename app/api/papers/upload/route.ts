import { env } from "cloudflare:workers";
import { requireAppUser } from "../../../server-user";
import { shortUserHash } from "../../../object-key";
import { getDb } from "../../../../db";
import { papers } from "../../../../db/schema";

export async function POST(request: Request) {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });

  const declaredSize = Number(request.headers.get("content-length") || 0);
  if (declaredSize > 60 * 1024 * 1024) return Response.json({ error: "PDF 超过 60MB" }, { status: 413 });
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > 60 * 1024 * 1024) return Response.json({ error: "PDF 文件无效或超过 60MB" }, { status: 413 });
  const signature = new TextDecoder().decode(bytes.slice(0, 5));
  if (signature !== "%PDF-") return Response.json({ error: "上传的文件不是有效 PDF" }, { status: 400 });

  const encodedName = request.headers.get("x-file-name") || "paper.pdf";
  let fileName = "paper.pdf";
  try { fileName = decodeURIComponent(encodedName).replace(/[\\/\r\n]/g, "_").slice(0, 180) || "paper.pdf"; } catch { /* keep fallback */ }
  const id = crypto.randomUUID();
  const objectKey = `users/${await shortUserHash(user.id)}/papers/${id}.pdf`;
  const bucket = (env as any).FILES as R2Bucket | undefined;
  if (!bucket) return Response.json({ error: "文件存储尚未就绪" }, { status: 503 });
  await bucket.put(objectKey, bytes, { httpMetadata: { contentType: "application/pdf" }, customMetadata: { fileName } });

  const db = getDb();
  await db.insert(papers).values({
    id,
    userId: user.id,
    title: fileName.replace(/\.pdf$/i, ""),
    meta: `已上传 PDF · ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB`,
    sourceKind: "upload",
    objectKey,
    pageCount: 1,
  });

  return Response.json({ paper: { id, title: fileName.replace(/\.pdf$/i, ""), meta: `已上传 PDF · ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB`, sourceKind: "upload" } }, { status: 201 });
}
