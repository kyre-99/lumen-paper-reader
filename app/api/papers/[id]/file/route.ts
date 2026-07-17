import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getChatGPTUser, chatGPTSignInPath } from "../../../../chatgpt-auth";
import { getDb } from "../../../../../db";
import { papers } from "../../../../../db/schema";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "需要登录", signInUrl: chatGPTSignInPath("/") }, { status: 401 });
  const { id } = await params;
  const db = getDb();
  const [paper] = await db.select({ objectKey: papers.objectKey, title: papers.title }).from(papers).where(and(eq(papers.id, id), eq(papers.userId, user.email))).limit(1);
  if (!paper?.objectKey) return Response.json({ error: "找不到该 PDF" }, { status: 404 });
  const bucket = (env as any).FILES as R2Bucket | undefined;
  if (!bucket) return Response.json({ error: "文件存储尚未就绪" }, { status: 503 });
  const object = await bucket.get(paper.objectKey);
  if (!object) return Response.json({ error: "PDF 文件不存在" }, { status: 404 });
  const asciiFileName = `${paper.title.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_")}.pdf`;
  const encodedFileName = encodeURIComponent(`${paper.title}.pdf`);
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(object.size),
      "Content-Disposition": `inline; filename="${asciiFileName}"; filename*=UTF-8''${encodedFileName}`,
      "Cache-Control": "private, max-age=3600",
      ETag: object.httpEtag,
    },
  });
}
