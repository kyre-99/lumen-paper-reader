// 旧版浏览器/WebView（Chrome <140）没有 Uint8Array 的 hex/base64 方法（ES2025 提案），
// 而 pdf.js 6 的指纹计算（worker 内 toHex）与内嵌文件解码（toBase64/fromBase64）依赖它们。
// applyUint8Polyfill 保持无闭包依赖、完全自包含：主线程直接调用；
// worker 是独立 JS 环境，靠 toString() 序列化后拼到 worker 源码前注入（见 pdfWorkerSrcWithPolyfill）。

declare global {
  interface Uint8Array {
    toHex?(): string;
    toBase64?(): string;
  }
  interface Uint8ArrayConstructor {
    fromBase64?(base64: string): Uint8Array;
  }
}

export function applyUint8Polyfill() {
  // Promise.withResolvers（Chrome 119+），pdf.js 6 的异步任务管理依赖
  const promiseCtor = Promise as unknown as { withResolvers?<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void } };
  if (!promiseCtor.withResolvers) {
    promiseCtor.withResolvers = function <T>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    };
  }
  if (!Uint8Array.prototype.toHex) {
    Uint8Array.prototype.toHex = function (this: Uint8Array) {
      let out = "";
      for (let i = 0; i < this.length; i++) out += this[i].toString(16).padStart(2, "0");
      return out;
    };
  }
  if (!Uint8Array.prototype.toBase64) {
    Uint8Array.prototype.toBase64 = function (this: Uint8Array) {
      let binary = "";
      // 分块转字符串，避免一次性展开大数组撑爆参数栈
      for (let i = 0; i < this.length; i += 0x8000) {
        binary += String.fromCharCode(...this.subarray(i, i + 0x8000));
      }
      return btoa(binary);
    };
  }
  if (!Uint8Array.fromBase64) {
    Uint8Array.fromBase64 = function (base64: string) {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    };
  }
  // Map/WeakMap 的 getOrInsert / getOrInsertComputed（ES2026 提案，约 Chrome 135+），
  // pdf.js 6 的缓存逻辑依赖；旧 WebView 没有会直接崩渲染（this[#t].getOrInsertComputed is not a function）
  for (const ctor of [Map, WeakMap]) {
    const proto = ctor.prototype as unknown as Record<string, unknown>;
    if (!proto.getOrInsert) {
      proto.getOrInsert = function (this: Pick<Map<unknown, unknown>, "has" | "get" | "set">, key: unknown, value: unknown) {
        if (this.has(key)) return this.get(key);
        this.set(key, value);
        return value;
      };
    }
    if (!proto.getOrInsertComputed) {
      proto.getOrInsertComputed = function (this: Pick<Map<unknown, unknown>, "has" | "get" | "set">, key: unknown, callback: (key: unknown) => unknown) {
        if (this.has(key)) return this.get(key);
        const value = callback(key);
        this.set(key, value);
        return value;
      };
    }
  }
}

let cachedWorkerSrc: string | null = null;

// 返回可用的 pdf.js worker 地址：内核够新直接用原文件；
// 老内核（如 Android WebView 138）把 polyfill 与 worker 源码拼成 Blob 再加载。
export async function pdfWorkerSrcWithPolyfill(rawWorkerUrl: string) {
  // 必须先探测原生支持、再打主线程补丁——顺序反了探测会永远为真，老内核就会拿到没补丁的 worker
  const mapProto = Map.prototype as unknown as Record<string, unknown>;
  const weakMapProto = WeakMap.prototype as unknown as Record<string, unknown>;
  const nativeSupported = Boolean(
    (Promise as unknown as Record<string, unknown>).withResolvers
    && Uint8Array.prototype.toHex && Uint8Array.prototype.toBase64 && Uint8Array.fromBase64
    && mapProto.getOrInsert && mapProto.getOrInsertComputed && weakMapProto.getOrInsert && weakMapProto.getOrInsertComputed,
  );
  applyUint8Polyfill();
  if (cachedWorkerSrc) return cachedWorkerSrc;
  if (nativeSupported) {
    cachedWorkerSrc = rawWorkerUrl;
    return cachedWorkerSrc;
  }
  const response = await fetch(rawWorkerUrl);
  const code = await response.text();
  cachedWorkerSrc = URL.createObjectURL(new Blob([`(${applyUint8Polyfill.toString()})();\n`, code], { type: "text/javascript" }));
  return cachedWorkerSrc;
}
