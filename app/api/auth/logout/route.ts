import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../supabase-auth";
import { clearGuestSession } from "../../../guest-session";

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  await clearGuestSession();
  return NextResponse.redirect(new URL("/", request.url));
}
