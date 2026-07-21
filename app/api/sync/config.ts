import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { userSettings } from "../../../db/schema";
import { decryptApiKey } from "../../model-config-crypto";
import type { SyncConfig } from "./webdav";

// 读取用户已保存的同步配置；未配置完整（缺地址/用户名/密码）时返回 null
export async function loadSyncConfig(userId: string): Promise<SyncConfig | null> {
  const db = getDb();
  const [settings] = await db.select().from(userSettings).where(eq(userSettings.userId, userId)).limit(1);
  if (!settings?.syncEndpoint || !settings.syncUsername || !settings.syncPasswordEncrypted) return null;
  const password = await decryptApiKey(settings.syncPasswordEncrypted);
  if (!password) return null;
  return {
    endpoint: settings.syncEndpoint,
    username: settings.syncUsername,
    password,
    remotePath: settings.syncRemotePath || "lumen-backup",
  };
}
