// 极简 WebDAV 客户端：Basic Auth + PROPFIND/MKCOL/PUT/GET
export type SyncConfig = {
  endpoint: string;
  username: string;
  password: string;
  remotePath: string;
};

const TIMEOUT_MS = 15000;

// 仅允许 https；本地开发放行 http://localhost / http://127.0.0.1
export function isAllowedEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint);
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) return true;
    return false;
  } catch {
    return false;
  }
}

function authHeaders(config: SyncConfig, extra?: Record<string, string>) {
  return {
    Authorization: `Basic ${btoa(`${config.username}:${config.password}`)}`,
    ...extra,
  };
}

function baseUrl(config: SyncConfig) {
  return config.endpoint.replace(/\/+$/, "");
}

// remotePath 可能含多级目录，需要逐级编码拼接
function encodePath(path: string) {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

async function request(method: string, url: string, config: SyncConfig, body?: BodyInit, extraHeaders?: Record<string, string>) {
  const response = await fetch(url, {
    method,
    headers: authHeaders(config, extraHeaders),
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return response;
}

// 验证连通性和凭证，返回 HTTP 状态码
export async function propfind(config: SyncConfig) {
  const response = await request("PROPFIND", baseUrl(config) + "/", config, undefined, { Depth: "0" });
  return response.status;
}

// 逐级创建目录（405 表示已存在，忽略）
export async function ensureDir(config: SyncConfig, path: string) {
  const segments = path.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current += `/${encodeURIComponent(segment)}`;
    const response = await request("MKCOL", baseUrl(config) + current + "/", config);
    if (!response.ok && response.status !== 405) throw new Error(`创建远程目录失败（HTTP ${response.status}）`);
  }
}

export async function putFile(config: SyncConfig, path: string, body: BodyInit, contentType = "application/octet-stream") {
  const response = await request("PUT", `${baseUrl(config)}/${encodePath(path)}`, config, body, { "Content-Type": contentType });
  if (!response.ok) throw new Error(`上传文件失败（HTTP ${response.status}）`);
  return response.status;
}

// 返回 null 表示远端不存在（404）
export async function getFile(config: SyncConfig, path: string) {
  const response = await request("GET", `${baseUrl(config)}/${encodePath(path)}`, config);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`下载文件失败（HTTP ${response.status}）`);
  return response;
}
