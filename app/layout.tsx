import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const incoming = await headers();
  const host = incoming.get("x-forwarded-host") || incoming.get("host") || "localhost:3000";
  const protocol = incoming.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  return {
    title: "文枢 Wenshu",
    description: "打开、理解并与每一篇研究论文对话。支持局部翻译、选区解释与自定义 AI 模型。",
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: {
      title: "文枢 Wenshu",
      description: "读深每一篇论文，随时追问。",
      images: [{ url: `${origin}/og.png`, width: 800, height: 420, alt: "文枢 Wenshu AI research reader" }],
    },
    twitter: { card: "summary_large_image", title: "文枢 Wenshu", description: "读深每一篇论文，随时追问。", images: [`${origin}/og.png`] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
