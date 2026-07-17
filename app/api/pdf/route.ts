import { NextRequest, NextResponse } from "next/server";
import { getChatGPTUser, chatGPTSignInPath } from "../../chatgpt-auth";

export async function GET(request: NextRequest) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "需要登录", signInUrl: chatGPTSignInPath("/") }, { status: 401 });
  const raw = request.nextUrl.searchParams.get("url");
  if (!raw) return NextResponse.json({ error: "缺少论文地址" }, { status: 400 });
  let url: URL;
  try { url = new URL(raw); } catch { return NextResponse.json({ error: "无效地址" }, { status: 400 }); }
  if (url.protocol !== "https:") return NextResponse.json({ error: "仅支持 HTTPS 地址" }, { status: 400 });
  try {
    const response = await fetch(url.toString(), { headers: { "User-Agent": "LumenPaper/1.0" }, redirect: "follow" });
    if (!response.ok) return NextResponse.json({ error: `论文源站返回 ${response.status}` }, { status: 502 });
    const length = Number(response.headers.get("content-length") || 0);
    if (length > 60 * 1024 * 1024) return NextResponse.json({ error: "PDF 超过 60MB" }, { status: 413 });
    const data = await response.arrayBuffer();
    return new NextResponse(data, { headers: { "Content-Type": "application/pdf", "Cache-Control": "public, max-age=3600", "Content-Length": String(data.byteLength) } });
  } catch { return NextResponse.json({ error: "无法获取该论文，请尝试上传 PDF" }, { status: 502 }); }
}
