import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../supabase-auth";
import { isEmailAllowed } from "../../api/auth/access";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  if (!code) return NextResponse.redirect(new URL("/?auth_error=登录链接无效或已过期", request.url));
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(new URL(`/?auth_error=${encodeURIComponent(error.message)}`, request.url));
  // 邮箱白名单：OAuth/确认链接登录成功后复核，不在名单内立即登出
  const { data } = await supabase.auth.getUser();
  if (data.user?.email && !isEmailAllowed(data.user.email)) {
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL(`/?auth_error=${encodeURIComponent("该邮箱没有访问权限")}`, request.url));
  }
  return NextResponse.redirect(new URL("/", request.url));
}
