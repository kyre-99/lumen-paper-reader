import { env } from "cloudflare:workers";
import { cookies } from "next/headers";

const COOKIE_NAME = "lumen_guest";
const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function getSecret() {
  const runtime = env as any;
  const secret = runtime.GUEST_SESSION_SECRET || process.env.GUEST_SESSION_SECRET;
  if (!secret || String(secret).length < 32) throw new Error("Guest sessions are not configured");
  return String(secret);
}

async function signingKey() {
  return crypto.subtle.importKey("raw", encoder.encode(getSecret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function sign(id: string) {
  const signature = await crypto.subtle.sign("HMAC", await signingKey(), encoder.encode(id));
  return base64Url(new Uint8Array(signature));
}

export async function createGuestSession() {
  const id = `guest:${crypto.randomUUID()}`;
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, `${id}.${await sign(id)}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "development",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return id;
}

export async function getGuestSessionId() {
  const value = (await cookies()).get(COOKIE_NAME)?.value;
  if (!value) return null;
  const separator = value.lastIndexOf(".");
  if (separator < 0) return null;
  const id = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!/^guest:[0-9a-f-]{36}$/i.test(id)) return null;
  try {
    const valid = await crypto.subtle.verify("HMAC", await signingKey(), fromBase64Url(signature), encoder.encode(id));
    return valid ? id : null;
  } catch {
    return null;
  }
}

export async function clearGuestSession() {
  (await cookies()).delete(COOKIE_NAME);
}
