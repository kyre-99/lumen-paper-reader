declare module "*?url" {
  const url: string;
  export default url;
}

declare module "cloudflare:workers" {
  export const env: Record<string, any>;
}

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface D1Database {}

interface R2ObjectBody {
  body: ReadableStream<Uint8Array>;
  size: number;
  httpEtag: string;
}

interface R2Bucket {
  put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
}
