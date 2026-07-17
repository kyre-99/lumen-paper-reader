import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  authSubject: text("auth_subject").unique(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const papers = sqliteTable("papers", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  meta: text("meta").notNull().default(""),
  sourceKind: text("source_kind", { enum: ["remote", "upload"] }).notNull(),
  sourceUrl: text("source_url"),
  objectKey: text("object_key"),
  paperText: text("paper_text").notNull().default(""),
  pageCount: integer("page_count").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

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
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const userSettings = sqliteTable("user_settings", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  globalSystemPrompt: text("global_system_prompt").notNull().default(""),
  inlineSystemPrompt: text("inline_system_prompt").notNull().default(""),
  modelProvider: text("model_provider").notNull().default("OpenAI"),
  modelEndpoint: text("model_endpoint").notNull().default("https://api.openai.com/v1"),
  modelName: text("model_name").notNull().default("gpt-4.1-mini"),
  apiKeyEncrypted: text("api_key_encrypted").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
