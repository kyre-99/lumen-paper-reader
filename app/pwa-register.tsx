"use client";

import { useEffect } from "react";

// 注册最小化 Service Worker（public/sw.js），使应用可被浏览器安装为 PWA。
// 注册失败不影响任何功能，仅在控制台提示。
export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.warn("Service Worker 注册失败：", error);
    });
  }, []);

  return null;
}
