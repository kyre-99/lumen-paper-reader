// R2 objectKey 统一格式：users/<userHash>/papers/<file>.pdf，上传与备份恢复共用
export async function shortUserHash(userId: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userId));
  return Array.from(new Uint8Array(digest)).slice(0, 10).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// 备份里的 objectKey 可能越权指向其他用户目录：合法的原样保留，否则重写为本用户目录下的新 key
export async function sanitizeObjectKey(userId: string, objectKey: string) {
  const prefix = `users/${await shortUserHash(userId)}/papers/`;
  const key = String(objectKey || "").slice(0, 500);
  if (key.startsWith(prefix)) return key;
  const tail = key.split("/").pop() || "";
  const safeTail = /^[A-Za-z0-9-]{1,80}\.pdf$/.test(tail) ? tail : `${crypto.randomUUID()}.pdf`;
  return `${prefix}${safeTail}`;
}
