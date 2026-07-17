"use client";

import {
  ArrowLeft,
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Copy,
  FileText,
  FolderOpen,
  Globe2,
  Highlighter,
  Languages,
  Library,
  Link2,
  LoaderCircle,
  Maximize2,
  MessageSquareText,
  Minus,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Search,
  Send,
  Settings,
  Sparkles,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

type ChatMessage = { id: number; role: "user" | "assistant"; content: string; context?: string };
type ToolAction = "translate" | "explain" | "ask";

const demoParagraphs = [
  {
    heading: "Abstract",
    body: "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.",
  },
  {
    heading: "1. Introduction",
    body: "Recurrent neural networks, long short-term memory and gated recurrent neural networks in particular, have been firmly established as state of the art approaches in sequence modeling and transduction problems such as language modeling and machine translation.",
  },
  {
    body: "In these models, the number of operations required to relate signals from two arbitrary input or output positions grows in the distance between positions. This makes it more difficult to learn dependencies between distant positions. Attention mechanisms reduce this distance to a constant number of operations, albeit at the cost of reduced effective resolution.",
  },
  {
    heading: "2. Model Architecture",
    body: "Most competitive neural sequence transduction models have an encoder-decoder structure. The encoder maps an input sequence of symbol representations to a sequence of continuous representations. Given those representations, the decoder then generates an output sequence one element at a time.",
  },
];

function normalizePaperUrl(raw: string) {
  const trimmed = raw.trim();
  const arxiv = trimmed.match(/arxiv\.org\/(?:abs|html|pdf)\/([^?#/]+)/i);
  if (arxiv) return `https://arxiv.org/pdf/${arxiv[1]}`;
  return trimmed;
}

function demoAnswer(prompt: string, context?: string) {
  const lower = prompt.toLowerCase();
  if (lower.includes("翻译") || lower.includes("translate")) {
    return `### 局部翻译\n\n${context ? `> ${context}\n\n` : ""}本文提出了一种全新的简洁网络架构——**Transformer**。它完全基于注意力机制，摒弃了循环结构和卷积结构。\n\n**术语提示**\n- *sequence transduction*：序列转换\n- *attention mechanism*：注意力机制\n- *recurrence*：循环结构`;
  }
  if (lower.includes("总结") || lower.includes("summary")) {
    return "### 核心结论\n\n1. 论文用**自注意力**替代循环与卷积。\n2. 不同位置的信息可以直接交互，更容易建模长距离依赖。\n3. 训练可并行化，因此效率明显更高。\n\n> 一句话理解：Transformer 让序列中的每个词都能直接关注其他词。";
  }
  return `### 这段话在说什么？\n\n作者强调的是：传统序列模型需要逐步传递信息，而注意力机制让两个相距很远的位置也能**直接建立联系**。\n\n${context ? `> ${context}\n\n` : ""}这带来两个直接好处：\n\n- 更容易捕捉长距离依赖\n- 计算可以并行执行，训练速度更快\n\n如果你愿意，我还可以用一个具体句子画出 Q、K、V 的计算过程。`;
}

function BrandMark() {
  return (
    <div className="brand-mark" aria-label="Lumen Paper">
      <span className="brand-core" />
      <span className="brand-orbit" />
    </div>
  );
}

function RailButton({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active?: boolean; onClick?: () => void }) {
  return (
    <button className={`rail-button ${active ? "active" : ""}`} onClick={onClick} aria-label={label} title={label}>
      {icon}
      <span className="rail-tooltip">{label}</span>
    </button>
  );
}

function DemoPaper() {
  return (
    <article className="paper-page demo-paper" data-testid="demo-paper">
      <header className="paper-head">
        <div className="paper-kicker">Neural Information Processing Systems · 2017</div>
        <h1>Attention Is All You Need</h1>
        <p className="authors">Ashish Vaswani · Noam Shazeer · Niki Parmar · Jakob Uszkoreit · Llion Jones</p>
      </header>
      <div className="paper-columns">
        {demoParagraphs.map((item, index) => (
          <section className="paper-section" key={index}>
            {item.heading && <h2>{item.heading}</h2>}
            <p>{item.body}</p>
            {index === 1 && (
              <div className="formula-card" aria-label="Scaled dot-product attention formula">
                <span>Attention(Q, K, V) = softmax</span>
                <span className="fraction"><i>QKᵀ</i><b>√dₖ</b></span>
                <span>V</span>
              </div>
            )}
          </section>
        ))}
      </div>
      <footer className="paper-footer"><span>1</span><span>Attention Is All You Need</span></footer>
    </article>
  );
}

function PdfPage({ pdf, pageNumber, zoom }: { pdf: any; pageNumber: number; zoom: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 760, height: 980 });

  useEffect(() => {
    let cancelled = false;
    let renderTask: any;
    let textLayer: any;
    (async () => {
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;
      const viewport = page.getViewport({ scale: 1.25 * zoom });
      const canvas = canvasRef.current;
      const textContainer = textRef.current;
      if (!canvas || !textContainer) return;
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      setSize({ width: viewport.width, height: viewport.height });
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      renderTask = page.render({ canvasContext: ctx, viewport, transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0] });
      await renderTask.promise;
      if (cancelled) return;
      textContainer.replaceChildren();
      const textContent = await page.getTextContent();
      const pdfjs = await import("pdfjs-dist");
      textLayer = new pdfjs.TextLayer({ textContentSource: textContent, container: textContainer, viewport });
      await textLayer.render();
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      renderTask?.cancel?.();
      textLayer?.cancel?.();
    };
  }, [pdf, pageNumber, zoom]);

  return (
    <div className="pdf-page" style={{ width: size.width, height: size.height }}>
      <canvas ref={canvasRef} />
      <div className="textLayer" ref={textRef} />
    </div>
  );
}

function PdfDocument({ source, zoom, onReady, onError }: { source: string | Uint8Array; zoom: number; onReady: (pages: number) => void; onError: (message: string) => void }) {
  const [pdf, setPdf] = useState<any>(null);

  useEffect(() => {
    let task: any;
    let cancelled = false;
    (async () => {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      task = pdfjs.getDocument(typeof source === "string" ? source : { data: source });
      const loaded = await task.promise;
      if (!cancelled) {
        setPdf(loaded);
        onReady(loaded.numPages);
      }
    })().catch((error) => !cancelled && onError(error?.message || "PDF 加载失败"));
    return () => {
      cancelled = true;
      task?.destroy?.();
    };
  }, [source, onReady, onError]);

  if (!pdf) {
    return <div className="pdf-loading"><LoaderCircle className="spin" size={22} /><span>正在解析论文版面…</span></div>;
  }
  return <div className="pdf-stack">{Array.from({ length: pdf.numPages }, (_, i) => <PdfPage key={i + 1} pdf={pdf} pageNumber={i + 1} zoom={zoom} />)}</div>;
}

function OpenPaperModal({ onClose, onOpenUrl, onOpenFile }: { onClose: () => void; onOpenUrl: (url: string) => void; onOpenFile: (file: File) => void }) {
  const [url, setUrl] = useState("https://arxiv.org/abs/1706.03762");
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="open-title">
        <button className="icon-button modal-close" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        <div className="modal-icon"><FolderOpen size={24} /></div>
        <h2 id="open-title">打开一篇论文</h2>
        <p>粘贴 arXiv 链接或任何公开 PDF 地址，也可以从本地上传。</p>
        <label className="url-field">
          <Link2 size={18} />
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://arxiv.org/abs/…" autoFocus />
        </label>
        <button className="primary-button wide" onClick={() => onOpenUrl(url)} disabled={!url.trim()}><Globe2 size={17} />打开链接</button>
        <div className="modal-or"><span>或</span></div>
        <input ref={inputRef} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => e.target.files?.[0] && onOpenFile(e.target.files[0])} />
        <button className="secondary-button wide" onClick={() => inputRef.current?.click()}><Upload size={17} />上传 PDF</button>
        <div className="privacy-note"><Check size={14} />本地文件仅在当前浏览器中解析</div>
      </div>
    </div>
  );
}

function SettingsModal({ onClose, config, setConfig }: { onClose: () => void; config: ApiConfig; setConfig: (v: ApiConfig) => void }) {
  const presets = {
    OpenAI: { endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4.1-mini" },
    DeepSeek: { endpoint: "https://api.deepseek.com/chat/completions", model: "deepseek-chat" },
    OpenRouter: { endpoint: "https://openrouter.ai/api/v1/chat/completions", model: "openai/gpt-4.1-mini" },
    Moonshot: { endpoint: "https://api.moonshot.cn/v1/chat/completions", model: "moonshot-v1-8k" },
  };
  const [saved, setSaved] = useState(false);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card settings-card" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <button className="icon-button modal-close" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        <div className="settings-heading"><div className="modal-icon"><Bot size={24} /></div><div><h2 id="settings-title">连接你的模型</h2><p>支持 OpenAI 兼容接口，密钥仅保存在当前会话。</p></div></div>
        <div className="preset-row">
          {Object.entries(presets).map(([name, value]) => (
            <button key={name} className={config.provider === name ? "selected" : ""} onClick={() => setConfig({ ...config, provider: name, ...value })}>{name}</button>
          ))}
        </div>
        <label className="field-label">API 地址<input value={config.endpoint} onChange={(e) => setConfig({ ...config, endpoint: e.target.value })} /></label>
        <label className="field-label">模型名称<input value={config.model} onChange={(e) => setConfig({ ...config, model: e.target.value })} /></label>
        <label className="field-label">API Key<input type="password" value={config.apiKey} onChange={(e) => setConfig({ ...config, apiKey: e.target.value })} placeholder="sk-••••••••••••" /></label>
        <button className="primary-button wide" onClick={() => { sessionStorage.setItem("lumen-api-key", config.apiKey); localStorage.setItem("lumen-api-config", JSON.stringify({ ...config, apiKey: "" })); setSaved(true); setTimeout(onClose, 650); }}>{saved ? <><Check size={17} />已保存</> : "保存连接"}</button>
        <div className="privacy-note"><Check size={14} />请求直接经安全代理转发，不会记录你的密钥</div>
      </div>
    </div>
  );
}

type ApiConfig = { provider: string; endpoint: string; model: string; apiKey: string };

export default function Home() {
  const [openModal, setOpenModal] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(true);
  const [source, setSource] = useState<string | Uint8Array | null>(null);
  const [paperTitle, setPaperTitle] = useState("Attention Is All You Need");
  const [paperMeta, setPaperMeta] = useState("Vaswani et al. · NeurIPS 2017");
  const [pageCount, setPageCount] = useState(15);
  const [currentPage, setCurrentPage] = useState(1);
  const [zoom, setZoom] = useState(0.88);
  const [selectedText, setSelectedText] = useState("");
  const [selectionPos, setSelectionPos] = useState<{ x: number; y: number } | null>(null);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState("");
  const readerRef = useRef<HTMLDivElement>(null);
  const [config, setConfig] = useState<ApiConfig>({ provider: "OpenAI", endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4.1-mini", apiKey: "" });
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: 1, role: "assistant", content: "你好，我已经读过这篇论文。你可以直接提问，也可以在左侧**选中任意段落**让我翻译或解释。" },
  ]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("lumen-api-config");
      const apiKey = sessionStorage.getItem("lumen-api-key") || "";
      if (saved) setConfig({ ...JSON.parse(saved), apiKey });
    } catch { /* ignore invalid local preferences */ }
  }, []);

  const sendQuestion = useCallback(async (raw: string, context?: string) => {
    const text = raw.trim();
    if (!text || loading) return;
    const userMessage: ChatMessage = { id: Date.now(), role: "user", content: text, context };
    setMessages((old) => [...old, userMessage]);
    setQuestion("");
    setLoading(true);
    setRightOpen(true);
    setSelectionPos(null);
    try {
      let answer = "";
      if (config.apiKey) {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: config.endpoint, apiKey: config.apiKey, model: config.model, paperTitle, question: text, context, history: messages.slice(-6) }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "模型请求失败");
        answer = payload.content;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 650));
        answer = demoAnswer(text, context);
      }
      setMessages((old) => [...old, { id: Date.now() + 1, role: "assistant", content: answer }]);
    } catch (error: any) {
      setMessages((old) => [...old, { id: Date.now() + 1, role: "assistant", content: `连接模型时遇到问题：${error?.message || "请检查 API 设置"}\n\n你可以在右上角的模型设置中检查接口地址与密钥。` }]);
    } finally { setLoading(false); }
  }, [config, loading, messages, paperTitle]);

  const handleSelection = useCallback(() => {
    const selection = window.getSelection();
    const text = selection?.toString().replace(/\s+/g, " ").trim() || "";
    if (!text || text.length < 2 || !selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!readerRef.current?.contains(range.commonAncestorContainer)) return;
    const rect = range.getBoundingClientRect();
    setSelectedText(text.slice(0, 1800));
    setSelectionPos({ x: Math.min(Math.max(rect.left + rect.width / 2, 190), window.innerWidth - 220), y: Math.max(rect.top - 58, 72) });
  }, []);

  const selectionAction = (action: ToolAction) => {
    if (!selectedText) return;
    if (action === "translate") sendQuestion("请将选中的内容准确翻译成中文，并保留专业术语。", selectedText);
    if (action === "explain") sendQuestion("请用直观、简洁的方式解释选中的内容，并说明它在论文中的作用。", selectedText);
    if (action === "ask") { setQuestion(`关于这段内容：`); setRightOpen(true); }
  };

  const openUrl = (raw: string) => {
    const normalized = normalizePaperUrl(raw);
    if (!/^https?:\/\//i.test(normalized)) { setToast("请输入有效的公开链接"); return; }
    setSource(`/api/pdf?url=${encodeURIComponent(normalized)}`);
    const arxivId = normalized.match(/arxiv\.org\/pdf\/([^?#/]+)/i)?.[1];
    setPaperTitle(arxivId ? `arXiv · ${arxivId}` : "正在读取论文…");
    setPaperMeta(new URL(normalized).hostname);
    setOpenModal(false);
    setToast("论文已加入阅读区");
  };

  const openFile = async (file: File) => {
    const data = new Uint8Array(await file.arrayBuffer());
    setSource(data);
    setPaperTitle(file.name.replace(/\.pdf$/i, ""));
    setPaperMeta(`本地 PDF · ${(file.size / 1024 / 1024).toFixed(1)} MB`);
    setOpenModal(false);
    setToast("本地论文已打开");
  };

  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 2200); return () => clearTimeout(timer); }, [toast]);

  const contextLabel = useMemo(() => selectedText ? `${selectedText.slice(0, 92)}${selectedText.length > 92 ? "…" : ""}` : "", [selectedText]);

  return (
    <main className={`app-shell ${rightOpen ? "right-open" : "right-closed"}`}>
      <aside className="app-rail">
        <BrandMark />
        <nav className="rail-nav">
          <RailButton icon={<BookOpen size={20} />} label="阅读器" active />
          <RailButton icon={<Library size={20} />} label="我的文库" onClick={() => setToast("文库同步将在账户系统接入后启用")} />
          <RailButton icon={<Search size={20} />} label="探索论文" onClick={() => setOpenModal(true)} />
          <RailButton icon={<Highlighter size={20} />} label="批注" onClick={() => setToast("选中文字即可开始批注")} />
        </nav>
        <div className="rail-bottom">
          <RailButton icon={<CircleHelp size={20} />} label="使用帮助" onClick={() => setToast("提示：先选中文字，再选择翻译或解释")} />
          <RailButton icon={<Settings size={20} />} label="设置" onClick={() => setSettingsOpen(true)} />
          <button className="avatar" aria-label="个人资料">W</button>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="paper-identity">
            <button className="icon-button" aria-label="返回"><ArrowLeft size={18} /></button>
            <div className="file-badge"><FileText size={17} /></div>
            <div><h1>{paperTitle}</h1><p>{paperMeta}</p></div>
          </div>
          <div className="top-actions">
            <button className="status-pill" onClick={() => setSettingsOpen(true)}><span className={`status-dot ${config.apiKey ? "online" : ""}`} />{config.apiKey ? config.model : "演示模型"}<ChevronDown size={14} /></button>
            <button className="secondary-button compact" onClick={() => setOpenModal(true)}><Plus size={16} />打开论文</button>
            <button className="icon-button" aria-label="更多"><MoreHorizontal size={19} /></button>
            <button className="icon-button" aria-label={rightOpen ? "收起 AI" : "展开 AI"} onClick={() => setRightOpen(!rightOpen)}>{rightOpen ? <PanelRightClose size={19} /> : <PanelRightOpen size={19} />}</button>
          </div>
        </header>

        <div className="reader-toolbar">
          <div className="toolbar-group"><button className="icon-button small" aria-label="上一页" onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}><ChevronLeft size={17} /></button><span className="page-indicator"><input aria-label="当前页" value={currentPage} onChange={(e) => setCurrentPage(Math.min(pageCount, Math.max(1, Number(e.target.value) || 1)))} /> / {pageCount}</span><button className="icon-button small" aria-label="下一页" onClick={() => setCurrentPage(Math.min(pageCount, currentPage + 1))}><ChevronRight size={17} /></button></div>
          <div className="toolbar-divider" />
          <div className="toolbar-group"><button className="icon-button small" aria-label="缩小" onClick={() => setZoom(Math.max(.55, zoom - .1))}><ZoomOut size={17} /></button><button className="zoom-label" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button><button className="icon-button small" aria-label="放大" onClick={() => setZoom(Math.min(1.8, zoom + .1))}><ZoomIn size={17} /></button></div>
          <div className="toolbar-spacer" />
          <button className="toolbar-text-button" onClick={() => setToast("拖动选择论文文字即可标记")}><Highlighter size={16} />高亮</button>
          <button className="icon-button small" aria-label="全屏"><Maximize2 size={17} /></button>
        </div>

        <div className="reader-viewport" ref={readerRef} onMouseUp={handleSelection} onScroll={() => selectionPos && setSelectionPos(null)}>
          {source ? (
            <PdfDocument source={source} zoom={zoom} onReady={(pages) => { setPageCount(pages); setPaperTitle((title) => title === "正在读取论文…" ? "已载入的研究论文" : title); }} onError={(msg) => { setToast(`加载失败：${msg.slice(0, 70)}`); setSource(null); }} />
          ) : <div style={{ transform: `scale(${zoom})`, transformOrigin: "top center" }}><DemoPaper /></div>}
          <div className="reader-tip"><Sparkles size={14} />选中论文中的任何内容，立即翻译或提问</div>
        </div>
      </section>

      <aside className="ai-panel" aria-hidden={!rightOpen}>
        <header className="ai-header">
          <div className="ai-title"><div className="ai-glyph"><Sparkles size={17} /></div><div><h2>Lumen AI</h2><span>已了解全文上下文</span></div></div>
          <button className="icon-button small" onClick={() => setRightOpen(false)} aria-label="关闭 AI 面板"><X size={17} /></button>
        </header>
        <div className="quick-actions">
          <button onClick={() => sendQuestion("请用三点总结这篇论文的核心贡献。")}>总结全文</button>
          <button onClick={() => sendQuestion("请解释这篇论文最重要的方法，并给出直觉理解。")}>解释方法</button>
          <button onClick={() => sendQuestion("请列出阅读这篇论文前需要了解的概念。")}>前置知识</button>
        </div>
        <div className="chat-stream">
          {messages.map((message) => (
            <div key={message.id} className={`message ${message.role}`}>
              {message.role === "assistant" && <div className="message-avatar"><Sparkles size={14} /></div>}
              <div className="message-body">
                {message.context && <div className="context-quote"><span>引用选区</span>{message.context.slice(0, 180)}{message.context.length > 180 ? "…" : ""}</div>}
                {message.role === "assistant" ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown> : <p>{message.content}</p>}
                {message.role === "assistant" && <div className="message-tools"><button aria-label="复制回答" onClick={() => navigator.clipboard.writeText(message.content)}><Copy size={13} /></button><button aria-label="有帮助"><Check size={13} /></button></div>}
              </div>
            </div>
          ))}
          {loading && <div className="message assistant"><div className="message-avatar"><Sparkles size={14} /></div><div className="thinking"><span /><span /><span /></div></div>}
        </div>
        <div className="composer-wrap">
          {selectedText && <div className="composer-context"><span>选中的内容</span><p>{contextLabel}</p><button onClick={() => setSelectedText("")} aria-label="清除选区"><X size={14} /></button></div>}
          <div className="composer">
            <textarea value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendQuestion(question, selectedText || undefined); } }} placeholder="询问这篇论文…" rows={2} />
            <div className="composer-bottom"><span>⌘ ↵</span><button onClick={() => sendQuestion(question, selectedText || undefined)} disabled={!question.trim() || loading} aria-label="发送"><Send size={16} /></button></div>
          </div>
          <p className="ai-disclaimer">AI 可能会出错，请核对重要结论</p>
        </div>
      </aside>

      {selectionPos && (
        <div className="selection-menu" style={{ left: selectionPos.x, top: selectionPos.y }}>
          <button onClick={() => selectionAction("translate")}><Languages size={15} />翻译</button>
          <button onClick={() => selectionAction("explain")}><Sparkles size={15} />解释</button>
          <button onClick={() => selectionAction("ask")}><MessageSquareText size={15} />提问</button>
          <span />
          <button className="menu-icon" aria-label="复制" onClick={async () => { await navigator.clipboard.writeText(selectedText); setCopied(true); setTimeout(() => setCopied(false), 1000); }}>{copied ? <Check size={15} /> : <Copy size={15} />}</button>
        </div>
      )}
      {openModal && <OpenPaperModal onClose={() => setOpenModal(false)} onOpenUrl={openUrl} onOpenFile={openFile} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} config={config} setConfig={setConfig} />}
      {toast && <div className="toast"><Check size={15} />{toast}</div>}
    </main>
  );
}
