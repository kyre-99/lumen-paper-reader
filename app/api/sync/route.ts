import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { userSettings } from "../../../db/schema";
import { DEFAULT_PROMPTS } from "../../chat-prompts";
import { encryptApiKey } from "../../model-config-crypto";
import { requireAppUser } from "../../server-user";
import { isAllowedEndpoint } from "./webdav";

export async function GET() {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const db = getDb();
  const [settings] = await db.select().from(userSettings).where(eq(userSettings.userId, user.id)).limit(1);
  // 绝不回传密码，只回 hasPassword
  return Response.json({
    configured: Boolean(settings?.syncEndpoint && settings.syncUsername && settings.syncPasswordEncrypted),
    endpoint: settings?.syncEndpoint || "",
    username: settings?.syncUsername || "",
    remotePath: settings?.syncRemotePath || "lumen-backup",
    hasPassword: Boolean(settings?.syncPasswordEncrypted),
    lastBackupAt: settings?.syncLastBackupAt || null,
  });
}

export async function PUT(request: Request) {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const payload = (await request.json()) as Record<string, unknown>;
  const endpoint = String(payload?.endpoint || "").trim().replace(/\/+$/, "").slice(0, 2000);
  const username = String(payload?.username || "").trim().slice(0, 500);
  const password = String(payload?.password || "").slice(0, 1000);
  const remotePath = String(payload?.remotePath || "").trim().replace(/^\/+|\/+$/g, "").slice(0, 500) || "lumen-backup";
  if (!endpoint || !isAllowedEndpoint(endpoint)) {
    return Response.json({ error: "WebDAV 地址必须是有效的 HTTPS 地址" }, { status: 400 });
  }
  if (!username) return Response.json({ error: "用户名不能为空" }, { status: 400 });
  const db = getDb();
  const [existing] = await db.select().from(userSettings).where(eq(userSettings.userId, user.id)).limit(1);
  // 密码留空表示保留旧值
  const syncPasswordEncrypted = password ? await encryptApiKey(password) : existing?.syncPasswordEncrypted || "";
  if (!syncPasswordEncrypted) return Response.json({ error: "首次配置需要填写密码" }, { status: 400 });
  const values = {
    userId: user.id,
    // 首次建行时补齐模型配置默认值，避免 not-null 约束失败
    globalSystemPrompt: existing?.globalSystemPrompt || DEFAULT_PROMPTS.global,
    inlineSystemPrompt: existing?.inlineSystemPrompt || DEFAULT_PROMPTS.inline,
    modelProvider: existing?.modelProvider || "OpenAI",
    modelEndpoint: existing?.modelEndpoint || "https://api.openai.com/v1",
    modelName: existing?.modelName || "gpt-4.1-mini",
    apiKeyEncrypted: existing?.apiKeyEncrypted || "",
    syncEndpoint: endpoint,
    syncUsername: username,
    syncPasswordEncrypted,
    syncRemotePath: remotePath,
    updatedAt: new Date().toISOString(),
  };
  await db.insert(userSettings).values(values).onConflictDoUpdate({ target: userSettings.userId, set: values });
  return Response.json({ saved: true, configured: true, endpoint, username, remotePath, hasPassword: true, lastBackupAt: existing?.syncLastBackupAt || null });
}
