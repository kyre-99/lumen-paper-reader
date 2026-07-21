import { eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getDb } from "../../../db";
import { paperFolders, papers, paperStates, readerStates } from "../../../db/schema";
import { sanitizeObjectKey } from "../../object-key";

// 全量备份快照（version 1），WebDAV 与本地导出共用
export type SyncSnapshot = {
  version: number;
  exportedAt: string;
  folders: Array<typeof paperFolders.$inferSelect>;
  papers: Array<typeof papers.$inferSelect>;
  paperStates: Array<typeof paperStates.$inferSelect>;
};

// 校验远端/文件里的快照结构
export function isSyncSnapshot(value: unknown): value is SyncSnapshot {
  const snapshot = value as SyncSnapshot | null;
  return Boolean(snapshot && snapshot.version === 1 && Array.isArray(snapshot.papers) && Array.isArray(snapshot.folders) && Array.isArray(snapshot.paperStates));
}

// 组装该用户的全量快照
export async function buildSnapshot(userId: string): Promise<SyncSnapshot> {
  const db = getDb();
  const [folders, allPapers, allStates] = await Promise.all([
    db.select().from(paperFolders).where(eq(paperFolders.userId, userId)),
    db.select().from(papers).where(eq(papers.userId, userId)),
    db.select().from(paperStates).where(eq(paperStates.userId, userId)),
  ]);
  return { version: 1, exportedAt: new Date().toISOString(), folders, papers: allPapers, paperStates: allStates };
}

// 覆盖式恢复：先删本用户现有数据，再插入快照行（userId 一律换成本用户）
export async function restoreSnapshot(userId: string, snapshot: SyncSnapshot) {
  const db = getDb();
  const now = new Date().toISOString();
  const statements: BatchItem<"sqlite">[] = [
    db.delete(paperStates).where(eq(paperStates.userId, userId)),
    db.delete(papers).where(eq(papers.userId, userId)),
    db.delete(paperFolders).where(eq(paperFolders.userId, userId)),
    db.update(readerStates).set({ activePaperId: null, updatedAt: now }).where(eq(readerStates.userId, userId)),
  ];
  for (const folder of snapshot.folders) {
    statements.push(db.insert(paperFolders).values({ ...folder, id: String(folder.id).slice(0, 64), userId, name: String(folder.name || "文件夹").slice(0, 200) }));
  }
  for (const paper of snapshot.papers) {
    // 备份里的 objectKey 可能指向他人目录，统一重写为本用户目录下的合法 key
    const objectKey = paper.objectKey ? await sanitizeObjectKey(userId, String(paper.objectKey)) : paper.objectKey;
    statements.push(db.insert(papers).values({ ...paper, id: String(paper.id).slice(0, 64), userId, title: String(paper.title || "未命名论文").slice(0, 500), objectKey }));
  }
  for (const state of snapshot.paperStates) {
    statements.push(db.insert(paperStates).values({ ...state, paperId: String(state.paperId).slice(0, 64), userId }));
  }
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}
