import { NextRequest, NextResponse } from "next/server";
import { requireAppUser } from "../../server-user";

const MAX_PDF_BYTES = 60 * 1024 * 1024;
const MAX_REDIRECTS = 5;

// SSRF 防护：arxiv 白名单直接放行；其余主机名若是内网/保留 IP 字面量则拒绝，公网域名放行
function isAllowedHost(hostname: string) {
  const host = hostname.toLowerCase();
  if (host === "arxiv.org" || host.endsWith(".arxiv.org")) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host === "[::1]" || host === "[::]" || host.startsWith("[fe80:")) return false;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
  }
  return true;
}

export async function GET(request: NextRequest) {
  const user = await requireAppUser();
  if (!user) return NextResponse.json({ error: "需要登录" }, { status: 401 });
  const raw = request.nextUrl.searchParams.get("url");
  if (!raw) return NextResponse.json({ error: "缺少论文地址" }, { status: 400 });
  let url: URL;
  try { url = new URL(raw); } catch { return NextResponse.json({ error: "无效地址" }, { status: 400 }); }
  if (url.protocol !== "https:") return NextResponse.json({ error: "仅支持 HTTPS 地址" }, { status: 400 });
  if (!isAllowedHost(url.hostname)) return NextResponse.json({ error: "不允许访问该地址" }, { status: 403 });
  try {
    // 手动跟随重定向（最多 5 跳）：每一跳重新校验协议与主机，防止 302 跳到内网/元数据地址
    let current = url;
    let response: Response | undefined;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      response = await fetch(current.toString(), { headers: { "User-Agent": "WenshuPaper/1.0" }, redirect: "manual" });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      if (!location) break;
      if (hop === MAX_REDIRECTS) return NextResponse.json({ error: "重定向次数过多" }, { status: 502 });
      let next: URL;
      try { next = new URL(location, current); } catch { return NextResponse.json({ error: "论文源站返回无效重定向" }, { status: 502 }); }
      if (next.protocol !== "https:" || !isAllowedHost(next.hostname)) return NextResponse.json({ error: "不允许访问该地址" }, { status: 403 });
      current = next;
    }
    if (!response) return NextResponse.json({ error: "无法获取该论文，请尝试上传 PDF" }, { status: 502 });
    if (!response.ok) return NextResponse.json({ error: `论文源站返回 ${response.status}` }, { status: 502 });
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_PDF_BYTES) return NextResponse.json({ error: "PDF 超过 60MB" }, { status: 413 });
    // 流式读取并硬截断：不再只信 content-length，超过 60MB 立即取消
    const reader = response.body?.getReader();
    if (!reader) return NextResponse.json({ error: "无法获取该论文，请尝试上传 PDF" }, { status: 502 });
    const chunks: Uint8Array[] = [];
    let total = 0;
    let tooLarge = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PDF_BYTES) { tooLarge = true; await reader.cancel(); break; }
      chunks.push(value);
    }
    if (tooLarge) return NextResponse.json({ error: "PDF 超过 60MB" }, { status: 413 });
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return new NextResponse(data.buffer as ArrayBuffer, { headers: { "Content-Type": "application/pdf", "Cache-Control": "private, max-age=3600", "Content-Length": String(data.byteLength) } });
  } catch { return NextResponse.json({ error: "无法获取该论文，请尝试上传 PDF" }, { status: 502 }); }
}
