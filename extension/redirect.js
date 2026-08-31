// 与 background.js 保持同步，自托管时一起改
const READER_URL = "https://wenshupaper.online/";

// ?u= 后紧跟原始地址（由 DNR 正则替换写入，始终是唯一且第一个参数）。
// 不能交给 URLSearchParams：原始地址里的 & 会被当成参数分隔符而截断
const search = window.location.search;
const target = search.startsWith("?u=") ? search.slice(3) : "";
const valid = /^https?:\/\//i.test(target);

const urlEl = document.getElementById("url");
const readerBtn = document.getElementById("open-reader");
const originalBtn = document.getElementById("open-original");

if (!valid) {
  urlEl.textContent = "链接无效或已丢失，请关闭本页。";
  readerBtn.disabled = true;
  originalBtn.disabled = true;
} else {
  let host = "";
  try {
    host = new URL(target).hostname;
  } catch {
    /* 保留空串 */
  }
  urlEl.textContent = host ? `${host} 的 PDF 文档` : "PDF 文档";
  urlEl.title = target;

  readerBtn.addEventListener("click", () => {
    readerBtn.disabled = true;
    originalBtn.disabled = true;
    window.location.replace(`${READER_URL}?url=${encodeURIComponent(target)}`);
  });

  originalBtn.addEventListener("click", () => {
    readerBtn.disabled = true;
    originalBtn.disabled = true;
    // background 会加一条一次性 allow 规则，再把当前标签页导航到原文件
    chrome.runtime.sendMessage({ type: "open-original", url: target });
  });
}
