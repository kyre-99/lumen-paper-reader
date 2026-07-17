import { env } from "cloudflare:workers";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function configSecret() {
  const runtime = env as any;
  const secret = runtime.MODEL_CONFIG_SECRET || process.env.MODEL_CONFIG_SECRET || runtime.GUEST_SESSION_SECRET || process.env.GUEST_SESSION_SECRET;
  if (!secret || String(secret).length < 32) throw new Error("本地模型配置加密尚未就绪");
  return String(secret);
}

async function encryptionKey() {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(configSecret()));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptApiKey(apiKey: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(), encoder.encode(apiKey));
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptApiKey(value: string) {
  if (!value) return "";
  const [version, ivValue, encryptedValue] = value.split(".");
  if (version !== "v1" || !ivValue || !encryptedValue) return "";
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(ivValue) }, await encryptionKey(), base64ToBytes(encryptedValue));
  return decoder.decode(plaintext);
}
