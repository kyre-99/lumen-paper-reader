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
  Cloud,
  CloudOff,
  Copy,
  FileText,
  FolderOpen,
  Globe2,
  Highlighter,
  Languages,
  Library,
  Link2,
  LoaderCircle,
  LogOut,
  Maximize2,
  MessageSquareText,
  Minus,
  MoreHorizontal,
  Palette,
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
import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

type ChatMessage = { id: number; role: "user" | "assistant"; content: string };
type ToolAction = "translate" | "explain" | "ask";
type HighlightColor = "yellow" | "green" | "blue" | "rose";
type Annotation = {
  id: number;
  kind: ToolAction | "highlight";
  color: HighlightColor;
  text: string;
  surrounding: string;
  top: number;
  left: number;
  cardTop: number;
  cardLeft: number;
  open: boolean;
  loading: boolean;
  result: string;
  draft: string;
  thread: ChatMessage[];
  pageNumber: number;
};
type SessionUser = { displayName: string; email: string; fullName: string | null; isGuest: boolean };
type PaperSourceKind = "remote" | "upload";

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

function trimRangeToText(input: Range) {
  const range = input.cloneRange();
  const root = range.commonAncestorContainer.nodeType === Node.TEXT_NODE ? range.commonAncestorContainer.parentNode : range.commonAncestorContainer;
  if (!root) return range;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let first: { node: Text; offset: number } | null = null;
  let last: { node: Text; offset: number } | null = null;
  let current = walker.nextNode() as Text | null;
  while (current) {
    if (range.intersectsNode(current)) {
      const value = current.data;
      const from = current === range.startContainer ? range.startOffset : 0;
      const to = current === range.endContainer ? range.endOffset : value.length;
      const part = value.slice(from, to);
      const firstNonSpace = part.search(/\S/);
      if (firstNonSpace >= 0) {
        const trailing = part.match(/\s+$/)?.[0].length || 0;
        if (!first) first = { node: current, offset: from + firstNonSpace };
        last = { node: current, offset: Math.max(from + firstNonSpace, to - trailing) };
      }
    }
    current = walker.nextNode() as Text | null;
  }
  if (first && last) {
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset);
  }
  return range;
}

function findTextRange(root: Element, target: string) {
  const wanted = target.replace(/\s+/g, " ").trim();
  if (!wanted) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const positions: Array<{ node: Text; offset: number }> = [];
  let normalized = "";
  let node = walker.nextNode() as Text | null;
  while (node) {
    for (let offset = 0; offset < node.data.length; offset++) {
      const char = node.data[offset];
      if (/\s/.test(char)) {
        if (normalized && normalized[normalized.length - 1] !== " ") {
          normalized += " ";
          positions.push({ node, offset });
        }
      } else {
        normalized += char;
        positions.push({ node, offset });
      }
    }
    node = walker.nextNode() as Text | null;
  }
  const index = normalized.indexOf(wanted);
  if (index < 0 || !positions[index] || !positions[index + wanted.length - 1]) return null;
  const start = positions[index];
  const end = positions[index + wanted.length - 1];
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset + 1);
  return range;
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

function MarkdownContent({ content, compact = false }: { content: string; compact?: boolean }) {
  return (
    <div className={`markdown-content${compact ? " compact" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
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
    <article className="paper-page demo-paper" data-testid="demo-paper" data-page-number="1">
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
    <div className="pdf-page" data-page-number={pageNumber} style={{ width: size.width, height: size.height, "--total-scale-factor": 1.25 * zoom } as React.CSSProperties}>
      <canvas ref={canvasRef} />
      <div className="textLayer" ref={textRef} />
    </div>
  );
}

function PdfDocument({ source, zoom, onReady, onTextExtracted, onError }: { source: string | Uint8Array; zoom: number; onReady: (pages: number) => void; onTextExtracted: (text: string) => void; onError: (message: string) => void }) {
  const [pdf, setPdf] = useState<any>(null);

  useEffect(() => {
    let task: any;
    let cancelled = false;
    (async () => {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      task = pdfjs.getDocument(typeof source === "string" ? { url: source } : { data: source });
      const loaded = await task.promise;
      if (!cancelled) {
        setPdf(loaded);
        onReady(loaded.numPages);
        void (async () => {
          const pageTexts: string[] = [];
          const limit = Math.min(loaded.numPages, 80);
          for (let pageNumber = 1; pageNumber <= limit && !cancelled; pageNumber++) {
            const page = await loaded.getPage(pageNumber);
            const content = await page.getTextContent();
            pageTexts.push(`--- PAGE ${pageNumber} ---\n${content.items.map((item: any) => item.str || "").join(" ")}`);
          }
          if (!cancelled) onTextExtracted(pageTexts.join("\n\n").slice(0, 120000));
        })().catch(() => !cancelled && onTextExtracted(""));
      }
    })().catch((error) => !cancelled && onError(error?.message || "PDF 加载失败"));
    return () => {
      cancelled = true;
      task?.destroy?.();
    };
  }, [source, onReady, onTextExtracted, onError]);

  if (!pdf) {
    return <div className="pdf-loading"><LoaderCircle className="spin" size={22} /><span>正在解析论文版面…</span></div>;
  }
  return <div className="pdf-stack">{Array.from({ length: pdf.numPages }, (_, i) => <PdfPage key={i + 1} pdf={pdf} pageNumber={i + 1} zoom={zoom} />)}</div>;
}

function OpenPaperModal({ onClose, onOpenUrl, onOpenFile }: { onClose: () => void; onOpenUrl: (url: string) => void; onOpenFile: (file: File) => void }) {
  const [url, setUrl] = useState("");
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
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="例如 https://arxiv.org/pdf/2507.21892" autoFocus />
        </label>
        <button className="primary-button wide" onClick={() => onOpenUrl(url)} disabled={!url.trim()}><Globe2 size={17} />打开链接</button>
        <div className="modal-or"><span>或</span></div>
        <input ref={inputRef} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => e.target.files?.[0] && onOpenFile(e.target.files[0])} />
        <button className="secondary-button wide" onClick={() => inputRef.current?.click()}><Upload size={17} />上传 PDF</button>
        <div className="privacy-note"><Check size={14} />上传文件会保存到你的私人账户空间</div>
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
  const [user, setUser] = useState<SessionUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const [guestSubmitting, setGuestSubmitting] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"loading" | "saved" | "saving" | "error">("loading");
  const [hydrated, setHydrated] = useState(false);
  const [openModal, setOpenModal] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(true);
  const [source, setSource] = useState<string | Uint8Array | null>(null);
  const [paperId, setPaperId] = useState<string | null>(null);
  const [paperSourceKind, setPaperSourceKind] = useState<PaperSourceKind | null>(null);
  const [paperSourceUrl, setPaperSourceUrl] = useState<string | null>(null);
  const [paperTitle, setPaperTitle] = useState("Attention Is All You Need");
  const [paperMeta, setPaperMeta] = useState("交互演示论文 · 打开链接后会替换为真实 PDF");
  const [pageCount, setPageCount] = useState(15);
  const [currentPage, setCurrentPage] = useState(1);
  const [zoom, setZoom] = useState(0.88);
  const [selectedText, setSelectedText] = useState("");
  const [selectionContext, setSelectionContext] = useState("");
  const [selectionPos, setSelectionPos] = useState<{ x: number; y: number } | null>(null);
  const [selectionAnchor, setSelectionAnchor] = useState<{ top: number; left: number; cardTop: number; cardLeft: number; pageNumber: number } | null>(null);
  const [showColors, setShowColors] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [paperText, setPaperText] = useState(demoParagraphs.map((item) => `${item.heading || ""}\n${item.body}`).join("\n\n"));
  const [extractingText, setExtractingText] = useState(false);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState("");
  const [showReaderTip, setShowReaderTip] = useState(true);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const readerRef = useRef<HTMLDivElement>(null);
  const selectionRangeRef = useRef<Range | null>(null);
  const annotationRangesRef = useRef(new Map<number, { range: Range; color: HighlightColor; persistent: boolean }>());
  const activeRangeIdsRef = useRef(new Set<number>());
  const flashTimersRef = useRef(new Map<number, number>());
  const dragRef = useRef<{ id: number; target: "card" | "pin"; startX: number; startY: number; startLeft: number; startTop: number } | null>(null);
  const lastDraggedPinRef = useRef<number | null>(null);
  const restoringWorkspaceRef = useRef(false);
  const [config, setConfig] = useState<ApiConfig>({ provider: "OpenAI", endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4.1-mini", apiKey: "" });
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: 1, role: "assistant", content: "这里是**全文对话**。我会基于整篇论文回答总结、方法、实验与结论问题；局部翻译和解释会留在原文旁边。" },
  ]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("lumen-api-config");
      const apiKey = sessionStorage.getItem("lumen-api-key") || "";
      if (saved) setConfig({ ...JSON.parse(saved), apiKey });
    } catch { /* ignore invalid local preferences */ }
  }, []);

  useEffect(() => {
    const error = new URLSearchParams(window.location.search).get("auth_error");
    if (error) {
      setAuthMessage(error);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sessionResponse = await fetch("/api/session", { cache: "no-store" });
        const sessionPayload = await sessionResponse.json();
        if (!sessionResponse.ok) {
          if (!cancelled) { setUser(null); setAuthReady(true); setHydrated(true); setSaveStatus("error"); }
          return;
        }
        if (cancelled) return;
        setUser(sessionPayload.user);
        setAuthReady(true);

        const workspaceResponse = await fetch("/api/workspace", { cache: "no-store" });
        const workspacePayload = await workspaceResponse.json();
        if (!workspaceResponse.ok) throw new Error(workspacePayload.error || "无法读取同步数据");
        const workspace = workspacePayload.workspace;
        if (workspace?.paper) {
          restoringWorkspaceRef.current = true;
          clearPaperAnnotations();
          const paper = workspace.paper;
          setPaperId(paper.id);
          setPaperSourceKind(paper.sourceKind);
          setPaperSourceUrl(paper.sourceUrl || null);
          setPaperTitle(paper.title);
          setPaperMeta(paper.meta);
          setPaperText(paper.paperText || "");
          setPageCount(paper.pageCount || 1);
          setCurrentPage(workspace.currentPage || 1);
          setZoom(workspace.zoom || 0.88);
          setRightOpen(workspace.rightOpen !== false);
          setMessages(Array.isArray(workspace.messages) && workspace.messages.length ? workspace.messages : [{ id: Date.now(), role: "assistant", content: "已恢复这篇论文的阅读记录。" }]);
          setAnnotations((Array.isArray(workspace.annotations) ? workspace.annotations : []).map((item: Annotation) => ({ ...item, loading: false, draft: "", thread: Array.isArray(item.thread) ? item.thread : [], pageNumber: item.pageNumber || 1 })));
          setSource(paper.sourceKind === "upload" ? `/api/papers/${paper.id}/file` : `/api/pdf?url=${encodeURIComponent(paper.sourceUrl)}`);
          setExtractingText(!paper.paperText);
        }
        setSaveStatus("saved");
      } catch {
        if (!cancelled) setSaveStatus("error");
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => { cancelled = true; };
  // Initial account/workspace hydration only; subsequent changes are handled by autosave.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setShowReaderTip(false), 30000);
    return () => window.clearTimeout(timer);
  }, []);

  const sendQuestion = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text || loading) return;
    const userMessage: ChatMessage = { id: Date.now(), role: "user", content: text };
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
          body: JSON.stringify({ endpoint: config.endpoint, apiKey: config.apiKey, model: config.model, paperTitle, question: text, paperContext: paperText, mode: "global", history: messages.slice(-6) }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "模型请求失败");
        answer = payload.content;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 650));
        answer = demoAnswer(text);
      }
      setMessages((old) => [...old, { id: Date.now() + 1, role: "assistant", content: answer }]);
    } catch (error: any) {
      setMessages((old) => [...old, { id: Date.now() + 1, role: "assistant", content: `连接模型时遇到问题：${error?.message || "请检查 API 设置"}\n\n你可以在右上角的模型设置中检查接口地址与密钥。` }]);
    } finally { setLoading(false); }
  }, [config, loading, messages, paperText, paperTitle]);

  const refreshHighlights = useCallback((color: HighlightColor) => {
    if (!(CSS as any).highlights || !(window as any).Highlight) return;
    if (!document.getElementById("lumen-highlight-styles")) {
      const style = document.createElement("style");
      style.id = "lumen-highlight-styles";
      style.textContent = "::highlight(lumen-yellow){background:rgba(244,207,86,.48)}::highlight(lumen-green){background:rgba(100,190,151,.40)}::highlight(lumen-blue){background:rgba(104,168,226,.36)}::highlight(lumen-rose){background:rgba(226,126,151,.34)}";
      document.head.appendChild(style);
    }
    const ranges = [...annotationRangesRef.current.entries()].filter(([id, item]) => item.color === color && (item.persistent || activeRangeIdsRef.current.has(id))).map(([, item]) => item.range);
    const name = `lumen-${color}`;
    if (ranges.length) (CSS as any).highlights.set(name, new (window as any).Highlight(...ranges));
    else (CSS as any).highlights.delete(name);
  }, []);

  const addAnnotationRange = useCallback((id: number, range: Range, color: HighlightColor, persistent: boolean) => {
    annotationRangesRef.current.set(id, { range: range.cloneRange(), color, persistent });
    if (persistent) refreshHighlights(color);
  }, [refreshHighlights]);

  const flashAnnotationRange = useCallback((id: number, duration = 1500) => {
    const stored = annotationRangesRef.current.get(id);
    if (!stored || stored.persistent) return;
    const existing = flashTimersRef.current.get(id);
    if (existing) window.clearTimeout(existing);
    activeRangeIdsRef.current.add(id);
    refreshHighlights(stored.color);
    const timer = window.setTimeout(() => {
      activeRangeIdsRef.current.delete(id);
      flashTimersRef.current.delete(id);
      refreshHighlights(stored.color);
    }, duration);
    flashTimersRef.current.set(id, timer);
  }, [refreshHighlights]);

  const updateAnnotation = useCallback((id: number, patch: Partial<Annotation>) => {
    setAnnotations((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  }, []);

  const startAnnotationDrag = useCallback((event: React.PointerEvent<HTMLElement>, annotation: Annotation, target: "card" | "pin") => {
    if (event.button !== 0 || (target === "card" && (event.target as HTMLElement).closest("button, textarea, a"))) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { id: annotation.id, target, startX: event.clientX, startY: event.clientY, startLeft: target === "card" ? annotation.cardLeft : annotation.left, startTop: target === "card" ? annotation.cardTop : annotation.top };
    setDraggingId(annotation.id);
  }, []);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      const reader = readerRef.current;
      if (!drag || !reader) return;
      const nextLeft = drag.startLeft + event.clientX - drag.startX;
      const nextTop = drag.startTop + event.clientY - drag.startY;
      if (drag.target === "pin" && (Math.abs(event.clientX - drag.startX) > 3 || Math.abs(event.clientY - drag.startY) > 3)) lastDraggedPinRef.current = drag.id;
      const minLeft = reader.scrollLeft + 8;
      const maxLeft = reader.scrollLeft + Math.max(8, reader.clientWidth - 350);
      const minTop = reader.scrollTop + 8;
      const maxTop = reader.scrollTop + Math.max(8, reader.clientHeight - 110);
      if (drag.target === "card") updateAnnotation(drag.id, { cardLeft: Math.min(maxLeft, Math.max(minLeft, nextLeft)), cardTop: Math.min(maxTop, Math.max(minTop, nextTop)) });
      else updateAnnotation(drag.id, { left: Math.min(reader.scrollLeft + reader.clientWidth - 30, Math.max(reader.scrollLeft + 4, nextLeft)), top: Math.min(reader.scrollTop + reader.clientHeight - 20, Math.max(reader.scrollTop + 12, nextTop)) });
    };
    const end = () => { dragRef.current = null; setDraggingId(null); window.setTimeout(() => { lastDraggedPinRef.current = null; }, 0); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); };
  }, [updateAnnotation]);

  const requestInlineAnswer = useCallback(async (id: number, action: ToolAction, text: string, surrounding: string, customQuestion?: string, history: ChatMessage[] = []) => {
    const prompt = customQuestion || (action === "translate" ? "请将选中的内容准确翻译成中文，保留公式与专业术语，并简短标注关键术语。" : "请直观解释选中内容的含义、它在本段中的作用，以及读者容易误解的地方。");
    const userMessage: ChatMessage = { id: Date.now(), role: "user", content: customQuestion || (action === "translate" ? "翻译这段内容" : action === "explain" ? "解释这段内容" : prompt) };
    const nextThread = [...history, userMessage];
    updateAnnotation(id, { loading: true, result: "", draft: "", thread: nextThread });
    try {
      let answer = "";
      if (config.apiKey) {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: config.endpoint, apiKey: config.apiKey, model: config.model, paperTitle, question: prompt, selectedText: text, surroundingContext: surrounding, mode: "inline", history: history.slice(-8) }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "模型请求失败");
        answer = payload.content;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 550));
        answer = demoAnswer(prompt, text);
      }
      updateAnnotation(id, { loading: false, result: answer, draft: "", thread: [...nextThread, { id: Date.now() + 1, role: "assistant", content: answer }] });
    } catch (error: any) {
      const errorText = `连接模型时遇到问题：${error?.message || "请检查 API 设置"}`;
      updateAnnotation(id, { loading: false, result: errorText, thread: [...nextThread, { id: Date.now() + 1, role: "assistant", content: errorText }] });
    }
  }, [config, paperTitle, updateAnnotation]);

  const handleSelection = useCallback(() => {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = trimRangeToText(selection.getRangeAt(0));
    const text = range.toString().replace(/\s+/g, " ").trim();
    if (!text || text.length < 2) return;
    selection.removeAllRanges();
    selection.addRange(range);
    if (!readerRef.current?.contains(range.commonAncestorContainer)) return;
    const readerRect = readerRef.current.getBoundingClientRect();
    const node = range.commonAncestorContainer.nodeType === Node.TEXT_NODE ? range.commonAncestorContainer.parentElement : range.commonAncestorContainer as HTMLElement;
    const contextRoot = node?.closest?.(".pdf-page, .demo-paper") as HTMLElement | null;
    const pageRect = contextRoot?.getBoundingClientRect();
    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > .5 && rect.height > 2 && (!pageRect || (rect.left >= pageRect.left - 2 && rect.right <= pageRect.right + 2)));
    const rect = rects[rects.length - 1] || range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    const blockText = (contextRoot?.innerText || node?.parentElement?.innerText || text).replace(/\s+/g, " ").trim();
    const needle = text.slice(0, 90);
    const index = blockText.indexOf(needle);
    const surrounding = index >= 0 ? blockText.slice(Math.max(0, index - 700), Math.min(blockText.length, index + text.length + 700)) : blockText.slice(0, 1600);
    const anchorLeft = Math.min(rect.right, pageRect?.right || rect.right) - readerRect.left + readerRef.current.scrollLeft + 7;
    const anchorTop = rect.top - readerRect.top + readerRef.current.scrollTop + Math.min(rect.height / 2, 18);
    const visibleRight = readerRef.current.scrollLeft + readerRef.current.clientWidth;
    const pageNumber = Number(contextRoot?.dataset.pageNumber || 1);
    setSelectedText(text.slice(0, 1800));
    setSelectionContext(surrounding);
    selectionRangeRef.current = range.cloneRange();
    setSelectionAnchor({ top: anchorTop, left: anchorLeft, cardTop: anchorTop + 15, cardLeft: anchorLeft + 358 > visibleRight ? Math.max(readerRef.current.scrollLeft + 14, anchorLeft - 360) : anchorLeft + 15, pageNumber });
    setSelectionPos({ x: Math.min(Math.max(rect.left + Math.min(rect.width / 2, 100), 190), window.innerWidth - 220), y: Math.max(rect.top - 58, 72) });
    setShowColors(false);
    setShowReaderTip(false);
  }, []);

  const createAnnotation = useCallback((kind: ToolAction | "highlight", color: HighlightColor = "green") => {
    if (!selectedText || !selectionAnchor || !selectionRangeRef.current) return;
    const id = Date.now() + Math.floor(Math.random() * 1000);
    const annotation: Annotation = { id, kind, color, text: selectedText, surrounding: selectionContext, ...selectionAnchor, open: kind !== "highlight", loading: false, result: "", draft: "", thread: [] };
    addAnnotationRange(id, selectionRangeRef.current, color, kind === "highlight");
    setAnnotations((items) => [...items, annotation]);
    setSelectionPos(null);
    setShowColors(false);
    window.getSelection()?.removeAllRanges();
    if (kind === "translate" || kind === "explain") void requestInlineAnswer(id, kind, selectedText, selectionContext);
    if (kind !== "highlight") window.setTimeout(() => flashAnnotationRange(id), 0);
    setSelectedText("");
    setSelectionContext("");
    selectionRangeRef.current = null;
  }, [addAnnotationRange, flashAnnotationRange, requestInlineAnswer, selectedText, selectionAnchor, selectionContext]);

  const removeAnnotation = useCallback((id: number) => {
    const stored = annotationRangesRef.current.get(id);
    const timer = flashTimersRef.current.get(id);
    if (timer) window.clearTimeout(timer);
    flashTimersRef.current.delete(id);
    activeRangeIdsRef.current.delete(id);
    annotationRangesRef.current.delete(id);
    if (stored) refreshHighlights(stored.color);
    setAnnotations((items) => items.filter((item) => item.id !== id));
  }, [refreshHighlights]);

  const closeAnnotation = useCallback((annotation: Annotation) => {
    const timer = flashTimersRef.current.get(annotation.id);
    if (timer) window.clearTimeout(timer);
    flashTimersRef.current.delete(annotation.id);
    activeRangeIdsRef.current.delete(annotation.id);
    refreshHighlights(annotation.color);
    updateAnnotation(annotation.id, { open: false });
  }, [refreshHighlights, updateAnnotation]);

  const openAnnotationFromPin = useCallback((annotation: Annotation) => {
    if (lastDraggedPinRef.current === annotation.id) return;
    const reader = readerRef.current;
    if (!reader) return;
    const visibleRight = reader.scrollLeft + reader.clientWidth;
    const cardLeft = annotation.left + 358 > visibleRight ? Math.max(reader.scrollLeft + 14, annotation.left - 360) : annotation.left + 15;
    const cardTop = Math.max(reader.scrollTop + 8, Math.min(reader.scrollTop + reader.clientHeight - 110, annotation.top + 15));
    updateAnnotation(annotation.id, { open: true, cardLeft, cardTop });
    flashAnnotationRange(annotation.id);
  }, [flashAnnotationRange, updateAnnotation]);

  const clearPaperAnnotations = useCallback(() => {
    flashTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    flashTimersRef.current.clear();
    activeRangeIdsRef.current.clear();
    annotationRangesRef.current.clear();
    if ((CSS as any).highlights) (["yellow", "green", "blue", "rose"] as HighlightColor[]).forEach((color) => (CSS as any).highlights.delete(`lumen-${color}`));
    setAnnotations([]);
    setSelectedText("");
    setSelectionPos(null);
  }, []);

  useEffect(() => {
    const reader = readerRef.current;
    if (!reader || !annotations.length) return;
    const restoreRanges = () => {
      for (const annotation of annotations) {
        if (annotationRangesRef.current.has(annotation.id)) continue;
        const page = reader.querySelector(`[data-page-number="${annotation.pageNumber || 1}"]`);
        const textRoot = page?.querySelector(".textLayer") || page;
        if (!textRoot) continue;
        const range = findTextRange(textRoot, annotation.text);
        if (range) addAnnotationRange(annotation.id, range, annotation.color, annotation.kind === "highlight");
      }
    };
    restoreRanges();
    const observer = new MutationObserver(restoreRanges);
    observer.observe(reader, { childList: true, subtree: true });
    const timer = window.setTimeout(() => observer.disconnect(), 15000);
    return () => { observer.disconnect(); window.clearTimeout(timer); };
  }, [addAnnotationRange, annotations, source]);

  useEffect(() => {
    if (!hydrated || !user || !paperId || !paperSourceKind) return;
    setSaveStatus("saving");
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch("/api/workspace", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            paper: {
              id: paperId,
              title: paperTitle,
              meta: paperMeta,
              sourceKind: paperSourceKind,
              sourceUrl: paperSourceUrl,
              paperText,
              pageCount,
            },
            currentPage,
            zoom,
            rightOpen,
            messages,
            annotations: annotations.map((annotation) => ({ ...annotation, loading: false, draft: "" })),
          }),
        });
        if (!response.ok) throw new Error("save failed");
        setSaveStatus("saved");
      } catch {
        setSaveStatus("error");
      }
    }, 900);
    return () => window.clearTimeout(timer);
  }, [annotations, currentPage, hydrated, messages, pageCount, paperId, paperMeta, paperSourceKind, paperSourceUrl, paperText, paperTitle, rightOpen, user, zoom]);

  const openUrl = (raw: string) => {
    const normalized = normalizePaperUrl(raw);
    if (!/^https?:\/\//i.test(normalized)) { setToast("请输入有效的公开链接"); return; }
    clearPaperAnnotations();
    setPaperId(crypto.randomUUID());
    setPaperSourceKind("remote");
    setPaperSourceUrl(normalized);
    setExtractingText(true);
    setPaperText("");
    setSource(`/api/pdf?url=${encodeURIComponent(normalized)}`);
    const arxivId = normalized.match(/arxiv\.org\/pdf\/([^?#/]+)/i)?.[1];
    setPaperTitle(arxivId ? `arXiv ${arxivId}` : "正在读取论文…");
    setPaperMeta(`${new URL(normalized).hostname} · 真实 PDF`);
    setMessages([{ id: Date.now(), role: "assistant", content: "论文正在解析。文字提取完成后，我会在这里基于**全文上下文**回答问题。" }]);
    setOpenModal(false);
    setToast("论文已加入阅读区");
  };

  const openFile = async (file: File) => {
    if (!user) { setToast("请先登录再上传 PDF"); return; }
    setExtractingText(true);
    setToast("正在保存并打开 PDF…");
    try {
      const response = await fetch("/api/papers/upload", {
        method: "POST",
        headers: { "Content-Type": "application/pdf", "x-file-name": encodeURIComponent(file.name) },
        body: file,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "上传失败");
      clearPaperAnnotations();
      setPaperId(payload.paper.id);
      setPaperSourceKind("upload");
      setPaperSourceUrl(null);
      setPaperText("");
      setSource(`/api/papers/${payload.paper.id}/file`);
      setPaperTitle(payload.paper.title);
      setPaperMeta(payload.paper.meta);
      setMessages([{ id: Date.now(), role: "assistant", content: "上传的论文正在解析。完成后，我会在这里基于**全文上下文**回答问题。" }]);
      setOpenModal(false);
      setToast("PDF 已保存到你的账户");
    } catch (error: any) {
      setExtractingText(false);
      setToast(`上传失败：${error?.message || "请稍后重试"}`);
    }
  };

  const handlePdfReady = useCallback((pages: number) => {
    setPageCount(pages);
    setPaperTitle((title) => title === "正在读取论文…" ? "已载入的研究论文" : title);
    setToast(`真实 PDF 已打开 · ${pages} 页`);
  }, []);

  const handleTextExtracted = useCallback((text: string) => {
    const restoring = restoringWorkspaceRef.current;
    restoringWorkspaceRef.current = false;
    setPaperText(text);
    setExtractingText(false);
    if (!restoring) setMessages([{ id: Date.now(), role: "assistant", content: text ? `全文文字已经准备好（约 **${text.length.toLocaleString()}** 个字符）。现在可以询问整篇论文的方法、实验、结论和局限。` : "PDF 已打开，但没有提取到可搜索文字；它可能是扫描版，需要接入 OCR。" }]);
  }, []);

  const handlePdfError = useCallback((msg: string) => {
    setToast(`加载失败：${msg.slice(0, 70)}`);
    setExtractingText(false);
    setSource(null);
  }, []);

  const startGuestSession = async () => {
    if (guestSubmitting) return;
    setGuestSubmitting(true);
    setAuthMessage("");
    try {
      const response = await fetch("/api/auth/guest", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "暂时无法进入游客模式");
      window.location.assign("/");
    } catch (error: any) {
      setAuthMessage(error?.message || "暂时无法进入游客模式");
      setGuestSubmitting(false);
    }
  };

  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 2200); return () => clearTimeout(timer); }, [toast]);

  return (
    <main className={`app-shell ${rightOpen ? "right-open" : "right-closed"}`}>
      <aside className="app-rail">
        <BrandMark />
        <nav className="rail-nav">
          <RailButton icon={<BookOpen size={20} />} label="阅读器" active />
          <RailButton icon={<Library size={20} />} label="我的文库" onClick={() => setToast("当前论文、聊天与批注已自动同步")} />
          <RailButton icon={<Search size={20} />} label="探索论文" onClick={() => setOpenModal(true)} />
          <RailButton icon={<Highlighter size={20} />} label="批注" onClick={() => setToast("选中文字即可开始批注")} />
        </nav>
        <div className="rail-bottom">
          <RailButton icon={<CircleHelp size={20} />} label="使用帮助" onClick={() => setToast("提示：先选中文字，再选择翻译或解释")} />
          <RailButton icon={<Settings size={20} />} label="设置" onClick={() => setSettingsOpen(true)} />
          <button className="avatar" aria-label="个人资料" onClick={() => setAccountOpen(!accountOpen)}>{(user?.displayName || user?.email || "W").slice(0, 1).toUpperCase()}</button>
          {accountOpen && user && <div className="account-popover"><strong>{user.displayName}</strong><span>{user.isGuest ? "当前浏览器的游客空间" : user.email}</span><div className={`account-sync ${saveStatus}`}><Cloud size={13} />{saveStatus === "saving" ? "正在同步" : saveStatus === "error" ? "同步遇到问题" : "已同步到云端"}</div><a href="/api/auth/logout"><LogOut size={13} />退出登录</a></div>}
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
            <div className={`sync-status ${saveStatus}`} title="阅读进度、聊天和批注会自动保存">{saveStatus === "error" ? <CloudOff size={14} /> : <Cloud size={14} />}<span>{saveStatus === "loading" ? "正在载入" : saveStatus === "saving" ? "正在保存" : saveStatus === "error" ? "同步失败" : "已保存"}</span></div>
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
            <PdfDocument source={source} zoom={zoom} onReady={handlePdfReady} onTextExtracted={handleTextExtracted} onError={handlePdfError} />
          ) : <div style={{ transform: `scale(${zoom})`, transformOrigin: "top center" }}><DemoPaper /></div>}
          {annotations.map((annotation) => (
            <React.Fragment key={annotation.id}>
              <button
                className={`annotation-pin ${annotation.color} ${draggingId === annotation.id ? "dragging" : ""}`}
                style={{ top: annotation.top, left: annotation.left }}
                onPointerDown={(event) => startAnnotationDrag(event, annotation, "pin")}
                onClick={() => annotation.open ? closeAnnotation(annotation) : openAnnotationFromPin(annotation)}
                aria-label="打开原文旁批注"
                title="拖动图标；点击定位原文"
              >
                {annotation.kind === "translate" ? <Languages size={14} /> : annotation.kind === "explain" ? <Sparkles size={14} /> : annotation.kind === "ask" ? <MessageSquareText size={14} /> : <Highlighter size={14} />}
              </button>
              {annotation.open && (
                <section className={`inline-card ${annotation.color} ${draggingId === annotation.id ? "dragging" : ""}`} style={{ top: annotation.cardTop, left: annotation.cardLeft }} onMouseDown={(event) => event.stopPropagation()}>
                  <header onPointerDown={(event) => startAnnotationDrag(event, annotation, "card")} title="拖动移动悬浮卡片">
                    <div className="inline-card-title">
                      <MoreHorizontal className="drag-grip" size={15} />
                      <span>{annotation.kind === "translate" ? <Languages size={15} /> : annotation.kind === "explain" ? <Sparkles size={15} /> : annotation.kind === "ask" ? <MessageSquareText size={15} /> : <Highlighter size={15} />}</span>
                      <div><strong>{annotation.kind === "translate" ? "局部翻译" : annotation.kind === "explain" ? "段落解释" : annotation.kind === "ask" ? "针对这段提问" : "高亮标记"}</strong><small>仅使用选区与相邻段落</small></div>
                    </div>
                    <button onClick={() => closeAnnotation(annotation)} aria-label="收起批注"><X size={15} /></button>
                  </header>
                  <blockquote>{annotation.text}</blockquote>
                  {annotation.kind === "highlight" && <p className="highlight-saved"><Check size={14} />已保存为{annotation.color === "yellow" ? "黄色" : annotation.color === "green" ? "绿色" : annotation.color === "blue" ? "蓝色" : "玫红色"}高亮</p>}
                  {annotation.thread.length > 0 && <div className="inline-thread">{annotation.thread.map((message) => <div key={message.id} className={`inline-message ${message.role}`}>{message.role === "assistant" ? <MarkdownContent content={message.content} compact /> : <p>{message.content}</p>}</div>)}</div>}
                  {annotation.loading && <div className="inline-thinking"><LoaderCircle className="spin" size={16} />正在结合相邻段落分析…</div>}
                  {annotation.kind !== "highlight" && !annotation.loading && (
                    <div className="inline-ask follow-up">
                      <textarea rows={2} value={annotation.draft} onChange={(event) => updateAnnotation(annotation.id, { draft: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && annotation.draft.trim()) { event.preventDefault(); requestInlineAnswer(annotation.id, annotation.kind as ToolAction, annotation.text, annotation.surrounding, annotation.draft, annotation.thread); } }} placeholder={annotation.thread.length ? "继续追问这段内容…" : "针对这段内容提问…"} autoFocus={annotation.kind === "ask" && annotation.thread.length === 0} />
                      <button disabled={!annotation.draft.trim()} onClick={() => requestInlineAnswer(annotation.id, annotation.kind as ToolAction, annotation.text, annotation.surrounding, annotation.draft, annotation.thread)}><Send size={14} />发送</button>
                    </div>
                  )}
                  <footer><button onClick={() => navigator.clipboard.writeText(annotation.result || annotation.text)}><Copy size={13} />复制</button><button className="delete-note" onClick={() => removeAnnotation(annotation.id)}>删除标记</button></footer>
                </section>
              )}
            </React.Fragment>
          ))}
          {showReaderTip && <div className="reader-tip"><Sparkles size={14} /><span>选中论文中的任何内容，立即翻译或提问</span><button onClick={() => setShowReaderTip(false)} aria-label="关闭提示"><X size={13} /></button></div>}
        </div>
        {!rightOpen && <button className="ai-reopen" onClick={() => setRightOpen(true)}><Sparkles size={16} />全文 AI<PanelRightOpen size={16} /></button>}
      </section>

      <aside className="ai-panel" aria-hidden={!rightOpen}>
        <header className="ai-header">
          <div className="ai-title"><div className="ai-glyph"><Sparkles size={17} /></div><div><h2>全文 AI</h2><span>{extractingText ? "正在提取论文文字…" : paperText ? `全文上下文 · 连续对话 · ${paperText.length.toLocaleString()} 字符` : "演示论文上下文 · 连续对话"}</span></div></div>
          <button className="ai-close-button" onClick={() => setRightOpen(false)} aria-label="关闭 AI 面板"><PanelRightClose size={16} />收起</button>
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
                {message.role === "assistant" ? <MarkdownContent content={message.content} /> : <p>{message.content}</p>}
                {message.role === "assistant" && <div className="message-tools"><button aria-label="复制回答" onClick={() => navigator.clipboard.writeText(message.content)}><Copy size={13} /></button><button aria-label="有帮助"><Check size={13} /></button></div>}
              </div>
            </div>
          ))}
          {loading && <div className="message assistant"><div className="message-avatar"><Sparkles size={14} /></div><div className="thinking"><span /><span /><span /></div></div>}
        </div>
        <div className="composer-wrap">
          <div className="global-context-chip"><BookOpen size={13} /><span>整篇论文</span><small>{extractingText ? "解析中" : paperText ? "上下文已就绪" : "等待文字"}</small></div>
          <div className="composer">
            <textarea value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendQuestion(question); } }} placeholder="询问整篇论文…" rows={2} />
            <div className="composer-bottom"><span>⌘ ↵</span><button onClick={() => sendQuestion(question)} disabled={!question.trim() || loading || extractingText} aria-label="发送"><Send size={16} /></button></div>
          </div>
          <p className="ai-disclaimer">AI 可能会出错，请核对重要结论</p>
        </div>
      </aside>

      {selectionPos && (
        <div className="selection-menu" style={{ left: selectionPos.x, top: selectionPos.y }}>
          <button onClick={() => createAnnotation("translate", "green")}><Languages size={15} />翻译</button>
          <button onClick={() => createAnnotation("explain", "green")}><Sparkles size={15} />解释</button>
          <button onClick={() => createAnnotation("ask", "green")}><MessageSquareText size={15} />提问</button>
          <button onClick={() => setShowColors(!showColors)} className={showColors ? "active" : ""}><Palette size={15} />高亮</button>
          <span />
          <button className="menu-icon" aria-label="复制" onClick={async () => { await navigator.clipboard.writeText(selectedText); setCopied(true); setTimeout(() => setCopied(false), 1000); }}>{copied ? <Check size={15} /> : <Copy size={15} />}</button>
          {showColors && <div className="color-picker" aria-label="选择高亮颜色">{(["yellow", "green", "blue", "rose"] as HighlightColor[]).map((color) => <button key={color} className={color} aria-label={`${color} 高亮`} onClick={() => createAnnotation("highlight", color)} />)}</div>}
        </div>
      )}
      {openModal && <OpenPaperModal onClose={() => setOpenModal(false)} onOpenUrl={openUrl} onOpenFile={openFile} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} config={config} setConfig={setConfig} />}
      {toast && <div className="toast"><Check size={15} />{toast}</div>}
      {!authReady && <div className="auth-gate"><div className="auth-card"><BrandMark /><LoaderCircle className="spin" size={22} /><h2>正在确认登录状态</h2><p>正在安全地读取你的论文空间…</p></div></div>}
      {authReady && !user && <div className="auth-gate"><div className="auth-card"><BrandMark /><h2>开始使用 Lumen Paper</h2><p>暂时不配置登录也没关系，可以先用游客身份继续阅读和测试。</p><button className="primary-button wide auth-guest" onClick={startGuestSession} disabled={guestSubmitting}>{guestSubmitting ? <><LoaderCircle className="spin" size={15} />正在创建游客空间</> : "游客试用"}</button><div className="auth-divider"><span>以后再登录</span></div><a className="auth-google wide" href="/api/auth/google"><span>G</span>使用 Google 继续</a>{authMessage && <div className="auth-message">{authMessage}</div>}<small>游客数据只绑定当前浏览器；清除 Cookie 后无法恢复，也不能跨设备同步。</small></div></div>}
    </main>
  );
}
