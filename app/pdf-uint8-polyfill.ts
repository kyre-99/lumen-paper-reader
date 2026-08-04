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
}

let cachedWorkerSrc: string | null = null;

// 返回可用的 pdf.js worker 地址：内核够新直接用原文件；
// 老内核（如 Android WebView 138）把 polyfill 与 worker 源码拼成 Blob 再加载。
export async function pdfWorkerSrcWithPolyfill(rawWorkerUrl: string) {
  // 必须先探测原生支持、再打主线程补丁——顺序反了探测会永远为真，老内核就会拿到没补丁的 worker
  const nativeSupported = Boolean(Uint8Array.prototype.toHex && Uint8Array.prototype.toBase64 && Uint8Array.fromBase64);
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
