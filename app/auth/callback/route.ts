import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../supabase-auth";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  if (!code) return NextResponse.redirect(new URL("/?auth_error=登录链接无效或已过期", request.url));
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(new URL(`/?auth_error=${encodeURIComponent(error.message)}`, request.url));
  return NextResponse.redirect(new URL("/", request.url));
}
