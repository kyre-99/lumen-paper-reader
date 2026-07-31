import { requireAppUser } from "../../server-user";
import { isGuestDisabled, turnstileSiteKey } from "../auth/access";

export async function GET() {
  const user = await requireAppUser();
  if (!user) {
    return Response.json({ authenticated: false, guestDisabled: isGuestDisabled(), turnstileSiteKey: turnstileSiteKey() }, { status: 401 });
  }
  return Response.json({ authenticated: true, user });
}
