# 文枢浏览器扩展

在网页中打开 PDF 时自动跳转到文枢阅读器。

## 安装（Chrome / Edge）

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」，选择本目录（`extension/`）

## 功能

- 自动拦截：网页里点开 PDF（响应头 `Content-Type: application/pdf`，含 arXiv 这类无 `.pdf` 后缀的地址）自动跳转到文枢解析
- 右键菜单：链接上右键 →「在文枢中打开此链接」
- 点扩展图标：把当前标签页的地址送去文枢

## 自托管

`background.js` 与 `rules.json` 中的 `wenshupaper.online` 替换为你自己的部署地址即可。应用侧通过 `?url=<PDF地址>` 深链打开论文。
