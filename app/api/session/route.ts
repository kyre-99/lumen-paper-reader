import { getChatGPTUser, chatGPTSignInPath, chatGPTSignOutPath } from "../../chatgpt-auth";
import { getDb } from "../../../db";
import { users } from "../../../db/schema";

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) {
    return Response.json({ authenticated: false, signInUrl: chatGPTSignInPath("/") }, { status: 401 });
  }

  const db = getDb();
  await db.insert(users).values({
    id: user.email,
    email: user.email,
    displayName: user.displayName,
  }).onConflictDoUpdate({
    target: users.id,
    set: { displayName: user.displayName, updatedAt: new Date().toISOString() },
  });

  return Response.json({
    authenticated: true,
    user,
    signOutUrl: chatGPTSignOutPath("/"),
  });
}
