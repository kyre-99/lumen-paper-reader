# 文枢浏览器扩展

打开网页 PDF 时不再直接跳转，而是先弹出让用户选择：在文枢阅读器解析，或直接查看原文件。

## 安装（Chrome / Edge）

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」，选择本目录（`extension/`）

需要 Chrome 128+（PDF 识别依赖响应头匹配）。

## 功能

- 选择性拦截：网页里点开 PDF（响应头 `Content-Type: application/pdf`，含 arXiv 这类无 `.pdf` 后缀的地址）时，先进入扩展的询问页，由你决定下一步
  - 「在文枢中打开」→ 跳转文枢解析阅读
  - 「直接查看原文件」→ 放行这一次导航，用浏览器自带查看器打开（适合需要登录、或无需解析的 PDF）
- 右键菜单：链接上右键 →「在文枢中打开此链接」（强制手动，不经过询问页）
- 点扩展图标：把当前标签页的地址直接送去文枢

## 实现说明

- PDF 识别由 `background.js` 里动态注册的 declarativeNetRequest 规则完成，命中后重定向到扩展内的 `redirect.html` 询问页。规则是动态注册的，因为重定向目标要包含扩展自身的 ID（`chrome.runtime.id`），静态 `rules.json` 写不了。
- 「直接查看原文件」通过临时加一条高优先级的 session `allow` 规则放行一次，避免导航回原始 PDF 时再次被拦截。

## 自托管

`background.js` 与 `redirect.js` 中的 `wenshupaper.online` 替换为你自己的部署地址（两处都要改）。应用侧通过 `?url=<PDF地址>` 深链打开论文。
