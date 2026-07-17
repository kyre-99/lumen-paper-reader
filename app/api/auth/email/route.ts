import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../supabase-auth";

export async function POST(request: NextRequest) {
  const payload = await request.json().catch(() => ({})) as { email?: string };
  const email = String(payload.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return NextResponse.json({ error: "请输入有效邮箱" }, { status: 400 });
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ sent: true });
}
