import { env } from "cloudflare:workers";
import { requireAppUser } from "../../../server-user";
import { sanitizeObjectKey } from "../../../object-key";
import { loadSyncConfig } from "../config";
import { isSyncSnapshot, mergeSnapshot, restoreSnapshot } from "../snapshot";
import { getFile } from "../webdav";

export async function POST(request: Request) {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const config = await loadSyncConfig(user.id);
  if (!config) return Response.json({ error: "请先保存同步配置" }, { status: 400 });
  const payload = await request.json().catch(() => ({})) as { mode?: unknown };
  const merge = payload?.mode === "merge";

  let snapshot: unknown;
  try {
    const response = await getFile(config, `${config.remotePath}/data.json`);
    if (!response) return Response.json({ error: "远端还没有备份" }, { status: 404 });
    snapshot = await response.json();
  } catch (error) {
    return Response.json({ error: (error instanceof Error ? error.message : "") || "读取远端备份失败" }, { status: 502 });
  }
  if (!isSyncSnapshot(snapshot)) return Response.json({ error: "远端备份格式不支持" }, { status: 400 });

  let restoredPaperIds: string[] | null = null;
  let summary = null;
  try {
    if (merge) {
      summary = await mergeSnapshot(user.id, snapshot);
      restoredPaperIds = summary.restoredPaperIds;
    } else {
      await restoreSnapshot(user.id, snapshot);
    }
  } catch (error) {
    return Response.json({ error: `恢复失败：${(error instanceof Error ? error.message : "") || "数据库写入失败"}` }, { status: 500 });
  }

  // 恢复上传过的 PDF 原件到 R2；合并模式下只写回「新增或快照胜出」的论文，本地较新的 PDF 不动
  const bucket = (env as unknown as { FILES?: R2Bucket }).FILES;
  let files = 0;
  let missing = 0;
  if (bucket) {
    for (const paper of snapshot.papers) {
      if (paper.sourceKind !== "upload" || !paper.objectKey) continue;
      if (restoredPaperIds && !restoredPaperIds.includes(String(paper.id).slice(0, 64))) continue;
      try {
        const response = await getFile(config, `${config.remotePath}/files/${paper.id}.pdf`);
        if (!response) { missing++; continue; }
        const body = await response.arrayBuffer();
        const objectKey = await sanitizeObjectKey(user.id, String(paper.objectKey));
        await bucket.put(objectKey, body, { httpMetadata: { contentType: "application/pdf" } });
        files++;
      } catch {
        missing++;
      }
    }
  }

  return Response.json({ ok: true, papers: snapshot.papers.length, files, missing, ...(summary ? { summary } : {}) });
}
