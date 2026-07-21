import { env } from "cloudflare:workers";
import { requireAppUser } from "../../../server-user";
import { loadSyncConfig } from "../config";
import { isSyncSnapshot, restoreSnapshot } from "../snapshot";
import { getFile } from "../webdav";

export async function POST() {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const config = await loadSyncConfig(user.id);
  if (!config) return Response.json({ error: "请先保存同步配置" }, { status: 400 });

  let snapshot: unknown;
  try {
    const response = await getFile(config, `${config.remotePath}/data.json`);
    if (!response) return Response.json({ error: "远端还没有备份" }, { status: 404 });
    snapshot = await response.json();
  } catch (error) {
    return Response.json({ error: (error instanceof Error ? error.message : "") || "读取远端备份失败" }, { status: 502 });
  }
  if (!isSyncSnapshot(snapshot)) return Response.json({ error: "远端备份格式不支持" }, { status: 400 });

  try {
    await restoreSnapshot(user.id, snapshot);
  } catch (error) {
    return Response.json({ error: `恢复失败：${(error instanceof Error ? error.message : "") || "数据库写入失败"}` }, { status: 500 });
  }

  // 恢复上传过的 PDF 原件到 R2
  const bucket = (env as unknown as { FILES?: R2Bucket }).FILES;
  let files = 0;
  let missing = 0;
  if (bucket) {
    for (const paper of snapshot.papers) {
      if (paper.sourceKind !== "upload" || !paper.objectKey) continue;
      try {
        const response = await getFile(config, `${config.remotePath}/files/${paper.id}.pdf`);
        if (!response) { missing++; continue; }
        const body = await response.arrayBuffer();
        await bucket.put(String(paper.objectKey), body, { httpMetadata: { contentType: "application/pdf" } });
        files++;
      } catch {
        missing++;
      }
    }
  }

  return Response.json({ ok: true, papers: snapshot.papers.length, files, missing });
}
