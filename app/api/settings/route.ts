import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { userSettings } from "../../../db/schema";
import { DEFAULT_PROMPTS } from "../../chat-prompts";
import { requireAppUser } from "../../server-user";

export async function GET() {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const db = getDb();
  const [settings] = await db.select().from(userSettings).where(eq(userSettings.userId, user.id)).limit(1);
  return Response.json({
    prompts: {
      global: settings?.globalSystemPrompt || DEFAULT_PROMPTS.global,
      inline: settings?.inlineSystemPrompt || DEFAULT_PROMPTS.inline,
    },
  });
}

export async function PUT(request: Request) {
  const user = await requireAppUser();
  if (!user) return Response.json({ error: "需要登录" }, { status: 401 });
  const payload = await request.json() as any;
  const globalSystemPrompt = String(payload?.prompts?.global || "").trim().slice(0, 12000);
  const inlineSystemPrompt = String(payload?.prompts?.inline || "").trim().slice(0, 12000);
  if (!globalSystemPrompt || !inlineSystemPrompt) return Response.json({ error: "两处 System Prompt 都不能为空" }, { status: 400 });
  const db = getDb();
  const values = { userId: user.id, globalSystemPrompt, inlineSystemPrompt, updatedAt: new Date().toISOString() };
  await db.insert(userSettings).values(values).onConflictDoUpdate({ target: userSettings.userId, set: values });
  return Response.json({ saved: true, prompts: { global: globalSystemPrompt, inline: inlineSystemPrompt } });
}
