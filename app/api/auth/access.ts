import { env } from "cloudflare:workers";

// 访问控制（通过 wrangler secret 配置，不进 Git、不影响本地开发）：
// ALLOWED_EMAILS：逗号分隔的邮箱白名单，设置后只有名单内邮箱能请求验证码/完成登录，
//   防止陌生人注册滥用配额；未设置则不限制（自托管默认开放）
// DISABLE_GUEST：为 "true" 时关闭游客模式，未登录访客只能看到登录页
function runtimeEnv() {
  return env as unknown as Record<string, string | undefined>;
}

export function isEmailAllowed(email: string) {
  const raw = String(runtimeEnv().ALLOWED_EMAILS || process.env.ALLOWED_EMAILS || "").toLowerCase();
  const list = raw.split(",").map((item) => item.trim()).filter(Boolean);
  if (!list.length) return true;
  return list.includes(email.trim().toLowerCase());
}

export function isGuestDisabled() {
  return String(runtimeEnv().DISABLE_GUEST || process.env.DISABLE_GUEST || "").toLowerCase() === "true";
}

// Cloudflare Turnstile 人机验证：配置 TURNSTILE_SECRET_KEY 后，发验证码等敏感接口
// 必须携带前端 turnstile token；未配置则跳过校验（自托管默认不启用）
export function turnstileSiteKey() {
  return String(runtimeEnv().TURNSTILE_SITE_KEY || process.env.TURNSTILE_SITE_KEY || "");
}

export async function verifyTurnstile(token: string, ip: string | null) {
  const secret = String(runtimeEnv().TURNSTILE_SECRET_KEY || process.env.TURNSTILE_SECRET_KEY || "");
  if (!secret) return true; // 未配置不校验
  if (!token) return false;
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json() as { success?: boolean };
    return payload.success === true;
  } catch {
    return false;
  }
}
