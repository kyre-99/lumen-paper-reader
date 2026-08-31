// 文枢阅读器地址（自托管用户改成自己的部署地址即可；redirect.html 里有一份同样的常量）
const READER_URL = "https://wenshupaper.online/";

const INTERCEPT_RULE_ID = 1; // PDF 拦截规则：重定向到扩展内的选择页
const SKIP_ONCE_RULE_ID = 2; // 「直接查看原文件」的一次性放行规则（避免拦截死循环）

function openInReader(targetUrl) {
  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) return;
  chrome.tabs.create({ url: `${READER_URL}?url=${encodeURIComponent(targetUrl)}` });
}

// 拦截规则用动态注册：重定向目标里要带扩展自己的 ID（chrome.runtime.id），静态 rules.json 写不了
function registerInterceptRule() {
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [INTERCEPT_RULE_ID],
    addRules: [
      {
        id: INTERCEPT_RULE_ID,
        priority: 1,
        action: {
          type: "redirect",
          redirect: {
            regexSubstitution: `chrome-extension://${chrome.runtime.id}/redirect.html?u=\\1`,
          },
        },
        // 响应头 Content-Type 为 PDF 的主文档请求（含 arXiv 这类无 .pdf 后缀的地址）
        condition: {
          regexFilter: "^(https?://.*)$",
          resourceTypes: ["main_frame"],
          responseHeaders: [{ header: "content-type", values: ["application/pdf*"] }],
        },
      },
    ],
  });
}

chrome.runtime.onInstalled.addListener(() => {
  registerInterceptRule();

  // 右键菜单兜底：拦截之外的手动入口
  chrome.contextMenus.create({
    id: "open-in-wenshu",
    title: "在文枢中打开此链接",
    contexts: ["link"],
  });
});

// 选择页点「直接查看原文件」时放行一次，否则导航回原始 PDF 会再次命中拦截规则
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "open-original" || !sender.tab) return false;
  (async () => {
    const target = String(message.url || "");
    if (!/^https?:\/\//i.test(target)) {
      sendResponse({ ok: false });
      return;
    }
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [SKIP_ONCE_RULE_ID],
      addRules: [
        {
          id: SKIP_ONCE_RULE_ID,
          priority: 2, // 高于拦截规则（priority 1），allow 优先生效
          action: { type: "allow" },
          condition: { regexFilter: `^${escaped}$`, resourceTypes: ["main_frame"] },
        },
      ],
    });
    await chrome.tabs.update(sender.tab.id, { url: target });
    // 放行只针对这一次导航，过后恢复拦截
    setTimeout(() => {
      chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [SKIP_ONCE_RULE_ID] });
    }, 10000);
    sendResponse({ ok: true });
  })();
  return true; // 保持消息通道，等待异步 sendResponse
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "open-in-wenshu") openInReader(info.linkUrl);
});

// 点击扩展图标：把当前标签页（比如 Chrome 内置 PDF 查看器里的文档）送去文枢
chrome.action.onClicked.addListener((tab) => {
  openInReader(tab && tab.url);
});
