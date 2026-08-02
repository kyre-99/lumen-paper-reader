// 文枢阅读器地址（自托管用户改成自己的部署地址即可）
const READER_URL = "https://wenshupaper.online/";

function openInReader(targetUrl) {
  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) return;
  chrome.tabs.create({ url: `${READER_URL}?url=${encodeURIComponent(targetUrl)}` });
}

// 右键菜单兜底：强制下载等拦截漏网场景，手动把链接送去文枢
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "open-in-wenshu",
    title: "在文枢中打开此链接",
    contexts: ["link"],
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "open-in-wenshu") openInReader(info.linkUrl);
});

// 点击扩展图标：把当前标签页（比如 Chrome 内置 PDF 查看器里的文档）送去文枢
chrome.action.onClicked.addListener((tab) => {
  openInReader(tab && tab.url);
});
