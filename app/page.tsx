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
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { DEFAULT_PROMPTS, type PromptConfig } from "./chat-prompts";

type ChatMessage = { id: number; role: "user" | "assistant"; content: string };
type ToolAction = "translate" | "explain" | "ask" | "formula";
type HighlightColor = "yellow" | "green" | "blue" | "rose";
type Annotation = {
  id: number;
  kind: ToolAction | "highlight" | "text-note";
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
  pinOffsetX?: number;
  pinOffsetY?: number;
  cardOffsetX?: number;
  cardOffsetY?: number;
  note?: string;
  fontSize?: number;
  textColor?: string;
  pageX?: number;
  pageY?: number;
};
type FormulaAnchor = { text: string; pageNumber: number; pageX: number; pageY: number };
type SessionUser = { displayName: string; email: string; fullName: string | null; isGuest: boolean; isLocal?: boolean };
type PaperSourceKind = "remote" | "upload";
type LibraryPaper = { id: string; folderId: string | null; title: string; meta: string; sourceKind: PaperSourceKind; pageCount: number; createdAt: string; updatedAt: string };
type LibraryFolder = { id: string; name: string; createdAt?: string; updatedAt: string };

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

function normalizedDocumentTitle(raw: unknown) {
  const title = String(raw || "").replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
  if (title.length < 5 || title.length > 300) return "";
  if (/^(untitled|document|paper|microsoft word|arxiv:?\s*[\d.]+)$/i.test(title)) return "";
  return title.replace(/\.pdf$/i, "").trim();
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function titleFromFirstPage(text: string) {
  const firstPage = text.split(/--- PAGE 2 ---/)[0]?.replace(/--- PAGE 1 ---/, "") || "";
  const lines = firstPage.split("\n").map(normalizedDocumentTitle).filter(Boolean).slice(0, 24);
  return lines.find((line) => line.length >= 12 && !/^(arxiv|doi|https?:|www\.|abstract|introduction|proceedings|preprint)/i.test(line) && !line.includes("@")) || "";
}

function shouldPersistAnnotation(annotation: Annotation) {
  if (annotation.kind !== "translate") return true;
  return annotation.thread.filter((message) => message.role === "user").length > 1;
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

function PdfPage({ pdf, pageNumber, zoom, onFormula }: { pdf: any; pageNumber: number; zoom: number; onFormula: (formula: FormulaAnchor) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 760, height: 980 });
  const [formulaAnchors, setFormulaAnchors] = useState<Array<FormulaAnchor & { left: number; top: number }>>([]);

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
      if (cancelled) return;
      const pageRect = textContainer.getBoundingClientRect();
      const rows = new Map<number, { texts: string[]; left: number; right: number; top: number; bottom: number; score: number }>();
      for (const span of Array.from(textContainer.querySelectorAll("span"))) {
        if (span.children.length) continue;
        const value = String(span.textContent || "").trim();
        if (!value) continue;
        const rect = span.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const key = Math.round((rect.top - pageRect.top) / 4);
        const mathScore = /[=≠≤≥∑∫√∞≈∝∈∉⊂⊆∪∩∂∇±×÷→←↦]|[α-ωΑ-Ω]|\b(?:softmax|argmax|log|exp|sim|Top-?k)\b/i.test(value) ? 1 : 0;
        const row = rows.get(key) || { texts: [], left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, score: 0 };
        row.texts.push(value);
        row.left = Math.min(row.left, rect.left);
        row.right = Math.max(row.right, rect.right);
        row.top = Math.min(row.top, rect.top);
        row.bottom = Math.max(row.bottom, rect.bottom);
        row.score += mathScore;
        rows.set(key, row);
      }
      const detected = [...rows.values()].filter((row) => row.score > 0).map((row) => {
        const text = row.texts.join(" ").replace(/\s+/g, " ").trim();
        const pageX = Math.min(.96, Math.max(.04, (row.right - pageRect.left) / Math.max(1, pageRect.width)));
        const pageY = Math.min(.98, Math.max(.02, ((row.top + row.bottom) / 2 - pageRect.top) / Math.max(1, pageRect.height)));
        return { text, pageNumber, pageX, pageY, left: Math.min(viewport.width - 28, row.right - pageRect.left + 7), top: (row.top + row.bottom) / 2 - pageRect.top };
      }).filter((item) => item.text.length >= 3 && item.text.length <= 240).slice(0, 10);
      setFormulaAnchors(detected);
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
      {formulaAnchors.map((formula, index) => <button key={`${Math.round(formula.top)}-${index}`} className="formula-assist" style={{ left: formula.left, top: formula.top }} onClick={(event) => { event.stopPropagation(); onFormula(formula); }} aria-label={`询问第 ${pageNumber} 页公式`} title="询问 AI 这个公式"><Sparkles size={13} /><span>问公式</span></button>)}
    </div>
  );
}

function PdfDocument({ source, zoom, onReady, onMetadata, onFormula, onTextExtracted, onError }: { source: string | Uint8Array; zoom: number; onReady: (pages: number) => void; onMetadata: (title: string) => void; onFormula: (formula: FormulaAnchor) => void; onTextExtracted: (text: string) => void; onError: (message: string) => void }) {
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
          const metadata = await loaded.getMetadata().catch(() => null) as { info?: { Title?: unknown }; metadata?: { get?: (key: string) => unknown } } | null;
          const metadataTitle = normalizedDocumentTitle(metadata?.info?.Title || metadata?.metadata?.get?.("dc:title"));
          if (metadataTitle && !cancelled) onMetadata(metadataTitle);
          const pageTexts: string[] = [];
          const limit = Math.min(loaded.numPages, 80);
          for (let pageNumber = 1; pageNumber <= limit && !cancelled; pageNumber++) {
            const page = await loaded.getPage(pageNumber);
            const content = await page.getTextContent();
            const lines: string[] = [];
            let currentLine: string[] = [];
            let previousY: number | null = null;
            for (const item of content.items as Array<{ str?: unknown; transform?: ArrayLike<number> }>) {
              const value = String(item.str || "").trim();
              if (!value) continue;
              const y = Number(item.transform?.[5] || 0);
              if (previousY !== null && Math.abs(y - previousY) > 2 && currentLine.length) {
                lines.push(currentLine.join(" "));
                currentLine = [];
              }
              currentLine.push(value);
              previousY = y;
            }
            if (currentLine.length) lines.push(currentLine.join(" "));
            pageTexts.push(`--- PAGE ${pageNumber} ---\n${lines.join("\n")}`);
          }
          if (!cancelled) {
            const extracted = pageTexts.join("\n\n").slice(0, 120000);
            if (!metadataTitle) {
              const extractedTitle = titleFromFirstPage(extracted);
              if (extractedTitle) onMetadata(extractedTitle);
            }
            onTextExtracted(extracted);
          }
        })().catch(() => !cancelled && onTextExtracted(""));
      }
    })().catch((error) => !cancelled && onError(error?.message || "PDF 加载失败"));
    return () => {
      cancelled = true;
      task?.destroy?.();
    };
  }, [source, onReady, onMetadata, onTextExtracted, onError]);

  if (!pdf) {
    return <div className="pdf-loading"><LoaderCircle className="spin" size={22} /><span>正在解析论文版面…</span></div>;
  }
  return <div className="pdf-stack">{Array.from({ length: pdf.numPages }, (_, i) => <PdfPage key={i + 1} pdf={pdf} pageNumber={i + 1} zoom={zoom} onFormula={onFormula} />)}</div>;
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

function LibraryModal({ onClose, papers, folders, loading, activePaperId, onOpenPaper, onAddPaper, onCreateFolder, onMovePaper }: { onClose: () => void; papers: LibraryPaper[]; folders: LibraryFolder[]; loading: boolean; activePaperId: string | null; onOpenPaper: (id: string) => void; onAddPaper: () => void; onCreateFolder: (name: string) => Promise<LibraryFolder | null>; onMovePaper: (paperId: string, folderId: string | null) => Promise<boolean> }) {
  const [activeFolder, setActiveFolder] = useState("all");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [folderSaving, setFolderSaving] = useState(false);
  const visiblePapers = activeFolder === "all" ? papers : activeFolder === "unfiled" ? papers.filter((paper) => !paper.folderId) : papers.filter((paper) => paper.folderId === activeFolder);
  const activeFolderName = activeFolder === "all" ? "全部论文" : activeFolder === "unfiled" ? "未分类" : folders.find((folder) => folder.id === activeFolder)?.name || "文件夹";
  const createFolder = async () => {
    const name = folderName.trim();
    if (!name || folderSaving) return;
    setFolderSaving(true);
    const folder = await onCreateFolder(name);
    setFolderSaving(false);
    if (folder) {
      setFolderName("");
      setCreatingFolder(false);
      setActiveFolder(folder.id);
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal-card library-card" role="dialog" aria-modal="true" aria-labelledby="library-title">
        <button className="icon-button modal-close" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        <div className="settings-heading"><div className="modal-icon"><Library size={23} /></div><div><h2 id="library-title">我的文库</h2><p>每篇论文的阅读位置、全文对话和提问批注都会独立保存。</p></div></div>
        <div className="library-browser">
          <aside className="library-folders" aria-label="论文文件夹">
            <button className={activeFolder === "all" ? "active" : ""} onClick={() => setActiveFolder("all")}><Library size={15} /><span>全部论文</span><small>{papers.length}</small></button>
            <button className={activeFolder === "unfiled" ? "active" : ""} onClick={() => setActiveFolder("unfiled")}><FolderOpen size={15} /><span>未分类</span><small>{papers.filter((paper) => !paper.folderId).length}</small></button>
            <div className="folder-divider" />
            {folders.map((folder) => <button key={folder.id} className={activeFolder === folder.id ? "active" : ""} onClick={() => setActiveFolder(folder.id)}><FolderOpen size={15} /><span>{folder.name}</span><small>{papers.filter((paper) => paper.folderId === folder.id).length}</small></button>)}
            {creatingFolder ? <div className="new-folder-row"><input value={folderName} onChange={(event) => setFolderName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createFolder(); if (event.key === "Escape") setCreatingFolder(false); }} placeholder="文件夹名称" autoFocus /><button onClick={() => void createFolder()} disabled={!folderName.trim() || folderSaving} aria-label="创建文件夹">{folderSaving ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}</button></div> : <button className="new-folder-button" onClick={() => setCreatingFolder(true)}><Plus size={14} /><span>新建文件夹</span></button>}
          </aside>
          <section className="library-content">
            <div className="library-content-title"><strong>{activeFolderName}</strong><span>{visiblePapers.length} 篇</span></div>
            {loading ? <div className="library-loading"><LoaderCircle className="spin" size={18} />正在读取文库…</div> : visiblePapers.length ? (
              <div className="library-list">
                {visiblePapers.map((paper) => (
                  <div key={paper.id} className={`library-item ${paper.id === activePaperId ? "active" : ""}`}>
                    <button className="library-paper-button" onClick={() => onOpenPaper(paper.id)}>
                      <span className="library-file"><FileText size={18} /></span>
                      <span className="library-copy"><strong>{paper.title}</strong><small>{paper.meta || `${paper.pageCount} 页`} · {new Date(paper.updatedAt).toLocaleDateString("zh-CN")}</small></span>
                      <span className="library-open">{paper.id === activePaperId ? "正在阅读" : "打开"}</span>
                    </button>
                    <label className="library-folder-select" title="移动到文件夹">
                      <FolderOpen size={12} />
                      <select aria-label={`移动《${paper.title}》到文件夹`} value={paper.folderId || ""} onChange={(event) => void onMovePaper(paper.id, event.target.value || null)}>
                        <option value="">未分类</option>
                        {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                      </select>
                    </label>
                  </div>
                ))}
              </div>
            ) : <div className="library-empty"><FolderOpen size={28} /><strong>{papers.length ? "这个文件夹还是空的" : "文库还是空的"}</strong><p>{papers.length ? "可以从其他文件夹把论文移动到这里。" : "打开链接或上传 PDF 后会自动出现在这里。"}</p></div>}
          </section>
        </div>
        <button className="primary-button wide" onClick={onAddPaper}><Plus size={16} />添加论文</button>
      </div>
    </div>
  );
}

const MODEL_PRESETS: Record<string, { endpoint: string; models: string[] }> = {
  "OpenAI 兼容": { endpoint: "https://api.zhizengzeng.com/v1", models: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "deepseek-chat", "deepseek-reasoner", "gemini-2.5-flash"] },
  OpenAI: { endpoint: "https://api.openai.com/v1", models: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "o4-mini"] },
  DeepSeek: { endpoint: "https://api.deepseek.com", models: ["deepseek-chat", "deepseek-reasoner"] },
  OpenRouter: { endpoint: "https://openrouter.ai/api/v1", models: ["openai/gpt-4.1-mini", "anthropic/claude-3.7-sonnet", "google/gemini-2.5-flash"] },
  Moonshot: { endpoint: "https://api.moonshot.cn/v1", models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"] },
};

function ProviderLogo({ name }: { name: string }) {
  const mark = name === "OpenAI" ? "✺" : name === "DeepSeek" ? "◒" : name === "OpenRouter" ? "⇆" : name === "Moonshot" ? "◐" : "↔";
  return <span className={`provider-logo provider-${name.toLowerCase().replace(/\s+/g, "-")}`} aria-hidden="true">{mark}</span>;
}

function SettingsModal({ onClose, config, setConfig, prompts, setPrompts }: { onClose: () => void; config: ApiConfig; setConfig: (v: ApiConfig) => void; prompts: PromptConfig; setPrompts: (v: PromptConfig) => void }) {
  const [tab, setTab] = useState<"model" | "prompts">("model");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState("");
  const providerModels = MODEL_PRESETS[config.provider]?.models || [];
  const usesCustomModel = !providerModels.includes(config.model);
  const saveSettings = async () => {
    setSaveState("saving");
    setSaveError("");
    try {
      const response = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompts, modelConfig: config }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "设置保存失败");
      setPrompts(payload.prompts);
      setConfig({ ...payload.modelConfig, apiKey: "" });
      sessionStorage.removeItem("lumen-api-key");
      localStorage.removeItem("lumen-api-config");
      setSaveState("saved");
      window.setTimeout(onClose, 650);
    } catch (error: any) { setSaveError(error?.message || "保存失败，请稍后重试"); setSaveState("error"); }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card settings-card" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <button className="icon-button modal-close" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        <div className="settings-heading"><div className="modal-icon"><Bot size={24} /></div><div><h2 id="settings-title">AI 设置</h2><p>连接模型，并决定两处 AI 怎样回答你。</p></div></div>
        <div className="settings-tabs">
          <button className={tab === "model" ? "active" : ""} onClick={() => setTab("model")}>模型连接</button>
          <button className={tab === "prompts" ? "active" : ""} onClick={() => setTab("prompts")}>回答规则</button>
        </div>
        {tab === "model" ? <div className="settings-pane">
          <div className="preset-row">
            {Object.entries(MODEL_PRESETS).map(([name, value]) => (
              <button key={name} className={config.provider === name ? "selected" : ""} onClick={() => setConfig({ ...config, provider: name, endpoint: value.endpoint, model: value.models[0] })}><ProviderLogo name={name} /><span>{name}</span></button>
            ))}
          </div>
          <label className="field-label">API Base URL<input value={config.endpoint} onChange={(e) => setConfig({ ...config, endpoint: e.target.value })} placeholder="https://api.example.com/v1" /></label>
          <label className="field-label">模型
            <select value={usesCustomModel ? "__custom" : config.model} onChange={(event) => setConfig({ ...config, model: event.target.value === "__custom" ? "" : event.target.value })}>
              {providerModels.map((model) => <option key={model} value={model}>{model}</option>)}
              <option value="__custom">自定义模型…</option>
            </select>
          </label>
          {usesCustomModel && <label className="field-label custom-model-field">自定义模型名称<input value={config.model} onChange={(event) => setConfig({ ...config, model: event.target.value })} placeholder="输入接口支持的模型 ID" autoFocus /></label>}
          <label className="field-label">API Key<input type="password" value={config.apiKey} onChange={(e) => setConfig({ ...config, apiKey: e.target.value })} placeholder={config.hasApiKey ? "************" : "输入 API Key"} /></label>
          {!config.hasApiKey && <div className="settings-note"><Check size={14} />密钥会加密保存在本机，之后无需重复填写。</div>}
        </div> : <div className="settings-pane prompt-pane">
          <div className="prompt-field">
            <div><strong>全文对话</strong><span>对应右侧“全文 AI”的总结、方法分析和连续追问。</span><button onClick={() => setPrompts({ ...prompts, global: DEFAULT_PROMPTS.global })}>恢复默认</button></div>
            <textarea value={prompts.global} onChange={(event) => setPrompts({ ...prompts, global: event.target.value })} />
          </div>
          <div className="prompt-field">
            <div><strong>划词悬浮</strong><span>对应选中文字后的翻译、解释和悬浮框内追问。</span><button onClick={() => setPrompts({ ...prompts, inline: DEFAULT_PROMPTS.inline })}>恢复默认</button></div>
            <textarea value={prompts.inline} onChange={(event) => setPrompts({ ...prompts, inline: event.target.value })} />
          </div>
          <div className="settings-note">可使用 <code>{"{{paperTitle}}"}</code> 代表当前论文标题；修改后会同步到你的账户。</div>
        </div>}
        {saveState === "error" && <div className="settings-error">{saveError}</div>}
        <button className="primary-button wide" onClick={saveSettings} disabled={saveState === "saving" || !prompts.global.trim() || !prompts.inline.trim() || !config.endpoint.trim() || !config.model.trim()}>{saveState === "saving" ? <><LoaderCircle className="spin" size={16} />正在保存</> : saveState === "saved" ? <><Check size={17} />已保存</> : "保存设置"}</button>
      </div>
    </div>
  );
}

type ApiConfig = { provider: string; endpoint: string; model: string; apiKey: string; hasApiKey: boolean };

export default function Home() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const [guestSubmitting, setGuestSubmitting] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"loading" | "saved" | "saving" | "error">("loading");
  const [hydrated, setHydrated] = useState(false);
  const [openModal, setOpenModal] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryPapers, setLibraryPapers] = useState<LibraryPaper[]>([]);
  const [libraryFolders, setLibraryFolders] = useState<LibraryFolder[]>([]);
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
  const [pdfContextMenu, setPdfContextMenu] = useState<{ x: number; y: number; pageNumber: number; pageX: number; pageY: number } | null>(null);
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
  const annotationAnchorsRef = useRef(new Map<number, { top: number; left: number }>());
  const activeRangeIdsRef = useRef(new Set<number>());
  const flashTimersRef = useRef(new Map<number, number>());
  const dragRef = useRef<{ id: number; target: "card" | "pin"; startX: number; startY: number; startLeft: number; startTop: number } | null>(null);
  const lastDraggedPinRef = useRef<number | null>(null);
  const restoringWorkspaceRef = useRef(false);
  const [config, setConfig] = useState<ApiConfig>({ provider: "OpenAI", endpoint: "https://api.openai.com/v1", model: "gpt-4.1-mini", apiKey: "", hasApiKey: false });
  const [promptConfig, setPromptConfig] = useState<PromptConfig>(DEFAULT_PROMPTS);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: 1, role: "assistant", content: "这里是**全文对话**。我会基于整篇论文回答总结、方法、实验与结论问题；局部翻译和解释会留在原文旁边。" },
  ]);
  const persistentAnnotationsJson = useMemo(() => JSON.stringify(annotations.filter(shouldPersistAnnotation).map((annotation) => ({ ...annotation, loading: false, draft: "" }))), [annotations]);

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
        const settingsResponse = await fetch("/api/settings", { cache: "no-store" });
        if (settingsResponse.ok) {
          const settingsPayload = await settingsResponse.json();
          if (settingsPayload?.prompts?.global && settingsPayload?.prompts?.inline) setPromptConfig(settingsPayload.prompts);
          if (settingsPayload?.modelConfig) setConfig({ ...settingsPayload.modelConfig, apiKey: "" });
        }
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
      if (config.apiKey || config.hasApiKey) {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: config.endpoint, apiKey: config.apiKey || undefined, model: config.model, paperTitle, question: text, paperContext: paperText, mode: "global", history: messages.slice(-10), systemPrompts: promptConfig }),
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
  }, [config, loading, messages, paperText, paperTitle, promptConfig]);

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
      const anchor = annotationAnchorsRef.current.get(drag.id);
      if (drag.target === "card") {
        const cardLeft = Math.min(maxLeft, Math.max(minLeft, nextLeft));
        const cardTop = Math.min(maxTop, Math.max(minTop, nextTop));
        updateAnnotation(drag.id, { cardLeft, cardTop, ...(anchor ? { cardOffsetX: cardLeft - anchor.left, cardOffsetY: cardTop - anchor.top } : {}) });
      } else {
        const left = Math.min(reader.scrollLeft + reader.clientWidth - 30, Math.max(reader.scrollLeft + 4, nextLeft));
        const top = Math.min(reader.scrollTop + reader.clientHeight - 20, Math.max(reader.scrollTop + 12, nextTop));
        updateAnnotation(drag.id, { left, top, ...(anchor ? { pinOffsetX: left - anchor.left, pinOffsetY: top - anchor.top } : {}) });
      }
    };
    const end = () => { dragRef.current = null; setDraggingId(null); window.setTimeout(() => { lastDraggedPinRef.current = null; }, 0); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); };
  }, [updateAnnotation]);

  const requestInlineAnswer = useCallback(async (id: number, action: ToolAction, text: string, surrounding: string, customQuestion?: string, history: ChatMessage[] = []) => {
    const prompt = customQuestion || (action === "translate" ? "请将选中的内容准确翻译成中文，保留公式与专业术语，并简短标注关键术语。" : action === "formula" ? "请逐项解释这个公式：说明每个符号、公式的直觉含义、它在论文中的作用，以及阅读时应注意的假设。" : "请直观解释选中内容的含义、它在本段中的作用，以及读者容易误解的地方。");
    const userMessage: ChatMessage = { id: Date.now(), role: "user", content: customQuestion || (action === "translate" ? "翻译这段内容" : action === "formula" ? "解释这个公式" : action === "explain" ? "解释这段内容" : prompt) };
    const nextThread = [...history, userMessage];
    updateAnnotation(id, { loading: true, result: "", draft: "", thread: nextThread });
    try {
      let answer = "";
      if (config.apiKey || config.hasApiKey) {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: config.endpoint, apiKey: config.apiKey || undefined, model: config.model, paperTitle, question: prompt, selectedText: text, surroundingContext: surrounding, mode: "inline", history: history.slice(-10), systemPrompts: promptConfig }),
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
  }, [config, paperTitle, promptConfig, updateAnnotation]);

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
    const annotation: Annotation = { id, kind, color, text: selectedText, surrounding: selectionContext, ...selectionAnchor, pinOffsetX: 0, pinOffsetY: 0, cardOffsetX: selectionAnchor.cardLeft - selectionAnchor.left, cardOffsetY: selectionAnchor.cardTop - selectionAnchor.top, open: kind !== "highlight", loading: false, result: "", draft: "", thread: [] };
    annotationAnchorsRef.current.set(id, { top: selectionAnchor.top, left: selectionAnchor.left });
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

  const createFormulaAnnotation = useCallback((formula: FormulaAnchor) => {
    const reader = readerRef.current;
    const page = reader?.querySelector(`[data-page-number="${formula.pageNumber}"]`) as HTMLElement | null;
    if (!reader || !page) return;
    const readerRect = reader.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    const left = pageRect.left - readerRect.left + reader.scrollLeft + formula.pageX * pageRect.width;
    const top = pageRect.top - readerRect.top + reader.scrollTop + formula.pageY * pageRect.height;
    const visibleRight = reader.scrollLeft + reader.clientWidth;
    const id = Date.now() + Math.floor(Math.random() * 1000);
    const cardLeft = left + 358 > visibleRight ? Math.max(reader.scrollLeft + 14, left - 360) : left + 15;
    const cardTop = Math.max(reader.scrollTop + 8, Math.min(reader.scrollTop + reader.clientHeight - 110, top + 15));
    const surrounding = String(page.innerText || formula.text).replace(/\s+/g, " ").slice(0, 2000);
    const annotation: Annotation = { id, kind: "formula", color: "blue", text: formula.text, surrounding, top, left, cardTop, cardLeft, open: true, loading: false, result: "", draft: "", thread: [], pageNumber: formula.pageNumber, pageX: formula.pageX, pageY: formula.pageY, pinOffsetX: 0, pinOffsetY: 0, cardOffsetX: cardLeft - left, cardOffsetY: cardTop - top };
    annotationAnchorsRef.current.set(id, { top, left });
    setAnnotations((items) => [...items, annotation]);
    void requestInlineAnswer(id, "formula", formula.text, surrounding);
  }, [requestInlineAnswer]);

  const handlePdfContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const page = (event.target as HTMLElement).closest(".pdf-page") as HTMLElement | null;
    if (!page) return;
    event.preventDefault();
    const rect = page.getBoundingClientRect();
    setPdfContextMenu({ x: Math.min(event.clientX, window.innerWidth - 210), y: Math.min(event.clientY, window.innerHeight - 110), pageNumber: Number(page.dataset.pageNumber || 1), pageX: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), pageY: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) });
    setSelectionPos(null);
  }, []);

  const createPdfTextNote = useCallback(() => {
    const reader = readerRef.current;
    const context = pdfContextMenu;
    const page = reader?.querySelector(`[data-page-number="${context?.pageNumber || 1}"]`) as HTMLElement | null;
    if (!reader || !page || !context) return;
    const readerRect = reader.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    const left = pageRect.left - readerRect.left + reader.scrollLeft + context.pageX * pageRect.width;
    const top = pageRect.top - readerRect.top + reader.scrollTop + context.pageY * pageRect.height;
    const id = Date.now() + Math.floor(Math.random() * 1000);
    const annotation: Annotation = { id, kind: "text-note", color: "yellow", text: "", surrounding: "", top, left, cardTop: top, cardLeft: left, open: true, loading: false, result: "", draft: "", thread: [], note: "", fontSize: 14, textColor: "#9a5a16", pageNumber: context.pageNumber, pageX: context.pageX, pageY: context.pageY, cardOffsetX: 0, cardOffsetY: 0 };
    annotationAnchorsRef.current.set(id, { top, left });
    setAnnotations((items) => [...items, annotation]);
    setPdfContextMenu(null);
  }, [pdfContextMenu]);

  const removeAnnotation = useCallback((id: number) => {
    const stored = annotationRangesRef.current.get(id);
    const timer = flashTimersRef.current.get(id);
    if (timer) window.clearTimeout(timer);
    flashTimersRef.current.delete(id);
    activeRangeIdsRef.current.delete(id);
    annotationRangesRef.current.delete(id);
    annotationAnchorsRef.current.delete(id);
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
    const anchor = annotationAnchorsRef.current.get(annotation.id) || { top: annotation.top - (annotation.pinOffsetY || 0), left: annotation.left - (annotation.pinOffsetX || 0) };
    updateAnnotation(annotation.id, { open: true, cardLeft, cardTop, cardOffsetX: cardLeft - anchor.left, cardOffsetY: cardTop - anchor.top });
    flashAnnotationRange(annotation.id);
  }, [flashAnnotationRange, updateAnnotation]);

  const clearPaperAnnotations = useCallback(() => {
    flashTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    flashTimersRef.current.clear();
    activeRangeIdsRef.current.clear();
    annotationRangesRef.current.clear();
    annotationAnchorsRef.current.clear();
    if ((CSS as any).highlights) (["yellow", "green", "blue", "rose"] as HighlightColor[]).forEach((color) => (CSS as any).highlights.delete(`lumen-${color}`));
    setAnnotations([]);
    setSelectedText("");
    setSelectionPos(null);
  }, []);

  const realignAnnotations = useCallback(() => {
    const reader = readerRef.current;
    if (!reader || dragRef.current) return;
    const readerRect = reader.getBoundingClientRect();
    setAnnotations((items) => {
      let changed = false;
      const next = items.map((annotation) => {
        if ((annotation.kind === "text-note" || annotation.kind === "formula") && annotation.pageX !== undefined && annotation.pageY !== undefined) {
          const page = reader.querySelector(`[data-page-number="${annotation.pageNumber || 1}"]`) as HTMLElement | null;
          if (!page) return annotation;
          const pageRect = page.getBoundingClientRect();
          const anchor = { left: pageRect.left - readerRect.left + reader.scrollLeft + annotation.pageX * pageRect.width, top: pageRect.top - readerRect.top + reader.scrollTop + annotation.pageY * pageRect.height };
          const previousAnchor = annotationAnchorsRef.current.get(annotation.id);
          const cardOffsetX = annotation.cardOffsetX ?? (previousAnchor ? annotation.cardLeft - previousAnchor.left : 0);
          const cardOffsetY = annotation.cardOffsetY ?? (previousAnchor ? annotation.cardTop - previousAnchor.top : 0);
          const left = anchor.left + (annotation.pinOffsetX || 0);
          const top = anchor.top + (annotation.pinOffsetY || 0);
          const cardLeft = anchor.left + cardOffsetX;
          const cardTop = anchor.top + cardOffsetY;
          annotationAnchorsRef.current.set(annotation.id, anchor);
          if (Math.abs(left - annotation.left) < .5 && Math.abs(top - annotation.top) < .5 && Math.abs(cardLeft - annotation.cardLeft) < .5 && Math.abs(cardTop - annotation.cardTop) < .5) return annotation;
          changed = true;
          return { ...annotation, left, top, cardLeft, cardTop };
        }
        const stored = annotationRangesRef.current.get(annotation.id);
        if (!stored || !stored.range.commonAncestorContainer.isConnected) return annotation;
        const rangeRects = Array.from(stored.range.getClientRects()).filter((rect) => rect.width > .5 && rect.height > 2);
        const rect = rangeRects[rangeRects.length - 1] || stored.range.getBoundingClientRect();
        if (!rect.width && !rect.height) return annotation;
        const node = stored.range.commonAncestorContainer.nodeType === Node.TEXT_NODE ? stored.range.commonAncestorContainer.parentElement : stored.range.commonAncestorContainer as HTMLElement;
        const pageRect = node?.closest?.(".pdf-page, .demo-paper")?.getBoundingClientRect();
        const anchor = {
          left: Math.min(rect.right, pageRect?.right || rect.right) - readerRect.left + reader.scrollLeft + 7,
          top: rect.top - readerRect.top + reader.scrollTop + Math.min(rect.height / 2, 18),
        };
        const previousAnchor = annotationAnchorsRef.current.get(annotation.id);
        const pinOffsetX = annotation.pinOffsetX ?? (previousAnchor ? annotation.left - previousAnchor.left : 0);
        const pinOffsetY = annotation.pinOffsetY ?? (previousAnchor ? annotation.top - previousAnchor.top : 0);
        const cardOffsetX = annotation.cardOffsetX ?? (previousAnchor ? annotation.cardLeft - previousAnchor.left : annotation.cardLeft - annotation.left);
        const cardOffsetY = annotation.cardOffsetY ?? (previousAnchor ? annotation.cardTop - previousAnchor.top : annotation.cardTop - annotation.top);
        const left = anchor.left + pinOffsetX;
        const top = anchor.top + pinOffsetY;
        const cardLeft = Math.min(reader.scrollLeft + Math.max(8, reader.clientWidth - 350), Math.max(reader.scrollLeft + 8, anchor.left + cardOffsetX));
        const cardTop = Math.min(reader.scrollTop + Math.max(8, reader.clientHeight - 110), Math.max(reader.scrollTop + 8, anchor.top + cardOffsetY));
        annotationAnchorsRef.current.set(annotation.id, anchor);
        if (Math.abs(left - annotation.left) < .5 && Math.abs(top - annotation.top) < .5 && Math.abs(cardLeft - annotation.cardLeft) < .5 && Math.abs(cardTop - annotation.cardTop) < .5 && annotation.pinOffsetX !== undefined) return annotation;
        changed = true;
        return { ...annotation, left, top, cardLeft, cardTop, pinOffsetX, pinOffsetY, cardOffsetX: cardLeft - anchor.left, cardOffsetY: cardTop - anchor.top };
      });
      return changed ? next : items;
    });
  }, []);

  useEffect(() => {
    const reader = readerRef.current;
    if (!reader) return;
    let frame = 0;
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(realignAnnotations);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(reader);
    window.addEventListener("resize", schedule);
    schedule();
    return () => { observer.disconnect(); window.removeEventListener("resize", schedule); window.cancelAnimationFrame(frame); };
  }, [realignAnnotations, rightOpen, source, zoom]);

  useEffect(() => {
    const reader = readerRef.current;
    if (!reader || !annotations.length) return;
    const restoreRanges = () => {
      for (const annotation of annotations) {
        if (annotation.kind === "text-note" || annotation.kind === "formula") continue;
        const existing = annotationRangesRef.current.get(annotation.id);
        if (existing?.range.commonAncestorContainer.isConnected) continue;
        if (existing) annotationRangesRef.current.delete(annotation.id);
        const page = reader.querySelector(`[data-page-number="${annotation.pageNumber || 1}"]`);
        const textRoot = page?.querySelector(".textLayer") || page;
        if (!textRoot) continue;
        const range = findTextRange(textRoot, annotation.text);
        if (range) addAnnotationRange(annotation.id, range, annotation.color, annotation.kind === "highlight");
      }
      window.requestAnimationFrame(realignAnnotations);
    };
    restoreRanges();
    const observer = new MutationObserver(restoreRanges);
    observer.observe(reader, { childList: true, subtree: true });
    const timer = window.setTimeout(() => observer.disconnect(), 15000);
    return () => { observer.disconnect(); window.clearTimeout(timer); };
  }, [addAnnotationRange, annotations, realignAnnotations, source]);

  useEffect(() => {
    if (!hydrated || !user || !paperId || !paperSourceKind) return;
    const timer = window.setTimeout(async () => {
      try {
        setSaveStatus("saving");
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
            annotations: JSON.parse(persistentAnnotationsJson),
          }),
        });
        if (!response.ok) throw new Error("save failed");
        setSaveStatus("saved");
      } catch {
        setSaveStatus("error");
      }
    }, 900);
    return () => window.clearTimeout(timer);
  }, [currentPage, hydrated, messages, pageCount, paperId, paperMeta, paperSourceKind, paperSourceUrl, paperText, paperTitle, persistentAnnotationsJson, rightOpen, user, zoom]);

  const showLibrary = useCallback(async () => {
    setLibraryOpen(true);
    setLibraryLoading(true);
    try {
      const response = await fetch("/api/papers", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "无法读取文库");
      setLibraryPapers(Array.isArray(payload.papers) ? payload.papers : []);
      setLibraryFolders(Array.isArray(payload.folders) ? payload.folders : []);
    } catch (error: any) {
      setToast(error?.message || "文库载入失败");
    } finally { setLibraryLoading(false); }
  }, []);

  const createLibraryFolder = useCallback(async (name: string) => {
    try {
      const response = await fetch("/api/folders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "文件夹创建失败");
      const folder = payload.folder as LibraryFolder;
      setLibraryFolders((folders) => [folder, ...folders]);
      setToast(`已创建文件夹“${folder.name}”`);
      return folder;
    } catch (error: unknown) {
      setToast(errorMessage(error, "文件夹创建失败"));
      return null;
    }
  }, []);

  const moveLibraryPaper = useCallback(async (id: string, folderId: string | null) => {
    try {
      const response = await fetch(`/api/papers/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folderId }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "移动论文失败");
      setLibraryPapers((papers) => papers.map((paper) => paper.id === id ? { ...paper, folderId, updatedAt: payload.paper?.updatedAt || paper.updatedAt } : paper));
      setToast(folderId ? "论文已移入文件夹" : "论文已移到未分类");
      return true;
    } catch (error: unknown) {
      setLibraryPapers((papers) => [...papers]);
      setToast(errorMessage(error, "移动论文失败"));
      return false;
    }
  }, []);

  const openLibraryPaper = useCallback(async (id: string) => {
    if (id === paperId) { setLibraryOpen(false); return; }
    setLibraryLoading(true);
    try {
      const response = await fetch(`/api/workspace?paperId=${encodeURIComponent(id)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.workspace?.paper) throw new Error(payload.error || "论文记录不存在");
      const workspace = payload.workspace;
      const paper = workspace.paper;
      restoringWorkspaceRef.current = true;
      clearPaperAnnotations();
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
      setMessages(Array.isArray(workspace.messages) && workspace.messages.length ? workspace.messages : [{ id: Date.now(), role: "assistant", content: "这篇论文已经打开，可以继续提问。" }]);
      setAnnotations((Array.isArray(workspace.annotations) ? workspace.annotations : []).map((item: Annotation) => ({ ...item, loading: false, draft: "", thread: Array.isArray(item.thread) ? item.thread : [], pageNumber: item.pageNumber || 1 })));
      setSource(paper.sourceKind === "upload" ? `/api/papers/${paper.id}/file` : `/api/pdf?url=${encodeURIComponent(paper.sourceUrl)}`);
      setExtractingText(!paper.paperText);
      setLibraryOpen(false);
      setToast("已恢复论文的阅读位置、对话和批注");
    } catch (error: any) {
      setToast(error?.message || "论文打开失败");
    } finally { setLibraryLoading(false); }
  }, [clearPaperAnnotations, paperId]);

  const openUrl = (raw: string) => {
    const normalized = normalizePaperUrl(raw);
    if (!/^https?:\/\//i.test(normalized)) { setToast("请输入有效的公开链接"); return; }
    restoringWorkspaceRef.current = false;
    clearPaperAnnotations();
    setPaperId(crypto.randomUUID());
    setPaperSourceKind("remote");
    setPaperSourceUrl(normalized);
    setExtractingText(true);
    setPaperText("");
    setSource(`/api/pdf?url=${encodeURIComponent(normalized)}`);
    const arxivId = normalized.match(/arxiv\.org\/pdf\/([^?#/]+)/i)?.[1];
    const urlName = decodeURIComponent(new URL(normalized).pathname.split("/").filter(Boolean).pop() || "").replace(/\.pdf$/i, "");
    setPaperTitle(arxivId ? `arXiv ${arxivId}` : normalizedDocumentTitle(urlName) || "正在读取论文…");
    setPaperMeta(`${new URL(normalized).hostname} · 真实 PDF`);
    setMessages([{ id: Date.now(), role: "assistant", content: "论文正在解析。文字提取完成后，我会在这里基于**全文上下文**回答问题。" }]);
    setOpenModal(false);
    setToast("论文已加入阅读区");
  };

  const openFile = async (file: File) => {
    if (!user) { setToast("请先登录再上传 PDF"); return; }
    restoringWorkspaceRef.current = false;
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
    setToast(`真实 PDF 已打开 · ${pages} 页`);
  }, []);

  const handlePaperMetadata = useCallback((title: string) => {
    const normalized = normalizedDocumentTitle(title);
    if (!normalized) return;
    const restoring = restoringWorkspaceRef.current;
    setPaperTitle((current) => {
      const placeholder = /^arXiv\s+[\d.]+(?:v\d+)?$/i.test(current) || /^(正在读取论文|已载入的研究论文|未命名论文)/.test(current);
      return !restoring || placeholder ? normalized : current;
    });
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
          <RailButton icon={<Library size={20} />} label="我的文库" onClick={showLibrary} />
          <RailButton icon={<Search size={20} />} label="探索论文" onClick={() => setOpenModal(true)} />
        </nav>
        <div className="rail-bottom">
          <RailButton icon={<CircleHelp size={20} />} label="使用帮助" onClick={() => setToast("提示：先选中文字，再选择翻译或解释")} />
          <RailButton icon={<Settings size={20} />} label="设置" onClick={() => setSettingsOpen(true)} />
          <button className="avatar" aria-label="个人资料" onClick={() => setAccountOpen(!accountOpen)}>{(user?.displayName || user?.email || "W").slice(0, 1).toUpperCase()}</button>
          {accountOpen && user && <div className="account-popover"><strong>{user.displayName}</strong><span>{user.isLocal ? "本机私人资料库" : user.isGuest ? "当前浏览器的游客空间" : user.email}</span><div className={`account-sync ${saveStatus}`}><Cloud size={13} />{saveStatus === "saving" ? "正在保存" : saveStatus === "error" ? "保存遇到问题" : user.isLocal ? "已保存到本机" : "已同步到云端"}</div>{!user.isLocal && <a href="/api/auth/logout"><LogOut size={13} />退出登录</a>}</div>}
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
            <div className={`sync-status ${saveStatus}`} title="内容变化后会自动写入本地数据库；只有实际写入时才短暂显示保存中">{saveStatus === "error" ? <CloudOff size={14} /> : <Cloud size={14} />}<span>{saveStatus === "loading" ? "读取中" : saveStatus === "saving" ? "保存中" : saveStatus === "error" ? "保存失败" : "本机已保存"}</span></div>
            <button className="status-pill" onClick={() => setSettingsOpen(true)}><span className={`status-dot ${config.apiKey || config.hasApiKey ? "online" : ""}`} />{config.apiKey || config.hasApiKey ? config.model : "演示模型"}<ChevronDown size={14} /></button>
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

        <div className="reader-viewport" ref={readerRef} onMouseUp={handleSelection} onContextMenu={handlePdfContextMenu} onMouseDown={() => pdfContextMenu && setPdfContextMenu(null)} onScroll={() => { if (selectionPos) setSelectionPos(null); if (pdfContextMenu) setPdfContextMenu(null); }}>
          {source ? (
            <PdfDocument source={source} zoom={zoom} onReady={handlePdfReady} onMetadata={handlePaperMetadata} onFormula={createFormulaAnnotation} onTextExtracted={handleTextExtracted} onError={handlePdfError} />
          ) : <div style={{ transform: `scale(${zoom})`, transformOrigin: "top center" }}><DemoPaper /></div>}
          {annotations.map((annotation) => annotation.kind === "text-note" ? (
            <section key={annotation.id} className={`pdf-text-note ${draggingId === annotation.id ? "dragging" : ""}`} style={{ top: annotation.cardTop, left: annotation.cardLeft, color: annotation.textColor || "#9a5a16" }} onMouseDown={(event) => event.stopPropagation()}>
              <header onPointerDown={(event) => startAnnotationDrag(event, annotation, "card")}><span><MoreHorizontal size={13} />PDF 文字批注</span><button onClick={() => removeAnnotation(annotation.id)} aria-label="删除 PDF 批注"><X size={13} /></button></header>
              <textarea value={annotation.note || ""} onChange={(event) => updateAnnotation(annotation.id, { note: event.target.value })} placeholder="输入批注…" autoFocus style={{ fontSize: annotation.fontSize || 14, color: annotation.textColor || "#9a5a16" }} />
              <footer>
                <label>字号<select value={annotation.fontSize || 14} onChange={(event) => updateAnnotation(annotation.id, { fontSize: Number(event.target.value) })}><option value="12">12</option><option value="14">14</option><option value="16">16</option><option value="20">20</option><option value="24">24</option></select></label>
                <div className="note-colors" aria-label="文字颜色">{["#9a5a16", "#b4233b", "#2563a7", "#237052", "#333333"].map((color) => <button key={color} className={annotation.textColor === color ? "active" : ""} style={{ background: color }} onClick={() => updateAnnotation(annotation.id, { textColor: color })} aria-label={`设置颜色 ${color}`} />)}</div>
              </footer>
            </section>
          ) : (
            <React.Fragment key={annotation.id}>
              <button
                className={`annotation-pin ${annotation.color} ${draggingId === annotation.id ? "dragging" : ""}`}
                style={{ top: annotation.top, left: annotation.left }}
                onPointerDown={(event) => startAnnotationDrag(event, annotation, "pin")}
                onClick={() => annotation.open ? closeAnnotation(annotation) : openAnnotationFromPin(annotation)}
                aria-label="打开原文旁批注"
                title="拖动图标；点击定位原文"
              >
                {annotation.kind === "translate" ? <Languages size={14} /> : annotation.kind === "formula" || annotation.kind === "explain" ? <Sparkles size={14} /> : annotation.kind === "ask" ? <MessageSquareText size={14} /> : <Highlighter size={14} />}
              </button>
              {annotation.open && (
                <section className={`inline-card ${annotation.color} ${draggingId === annotation.id ? "dragging" : ""}`} style={{ top: annotation.cardTop, left: annotation.cardLeft }} onMouseDown={(event) => event.stopPropagation()}>
                  <header onPointerDown={(event) => startAnnotationDrag(event, annotation, "card")} title="拖动移动悬浮卡片">
                    <div className="inline-card-title">
                      <MoreHorizontal className="drag-grip" size={15} />
                      <span>{annotation.kind === "translate" ? <Languages size={15} /> : annotation.kind === "formula" || annotation.kind === "explain" ? <Sparkles size={15} /> : annotation.kind === "ask" ? <MessageSquareText size={15} /> : <Highlighter size={15} />}</span>
                      <div><strong>{annotation.kind === "translate" ? "局部翻译" : annotation.kind === "formula" ? "公式解释" : annotation.kind === "explain" ? "段落解释" : annotation.kind === "ask" ? "针对这段提问" : "高亮标记"}</strong><small>{annotation.kind === "translate" && !shouldPersistAnnotation(annotation) ? "临时翻译 · 本次阅读显示" : "仅使用相关原文 · 自动保存"}</small></div>
                    </div>
                    <button onClick={() => closeAnnotation(annotation)} aria-label="收起批注"><X size={15} /></button>
                  </header>
                  <blockquote>{annotation.text}</blockquote>
                  {annotation.kind === "highlight" && <><p className="highlight-saved"><Check size={14} />已保存为{annotation.color === "yellow" ? "黄色" : annotation.color === "green" ? "绿色" : annotation.color === "blue" ? "蓝色" : "玫红色"}高亮</p><label className="highlight-note"><span>个人批注</span><textarea value={annotation.note || ""} onChange={(event) => updateAnnotation(annotation.id, { note: event.target.value })} placeholder="记录你对这段内容的想法…" rows={3} /></label></>}
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
      {pdfContextMenu && <div className="pdf-context-menu" style={{ left: pdfContextMenu.x, top: pdfContextMenu.y }} onMouseDown={(event) => event.stopPropagation()}>
        <button onClick={createPdfTextNote}><MessageSquareText size={15} /><span><strong>添加文字批注</strong><small>写在当前 PDF 位置</small></span></button>
      </div>}
      {openModal && <OpenPaperModal onClose={() => setOpenModal(false)} onOpenUrl={openUrl} onOpenFile={openFile} />}
      {libraryOpen && <LibraryModal onClose={() => setLibraryOpen(false)} papers={libraryPapers} folders={libraryFolders} loading={libraryLoading} activePaperId={paperId} onOpenPaper={openLibraryPaper} onAddPaper={() => { setLibraryOpen(false); setOpenModal(true); }} onCreateFolder={createLibraryFolder} onMovePaper={moveLibraryPaper} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} config={config} setConfig={setConfig} prompts={promptConfig} setPrompts={setPromptConfig} />}
      {toast && <div className="toast"><Check size={15} />{toast}</div>}
      {!authReady && <div className="auth-gate"><div className="auth-card"><BrandMark /><LoaderCircle className="spin" size={22} /><h2>正在确认登录状态</h2><p>正在安全地读取你的论文空间…</p></div></div>}
      {authReady && !user && <div className="auth-gate"><div className="auth-card"><BrandMark /><h2>开始使用 Lumen Paper</h2><p>暂时不配置登录也没关系，可以先用游客身份继续阅读和测试。</p><button className="primary-button wide auth-guest" onClick={startGuestSession} disabled={guestSubmitting}>{guestSubmitting ? <><LoaderCircle className="spin" size={15} />正在创建游客空间</> : "游客试用"}</button><div className="auth-divider"><span>以后再登录</span></div><a className="auth-google wide" href="/api/auth/google"><span>G</span>使用 Google 继续</a>{authMessage && <div className="auth-message">{authMessage}</div>}<small>游客数据只绑定当前浏览器；清除 Cookie 后无法恢复，也不能跨设备同步。</small></div></div>}
    </main>
  );
}
