import { desc, eq, max } from "drizzle-orm";
import { getDb } from "../../../db";
import { paperFolders, papers, readingSessions } from "../../../db/schema";
import { requireAppUser } from "../../server-user";
import { extractArxivId, fetchArxivMeta } from "./arxiv-meta";

// reading_sessions.lastPingAt 是 CURRENT_TIMESTAMP 格式（UTC "YYYY-MM-DD HH:MM:SS"），规范成 ISO 便于前端解析
function toIso(value: string | null): string | null {
  return value ? `${value.replace(" ", "T")}Z` : null;
}

export async function GET() {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const db = getDb();
  const [library, folders, lastReads] = await Promise.all([
    db.select({
      id: papers.id,
      folderId: papers.folderId,
      title: papers.title,
      meta: papers.meta,
      authors: papers.authors,
      publishedAt: papers.publishedAt,
      metaCheckedAt: papers.metaCheckedAt,
      sourceKind: papers.sourceKind,
      sourceUrl: papers.sourceUrl,
      pageCount: papers.pageCount,
      status: papers.status,
      rating: papers.rating,
      createdAt: papers.createdAt,
      updatedAt: papers.updatedAt,
    }).from(papers).where(eq(papers.userId, user.id)).orderBy(desc(papers.updatedAt)).limit(500),
    db.select({
      id: paperFolders.id,
      name: paperFolders.name,
      parentId: paperFolders.parentId,
      createdAt: paperFolders.createdAt,
      updatedAt: paperFolders.updatedAt,
    }).from(paperFolders).where(eq(paperFolders.userId, user.id)).orderBy(desc(paperFolders.updatedAt)).limit(100),
    db.select({ paperId: readingSessions.paperId, lastReadAt: max(readingSessions.lastPingAt) })
      .from(readingSessions).where(eq(readingSessions.userId, user.id)).groupBy(readingSessions.paperId),
  ]);
  const lastReadByPaperId = new Map(lastReads.map((row) => [row.paperId, toIso(row.lastReadAt)]));

  // 存量回填：远程 arXiv 论文且 publishedAt 未知且没查过时，一次批量抓取。
  // 请求成功（metaMap 非 null）：命中行写 authors/publishedAt + metaCheckedAt，未命中行也写 metaCheckedAt（arXiv 上确实没有，不再重试）；
  // 整体失败（null）：什么都不写，下次打开文库重试。失败静默。
  const pending = library
    .map((paper, index) => ({ paper, index, arxivId: paper.sourceKind === "remote" && !paper.publishedAt && !paper.metaCheckedAt ? extractArxivId(paper.sourceUrl || "") : null }))
    .filter((item): item is { paper: (typeof library)[number]; index: number; arxivId: string } => item.arxivId !== null);
  if (pending.length > 0) {
    const metaMap = await fetchArxivMeta(pending.map((item) => item.arxivId));
    if (metaMap !== null) {
      const checkedAt = new Date().toISOString();
      const hits = pending
        .map((item) => ({ ...item, meta: metaMap.get(item.arxivId) }))
        .filter((item): item is typeof item & { meta: NonNullable<typeof item.meta> } => Boolean(item.meta));
      await Promise.all(pending.map((item) => {
        const meta = metaMap.get(item.arxivId);
        return db.update(papers)
          .set(meta ? { authors: meta.authors, publishedAt: meta.publishedAt, metaCheckedAt: checkedAt } : { metaCheckedAt: checkedAt })
          .where(eq(papers.id, item.paper.id));
      }));
      for (const hit of hits) {
        library[hit.index] = { ...hit.paper, authors: hit.meta.authors, publishedAt: hit.meta.publishedAt, metaCheckedAt: checkedAt };
      }
    }
  }

  // 带上每篇论文的"上次阅读时间"（从未读过为 null），并按 最近阅读 ?? 更新时间 ?? 创建时间 倒序排
  const result = library.map((paper) => {
    const { metaCheckedAt: _metaCheckedAt, ...rest } = paper;
    void _metaCheckedAt;
    return { ...rest, lastReadAt: lastReadByPaperId.get(paper.id) ?? null };
  });
  const stamp = (paper: (typeof result)[number]) => Date.parse(paper.lastReadAt || paper.updatedAt || paper.createdAt) || 0;
  result.sort((a, b) => stamp(b) - stamp(a));
  return Response.json({ papers: result, folders });
}
