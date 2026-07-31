import { and, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getDb } from "../../../db";
import { paperFolders, papers, paperStates, readerStates, readingSessions } from "../../../db/schema";
import { sanitizeObjectKey } from "../../object-key";

// 全量备份快照（version 1），WebDAV 与本地导出共用
export type SyncSnapshot = {
  version: number;
  exportedAt: string;
  folders: Array<typeof paperFolders.$inferSelect>;
  papers: Array<typeof papers.$inferSelect>;
  paperStates: Array<typeof paperStates.$inferSelect>;
  // 旧快照没有该字段，恢复时按空数组处理
  readingSessions?: Array<typeof readingSessions.$inferSelect>;
};

// 校验远端/文件里的快照结构
export function isSyncSnapshot(value: unknown): value is SyncSnapshot {
  const snapshot = value as SyncSnapshot | null;
  return Boolean(snapshot && snapshot.version === 1 && Array.isArray(snapshot.papers) && Array.isArray(snapshot.folders) && Array.isArray(snapshot.paperStates) && (snapshot.readingSessions === undefined || Array.isArray(snapshot.readingSessions)));
}

// 组装该用户的全量快照
export async function buildSnapshot(userId: string): Promise<SyncSnapshot> {
  const db = getDb();
  const [folders, allPapers, allStates, allSessions] = await Promise.all([
    db.select().from(paperFolders).where(eq(paperFolders.userId, userId)),
    db.select().from(papers).where(eq(papers.userId, userId)),
    db.select().from(paperStates).where(eq(paperStates.userId, userId)),
    db.select().from(readingSessions).where(eq(readingSessions.userId, userId)),
  ]);
  return { version: 1, exportedAt: new Date().toISOString(), folders, papers: allPapers, paperStates: allStates, readingSessions: allSessions };
}

// 覆盖式恢复：先删本用户现有数据，再插入快照行（userId 一律换成本用户）
export async function restoreSnapshot(userId: string, snapshot: SyncSnapshot) {
  const db = getDb();
  const now = new Date().toISOString();
  const statements: BatchItem<"sqlite">[] = [
    db.delete(paperStates).where(eq(paperStates.userId, userId)),
    db.delete(readingSessions).where(eq(readingSessions.userId, userId)),
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
  // 论文按原 id 重新插入，readingSessions 的 paperId 与 paperStates 一样直接沿用
  for (const session of snapshot.readingSessions || []) {
    statements.push(db.insert(readingSessions).values({ ...session, id: String(session.id).slice(0, 64), paperId: String(session.paperId).slice(0, 64), userId }));
  }
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}

export type MergeSummary = {
  foldersAdded: number;
  papersAdded: number;
  papersUpdated: number;
  statesUpdated: number;
  sessionsAdded: number;
  // 行内容来自快照的论文 id（新增或快照更新胜出）：只有这些论文的 PDF 原件需要从备份写回，
  // 本地胜出的论文保持本地 PDF 不动
  restoredPaperIds: string[];
};

// 合并式恢复（last-write-wins）：快照与本地取并集，同一 id 冲突时按 updatedAt 较新者胜出；
// 同名文件夹归并为一个，避免重复；不删除任何本地数据
export async function mergeSnapshot(userId: string, snapshot: SyncSnapshot): Promise<MergeSummary> {
  const db = getDb();
  const now = new Date().toISOString();
  const ts = (value: unknown) => {
    const parsed = Date.parse(String(value || ""));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const [localFolders, localPapers, localStates, localSessions] = await Promise.all([
    db.select().from(paperFolders).where(eq(paperFolders.userId, userId)),
    db.select().from(papers).where(eq(papers.userId, userId)),
    db.select().from(paperStates).where(eq(paperStates.userId, userId)),
    db.select().from(readingSessions).where(eq(readingSessions.userId, userId)),
  ]);
  const statements: BatchItem<"sqlite">[] = [];
  const summary: MergeSummary = { foldersAdded: 0, papersAdded: 0, papersUpdated: 0, statesUpdated: 0, sessionsAdded: 0, restoredPaperIds: [] };

  // 文件夹：同 id 取新；没有同 id 但本地有同名文件夹时，映射到本地文件夹，避免重名重复
  const localFolderById = new Map(localFolders.map((folder) => [folder.id, folder]));
  const localFolderByName = new Map(localFolders.map((folder) => [folder.name, folder]));
  const folderIdMap = new Map<string, string>(); // 快照文件夹 id → 合并后的文件夹 id
  for (const folder of snapshot.folders) {
    const id = String(folder.id).slice(0, 64);
    const name = String(folder.name || "文件夹").slice(0, 200);
    const byId = localFolderById.get(id);
    if (byId) {
      folderIdMap.set(id, id);
      if (ts(folder.updatedAt) > ts(byId.updatedAt)) {
        statements.push(db.update(paperFolders).set({ name, updatedAt: String(folder.updatedAt || now) }).where(and(eq(paperFolders.id, id), eq(paperFolders.userId, userId))));
      }
      continue;
    }
    const byName = localFolderByName.get(name);
    if (byName) { folderIdMap.set(id, byName.id); continue; }
    folderIdMap.set(id, id);
    statements.push(db.insert(paperFolders).values({ ...folder, id, userId, name }));
    summary.foldersAdded++;
  }

  // 论文：新 id 直接并入；同 id 按 updatedAt 较新者胜出；folderId 按合并结果修正
  const localPaperById = new Map(localPapers.map((paper) => [paper.id, paper]));
  const mergedPaperIds = new Set(localPapers.map((paper) => paper.id));
  for (const paper of snapshot.papers) {
    const id = String(paper.id).slice(0, 64);
    const folderId = paper.folderId ? folderIdMap.get(String(paper.folderId)) ?? null : null;
    const objectKey = paper.objectKey ? await sanitizeObjectKey(userId, String(paper.objectKey)) : paper.objectKey;
    const values = { ...paper, id, userId, folderId, title: String(paper.title || "未命名论文").slice(0, 500), objectKey };
    mergedPaperIds.add(id);
    const local = localPaperById.get(id);
    if (!local) {
      statements.push(db.insert(papers).values(values));
      summary.papersAdded++;
      summary.restoredPaperIds.push(id);
      continue;
    }
    if (ts(paper.updatedAt) > ts(local.updatedAt)) {
      statements.push(db.update(papers).set(values).where(and(eq(papers.id, id), eq(papers.userId, userId))));
      summary.papersUpdated++;
      summary.restoredPaperIds.push(id);
    }
  }

  // 每篇论文的阅读状态（批注/对话/进度）按 paperId 独立取新；仅处理合并后存在的论文，防止外键悬空
  const localStateByPaper = new Map(localStates.map((state) => [state.paperId, state]));
  for (const state of snapshot.paperStates) {
    const paperId = String(state.paperId).slice(0, 64);
    if (!mergedPaperIds.has(paperId)) continue;
    const values = { ...state, paperId, userId };
    const local = localStateByPaper.get(paperId);
    if (!local) {
      statements.push(db.insert(paperStates).values(values));
      summary.statesUpdated++;
      continue;
    }
    if (ts(state.updatedAt) > ts(local.updatedAt)) {
      statements.push(db.update(paperStates).set(values).where(and(eq(paperStates.paperId, paperId), eq(paperStates.userId, userId))));
      summary.statesUpdated++;
    }
  }

  // 阅读时长会话按 id 合并，同 id 取 lastPingAt 较新者
  const localSessionById = new Map(localSessions.map((session) => [session.id, session]));
  for (const session of snapshot.readingSessions || []) {
    const id = String(session.id).slice(0, 64);
    const paperId = String(session.paperId).slice(0, 64);
    if (!mergedPaperIds.has(paperId)) continue;
    const values = { ...session, id, paperId, userId };
    const local = localSessionById.get(id);
    if (!local) {
      statements.push(db.insert(readingSessions).values(values));
      summary.sessionsAdded++;
      continue;
    }
    if (ts(session.lastPingAt) > ts(local.lastPingAt)) {
      statements.push(db.update(readingSessions).set(values).where(and(eq(readingSessions.id, id), eq(readingSessions.userId, userId))));
    }
  }

  if (statements.length) await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  return summary;
}
