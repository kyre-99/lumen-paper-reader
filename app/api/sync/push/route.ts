import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { userSettings } from "../../../../db/schema";
import { requireAppUser } from "../../../server-user";
import { loadSyncConfig } from "../config";
import { buildSnapshot } from "../snapshot";
import { ensureDir, putFile } from "../webdav";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_DATA_BYTES = 40 * 1024 * 1024;

export async function POST() {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const config = await loadSyncConfig(user.id);
  if (!config) return Response.json({ error: "请先保存同步配置" }, { status: 400 });

  const snapshot = await buildSnapshot(user.id);
  const dataJson = JSON.stringify(snapshot);
  if (dataJson.length > MAX_DATA_BYTES) return Response.json({ error: "备份数据超过 40MB，暂不支持备份" }, { status: 413 });

  try {
    // data.json 放在 {remotePath}/ 下，PDF 放在 {remotePath}/files/ 下
    await ensureDir(config, `${config.remotePath}/files`);
    await putFile(config, `${config.remotePath}/data.json`, dataJson, "application/json");

    const bucket = (env as unknown as { FILES?: R2Bucket }).FILES;
    let files = 0;
    let skipped = 0;
    let bytes = dataJson.length;
    for (const paper of snapshot.papers) {
      if (paper.sourceKind !== "upload" || !paper.objectKey || !bucket) continue;
      const object = await bucket.get(paper.objectKey);
      if (!object) { skipped++; continue; }
      if (object.size > MAX_FILE_BYTES) { skipped++; continue; }
      await putFile(config, `${config.remotePath}/files/${paper.id}.pdf`, object.body, "application/pdf");
      files++;
      bytes += object.size;
    }

    const db = getDb();
    await db.update(userSettings).set({ syncLastBackupAt: snapshot.exportedAt, updatedAt: snapshot.exportedAt }).where(eq(userSettings.userId, user.id));
    return Response.json({ ok: true, papers: snapshot.papers.length, files, skipped, bytes });
  } catch (error) {
    return Response.json({ error: (error instanceof Error ? error.message : "") || "备份失败，请稍后重试" }, { status: 502 });
  }
}
