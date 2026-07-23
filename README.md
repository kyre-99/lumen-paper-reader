# 文枢 Wenshu

文枢（Wenshu）是一个本地优先的 AI 论文阅读器。它可以打开 arXiv 等网站的 PDF 或本地论文，在原文旁完成翻译、解释、追问、高亮和批注，并保存文库、阅读位置与对话记录。

![文枢 Wenshu 界面](public/og.png)

## 功能

- 打开 arXiv PDF 链接或上传本地 PDF
- PDF 文本层解析与精确跨行选择
- 选中文本后翻译、解释、连续追问或多色高亮
- 原文旁可拖动的 AI 卡片与批注标记
- 公式区域识别与公式解释入口
- 框选图表区域截图问答（多模态），可单独配置图表理解模型
- 点击正文 [n] 引用弹出参考文献卡片，一键跳转并高亮原文
- 阅读统计：本周时长柱状图、连续天数、在读论文进度
- 全文 AI 多轮对话，支持 Markdown 与 LaTeX 公式渲染，SSE 流式输出
- 回答中的页码引用可点击，一键跳转并高亮原文对应页
- 论文内全文搜索（Ctrl/⌘ + F），支持匹配计数与逐个跳转高亮
- 键盘快捷键：翻页、聚焦提问、搜索、关闭浮层，按 ? 查看速查表
- 深色模式，跟随系统或手动切换
- 笔记面板：汇总当前论文的高亮、批注和 AI 卡片，按页排列、点击跳回原文
- 三档 AI 思考力度：快速（本地检索 + 单次作答，零额外模型调用）、深入（查询改写 + 两轮查漏补缺）、研究（Agent 多轮主动检索，步骤可见）
- 服务端按页/标题/段落切分 chunk，查询改写为中英双语检索词后打分召回，回答带页码引用
- 文件夹式论文文库
- 持久化论文、阅读进度、对话、高亮和批注
- OpenAI 兼容接口，可自定义 Base URL、API Key 和模型
- 本地 SQLite（Cloudflare D1）与本地对象存储（R2）开发模式
- 可选 Supabase 邮箱、Google 和游客登录

## 界面预览

| 阅读器主界面 | 划词即译 / 即问 |
| --- | --- |
| ![阅读器主界面](docs/screenshots/01-reader.jpg) | ![划词工具条](docs/screenshots/02-selection.jpg) |

| 文件夹文库与阅读状态 | 全局用量账单 |
| --- | --- |
| ![文库与阅读状态](docs/screenshots/03-library.jpg) | ![用量账单](docs/screenshots/04-usage.jpg) |

## 本地运行

需要 Node.js `>=22.13.0`。

### 一键启动

```bash
git clone https://github.com/kyre-99/lumen-paper-reader.git
cd lumen-paper-reader
```

- Windows：双击 `scripts/setup.bat`（或在终端执行）
- macOS / Linux / Git Bash：`./scripts/setup.sh`

脚本会自动完成依赖安装、生成带随机密钥的 `.dev.vars`、初始化本地数据库并启动。之后再次启动只需重新运行同一脚本。

### 打开应用

启动成功后，终端会打印一行本地地址：

```
➜  Local:   http://localhost:3000/
```

在浏览器（推荐 Chrome / Edge）打开这个地址即可使用。默认端口是 `3000`，被占用时会自动换成 `3001`、`3002`，以终端实际打印的为准。停止应用在终端按 `Ctrl + C`。

### 手动步骤

```bash
npm install
cp .env.example .dev.vars
npm run local
```

打开终端显示的本地地址即可使用。一键脚本会自动生成下面的配置；手动安装时，默认建议在 `.dev.vars` 中设置：

```env
LOCAL_ONLY=true
GUEST_SESSION_SECRET=请替换为至少32位的随机字符串
MODEL_CONFIG_SECRET=请替换为至少32位的随机字符串
```

本地模式不要求 Supabase 或第三方账号登录。文库和结构化数据保存在 `.wrangler/state/` 的本地 D1 中，上传的 PDF 保存在本地 R2 中。该目录不会提交到 Git；删除它会清空本地数据。

## 如何使用

**1. 配置模型（一次性）**

首次打开是演示模式。点击右上角的模型卡片（或左侧栏「设置」），在「模型」标签页选择服务商预设或自定义，填入 Base URL、API Key 和模型名，点「测试连接」确认可用后保存。没有配置模型时也可以浏览论文和体验界面，只是 AI 功能不可用。

**2. 打开论文**

点击顶栏「打开论文」：粘贴 arXiv 等网站的 PDF 直链，或上传本地 PDF 文件。打开过的论文会自动进入文库。

**3. 划词交互**

- 用鼠标选中正文任意文字，会弹出悬浮工具条：**翻译**、**解释**、**提问**、**高亮**（四色可选）
- 生成的 AI 卡片钉在原文旁，可拖动、可继续追问，刷新后仍在
- 工具栏开启「公式辅助」后，公式旁会出现「问公式」按钮
- 在页面上右键可以添加纯文字批注

**4. 全文问答**

右侧 AI 面板基于整篇论文回答，支持多轮对话、Markdown 与 LaTeX 渲染。顶栏的「思考力度」滑条有三档：**快速**（最省 token）、**深入**（补充检索）、**研究**（Agent 多轮翻阅，步骤可见）。划词工具条上的档位按钮可单独控制划词问答的力度。

**5. 管理文库**

左侧栏「我的文库」：按文件夹整理论文，给每篇标记 **未读 / 阅读中 / 已阅读**。每篇论文的阅读页码、缩放、对话和批注独立保存，下次打开自动恢复。

**6. 查看用量**

左侧栏「用量账单」：汇总所有论文的模型调用 token 数和按公开标价估算的费用，可按模型查看明细。

## 接入模型

可以在应用右上角的 AI 设置中填写 OpenAI 兼容配置，配置只需保存一次。也可以通过 `.dev.vars` 提供默认值：

```env
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=your_api_key
OPENAI_MODEL=gpt-4.1-mini
```

第三方兼容服务的 Base URL 通常应包含 `/v1`。请勿提交包含真实密钥的 `.dev.vars`；该文件已加入 `.gitignore`。

## 可选云端登录

如需启用 Supabase 登录和跨设备账户，可在 `.dev.vars` 中配置：

```env
LOCAL_ONLY=false
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_your_key
```

Google 登录还需要在 Supabase 和 Google Cloud Console 中配置 OAuth Provider 与回调地址。本地阅读和本地持久化不依赖这些设置。

## 常用命令

```bash
npm run local       # 初始化本地数据库并启动开发环境
npm run dev         # 启动开发环境
npm run build       # 生产构建
npm test            # 构建并运行测试
npm run lint        # ESLint 检查
npm run db:generate # 根据 schema 生成 Drizzle migration
```

## 技术栈

- React 19、Next.js API Routes、vinext、Vite
- PDF.js
- Cloudflare D1、R2、Wrangler
- Drizzle ORM
- Supabase Auth（可选）
- React Markdown 与 GFM

## 数据与安全

- `.dev.vars`、`.env`、`.wrangler/state/`、构建产物和上传文件不会进入 Git。
- 模型 API Key 不会发送给除所配置模型接口以外的第三方。
- 对外部署前请使用随机的 `GUEST_SESSION_SECRET` 和 `MODEL_CONFIG_SECRET`。
- AI 输出可能有误，重要论文结论请回到原文核对。

## License

[MIT](LICENSE)
