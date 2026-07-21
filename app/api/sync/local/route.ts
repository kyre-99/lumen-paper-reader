import { env } from "cloudflare:workers";
import { requireAppUser } from "../../../server-user";
import { buildSnapshot, isSyncSnapshot, restoreSnapshot } from "../snapshot";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_IMPORT_BYTES = 100 * 1024 * 1024;

// 大文件分块转 base64，避免栈溢出
function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

// 导出：快照 JSON + 上传过的 PDF 以 base64 内嵌，作为附件下载
export async function GET() {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const snapshot = await buildSnapshot(user.id);
  const bucket = (env as unknown as { FILES?: R2Bucket }).FILES;
  const files: Array<{ paperId: string; objectKey: string; base64: string }> = [];
  const skippedFiles: Array<{ paperId: string; objectKey: string; reason: string }> = [];
  for (const paper of snapshot.papers) {
    if (paper.sourceKind !== "upload" || !paper.objectKey || !bucket) continue;
    const object = await bucket.get(paper.objectKey);
    if (!object) { skippedFiles.push({ paperId: paper.id, objectKey: paper.objectKey, reason: "missing" }); continue; }
    if (object.size > MAX_FILE_BYTES) { skippedFiles.push({ paperId: paper.id, objectKey: paper.objectKey, reason: "too_large" }); continue; }
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    files.push({ paperId: paper.id, objectKey: paper.objectKey, base64: bytesToBase64(bytes) });
  }
  const date = snapshot.exportedAt.slice(0, 10).replaceAll("-", "");
  return new Response(JSON.stringify({ ...snapshot, files, skippedFiles }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="lumen-backup-${date}.json"`,
    },
  });
}

// 导入：解析备份文件，覆盖式恢复（与 WebDAV 恢复同一套逻辑）
export async function POST(request: Request) {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  if (Number(request.headers.get("content-length") || 0) > MAX_IMPORT_BYTES) {
    return Response.json({ error: "备份文件超过 100MB，暂不支持导入" }, { status: 413 });
  }
  const body = await request.json().catch(() => null) as unknown;
  if (!isSyncSnapshot(body)) return Response.json({ error: "备份文件格式不支持" }, { status: 400 });

  try {
    await restoreSnapshot(user.id, body);
  } catch (error) {
    return Response.json({ error: `导入失败：${(error instanceof Error ? error.message : "") || "数据库写入失败"}` }, { status: 500 });
  }

  // 把内嵌的 PDF 写回 R2
  const bucket = (env as unknown as { FILES?: R2Bucket }).FILES;
  const embedded = (body as { files?: unknown }).files;
  let files = 0;
  let missing = 0;
  if (bucket && Array.isArray(embedded)) {
    for (const item of embedded as Array<{ paperId?: unknown; objectKey?: unknown; base64?: unknown }>) {
      const objectKey = String(item?.objectKey || "").slice(0, 500);
      const base64 = typeof item?.base64 === "string" ? item.base64 : "";
      if (!objectKey || !base64) { missing++; continue; }
      try {
        await bucket.put(objectKey, base64ToBytes(base64).buffer as ArrayBuffer, { httpMetadata: { contentType: "application/pdf" } });
        files++;
      } catch {
        missing++;
      }
    }
  }

  return Response.json({ ok: true, papers: body.papers.length, files, missing });
}
