import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../../supabase-auth";

export async function POST(request: NextRequest) {
  const payload = await request.json().catch(() => ({})) as { email?: string; token?: string };
  const email = String(payload.email || "").trim().toLowerCase();
  const token = String(payload.token || "").replace(/\D/g, "").slice(0, 8);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || token.length < 6) {
    return NextResponse.json({ error: "请输入邮件中的验证码" }, { status: 400 });
  }
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.verifyOtp({ email, token, type: "email" });
  if (error || !data.user) return NextResponse.json({ error: error?.message || "验证码无效或已过期" }, { status: 400 });
  return NextResponse.json({ verified: true });
}
