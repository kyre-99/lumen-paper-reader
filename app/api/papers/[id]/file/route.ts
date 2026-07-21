import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { requireAppUser } from "../../../../server-user";
import { getDb } from "../../../../../db";
import { papers } from "../../../../../db/schema";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const { id } = await params;
  const db = getDb();
  const [paper] = await db.select({ objectKey: papers.objectKey, title: papers.title }).from(papers).where(and(eq(papers.id, id), eq(papers.userId, user.id))).limit(1);
  if (!paper?.objectKey) return Response.json({ error: "找不到该 PDF" }, { status: 404 });
  const bucket = (env as any).FILES as R2Bucket | undefined;
  if (!bucket) return Response.json({ error: "文件存储尚未就绪" }, { status: 503 });
  const asciiFileName = `${paper.title.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_")}.pdf`;
  const encodedFileName = encodeURIComponent(`${paper.title}.pdf`);
  const baseHeaders = {
    "Content-Type": "application/pdf",
    "Content-Disposition": `inline; filename="${asciiFileName}"; filename*=UTF-8''${encodedFileName}`,
    "Cache-Control": "private, max-age=3600",
    "Accept-Ranges": "bytes",
  };

  // 支持 HTTP Range，让 pdf.js 可以分段加载大文件
  const rangeHeader = request.headers.get("range");
  const rangeMatch = rangeHeader ? /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim()) : null;
  if (rangeMatch) {
    const meta = await bucket.head(paper.objectKey);
    if (!meta) return Response.json({ error: "PDF 文件不存在" }, { status: 404 });
    const total = meta.size;
    const start = Number(rangeMatch[1]);
    const end = rangeMatch[2] ? Math.min(Number(rangeMatch[2]), total - 1) : total - 1;
    if (start >= total || end < start) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
    }
    const length = end - start + 1;
    const object = await bucket.get(paper.objectKey, { range: { offset: start, length } });
    if (!object) return Response.json({ error: "PDF 文件不存在" }, { status: 404 });
    return new Response(object.body, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Length": String(length),
        "Content-Range": `bytes ${start}-${end}/${total}`,
        ETag: object.httpEtag,
      },
    });
  }

  const object = await bucket.get(paper.objectKey);
  if (!object) return Response.json({ error: "PDF 文件不存在" }, { status: 404 });
  return new Response(object.body, {
    headers: {
      ...baseHeaders,
      "Content-Length": String(object.size),
      ETag: object.httpEtag,
    },
  });
}
