import { createGuestSession } from "../../../guest-session";
import { isGuestDisabled } from "../access";

export async function POST() {
  if (isGuestDisabled()) return Response.json({ error: "游客模式已关闭，请用邮箱登录" }, { status: 403 });
  const id = await createGuestSession();
  return Response.json({ user: { id, displayName: "游客", email: "", fullName: null, isGuest: true } }, { status: 201 });
}
