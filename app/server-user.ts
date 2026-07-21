import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { users } from "../db/schema";
import { getGuestSessionId } from "./guest-session";
import { getSupabaseUser } from "./supabase-auth";

export type AppUser = { id: string; email: string; displayName: string; fullName: string | null; isGuest: boolean; isLocal?: boolean };

function isLocalOnly() {
  const runtime = env as any;
  return String(runtime.LOCAL_ONLY || process.env.LOCAL_ONLY || "").toLowerCase() === "true";
}

export async function requireAppUser(): Promise<AppUser | null> {
  if (isLocalOnly()) {
    const db = getDb();
    const id = "local:lumen-paper";
    const email = "local@lumen.paper";
    await db.insert(users).values({ id, email, displayName: "本地用户" }).onConflictDoNothing();
    return { id, email, displayName: "本地用户", fullName: null, isGuest: false, isLocal: true };
  }
  const authUser = await getSupabaseUser();
  const email = authUser?.email?.trim().toLowerCase();
  if (!authUser || !email) {
    const guestId = await getGuestSessionId();
    if (!guestId) return null;
    const db = getDb();
    const guestEmail = `${guestId.replace(":", "+")}@guest.lumen.local`;
    await db.insert(users).values({ id: guestId, email: guestEmail, displayName: "游客" }).onConflictDoNothing();
    return { id: guestId, email: "", displayName: "游客", fullName: null, isGuest: true };
  }

  const metadata = authUser.user_metadata || {};
  const fullName = String(metadata.full_name || metadata.name || "").trim() || null;
  const displayName = fullName || email.split("@")[0] || email;
  const db = getDb();

  const [bySubject] = await db.select().from(users).where(eq(users.authSubject, authUser.id)).limit(1);
  if (bySubject) {
    // 已存在用户不必每个请求都写库：仅在资料变化或超过一天未触碰时更新
    // （updatedAt 可能是 new Date().toISOString()，也可能是 SQLite CURRENT_TIMESTAMP 默认值）
    const lastTouchedAt = bySubject.updatedAt ? Date.parse(bySubject.updatedAt.includes("T") ? bySubject.updatedAt : `${bySubject.updatedAt.replace(" ", "T")}Z`) : NaN;
    const stale = !Number.isFinite(lastTouchedAt) || Date.now() - lastTouchedAt > 24 * 60 * 60 * 1000;
    if (bySubject.email !== email || bySubject.displayName !== displayName || stale) {
      await db.update(users).set({ email, displayName, updatedAt: new Date().toISOString() }).where(eq(users.id, bySubject.id));
    }
    return { id: bySubject.id, email, displayName, fullName, isGuest: false };
  }

  const [byEmail] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (byEmail) {
    await db.update(users).set({ authSubject: authUser.id, displayName, updatedAt: new Date().toISOString() }).where(eq(users.id, byEmail.id));
    return { id: byEmail.id, email, displayName, fullName, isGuest: false };
  }

  await db.insert(users).values({ id: authUser.id, authSubject: authUser.id, email, displayName });
  return { id: authUser.id, email, displayName, fullName, isGuest: false };
}
