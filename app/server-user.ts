import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { users } from "../db/schema";
import { getSupabaseUser } from "./supabase-auth";

export type AppUser = { id: string; email: string; displayName: string; fullName: string | null };

export async function requireAppUser(): Promise<AppUser | null> {
  const authUser = await getSupabaseUser();
  const email = authUser?.email?.trim().toLowerCase();
  if (!authUser || !email) return null;

  const metadata = authUser.user_metadata || {};
  const fullName = String(metadata.full_name || metadata.name || "").trim() || null;
  const displayName = fullName || email.split("@")[0] || email;
  const db = getDb();

  const [bySubject] = await db.select().from(users).where(eq(users.authSubject, authUser.id)).limit(1);
  if (bySubject) {
    await db.update(users).set({ email, displayName, updatedAt: new Date().toISOString() }).where(eq(users.id, bySubject.id));
    return { id: bySubject.id, email, displayName, fullName };
  }

  const [byEmail] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (byEmail) {
    await db.update(users).set({ authSubject: authUser.id, displayName, updatedAt: new Date().toISOString() }).where(eq(users.id, byEmail.id));
    return { id: byEmail.id, email, displayName, fullName };
  }

  await db.insert(users).values({ id: authUser.id, authSubject: authUser.id, email, displayName });
  return { id: authUser.id, email, displayName, fullName };
}
