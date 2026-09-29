import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { paperFolders, papers } from "../../../../db/schema";
import { requireAppUser } from "../../../server-user";
import { extractArxivId, fetchArxivMeta } from "../arxiv-meta";

// 与前端 normalizePaperUrl 同一规则：arXiv abs/html/pdf 统一成 pdf 链接，作为去重键
function normalizePaperUrl(raw: string) {
  const trimmed = raw.trim();
  const arxiv = trimmed.match(/arxiv\.org\/(?:abs|html|pdf)\/([^?#/]+)/i);
  if (arxiv) return `https://arxiv.org/pdf/${arxiv[1]}`;
  return trimmed;
}

// 标题兜底：arXiv id 或 URL 文件名；都没有时用域名（标题会在首次打开解析后更新）
function fallbackTitle(url: string) {
  const arxivId = extractArxivId(url);
  if (arxivId) return `arXiv ${arxivId}`;
  try {
    const parsed = new URL(url);
    const name = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "").replace(/\.pdf$/i, "").trim();
    return name || parsed.hostname;
  } catch {
    return url.slice(0, 60);
  }
}

// 批量导入文献：只建记录不解析 PDF（首次打开时按现有流程解析正文）。
// 输入 { items: [{ url, title? }], folderId? }；按 sourceUrl 去重（含批次内重复），
// arXiv 链接顺手批量补标题/作者/发表日期——失败不阻塞，留给文库 GET 的存量回填重试
export async function POST(request: Request) {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  let body: { items?: Array<{ url?: unknown; title?: unknown }>; folderId?: unknown };
  try { body = await request.json(); } catch { return Response.json({ error: "请求格式不正确" }, { status: 400 }); }
  const seen = new Set<string>();
  const items = (Array.isArray(body.items) ? body.items : [])
    .map((item) => ({ url: normalizePaperUrl(String(item?.url ?? "")), title: String(item?.title ?? "").trim().slice(0, 300) }))
    .filter((item) => /^https?:\/\//i.test(item.url))
    .filter((item) => { if (seen.has(item.url)) return false; seen.add(item.url); return true; })
    .slice(0, 100);
  if (!items.length) return Response.json({ error: "没有可导入的链接" }, { status: 400 });

  const db = getDb();
  // 目标文件夹必须属于当前用户，否则按未分类处理
  let folderId: string | null = null;
  if (typeof body.folderId === "string" && body.folderId) {
    const owned = await db.select({ id: paperFolders.id }).from(paperFolders).where(eq(paperFolders.userId, user.id));
    if (owned.some((folder) => folder.id === body.folderId)) folderId = body.folderId;
  }

  const existing = await db.select({ sourceUrl: papers.sourceUrl }).from(papers).where(eq(papers.userId, user.id));
  const existingUrls = new Set(existing.map((row) => row.sourceUrl).filter(Boolean));
  const fresh = items.filter((item) => !existingUrls.has(item.url));
  const skipped = items.length - fresh.length;
  if (!fresh.length) return Response.json({ added: 0, skipped });

  // arXiv 元数据：标题缺失的也要补；整体失败（null）时静默跳过，metaCheckedAt 留空让文库回填重试
  const arxivIds = fresh.map((item) => extractArxivId(item.url)).filter((id): id is string => Boolean(id));
  const metaMap = arxivIds.length ? await fetchArxivMeta(arxivIds) : null;
  const checkedAt = metaMap ? new Date().toISOString() : "";

  // createdAt/updatedAt 走数据库默认值 CURRENT_TIMESTAMP，与现有记录格式保持一致
  const rows = fresh.map((item) => {
    const meta = metaMap?.get(extractArxivId(item.url) || "") ?? null;
    let hostname = "";
    try { hostname = new URL(item.url).hostname; } catch { /* 前面已校验过 URL */ }
    return {
      id: crypto.randomUUID(),
      userId: user.id,
      folderId,
      title: item.title || meta?.title || fallbackTitle(item.url),
      meta: hostname,
      authors: meta?.authors || "",
      publishedAt: meta?.publishedAt || "",
      metaCheckedAt: checkedAt,
      sourceKind: "remote" as const,
      sourceUrl: item.url,
    };
  });
  await db.insert(papers).values(rows);
  return Response.json({ added: rows.length, skipped });
}
