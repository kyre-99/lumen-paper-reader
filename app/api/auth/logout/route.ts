import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../supabase-auth";

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/", request.url));
}
