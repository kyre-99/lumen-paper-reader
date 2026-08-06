import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  authSubject: text("auth_subject").unique(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const paperFolders = sqliteTable("paper_folders", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("paper_folders_user_id_idx").on(table.userId)]);

export const papers = sqliteTable("papers", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  folderId: text("folder_id").references(() => paperFolders.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  meta: text("meta").notNull().default(""),
  sourceKind: text("source_kind", { enum: ["remote", "upload"] }).notNull(),
  sourceUrl: text("source_url"),
  objectKey: text("object_key"),
  paperText: text("paper_text").notNull().default(""),
  pageCount: integer("page_count").notNull().default(1),
  status: text("status", { enum: ["unread", "reading", "done"] }).notNull().default("unread"),
  // 星级评分 0-5，0 表示未评分
  rating: integer("rating").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("papers_user_id_idx").on(table.userId)]);

export const readerStates = sqliteTable("reader_states", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  activePaperId: text("active_paper_id").references(() => papers.id, { onDelete: "set null" }),
  currentPage: integer("current_page").notNull().default(1),
  zoom: real("zoom").notNull().default(0.88),
  rightOpen: integer("right_open", { mode: "boolean" }).notNull().default(true),
  messagesJson: text("messages_json").notNull().default("[]"),
  annotationsJson: text("annotations_json").notNull().default("[]"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const paperStates = sqliteTable("paper_states", {
  paperId: text("paper_id").primaryKey().references(() => papers.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  currentPage: integer("current_page").notNull().default(1),
  zoom: real("zoom").notNull().default(0.88),
  rightOpen: integer("right_open", { mode: "boolean" }).notNull().default(true),
  messagesJson: text("messages_json").notNull().default("[]"),
  annotationsJson: text("annotations_json").notNull().default("[]"),
  conversationsJson: text("conversations_json").notNull().default("[]"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const readingSessions = sqliteTable("reading_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  paperId: text("paper_id").notNull().references(() => papers.id, { onDelete: "cascade" }),
  // 客户端本地日期 YYYY-MM-DD，按天聚合的分组键
  day: text("day").notNull(),
  startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  lastPingAt: text("last_ping_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  activeSeconds: integer("active_seconds").notNull().default(0),
  startPage: integer("start_page"),
  endPage: integer("end_page"),
}, (table) => [index("reading_sessions_user_paper_day_idx").on(table.userId, table.paperId, table.day)]);

// 语义索引：每篇论文一行。embeddingModel 或 textStamp（建索引时的 papers.updatedAt）不匹配即失效重建；
// status 标记 building/ready，doneCount 记录已写入的块数——中断后从断点续建，不整批重来
export const paperIndexes = sqliteTable("paper_indexes", {
  paperId: text("paper_id").primaryKey().references(() => papers.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  embeddingModel: text("embedding_model").notNull().default(""),
  textStamp: text("text_stamp").notNull().default(""),
  chunkCount: integer("chunk_count").notNull().default(0),
  status: text("status", { enum: ["building", "ready"] }).notNull().default("ready"),
  doneCount: integer("done_count").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("paper_indexes_user_id_idx").on(table.userId)]);

// 语义索引的分块向量：chunkId 与 chunkPaper 的确定性分块结果一一对应，向量存 base64 编码的 Float32
export const paperChunks = sqliteTable("paper_chunks", {
  paperId: text("paper_id").notNull().references(() => papers.id, { onDelete: "cascade" }),
  chunkId: integer("chunk_id").notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  page: integer("page").notNull().default(1),
  vector: text("vector").notNull().default(""),
}, (table) => [primaryKey({ columns: [table.paperId, table.chunkId] }), index("paper_chunks_user_id_idx").on(table.userId)]);

export const llmUsage = sqliteTable("llm_usage", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  model: text("model").notNull().default(""),
  mode: text("mode", { enum: ["global", "inline"] }).notNull().default("global"),
  effort: text("effort", { enum: ["medium", "high", "max"] }).notNull().default("medium"),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("llm_usage_user_id_idx").on(table.userId)]);

export const userSettings = sqliteTable("user_settings", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  globalSystemPrompt: text("global_system_prompt").notNull().default(""),
  inlineSystemPrompt: text("inline_system_prompt").notNull().default(""),
  modelProvider: text("model_provider").notNull().default("OpenAI"),
  modelEndpoint: text("model_endpoint").notNull().default("https://api.openai.com/v1"),
  modelName: text("model_name").notNull().default("gpt-4.1-mini"),
  apiKeyEncrypted: text("api_key_encrypted").notNull().default(""),
  // 图表理解模型（多模态）：留空表示回退到主模型配置
  visionModelEndpoint: text("vision_model_endpoint").notNull().default(""),
  visionModelName: text("vision_model_name").notNull().default(""),
  visionApiKeyEncrypted: text("vision_api_key_encrypted").notNull().default(""),
  // 语义检索模型（Embedding）：模型名留空表示关闭语义检索；endpoint/key 留空回退主模型配置
  embeddingModelEndpoint: text("embedding_model_endpoint").notNull().default(""),
  embeddingModelName: text("embedding_model_name").notNull().default(""),
  embeddingApiKeyEncrypted: text("embedding_api_key_encrypted").notNull().default(""),
  syncEndpoint: text("sync_endpoint").notNull().default(""),
  syncUsername: text("sync_username").notNull().default(""),
  syncPasswordEncrypted: text("sync_password_encrypted").notNull().default(""),
  syncRemotePath: text("sync_remote_path").notNull().default("lumen-backup"),
  syncLastBackupAt: text("sync_last_backup_at"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
