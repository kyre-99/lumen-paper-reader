import { requireAppUser } from "../../server-user";

export async function GET() {
  const user = await requireAppUser();
  if (!user) {
    return Response.json({ authenticated: false }, { status: 401 });
  }
  return Response.json({ authenticated: true, user });
}
