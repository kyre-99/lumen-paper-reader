// 最小化 Service Worker：仅用于满足 PWA 可安装条件。
// 不拦截、不缓存任何请求 —— 本应用依赖本地服务运行，离线无意义，
// 缓存只会带来陈旧数据风险。空 fetch 监听是 Chrome 可安装性检查的要求。
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {
  // 故意留空：不调用 respondWith，所有请求照常走网络。
});
