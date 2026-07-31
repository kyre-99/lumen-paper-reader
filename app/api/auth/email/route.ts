import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../supabase-auth";
import { isEmailAllowed, verifyTurnstile } from "../access";

export async function POST(request: NextRequest) {
  const payload = await request.json().catch(() => ({})) as { email?: string; turnstileToken?: string };
  const email = String(payload.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return NextResponse.json({ error: "请输入有效邮箱" }, { status: 400 });
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for");
  if (!(await verifyTurnstile(String(payload.turnstileToken || ""), ip))) {
    return NextResponse.json({ error: "人机验证未通过，请完成验证后重试" }, { status: 403 });
  }
  if (!isEmailAllowed(email)) return NextResponse.json({ error: "该邮箱没有访问权限" }, { status: 403 });
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ sent: true });
}
