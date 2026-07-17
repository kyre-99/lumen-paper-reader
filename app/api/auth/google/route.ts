import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient, requestOrigin } from "../../../supabase-auth";

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${requestOrigin(request)}/auth/callback` },
  });
  if (error || !data.url) return NextResponse.redirect(new URL(`/?auth_error=${encodeURIComponent(error?.message || "无法启动 Google 登录")}`, request.url));
  return NextResponse.redirect(data.url);
}
