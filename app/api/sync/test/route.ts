import { requireAppUser } from "../../../server-user";
import { loadSyncConfig } from "../config";
import { isAllowedEndpoint, propfind, type SyncConfig } from "../webdav";

export async function POST(request: Request) {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  // 未提供的字段回落到已保存配置
  const saved = await loadSyncConfig(user.id);
  const endpoint = String(payload?.endpoint || saved?.endpoint || "").trim().replace(/\/+$/, "").slice(0, 2000);
  const config: SyncConfig = {
    endpoint,
    username: String(payload?.username || saved?.username || "").trim().slice(0, 500),
    password: payload?.password ? String(payload.password).slice(0, 1000) : saved?.password || "",
    remotePath: String(payload?.remotePath || saved?.remotePath || "lumen-backup").trim().slice(0, 500),
  };
  if (!endpoint || !isAllowedEndpoint(endpoint)) return Response.json({ ok: false, error: "WebDAV 地址必须是有效的 HTTPS 地址" });
  if (!config.username || !config.password) return Response.json({ ok: false, error: "请先填写用户名和密码" });
  const startedAt = Date.now();
  try {
    const status = await propfind(config);
    if (status === 401 || status === 403) return Response.json({ ok: false, error: "认证失败，请检查用户名和密码" });
    if (status >= 400) return Response.json({ ok: false, error: `服务器返回 HTTP ${status}` });
    return Response.json({ ok: true, latencyMs: Date.now() - startedAt });
  } catch (error) {
    return Response.json({ ok: false, error: (error instanceof Error ? error.message : "") || "无法连接到 WebDAV 服务器" });
  }
}
