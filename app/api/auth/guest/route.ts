import { createGuestSession } from "../../../guest-session";

export async function POST() {
  const id = await createGuestSession();
  return Response.json({ user: { id, displayName: "游客", email: "", fullName: null, isGuest: true } }, { status: 201 });
}
