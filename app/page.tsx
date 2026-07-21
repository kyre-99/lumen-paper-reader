"use client";

import {
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
  Download,
  FileText,
  FolderOpen,
  Globe2,
  Highlighter,
  Hand,
  Languages,
  Library,
  Link2,
  LoaderCircle,
  LogOut,
  Maximize2,
  MessageSquareText,
  Minus,
  MoreHorizontal,
  PanelLeft,
  Palette,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Receipt,
  Send,
  Settings,
  Sparkles,
  SquarePen,
  Trash2,
  Type,
  Upload,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { DEFAULT_PROMPTS, type PromptConfig } from "./chat-prompts";

type ChatMessage = { id: number; role: "user" | "assistant"; content: string; steps?: string[] };
type ChatEffort = "medium" | "high" | "max";
const UI_FONT_SIZES = ["compact", "standard", "large", "xlarge"] as const;
const CHAT_EFFORTS = ["medium", "high", "max"] as const;

// 从 localStorage 读取界面偏好：SSR 与水合阶段用 fallback，挂载后自动切换到保存值，避免水合不一致
function useStoredPref<T extends string>(key: string, fallback: T, valid: readonly T[]): [T, (next: T) => void] {
  const subscribe = React.useCallback((notify: () => void) => {
    const handler = (event: Event) => { if ((event as CustomEvent).detail === key) notify(); };
    window.addEventListener("lumen-pref-change", handler);
    return () => window.removeEventListener("lumen-pref-change", handler);
  }, [key]);
  const value = React.useSyncExternalStore(
    subscribe,
    () => {
      const saved = window.localStorage.getItem(key);
      return (valid as readonly string[]).includes(saved || "") ? (saved as T) : fallback;
    },
    () => fallback,
  );
  const setValue = React.useCallback((next: T) => {
    window.localStorage.setItem(key, next);
    window.dispatchEvent(new CustomEvent("lumen-pref-change", { detail: key }));
  }, [key]);
  return [value, setValue];
}
const CHAT_EFFORT_LEVELS: Array<{ value: ChatEffort; label: string; desc: string }> = [
  { value: "medium", label: "快速", desc: "本地检索，单次回答，零额外调用，最快最省" },
  { value: "high", label: "深入", desc: "智能改写检索词，从全文补充上下文，更准也更贵" },
  { value: "max", label: "研究", desc: "Agent 多轮主动检索翻阅论文，最彻底" },
];

// 解析 /api/chat 的 SSE 流：step 为检索进度，delta 为回答增量；signal 中断时静默退出
async function consumeChatStream(response: Response, handlers: { onStep?: (label: string) => void; onDelta?: (text: string) => void; signal?: AbortSignal }) {
  if (!response.body) throw new Error("连接中断");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let failed: string | null = null;
  for (;;) {
    if (handlers.signal?.aborted) {
      reader.cancel().catch(() => undefined);
      return;
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";
    for (const event of events) {
      const line = event.split("\n").find((item) => item.startsWith("data:"));
      if (!line) continue;
      try {
        const payload = JSON.parse(line.slice(5).trim());
        if (payload.type === "step" && payload.label) handlers.onStep?.(String(payload.label));
        if (payload.type === "delta" && payload.text) handlers.onDelta?.(String(payload.text));
        if (payload.type === "error") failed = String(payload.message || "模型请求失败");
      } catch { /* 忽略不完整分片 */ }
    }
  }
  if (failed) throw new Error(failed);
}
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
  cardWidth?: number;
  cardHeight?: number;
  open: boolean;
  loading: boolean;
  loadingLabel?: string;
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
  formulaRegionX?: number;
  formulaRegionY?: number;
  formulaRegionWidth?: number;
  formulaRegionHeight?: number;
  formulaRegionLeft?: number;
  formulaRegionTop?: number;
  formulaRegionPixelWidth?: number;
  formulaRegionPixelHeight?: number;
};
type FormulaAnchor = { text: string; label?: string; pageNumber: number; pageX: number; pageY: number; regionX: number; regionY: number; regionWidth: number; regionHeight: number };
type SessionUser = { displayName: string; email: string; fullName: string | null; isGuest: boolean; isLocal?: boolean };
type PaperSourceKind = "remote" | "upload";
type PaperStatus = "unread" | "reading" | "done";
const PAPER_STATUS_OPTIONS: Array<{ value: PaperStatus; label: string }> = [
  { value: "unread", label: "未读" },
  { value: "reading", label: "阅读中" },
  { value: "done", label: "已阅读" },
];
type LibraryPaper = { id: string; folderId: string | null; title: string; meta: string; sourceKind: PaperSourceKind; pageCount: number; status: PaperStatus; createdAt: string; updatedAt: string };
type LibraryFolder = { id: string; name: string; createdAt?: string; updatedAt: string };
type UsageStats = {
  totalCalls: number; promptTokens: number; completionTokens: number; totalTokens: number;
  estimatedCost: number | null; currency: string;
  perModel: Array<{ model: string; calls: number; promptTokens: number; completionTokens: number; estimatedCost: number | null }>;
  recent: Array<{ id: string; model: string; mode: string; effort: string; promptTokens: number; completionTokens: number; createdAt: string }>;
};

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

// 判断按下位置是否适合直接触发平移：文字上保持划词选择，按钮/输入框/批注卡片保持原有交互，空白区域才允许左键拖动
function isReaderPanSafeTarget(target: HTMLElement) {
  return !target.closest(".textLayer span, .demo-paper p, .demo-paper h1, .demo-paper h2, .demo-paper .authors, .demo-paper .formula-card, .pdf-text-note, [class*='annotation'], button, a, input, textarea, select, label, .reader-tip");
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

// 需要持久化的批注序列化，自动保存与水合恢复的快照共用，保证两处结果一致
function serializePersistentAnnotations(list: Annotation[]) {
  return JSON.stringify(list.filter(shouldPersistAnnotation).map((annotation) => ({ ...annotation, loading: false, draft: "" })));
}

// 工作区内容快照：用于判断自动保存时内容相对上次保存/恢复是否真的变化过
function workspaceSnapshot(input: { paperId: string; title: string; meta: string; sourceKind: PaperSourceKind; sourceUrl: string | null; paperText: string; pageCount: number; currentPage: number; zoom: number; rightOpen: boolean; messages: ChatMessage[]; annotationsJson: string }) {
  return JSON.stringify(input);
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

type TextCaret = { node: Text; offset: number };
type SelectionOverlayRect = { left: number; top: number; width: number; height: number };

type ClientRectShape = { left: number; top: number; right: number; bottom: number; width: number; height: number };

function tightRangeClientRects(range: Range, contextRoot: Element | null): ClientRectShape[] {
  const textLayer = contextRoot?.matches(".textLayer")
    ? contextRoot
    : contextRoot?.querySelector(".textLayer");
  if (!textLayer) {
    return Array.from(range.getClientRects())
      .filter((rect) => rect.width > .5 && rect.height > 2)
      .map((rect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }));
  }

  const pageRect = textLayer.closest(".pdf-page")?.getBoundingClientRect();
  const fragments: ClientRectShape[] = [];
  for (const span of Array.from(textLayer.querySelectorAll("span"))) {
    if (span.getAttribute("role") === "img") continue;
    const spanRect = span.getBoundingClientRect();
    if (!spanRect.width || !spanRect.height) continue;
    for (const child of Array.from(span.childNodes)) {
      if (child.nodeType !== Node.TEXT_NODE || !child.textContent) continue;
      const textNode = child as Text;
      try {
        if (!range.intersectsNode(textNode)) continue;
      } catch {
        continue;
      }
      const from = textNode === range.startContainer ? range.startOffset : 0;
      const to = textNode === range.endContainer ? range.endOffset : textNode.data.length;
      if (to <= from) continue;
      const slice = textNode.data.slice(from, to);
      if (!slice.trim()) continue;
      // 去掉每个文本片段首尾的空白字符，避免行尾/行首的空格被高亮成多余的空白块
      const tightFrom = from + (slice.match(/^\s+/)?.[0].length || 0);
      const tightTo = to - (slice.match(/\s+$/)?.[0].length || 0);
      if (tightTo <= tightFrom) continue;
      const fragmentRange = document.createRange();
      fragmentRange.setStart(textNode, Math.max(0, Math.min(textNode.data.length, tightFrom)));
      fragmentRange.setEnd(textNode, Math.max(0, Math.min(textNode.data.length, tightTo)));
      for (const fragment of Array.from(fragmentRange.getClientRects())) {
        const left = Math.max(fragment.left, spanRect.left, pageRect?.left || -Infinity);
        const right = Math.min(fragment.right, spanRect.right, pageRect?.right || Infinity);
        const top = Math.max(spanRect.top, pageRect?.top || -Infinity);
        const bottom = Math.min(spanRect.bottom, pageRect?.bottom || Infinity);
        if (right - left <= .5 || bottom - top <= 2) continue;
        fragments.push({ left, top, right, bottom, width: right - left, height: bottom - top });
      }
    }
  }

  const deduped: ClientRectShape[] = [];
  for (const rect of fragments.sort((a, b) => a.top - b.top || a.left - b.left)) {
    const duplicate = deduped.some((item) => {
      const verticalOverlap = Math.max(0, Math.min(item.bottom, rect.bottom) - Math.max(item.top, rect.top));
      const overlapRatio = verticalOverlap / Math.max(1, Math.min(item.height, rect.height));
      return overlapRatio > .72 && Math.abs(item.left - rect.left) < .75 && Math.abs(item.right - rect.right) < .75;
    });
    if (!duplicate) deduped.push(rect);
  }

  const merged: ClientRectShape[] = [];
  for (const rect of deduped) {
    const row = merged.find((item) => {
      const centerDistance = Math.abs((item.top + item.bottom - rect.top - rect.bottom) / 2);
      const gap = rect.left > item.right ? rect.left - item.right : item.left > rect.right ? item.left - rect.right : 0;
      return centerDistance <= Math.max(2, Math.min(item.height, rect.height) * .35) && gap <= Math.max(3, Math.min(item.height, rect.height) * .55);
    });
    if (!row) {
      merged.push({ ...rect });
      continue;
    }
    row.left = Math.min(row.left, rect.left);
    row.right = Math.max(row.right, rect.right);
    row.top = Math.max(row.top, rect.top);
    row.bottom = Math.min(row.bottom, rect.bottom);
    if (row.bottom <= row.top) {
      row.top = Math.min(row.top, rect.top);
      row.bottom = Math.max(row.bottom, rect.bottom);
    }
    row.width = row.right - row.left;
    row.height = row.bottom - row.top;
  }
  return merged.sort((a, b) => a.top - b.top || a.left - b.left);
}

function overlayRectsForRange(range: Range, contextRoot: Element | null, reader: HTMLElement) {
  const readerRect = reader.getBoundingClientRect();
  return tightRangeClientRects(range, contextRoot).map((rect) => ({
    left: rect.left - readerRect.left + reader.scrollLeft,
    top: rect.top - readerRect.top + reader.scrollTop,
    width: rect.width,
    height: rect.height,
  }));
}

function textOffsetAtX(node: Text, x: number) {
  if (!node.data.length) return 0;
  const probe = document.createRange();
  for (let offset = 0; offset < node.data.length; offset++) {
    probe.setStart(node, offset);
    probe.setEnd(node, offset + 1);
    const rect = probe.getBoundingClientRect();
    if (rect.width && x <= rect.left + rect.width / 2) return offset;
  }
  return node.data.length;
}

function textCaretFromPoint(root: Element, x: number, y: number): TextCaret | null {
  const caretDocument = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = caretDocument.caretPositionFromPoint?.(x, y);
  const legacyRange = position ? null : caretDocument.caretRangeFromPoint?.(x, y);
  const nativeNode = position?.offsetNode || legacyRange?.startContainer;
  const nativeOffset = position?.offset ?? legacyRange?.startOffset;
  if (nativeNode?.nodeType === Node.TEXT_NODE && root.contains(nativeNode)) {
    const textNode = nativeNode as Text;
    const span = textNode.parentElement;
    const rootRect = root.getBoundingClientRect();
    const spanRect = span?.getBoundingClientRect();
    const pointerSide = x < rootRect.left + rootRect.width / 2 ? -1 : 1;
    const spanSide = spanRect && spanRect.left + spanRect.width / 2 < rootRect.left + rootRect.width / 2 ? -1 : 1;
    const isNarrowColumnText = Boolean(spanRect && spanRect.width < rootRect.width * .65);
    if (!isNarrowColumnText || pointerSide === spanSide || Math.abs(x - (rootRect.left + rootRect.width / 2)) < rootRect.width * .04) {
      return { node: textNode, offset: Math.min(textNode.data.length, Math.max(0, Number(nativeOffset) || 0)) };
    }
  }

  const rootRect = root.getBoundingClientRect();
  const pointerSide = x < rootRect.left + rootRect.width / 2 ? -1 : 1;
  let closest: { node: Text; rect: DOMRect; score: number } | null = null;
  for (const span of Array.from(root.querySelectorAll("span"))) {
    if (span.getAttribute("role") === "img") continue;
    const node = Array.from(span.childNodes).find((child): child is Text => child.nodeType === Node.TEXT_NODE && Boolean(child.textContent));
    if (!node) continue;
    const rect = span.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const spanSide = rect.left + rect.width / 2 < rootRect.left + rootRect.width / 2 ? -1 : 1;
    if (rect.width < rootRect.width * .65 && spanSide !== pointerSide) continue;
    const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
    const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    const score = dy * 4 + dx;
    if (!closest || score < closest.score) closest = { node, rect, score };
  }
  if (!closest) return null;
  return { node: closest.node, offset: textOffsetAtX(closest.node, x) };
}

function rangeFromPointerPoints(root: Element, start: { x: number; y: number }, end: { x: number; y: number }) {
  const startCaret = textCaretFromPoint(root, start.x, start.y);
  const endCaret = textCaretFromPoint(root, end.x, end.y);
  if (!startCaret || !endCaret) return null;
  const startProbe = document.createRange();
  const endProbe = document.createRange();
  startProbe.setStart(startCaret.node, startCaret.offset);
  startProbe.collapse(true);
  endProbe.setStart(endCaret.node, endCaret.offset);
  endProbe.collapse(true);
  const forward = startProbe.compareBoundaryPoints(Range.START_TO_START, endProbe) <= 0;
  const range = document.createRange();
  const first = forward ? startCaret : endCaret;
  const last = forward ? endCaret : startCaret;
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset);
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

// 把模型常用的 \(...\) 和 \[...\] 公式写法统一转成 $...$ / $$...$$，跳过代码块
function normalizeMathDelimiters(content: string) {
  return content.split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part) => {
    if (part.startsWith("`")) return part;
    return part
      .replace(/\\\[([\s\S]*?)\\\]/g, (_match, tex) => `$$${tex}$$`)
      .replace(/\\\(([\s\S]*?)\\\)/g, (_match, tex) => `$${tex}$`);
  }).join("");
}

// memo 包裹：流式输出时只有当前消息变化，历史消息不必重新跑 Markdown/KaTeX 解析
const MarkdownContent = React.memo(function MarkdownContent({ content, compact = false }: { content: string; compact?: boolean }) {
  return (
    <div className={`markdown-content${compact ? " compact" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
        components={{
          a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
        }}
      >
        {normalizeMathDelimiters(content)}
      </ReactMarkdown>
    </div>
  );
});

function BrandMark() {
  return (
    <div className="brand-mark" aria-label="文枢 Wenshu" role="img">
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs>
          <linearGradient id="brand-gradient" x1="2" y1="1" x2="22" y2="23" gradientUnits="userSpaceOnUse">
            <stop stopColor="#4BA07E" />
            <stop offset="0.55" stopColor="#2F6C5B" />
            <stop offset="1" stopColor="#234F43" />
          </linearGradient>
        </defs>
        <rect width="24" height="24" rx="6" fill="url(#brand-gradient)" />
        <path d="M4.6 10.4C6.9 9.1 9.5 9.1 12 10.9C14.5 9.1 17.1 9.1 19.4 10.4V17.4C17.1 16.1 14.5 16.1 12 17.9C9.5 16.1 6.9 16.1 4.6 17.4V10.4Z" fill="#F7FBF8" />
        <path d="M12 10.9V17.9" stroke="#2F6C5B" strokeWidth="0.9" />
        <path d="M6.4 11.8C7.6 11.3 8.9 11.4 10.2 12.1" stroke="#7FB5A2" strokeWidth="0.8" strokeLinecap="round" />
        <path d="M6.4 13.9C7.6 13.4 8.9 13.5 10.2 14.2" stroke="#7FB5A2" strokeWidth="0.8" strokeLinecap="round" />
        <path d="M13.8 12.1C15.1 11.4 16.4 11.3 17.6 11.8" stroke="#7FB5A2" strokeWidth="0.8" strokeLinecap="round" />
        <path d="M13.8 14.2C15.1 13.5 16.4 13.4 17.6 13.9" stroke="#7FB5A2" strokeWidth="0.8" strokeLinecap="round" />
        <path d="M17.7 3.2L18.42 5.15L20.37 5.87L18.42 6.59L17.7 8.54L16.98 6.59L15.03 5.87L16.98 5.15L17.7 3.2Z" fill="#F2B764" />
      </svg>
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

function EffortControl({ effort, onChange }: { effort: ChatEffort; onChange: (value: ChatEffort) => void }) {
  const effortIndex = CHAT_EFFORT_LEVELS.findIndex((level) => level.value === effort);
  const current = CHAT_EFFORT_LEVELS[effortIndex] || CHAT_EFFORT_LEVELS[0];
  return (
    <div className={`effort-control level-${effortIndex}`} title={`全文对话 · 思考力度 · ${current.label}：${current.desc}`}>
      <Zap size={15} className="effort-zap" />
      <span className="effort-caption">思考力度</span>
      <input type="range" min={0} max={2} step={1} value={effortIndex} onChange={(event) => onChange(CHAT_EFFORT_LEVELS[Number(event.target.value)].value)} style={{ "--fill": `${effortIndex * 50}%` } as React.CSSProperties} aria-label="AI 思考力度" aria-valuetext={current.label} />
      <span className="effort-name">{current.label}</span>
    </div>
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

function PdfPage({ pdf, pageNumber, zoom, showFormula, onFormula, onTextLayerReady, onThumbnail }: { pdf: any; pageNumber: number; zoom: number; showFormula: boolean; onFormula: (formula: FormulaAnchor) => void; onTextLayerReady: (pageNumber: number) => void; onThumbnail?: (pageNumber: number, dataUrl: string) => void }) {
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
      onTextLayerReady(pageNumber);
      const pageRect = textContainer.getBoundingClientRect();
      const boxes = Array.from(textContainer.querySelectorAll("span")).map((span, index) => {
        const text = String(span.textContent || "").trim();
        const rect = span.getBoundingClientRect();
        return { index, text, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      }).filter((item) => item.text && item.width > 0 && item.height > 0);
      const equationNumber = /^\(\d{1,3}[a-z]?\)$/i;
      const strongMath = /[=≠≤≥∑∏∫√∞≈∝∈∉⊂⊆∪∩∂∇±×÷→←↦|]|[α-ωΑ-Ω]|\b(?:arg\s*max|arg\s*min|softmax|log|exp|sim)\b/i;
      const detected = boxes.map((anchor) => {
        if (!equationNumber.test(anchor.text)) return null;
        const centerX = (anchor.left + anchor.right) / 2 - pageRect.left;
        const normalizedX = centerX / Math.max(1, pageRect.width);
        const isLeftColumnNumber = normalizedX >= .43 && normalizedX <= .50;
        const isRightColumnNumber = normalizedX >= .84 && normalizedX <= .94;
        if (!isLeftColumnNumber && !isRightColumnNumber) return null;

        const columnLeft = pageRect.left + (isRightColumnNumber ? pageRect.width * .50 : pageRect.width * .06);
        const columnRight = pageRect.left + (isRightColumnNumber ? pageRect.width * .92 : pageRect.width * .50);
        const anchorCenterY = (anchor.top + anchor.bottom) / 2;
        const verticalRadius = Math.max(22, anchor.height * 2.35);
        const nearbyParts = boxes.filter((item) => (
          item.index !== anchor.index
          && item.index < anchor.index
          && !equationNumber.test(item.text)
          && item.right >= columnLeft
          && item.left <= columnRight
          && Math.abs((item.top + item.bottom) / 2 - anchorCenterY) <= verticalRadius
          && item.text.length <= 90
        ));
        const firstMathPart = nearbyParts.findIndex((item) => strongMath.test(item.text));
        if (firstMathPart < 0) return null;
        let formulaStart = firstMathPart;
        while (formulaStart > 0) {
          const previous = nearbyParts[formulaStart - 1];
          const wordCount = previous.text.split(/\s+/).filter(Boolean).length;
          if (wordCount >= 5 && !strongMath.test(previous.text)) break;
          formulaStart -= 1;
        }
        const formulaParts = nearbyParts.slice(formulaStart);
        const rawFormula = formulaParts.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
        const compactTokens = formulaParts.filter((item) => item.text.length <= 12).length;
        if (!strongMath.test(rawFormula) || compactTokens < 2 || rawFormula.length < 4 || rawFormula.length > 360) return null;
        const formulaText = rawFormula
          .replace(/\s+([,.;:)\]}])/g, "$1")
          .replace(/([({\[])\s+/g, "$1")
          .replace(/\s*\|\s*/g, " | ")
          .replace(/\s+/g, " ")
          .trim();
        const regionLeft = Math.max(pageRect.left, Math.min(...formulaParts.map((item) => item.left)) - 4);
        const regionTop = Math.max(pageRect.top, Math.min(...formulaParts.map((item) => item.top)) - 3);
        const regionRight = Math.min(pageRect.right, Math.max(...formulaParts.map((item) => item.right)) + 4);
        const regionBottom = Math.min(pageRect.bottom, Math.max(...formulaParts.map((item) => item.bottom)) + 3);
        const markerLeft = Math.min(pageRect.width - 30, anchor.right - pageRect.left + 12);
        const pageX = Math.min(.96, Math.max(.04, markerLeft / Math.max(1, pageRect.width)));
        const pageY = Math.min(.98, Math.max(.02, (anchorCenterY - pageRect.top) / Math.max(1, pageRect.height)));
        return {
          text: `公式 ${anchor.text}：${formulaText}`,
          label: anchor.text,
          pageNumber,
          pageX,
          pageY,
          regionX: (regionLeft - pageRect.left) / Math.max(1, pageRect.width),
          regionY: (regionTop - pageRect.top) / Math.max(1, pageRect.height),
          regionWidth: (regionRight - regionLeft) / Math.max(1, pageRect.width),
          regionHeight: (regionBottom - regionTop) / Math.max(1, pageRect.height),
          left: markerLeft,
          top: anchorCenterY - pageRect.top,
        };
      }).filter((item): item is NonNullable<typeof item> => Boolean(item));
      setFormulaAnchors(detected);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      renderTask?.cancel?.();
      textLayer?.cancel?.();
    };
  }, [onTextLayerReady, pdf, pageNumber, zoom]);

  // 缩略图独立生成（白底小图，避免透明）：每页每文档只生成一次，不随缩放重建
  useEffect(() => {
    if (!onThumbnail) return;
    let cancelled = false;
    let thumbTask: { promise: Promise<void>; cancel: () => void } | null = null;
    (async () => {
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: 140 / Math.max(1, base.width) });
      const thumbCanvas = document.createElement("canvas");
      thumbCanvas.width = 140;
      thumbCanvas.height = Math.max(1, Math.round(viewport.height));
      const thumbCtx = thumbCanvas.getContext("2d");
      if (!thumbCtx) return;
      thumbCtx.fillStyle = "#ffffff";
      thumbCtx.fillRect(0, 0, thumbCanvas.width, thumbCanvas.height);
      thumbTask = page.render({ canvasContext: thumbCtx, viewport });
      await thumbTask.promise;
      if (cancelled) return;
      onThumbnail(pageNumber, thumbCanvas.toDataURL("image/jpeg", 0.65));
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      thumbTask?.cancel?.();
    };
  }, [onThumbnail, pdf, pageNumber]);

  return (
    <div className="pdf-page" data-page-number={pageNumber} style={{ width: size.width, height: size.height, "--total-scale-factor": 1.25 * zoom } as React.CSSProperties}>
      <canvas ref={canvasRef} />
      <div className="textLayer" ref={textRef} />
      {showFormula && formulaAnchors.map((formula, index) => <button key={`${formula.label || Math.round(formula.top)}-${index}`} className="formula-assist" data-formula-text={formula.text} data-formula-region={`${formula.regionX},${formula.regionY},${formula.regionWidth},${formula.regionHeight}`} style={{ left: formula.left, top: formula.top }} onClick={(event) => { event.stopPropagation(); onFormula(formula); }} aria-label={`询问第 ${pageNumber} 页公式 ${formula.label || ""}`.trim()} title={formula.text}><Sparkles size={13} /><span>问公式</span></button>)}
    </div>
  );
}

function PdfDocument({ source, zoom, showFormula, onReady, onMetadata, onFormula, onTextLayerReady, onTextExtracted, onError, onThumbnail }: { source: string | Uint8Array; zoom: number; showFormula: boolean; onReady: (pages: number) => void; onMetadata: (title: string) => void; onFormula: (formula: FormulaAnchor) => void; onTextLayerReady: (pageNumber: number) => void; onTextExtracted: (text: string) => void; onError: (message: string) => void; onThumbnail?: (pageNumber: number, dataUrl: string) => void }) {
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
  return <div className="pdf-stack">{Array.from({ length: pdf.numPages }, (_, i) => <PdfPage key={i + 1} pdf={pdf} pageNumber={i + 1} zoom={zoom} showFormula={showFormula} onFormula={onFormula} onTextLayerReady={onTextLayerReady} onThumbnail={onThumbnail} />)}</div>;
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

function LibraryModal({ onClose, papers, folders, loading, activePaperId, onOpenPaper, onAddPaper, onCreateFolder, onMovePaper, onSetStatus }: { onClose: () => void; papers: LibraryPaper[]; folders: LibraryFolder[]; loading: boolean; activePaperId: string | null; onOpenPaper: (id: string) => void; onAddPaper: () => void; onCreateFolder: (name: string) => Promise<LibraryFolder | null>; onMovePaper: (paperId: string, folderId: string | null) => Promise<boolean>; onSetStatus: (paperId: string, status: PaperStatus) => Promise<boolean> }) {
  const [activeFolder, setActiveFolder] = useState("all");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [folderSaving, setFolderSaving] = useState(false);
  const visiblePapers = useMemo(() => activeFolder === "all" ? papers : activeFolder === "unfiled" ? papers.filter((paper) => !paper.folderId) : papers.filter((paper) => paper.folderId === activeFolder), [papers, activeFolder]);
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
                    <label className={`library-status-select ${paper.status || "unread"}`} title="阅读状态">
                      <span className="status-dot-lib" aria-hidden="true" />
                      <select aria-label={`设置《${paper.title}》的阅读状态`} value={paper.status || "unread"} onChange={(event) => void onSetStatus(paper.id, event.target.value as PaperStatus)}>
                        {PAPER_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
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

function formatTokenCount(value: number) {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return String(value);
}
function formatEstimatedCost(value: number | null) {
  if (value === null) return "—";
  return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
}
const USAGE_MODE_LABELS: Record<string, string> = { global: "全文问答", inline: "划词问答" };
const USAGE_EFFORT_LABELS: Record<string, string> = { medium: "快速", high: "深入", max: "研究" };

function UsageModal({ onClose, stats, loading }: { onClose: () => void; stats: UsageStats | null; loading: boolean }) {
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal-card usage-card" role="dialog" aria-modal="true" aria-labelledby="usage-title">
        <button className="icon-button modal-close" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        <div className="settings-heading"><div className="modal-icon"><Receipt size={23} /></div><div><h2 id="usage-title">用量账单</h2><p>跨全部论文累计的模型调用统计。费用按公开标价估算，实际以服务商账单为准。</p></div></div>
        {loading ? <div className="library-loading"><LoaderCircle className="spin" size={18} />正在统计用量…</div> : !stats || !stats.totalCalls ? (
          <div className="library-empty usage-empty"><Receipt size={28} /><strong>还没有模型调用记录</strong><p>配置模型后开始提问，这里会自动累计 token 用量。</p></div>
        ) : (
          <>
            <div className="usage-summary">
              <div className="usage-stat"><small>累计 Token</small><strong>{formatTokenCount(stats.totalTokens)}</strong><span>输入 {formatTokenCount(stats.promptTokens)} · 输出 {formatTokenCount(stats.completionTokens)}</span></div>
              <div className="usage-stat"><small>估算费用</small><strong>{formatEstimatedCost(stats.estimatedCost)}</strong><span>{stats.estimatedCost === null ? "当前模型暂无标价" : "按公开标价估算"}</span></div>
              <div className="usage-stat"><small>调用次数</small><strong>{stats.totalCalls}</strong><span>含检索规划等辅助调用</span></div>
            </div>
            <h3 className="usage-section-title">按模型</h3>
            <div className="usage-model-list">
              {stats.perModel.map((item) => (
                <div key={item.model} className="usage-model-row">
                  <strong>{item.model}</strong>
                  <span>{formatTokenCount(item.promptTokens + item.completionTokens)} tokens · {item.calls} 次</span>
                  <em>{formatEstimatedCost(item.estimatedCost)}</em>
                </div>
              ))}
            </div>
            <h3 className="usage-section-title">最近记录</h3>
            <div className="usage-recent-list">
              {stats.recent.map((item) => (
                <div key={item.id} className="usage-recent-row">
                  <span className="usage-recent-mode">{USAGE_MODE_LABELS[item.mode] || item.mode} · {USAGE_EFFORT_LABELS[item.effort] || item.effort}</span>
                  <span className="usage-recent-tokens">{formatTokenCount(item.promptTokens + item.completionTokens)} tokens</span>
                  <time>{new Date(item.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
                </div>
              ))}
            </div>
          </>
        )}
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

type UiFontSize = "compact" | "standard" | "large" | "xlarge";

const UI_FONT_OPTIONS: Array<{ value: UiFontSize; label: string; desc: string; sample: number }> = [
  { value: "compact", label: "紧凑", desc: "信息密度最高", sample: 13 },
  { value: "standard", label: "标准", desc: "推荐，舒适易读", sample: 16 },
  { value: "large", label: "较大", desc: "长时间阅读更轻松", sample: 19 },
  { value: "xlarge", label: "特大", desc: "最大化可读性", sample: 23 },
];

function SettingsModal({ onClose, config, setConfig, prompts, setPrompts }: { onClose: () => void; config: ApiConfig; setConfig: (v: ApiConfig) => void; prompts: PromptConfig; setPrompts: (v: PromptConfig) => void }) {
  const [tab, setTab] = useState<"model" | "prompts" | "sync">("model");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState("");
  const [testState, setTestState] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [testMessage, setTestMessage] = useState("");
  const syncLoadedRef = useRef(false);
  const [syncConfig, setSyncConfig] = useState({ endpoint: "", username: "", password: "", remotePath: "lumen-backup", hasPassword: false, configured: false, lastBackupAt: null as string | null });
  const [syncTestState, setSyncTestState] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [syncTestMessage, setSyncTestMessage] = useState("");
  const [syncSaveState, setSyncSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [syncSaveMessage, setSyncSaveMessage] = useState("");
  const [backupState, setBackupState] = useState<"idle" | "running" | "ok" | "fail">("idle");
  const [backupMessage, setBackupMessage] = useState("");
  const [restoreState, setRestoreState] = useState<"idle" | "running" | "fail">("idle");
  const [restoreMessage, setRestoreMessage] = useState("");
  const [localImportState, setLocalImportState] = useState<"idle" | "running" | "fail">("idle");
  const [localMessage, setLocalMessage] = useState("");
  const localFileRef = useRef<HTMLInputElement>(null);
  const providerModels = MODEL_PRESETS[config.provider]?.models || [];
  const usesCustomModel = !providerModels.includes(config.model);
  const testConnection = async () => {
    if (testState === "testing") return;
    setTestState("testing");
    setTestMessage("");
    try {
      const response = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: config.endpoint, apiKey: config.apiKey || undefined, model: config.model }),
      });
      const payload = await response.json();
      if (payload.ok) {
        setTestState("ok");
        setTestMessage(`连接成功，模型可用（${payload.latencyMs} ms）`);
      } else {
        setTestState("fail");
        setTestMessage(payload.error || "连接失败，请检查配置");
      }
    } catch {
      setTestState("fail");
      setTestMessage("网络错误，无法完成测试");
    }
  };
  // 配置一旦修改，之前的测试结果作废
  const updateConfig = (next: ApiConfig) => {
    setTestState("idle");
    setTestMessage("");
    setConfig(next);
  };
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
  // 进入云同步 tab 时懒加载已保存的配置（密码不回传，只回 hasPassword）
  useEffect(() => {
    if (tab !== "sync" || syncLoadedRef.current) return;
    syncLoadedRef.current = true;
    fetch("/api/sync").then((response) => response.json()).then((payload) => {
      setSyncConfig((prev) => ({ ...prev, endpoint: payload.endpoint || "", username: payload.username || "", remotePath: payload.remotePath || "lumen-backup", hasPassword: Boolean(payload.hasPassword), configured: Boolean(payload.configured), lastBackupAt: payload.lastBackupAt || null }));
    }).catch(() => { syncLoadedRef.current = false; });
  }, [tab]);
  // 配置修改后此前的测试结果作废
  const updateSync = (next: typeof syncConfig) => {
    setSyncTestState("idle");
    setSyncTestMessage("");
    setSyncSaveState("idle");
    setSyncSaveMessage("");
    setSyncConfig(next);
  };
  const testSyncConnection = async () => {
    if (syncTestState === "testing") return;
    setSyncTestState("testing");
    setSyncTestMessage("");
    try {
      const response = await fetch("/api/sync/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: syncConfig.endpoint, username: syncConfig.username, password: syncConfig.password || undefined, remotePath: syncConfig.remotePath }),
      });
      const payload = await response.json();
      if (payload.ok) {
        setSyncTestState("ok");
        setSyncTestMessage(`连接成功（${payload.latencyMs} ms）`);
      } else {
        setSyncTestState("fail");
        setSyncTestMessage(payload.error || "连接失败，请检查配置");
      }
    } catch {
      setSyncTestState("fail");
      setSyncTestMessage("网络错误，无法完成测试");
    }
  };
  const saveSyncConfig = async () => {
    if (syncSaveState === "saving") return;
    setSyncSaveState("saving");
    setSyncSaveMessage("");
    try {
      const response = await fetch("/api/sync", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: syncConfig.endpoint, username: syncConfig.username, password: syncConfig.password || undefined, remotePath: syncConfig.remotePath }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "保存失败");
      setSyncConfig({ ...syncConfig, password: "", hasPassword: true, configured: true, lastBackupAt: payload.lastBackupAt || null });
      setSyncSaveState("saved");
      setSyncSaveMessage("同步配置已保存");
    } catch (error) {
      setSyncSaveState("error");
      setSyncSaveMessage((error instanceof Error ? error.message : "") || "保存失败，请稍后重试");
    }
  };
  const backupNow = async () => {
    if (backupState === "running") return;
    setBackupState("running");
    setBackupMessage("");
    try {
      const response = await fetch("/api/sync/push", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "备份失败");
      const skippedText = payload.skipped ? `，跳过 ${payload.skipped} 个过大或缺失的文件` : "";
      setBackupMessage(`已备份 ${payload.papers} 篇论文、${payload.files} 个文件${skippedText}`);
      setBackupState("ok");
      setSyncConfig((prev) => ({ ...prev, lastBackupAt: new Date().toISOString() }));
    } catch (error) {
      setBackupState("fail");
      setBackupMessage((error instanceof Error ? error.message : "") || "备份失败，请稍后重试");
    }
  };
  const restoreNow = async () => {
    if (restoreState === "running") return;
    if (!window.confirm("恢复会用远端备份覆盖当前所有论文和阅读记录，确定继续吗？")) return;
    setRestoreState("running");
    setRestoreMessage("");
    try {
      const response = await fetch("/api/sync/pull", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "恢复失败");
      window.location.reload();
    } catch (error) {
      setRestoreState("fail");
      setRestoreMessage((error instanceof Error ? error.message : "") || "恢复失败，请稍后重试");
    }
  };
  // 本地导出：Content-Disposition 附件，直接触发下载
  const exportLocalBackup = () => {
    const link = document.createElement("a");
    link.href = "/api/sync/local";
    link.download = "";
    link.click();
  };
  // 本地导入：确认覆盖后上传备份文件，成功后刷新重新水合
  const importLocalBackup = async (file: File) => {
    if (localImportState === "running") return;
    if (!window.confirm("导入会用备份文件覆盖当前所有论文和阅读记录，确定继续吗？")) return;
    setLocalImportState("running");
    setLocalMessage("");
    try {
      const response = await fetch("/api/sync/local", { method: "POST", headers: { "Content-Type": "application/json" }, body: file });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "导入失败");
      window.location.reload();
    } catch (error) {
      setLocalImportState("fail");
      setLocalMessage((error instanceof Error ? error.message : "") || "导入失败，请检查备份文件");
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card settings-card" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <button className="icon-button modal-close" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        <div className="settings-heading"><div className="modal-icon"><Bot size={24} /></div><div><h2 id="settings-title">设置</h2><p>连接模型、调整回答规则和同步方式。</p></div></div>
        <div className="settings-tabs">
          <button className={tab === "model" ? "active" : ""} onClick={() => setTab("model")}>模型连接</button>
          <button className={tab === "prompts" ? "active" : ""} onClick={() => setTab("prompts")}>回答规则</button>
          <button className={tab === "sync" ? "active" : ""} onClick={() => setTab("sync")}>同步</button>
        </div>
        {tab === "model" ? <div className="settings-pane">
          <div className="preset-row">
            {Object.entries(MODEL_PRESETS).map(([name, value]) => (
              <button key={name} className={config.provider === name ? "selected" : ""} onClick={() => updateConfig({ ...config, provider: name, endpoint: value.endpoint, model: value.models[0] })}><ProviderLogo name={name} /><span>{name}</span></button>
            ))}
          </div>
          <label className="field-label">API Base URL<input value={config.endpoint} onChange={(e) => updateConfig({ ...config, endpoint: e.target.value })} placeholder="https://api.example.com/v1" /></label>
          <label className="field-label">模型
            <select value={usesCustomModel ? "__custom" : config.model} onChange={(event) => updateConfig({ ...config, model: event.target.value === "__custom" ? "" : event.target.value })}>
              {providerModels.map((model) => <option key={model} value={model}>{model}</option>)}
              <option value="__custom">自定义模型…</option>
            </select>
          </label>
          {usesCustomModel && <label className="field-label custom-model-field">自定义模型名称<input value={config.model} onChange={(event) => updateConfig({ ...config, model: event.target.value })} placeholder="输入接口支持的模型 ID" autoFocus /></label>}
          <label className="field-label">API Key<input type="password" value={config.apiKey} onChange={(e) => updateConfig({ ...config, apiKey: e.target.value })} placeholder={config.hasApiKey ? "************" : "输入 API Key"} /></label>
          <div className="test-row">
            <button type="button" className="test-button" onClick={testConnection} disabled={testState === "testing" || !config.endpoint.trim() || !config.model.trim()}>
              {testState === "testing" ? <><LoaderCircle className="spin" size={14} />正在测试连接…</> : <><Zap size={14} />测试连接</>}
            </button>
            {testState === "ok" && <span className="test-result ok"><span className="test-dot" />{testMessage}</span>}
            {testState === "fail" && <span className="test-result fail"><span className="test-dot" />{testMessage}</span>}
          </div>
          {!config.hasApiKey && <div className="settings-note"><Check size={14} />密钥会加密保存在本机，之后无需重复填写。</div>}
        </div> : tab === "sync" ? <div className="settings-pane">
          <div className="sync-section-title">云同步</div>
          <label className="field-label">WebDAV 地址<input value={syncConfig.endpoint} onChange={(event) => updateSync({ ...syncConfig, endpoint: event.target.value })} placeholder="https://dav.jianguoyun.com/dav/" /></label>
          <label className="field-label">用户名<input value={syncConfig.username} onChange={(event) => updateSync({ ...syncConfig, username: event.target.value })} placeholder="WebDAV 账号" /></label>
          <label className="field-label">密码<input type="password" value={syncConfig.password} onChange={(event) => updateSync({ ...syncConfig, password: event.target.value })} placeholder={syncConfig.hasPassword ? "************" : "WebDAV 密码或应用授权码"} /></label>
          <label className="field-label">远程路径<input value={syncConfig.remotePath} onChange={(event) => updateSync({ ...syncConfig, remotePath: event.target.value })} placeholder="lumen-backup" /></label>
          <div className="test-row">
            <button type="button" className="test-button" onClick={testSyncConnection} disabled={syncTestState === "testing" || !syncConfig.endpoint.trim()}>
              {syncTestState === "testing" ? <><LoaderCircle className="spin" size={14} />正在测试连接…</> : <><Zap size={14} />测试连接</>}
            </button>
            {syncTestState === "ok" && <span className="test-result ok"><span className="test-dot" />{syncTestMessage}</span>}
            {syncTestState === "fail" && <span className="test-result fail"><span className="test-dot" />{syncTestMessage}</span>}
          </div>
          <div className="test-row">
            <button type="button" className="test-button" onClick={saveSyncConfig} disabled={syncSaveState === "saving" || !syncConfig.endpoint.trim() || !syncConfig.username.trim()}>
              {syncSaveState === "saving" ? <><LoaderCircle className="spin" size={14} />正在保存…</> : <><Check size={14} />保存同步配置</>}
            </button>
            {syncSaveState === "saved" && <span className="test-result ok"><span className="test-dot" />{syncSaveMessage}</span>}
            {syncSaveState === "error" && <span className="test-result fail"><span className="test-dot" />{syncSaveMessage}</span>}
          </div>
          <div className="test-row">
            <button type="button" className="test-button" onClick={backupNow} disabled={!syncConfig.configured || backupState === "running" || restoreState === "running"}>
              {backupState === "running" ? <><LoaderCircle className="spin" size={14} />正在备份…</> : <><Cloud size={14} />立即备份</>}
            </button>
            <button type="button" className="test-button" onClick={restoreNow} disabled={!syncConfig.configured || restoreState === "running" || backupState === "running"}>
              {restoreState === "running" ? <><LoaderCircle className="spin" size={14} />正在恢复…</> : <><Upload size={14} />从备份恢复</>}
            </button>
          </div>
          {backupMessage && <span className={`test-result ${backupState === "ok" ? "ok" : "fail"}`}><span className="test-dot" />{backupMessage}</span>}
          {restoreMessage && <span className="test-result fail"><span className="test-dot" />{restoreMessage}</span>}
          {syncConfig.lastBackupAt && <div className="settings-note"><Check size={14} />上次备份：{new Date(syncConfig.lastBackupAt).toLocaleString("zh-CN")}</div>}
          {!syncConfig.configured && <div className="settings-note"><Check size={14} />支持坚果云（https://dav.jianguoyun.com/dav/）、Nextcloud 等 WebDAV 网盘，配置后可将论文库备份到云端并在新设备恢复。</div>}
          {syncConfig.configured && <div className="settings-note"><Check size={14} />立即备份 / 从备份恢复使用已保存的配置；恢复会覆盖本地全部论文和阅读记录。</div>}
          <div className="sync-section-title">本地同步</div>
          <div className="settings-note"><Check size={14} />把全部论文、阅读记录和已上传的 PDF 原件导出为一个备份文件，换设备后用导入恢复。</div>
          <div className="test-row">
            <button type="button" className="test-button" onClick={exportLocalBackup}><Download size={14} />导出备份</button>
            <button type="button" className="test-button" onClick={() => localFileRef.current?.click()} disabled={localImportState === "running"}>
              {localImportState === "running" ? <><LoaderCircle className="spin" size={14} />正在导入…</> : <><Upload size={14} />导入备份</>}
            </button>
            <input ref={localFileRef} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importLocalBackup(file); }} />
          </div>
          {localMessage && <span className="test-result fail"><span className="test-dot" />{localMessage}</span>}
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
        {(tab === "model" || tab === "prompts") && <button className="primary-button wide" onClick={saveSettings} disabled={saveState === "saving" || !prompts.global.trim() || !prompts.inline.trim() || !config.endpoint.trim() || !config.model.trim()}>{saveState === "saving" ? <><LoaderCircle className="spin" size={16} />正在保存</> : saveState === "saved" ? <><Check size={17} />已保存</> : "保存设置"}</button>}
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
  const [fontMenuOpen, setFontMenuOpen] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"loading" | "saved" | "saving" | "error">("loading");
  const [hydrated, setHydrated] = useState(false);
  const [openModal, setOpenModal] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryPapers, setLibraryPapers] = useState<LibraryPaper[]>([]);
  const [libraryFolders, setLibraryFolders] = useState<LibraryFolder[]>([]);
  const [usageOpen, setUsageOpen] = useState(false);
  const [usageStats, setUsageStats] = useState<UsageStats | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [uiFontSize, setUiFontSize] = useStoredPref<"compact" | "standard" | "large" | "xlarge">("lumen-ui-font-size", "standard", UI_FONT_SIZES);
  const [rightOpen, setRightOpen] = useState(true);
  const [panelWidth, setPanelWidth] = useState(394);
  const [panelResizing, setPanelResizing] = useState(false);
  const panelResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const startPanelResize = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    panelResizeRef.current = { startX: event.clientX, startWidth: panelWidth };
    setPanelResizing(true);
  }, [panelWidth]);
  const [thumbWidth, setThumbWidth] = useState(108);
  const [thumbsOpen, setThumbsOpen] = useStoredPref<"show" | "hide">("lumen-thumbs-open", "show", ["show", "hide"]);
  const [formulaAssist, setFormulaAssist] = useStoredPref<"show" | "hide">("lumen-formula-assist", "show", ["show", "hide"]);
  const [thumbResizing, setThumbResizing] = useState(false);
  const thumbResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const startThumbResize = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    thumbResizeRef.current = { startX: event.clientX, startWidth: thumbWidth };
    setThumbResizing(true);
  }, [thumbWidth]);
  // 缩略图栏抓手拖动滚动；拖动超过阈值时抑制点击跳页
  const thumbRailRef = useRef<HTMLElement | null>(null);
  const thumbPanRef = useRef<{ startY: number; startScroll: number } | null>(null);
  const thumbPanMovedRef = useRef(false);
  const [thumbPanning, setThumbPanning] = useState(false);
  // 阅读区抓手平移：手型模式下左键拖动、任意模式下鼠标中键拖动，或左键按在文字以外的空白区域直接拖动
  const [panMode, setPanMode] = useState(false);
  const [readerPanning, setReaderPanning] = useState(false);
  const readerPanRef = useRef<{ startX: number; startY: number; startLeft: number; startTop: number; moved: boolean } | null>(null);
  const startReaderPan = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const leftButtonPan = event.button === 0 && (panMode || isReaderPanSafeTarget(event.target as HTMLElement));
    if (!(event.button === 1 || leftButtonPan)) return;
    const reader = readerRef.current;
    if (!reader) return;
    event.preventDefault();
    readerPanRef.current = { startX: event.clientX, startY: event.clientY, startLeft: reader.scrollLeft, startTop: reader.scrollTop, moved: false };
  }, [panMode]);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const pan = readerPanRef.current;
      const reader = readerRef.current;
      if (!pan || !reader) return;
      const dx = pan.startX - event.clientX;
      const dy = pan.startY - event.clientY;
      if (!pan.moved && Math.hypot(dx, dy) > 3) { pan.moved = true; setReaderPanning(true); }
      if (pan.moved) {
        reader.scrollLeft = pan.startLeft + dx;
        reader.scrollTop = pan.startTop + dy;
      }
    };
    const end = () => { readerPanRef.current = null; setReaderPanning(false); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); };
  }, []);
  const startThumbPan = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || thumbResizeRef.current) return;
    const rail = thumbRailRef.current;
    if (!rail) return;
    thumbPanRef.current = { startY: event.clientY, startScroll: rail.scrollTop };
  }, []);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const pan = thumbPanRef.current;
      if (!pan) return;
      const rail = thumbRailRef.current;
      if (!rail) return;
      const delta = pan.startY - event.clientY;
      if (Math.abs(delta) > 4) {
        if (!thumbPanMovedRef.current) { thumbPanMovedRef.current = true; setThumbPanning(true); }
        rail.scrollTop = pan.startScroll + delta;
      }
    };
    const end = () => { thumbPanRef.current = null; setThumbPanning(false); window.setTimeout(() => { thumbPanMovedRef.current = false; }, 0); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); };
  }, []);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const panelDrag = panelResizeRef.current;
      if (panelDrag) setPanelWidth(Math.min(680, Math.max(320, panelDrag.startWidth + panelDrag.startX - event.clientX)));
      const thumbDrag = thumbResizeRef.current;
      if (thumbDrag) setThumbWidth(Math.min(220, Math.max(72, thumbDrag.startWidth + event.clientX - thumbDrag.startX)));
    };
    const end = () => { panelResizeRef.current = null; thumbResizeRef.current = null; setPanelResizing(false); setThumbResizing(false); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); };
  }, []);
  const [source, setSource] = useState<string | Uint8Array | null>(null);
  const [paperId, setPaperId] = useState<string | null>(null);
  const [paperSourceKind, setPaperSourceKind] = useState<PaperSourceKind | null>(null);
  const [paperSourceUrl, setPaperSourceUrl] = useState<string | null>(null);
  const [paperTitle, setPaperTitle] = useState("Attention Is All You Need");
  const [paperMeta, setPaperMeta] = useState("交互演示论文 · 打开链接后会替换为真实 PDF");
  const [pageCount, setPageCount] = useState(15);
  const [thumbCache, setThumbCache] = useState<{ key: string; thumbs: Record<number, string> }>({ key: "", thumbs: {} });
  const [currentPage, setCurrentPage] = useState(1);
  // 页码输入框用本地字符串，Enter/blur 才提交，外部翻页时同步
  const [pageInput, setPageInput] = useState("1");
  const [pageInputSyncedTo, setPageInputSyncedTo] = useState(currentPage);
  if (pageInputSyncedTo !== currentPage) {
    setPageInputSyncedTo(currentPage);
    setPageInput(String(currentPage));
  }
  const [zoom, setZoom] = useState(0.88);
  const [textLayerVersion, setTextLayerVersion] = useState(0);
  const [selectedText, setSelectedText] = useState("");
  const [selectionContext, setSelectionContext] = useState("");
  const [selectionPos, setSelectionPos] = useState<{ x: number; y: number } | null>(null);
  const [selectionRects, setSelectionRects] = useState<SelectionOverlayRect[]>([]);
  const [pdfContextMenu, setPdfContextMenu] = useState<{ x: number; y: number; pageNumber: number; pageX: number; pageY: number } | null>(null);
  const [selectionAnchor, setSelectionAnchor] = useState<{ top: number; left: number; cardTop: number; cardLeft: number; pageNumber: number } | null>(null);
  const [showColors, setShowColors] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [paperText, setPaperText] = useState(demoParagraphs.map((item) => `${item.heading || ""}\n${item.body}`).join("\n\n"));
  const [extractingText, setExtractingText] = useState(false);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [effort, setEffort] = useStoredPref<ChatEffort>("lumen-chat-effort", "medium", CHAT_EFFORTS);
  const [inlineEffort, setInlineEffort] = useStoredPref<ChatEffort>("lumen-inline-effort", "medium", CHAT_EFFORTS);
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState("");
  const [showReaderTip, setShowReaderTip] = useState(true);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [flashedFormulaIds, setFlashedFormulaIds] = useState<Set<number>>(() => new Set());
  const readerRef = useRef<HTMLDivElement>(null);
  const selectionRangeRef = useRef<Range | null>(null);
  const annotationRangesRef = useRef(new Map<number, { range: Range; color: HighlightColor; persistent: boolean }>());
  const annotationAnchorsRef = useRef(new Map<number, { top: number; left: number }>());
  const activeRangeIdsRef = useRef(new Set<number>());
  const flashTimersRef = useRef(new Map<number, number>());
  const dragRef = useRef<{ id: number; target: "card" | "pin"; startX: number; startY: number; startLeft: number; startTop: number } | null>(null);
  const resizeRef = useRef<{ id: number; startX: number; startY: number; startWidth: number; startHeight: number } | null>(null);
  const lastDraggedPinRef = useRef<number | null>(null);
  const selectionPointerRef = useRef<{ x: number; y: number; root: Element } | null>(null);
  const selectionFrameRef = useRef(0);
  const scrollFrameRef = useRef(0);
  const restoringWorkspaceRef = useRef(false);
  const pendingScrollPageRef = useRef<number | null>(null);
  // 划词回答的请求控制器：删除批注/换论文时中断对应流
  const inlineControllersRef = useRef(new Map<number, AbortController>());
  // 缩略图与文本层就绪回调批量上报，避免每页一次 setState
  const thumbPendingRef = useRef<{ key: string; thumbs: Record<number, string> }>({ key: "", thumbs: {} });
  const thumbFlushTimerRef = useRef<number | null>(null);
  const textLayerReadyCountRef = useRef(0);
  const textLayerFlushTimerRef = useRef<number | null>(null);
  // 自动保存：自增序号用于丢弃过期响应，快照用于跳过未变更的写回
  const saveSeqRef = useRef(0);
  const lastSavedSnapshotRef = useRef("");
  const lastSavedTextRef = useRef("");
  const [config, setConfig] = useState<ApiConfig>({ provider: "OpenAI", endpoint: "https://api.openai.com/v1", model: "gpt-4.1-mini", apiKey: "", hasApiKey: false });
  const [promptConfig, setPromptConfig] = useState<PromptConfig>(DEFAULT_PROMPTS);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: 1, role: "assistant", content: "这里是**全文对话**。我会基于整篇论文回答总结、方法、实验与结论问题；局部翻译和解释会留在原文旁边。" },
  ]);

  // 文本层就绪批量上报：约 200ms 合并成一次 textLayerVersion 递增，避免每页一次整树渲染
  const handleTextLayerReady = useCallback(() => {
    textLayerReadyCountRef.current += 1;
    if (textLayerFlushTimerRef.current === null) {
      textLayerFlushTimerRef.current = window.setTimeout(() => {
        textLayerFlushTimerRef.current = null;
        if (textLayerReadyCountRef.current > 0) {
          textLayerReadyCountRef.current = 0;
          setTextLayerVersion((version) => version + 1);
        }
      }, 200);
    }
  }, []);

  const thumbSourceKey = typeof source === "string" ? source : source ? "file" : "";
  // 缩略图先进 ref 累积，约 200ms 批量写入 state
  const handleThumbnail = useCallback((pageNumber: number, dataUrl: string) => {
    const pending = thumbPendingRef.current;
    if (pending.key !== thumbSourceKey) {
      pending.key = thumbSourceKey;
      pending.thumbs = {};
    }
    pending.thumbs[pageNumber] = dataUrl;
    if (thumbFlushTimerRef.current === null) {
      thumbFlushTimerRef.current = window.setTimeout(() => {
        thumbFlushTimerRef.current = null;
        setThumbCache({ key: thumbPendingRef.current.key, thumbs: { ...thumbPendingRef.current.thumbs } });
      }, 200);
    }
  }, [thumbSourceKey]);
  // 卸载时清掉未执行的批量定时器
  useEffect(() => () => {
    if (thumbFlushTimerRef.current !== null) window.clearTimeout(thumbFlushTimerRef.current);
    if (textLayerFlushTimerRef.current !== null) window.clearTimeout(textLayerFlushTimerRef.current);
  }, []);
  const pageThumbs = thumbCache.key === thumbSourceKey ? thumbCache.thumbs : {};

  const scrollToPage = useCallback((page: number, behavior: ScrollBehavior = "smooth") => {
    const reader = readerRef.current;
    const target = reader?.querySelector(`[data-page-number="${page}"]`) as HTMLElement | null;
    if (!reader || !target) return;
    reader.scrollTo({ top: Math.max(0, target.offsetTop - 18), behavior });
  }, []);

  const goToPage = useCallback((page: number) => {
    const next = Math.min(pageCount, Math.max(1, Math.floor(page) || 1));
    setCurrentPage(next);
    scrollToPage(next);
  }, [pageCount, scrollToPage]);

  // 打开/恢复论文后，等文本层渲染出来再滚动到上次阅读页
  useEffect(() => {
    if (!textLayerVersion || !pendingScrollPageRef.current) return;
    const page = pendingScrollPageRef.current;
    pendingScrollPageRef.current = null;
    const timer = window.setTimeout(() => scrollToPage(page, "auto"), 60);
    return () => window.clearTimeout(timer);
  }, [scrollToPage, textLayerVersion]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => undefined);
  }, []);

  // 阅读区两侧留有可拖动余量，换论文/缩放后把水平滚动位置校正回居中
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const reader = readerRef.current;
      if (!reader) return;
      reader.scrollLeft = Math.max(0, (reader.scrollWidth - reader.clientWidth) / 2);
    }, 60);
    return () => window.clearTimeout(timer);
  }, [source, zoom]);

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
          const restoredMessages: ChatMessage[] = Array.isArray(workspace.messages) && workspace.messages.length ? workspace.messages : [{ id: Date.now(), role: "assistant", content: "已恢复这篇论文的阅读记录。" }];
          const restoredAnnotations: Annotation[] = (Array.isArray(workspace.annotations) ? workspace.annotations : []).map((item: Annotation) => ({ ...item, loading: false, draft: "", thread: Array.isArray(item.thread) ? item.thread : [], pageNumber: item.pageNumber || 1 }));
          setPaperId(paper.id);
          setPaperSourceKind(paper.sourceKind);
          setPaperSourceUrl(paper.sourceUrl || null);
          setPaperTitle(paper.title);
          setPaperMeta(paper.meta);
          setPaperText(paper.paperText || "");
          setPageCount(paper.pageCount || 1);
          setCurrentPage(workspace.currentPage || 1);
          pendingScrollPageRef.current = workspace.currentPage || 1;
          setZoom(workspace.zoom || 0.88);
          setRightOpen(workspace.rightOpen !== false);
          setMessages(restoredMessages);
          setAnnotations(restoredAnnotations);
          // 记录恢复内容的快照，自动保存据此跳过未变更的"原样写回"
          lastSavedSnapshotRef.current = workspaceSnapshot({ paperId: paper.id, title: paper.title, meta: paper.meta, sourceKind: paper.sourceKind, sourceUrl: paper.sourceUrl || null, paperText: "", pageCount: paper.pageCount || 1, currentPage: workspace.currentPage || 1, zoom: workspace.zoom || 0.88, rightOpen: workspace.rightOpen !== false, messages: restoredMessages, annotationsJson: serializePersistentAnnotations(restoredAnnotations) });
          lastSavedTextRef.current = paper.paperText || "";
          if (paper.sourceKind === "upload") {
            setSource(`/api/papers/${paper.id}/file`);
          } else if (paper.sourceUrl) {
            setSource(`/api/pdf?url=${encodeURIComponent(paper.sourceUrl)}`);
          } else {
            // sourceUrl 缺失时不拼 /api/pdf?url=null
            setSource(null);
            setToast("这篇论文缺少原始链接，无法重新加载 PDF");
          }
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
    const assistantId = Date.now() + 1;
    const steps: string[] = [];
    let created = false;
    // 流式 delta 先累积到本地变量，约 50ms 批量写入 state，避免每个 delta 触发整树重渲染
    let pendingText = "";
    let flushTimer: number | null = null;
    const flushDelta = () => {
      if (!pendingText) return;
      const chunk = pendingText;
      pendingText = "";
      if (!created) {
        created = true;
        setStreaming(true);
        setStatusText("");
        setMessages((old) => [...old, { id: assistantId, role: "assistant", content: chunk, steps: [...steps] }]);
      } else {
        setMessages((old) => old.map((message) => message.id === assistantId ? { ...message, content: message.content + chunk } : message));
      }
    };
    const flushNow = () => {
      if (flushTimer !== null) { window.clearTimeout(flushTimer); flushTimer = null; }
      flushDelta();
    };
    const pushDelta = (delta: string) => {
      pendingText += delta;
      if (flushTimer === null) flushTimer = window.setTimeout(() => { flushTimer = null; flushDelta(); }, 50);
    };
    try {
      if (config.apiKey || config.hasApiKey) {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: config.endpoint, apiKey: config.apiKey || undefined, model: config.model, paperTitle, question: text, paperContext: paperText, mode: "global", history: messages.slice(-10), systemPrompts: promptConfig, effort }),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || "模型请求失败");
        }
        await consumeChatStream(response, {
          onStep: (label) => {
            steps.push(label);
            setStatusText(label);
            if (created) setMessages((old) => old.map((message) => message.id === assistantId ? { ...message, steps: [...steps] } : message));
          },
          onDelta: pushDelta,
        });
        flushNow();
        setLoading(false);
        setStreaming(false);
        setStatusText("");
      } else {
        const demoSteps = effort === "max" ? ["生成检索词（演示）", "Agent 主动检索 2 轮（演示）"] : effort === "high" ? ["生成检索词（演示）", "第 2 轮补充检索（演示）"] : ["检索相关片段（演示）"];
        for (const label of demoSteps) {
          steps.push(label);
          setStatusText(label);
          await new Promise((resolve) => setTimeout(resolve, 420));
        }
        const demoText = demoAnswer(text);
        for (let index = 0; index < demoText.length; index += 12) {
          pushDelta(demoText.slice(index, index + 12));
          await new Promise((resolve) => setTimeout(resolve, 16));
        }
        flushNow();
        setLoading(false);
        setStreaming(false);
        setStatusText("");
      }
    } catch (error: unknown) {
      flushNow(); // 已收到的内容先写进 state，避免丢字
      const errorText = `连接模型时遇到问题：${error instanceof Error && error.message ? error.message : "请检查 API 设置"}\n\n你可以在右上角的模型设置中检查接口地址与密钥。`;
      if (created) setMessages((old) => old.map((message) => message.id === assistantId ? { ...message, content: `${message.content}\n\n> ${errorText}` } : message));
      else setMessages((old) => [...old, { id: assistantId, role: "assistant", content: errorText }]);
      setLoading(false);
      setStreaming(false);
      setStatusText("");
    }
  }, [config, effort, loading, messages, paperText, paperTitle, promptConfig]);

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
    if (persistent || activeRangeIdsRef.current.has(id)) refreshHighlights(color);
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

  const flashFormulaRegion = useCallback((id: number, duration = 1800) => {
    const existing = flashTimersRef.current.get(id);
    if (existing) window.clearTimeout(existing);
    setFlashedFormulaIds((current) => new Set(current).add(id));
    const timer = window.setTimeout(() => {
      flashTimersRef.current.delete(id);
      setFlashedFormulaIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }, duration);
    flashTimersRef.current.set(id, timer);
  }, []);

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

  const startAnnotationResize = useCallback((event: React.PointerEvent<HTMLElement>, annotation: Annotation) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const card = (event.currentTarget as HTMLElement).closest(".inline-card");
    const rect = card?.getBoundingClientRect();
    resizeRef.current = {
      id: annotation.id,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: annotation.cardWidth || rect?.width || 342,
      startHeight: annotation.cardHeight || rect?.height || 300,
    };
    setDraggingId(annotation.id);
  }, []);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const resize = resizeRef.current;
      if (!resize) return;
      const cardWidth = Math.min(640, Math.max(260, resize.startWidth + event.clientX - resize.startX));
      const cardHeight = Math.min(680, Math.max(200, resize.startHeight + event.clientY - resize.startY));
      updateAnnotation(resize.id, { cardWidth, cardHeight });
    };
    const end = () => { resizeRef.current = null; setDraggingId(null); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); };
  }, [updateAnnotation]);

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
    // 同一批注重新提问时中断上一次未完成的流
    inlineControllersRef.current.get(id)?.abort();
    const controller = new AbortController();
    inlineControllersRef.current.set(id, controller);
    updateAnnotation(id, { loading: true, result: "", draft: "", thread: nextThread });
    try {
      if (config.apiKey || config.hasApiKey) {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: config.endpoint, apiKey: config.apiKey || undefined, model: config.model, paperTitle, question: prompt, selectedText: text, surroundingContext: surrounding, paperContext: paperText, mode: "inline", history: history.slice(-10), systemPrompts: promptConfig, effort: inlineEffort }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || "模型请求失败");
        }
        let answer = "";
        let created = false;
        const assistantMsgId = Date.now() + 1;
        // 流式 delta 先累积，约 50ms 批量写入批注，避免每个 delta 一次 setState
        let flushTimer: number | null = null;
        const flushAnswer = () => {
          if (controller.signal.aborted || !answer) return;
          if (!created) { created = true; updateAnnotation(id, { loading: false }); }
          updateAnnotation(id, { thread: [...nextThread, { id: assistantMsgId, role: "assistant", content: answer }] });
        };
        await consumeChatStream(response, {
          signal: controller.signal,
          onStep: (label) => { if (!controller.signal.aborted) updateAnnotation(id, { loadingLabel: label }); },
          onDelta: (delta) => {
            answer += delta;
            if (flushTimer === null) flushTimer = window.setTimeout(() => { flushTimer = null; flushAnswer(); }, 50);
          },
        });
        if (flushTimer !== null) { window.clearTimeout(flushTimer); flushTimer = null; }
        if (controller.signal.aborted) return;
        flushAnswer();
        updateAnnotation(id, { loading: false, result: answer, draft: "", thread: [...nextThread, { id: assistantMsgId, role: "assistant", content: answer }] });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 550));
        if (controller.signal.aborted) return;
        const answer = demoAnswer(prompt, text);
        updateAnnotation(id, { loading: false, result: answer, draft: "", thread: [...nextThread, { id: Date.now() + 1, role: "assistant", content: answer }] });
      }
    } catch (error: any) {
      if (controller.signal.aborted) return; // 批注已删除或论文已切换，静默退出
      const errorText = `连接模型时遇到问题：${error?.message || "请检查 API 设置"}`;
      updateAnnotation(id, { loading: false, result: errorText, thread: [...nextThread, { id: Date.now() + 1, role: "assistant", content: errorText }] });
    } finally {
      if (inlineControllersRef.current.get(id) === controller) inlineControllersRef.current.delete(id);
    }
  }, [config, inlineEffort, paperText, paperTitle, promptConfig, updateAnnotation]);

  const handleSelectionStart = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || panMode) return;
    // 本次按下已被平移接管（空白区域左键或中键），不进入划词流程，避免拖动时拉出选区
    if (readerPanRef.current) {
      selectionPointerRef.current = null;
      setSelectionRects([]);
      setSelectionPos(null);
      if (pdfContextMenu) setPdfContextMenu(null);
      return;
    }
    const target = event.target as HTMLElement;
    const root = target.closest(".textLayer, .demo-paper");
    selectionPointerRef.current = root ? { x: event.clientX, y: event.clientY, root } : null;
    setSelectionRects([]);
    setSelectionPos(null);
    if (pdfContextMenu) setPdfContextMenu(null);
  }, [panMode, pdfContextMenu]);

  const handleSelectionMove = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const pointerStart = selectionPointerRef.current;
    const reader = readerRef.current;
    if (!pointerStart || !reader || !(event.buttons & 1)) return;
    const endRoot = (event.target as HTMLElement).closest(".textLayer, .demo-paper");
    if (endRoot !== pointerStart.root) return;
    const end = { x: event.clientX, y: event.clientY };
    window.cancelAnimationFrame(selectionFrameRef.current);
    selectionFrameRef.current = window.requestAnimationFrame(() => {
      const range = rangeFromPointerPoints(pointerStart.root, { x: pointerStart.x, y: pointerStart.y }, end);
      if (!range || range.collapsed) {
        setSelectionRects([]);
        return;
      }
      const contextRoot = pointerStart.root.closest(".pdf-page, .demo-paper");
      setSelectionRects(overlayRectsForRange(trimRangeToText(range), contextRoot, reader));
    });
  }, []);

  const handleSelection = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    window.cancelAnimationFrame(selectionFrameRef.current);
    const pointerStart = selectionPointerRef.current;
    selectionPointerRef.current = null;
    const selection = window.getSelection();
    const endRoot = (event.target as HTMLElement).closest(".textLayer, .demo-paper");
    const pointerRange = pointerStart?.root.isConnected && endRoot === pointerStart.root
      ? rangeFromPointerPoints(pointerStart.root, { x: pointerStart.x, y: pointerStart.y }, { x: event.clientX, y: event.clientY })
      : null;
    if ((!pointerRange || pointerRange.collapsed) && !selection?.rangeCount) { setSelectionRects([]); return; }
    const range = trimRangeToText(pointerRange && !pointerRange.collapsed ? pointerRange : selection!.getRangeAt(0));
    const text = range.toString().replace(/\s+/g, " ").trim();
    if (!text || text.length < 2) { setSelectionRects([]); return; }
    selection?.removeAllRanges();
    selection?.addRange(range);
    if (!readerRef.current?.contains(range.commonAncestorContainer)) { setSelectionRects([]); return; }
    const readerRect = readerRef.current.getBoundingClientRect();
    const node = range.commonAncestorContainer.nodeType === Node.TEXT_NODE ? range.commonAncestorContainer.parentElement : range.commonAncestorContainer as HTMLElement;
    const contextRoot = node?.closest?.(".pdf-page, .demo-paper") as HTMLElement | null;
    const pageRect = contextRoot?.getBoundingClientRect();
    const rects = tightRangeClientRects(range, contextRoot);
    const rect = rects[rects.length - 1] || range.getBoundingClientRect();
    if (!rect.width && !rect.height) { setSelectionRects([]); return; }
    setSelectionRects(overlayRectsForRange(range, contextRoot, readerRef.current));
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
    setSelectionRects([]);
    setShowColors(false);
    window.getSelection()?.removeAllRanges();
    if (kind === "translate" || kind === "explain") void requestInlineAnswer(id, kind, selectedText, selectionContext);
    if (kind !== "highlight") window.setTimeout(() => flashAnnotationRange(id), 0);
    setSelectedText("");
    setSelectionContext("");
    selectionRangeRef.current = null;
  }, [addAnnotationRange, flashAnnotationRange, requestInlineAnswer, selectedText, selectionAnchor, selectionContext]);

  useEffect(() => {
    window.cancelAnimationFrame(selectionFrameRef.current);
    setSelectionRects([]);
    setSelectionPos(null);
    setSelectedText("");
    setSelectionContext("");
    selectionRangeRef.current = null;
    selectionPointerRef.current = null;
    window.getSelection()?.removeAllRanges();
  }, [source, zoom]);

  const createFormulaAnnotation = useCallback((formula: FormulaAnchor) => {
    const reader = readerRef.current;
    const page = reader?.querySelector(`[data-page-number="${formula.pageNumber}"]`) as HTMLElement | null;
    if (!reader || !page) return;
    const readerRect = reader.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    const left = pageRect.left - readerRect.left + reader.scrollLeft + formula.pageX * pageRect.width;
    const top = pageRect.top - readerRect.top + reader.scrollTop + formula.pageY * pageRect.height;
    const formulaRegionLeft = pageRect.left - readerRect.left + reader.scrollLeft + formula.regionX * pageRect.width;
    const formulaRegionTop = pageRect.top - readerRect.top + reader.scrollTop + formula.regionY * pageRect.height;
    const formulaRegionPixelWidth = formula.regionWidth * pageRect.width;
    const formulaRegionPixelHeight = formula.regionHeight * pageRect.height;
    const visibleRight = reader.scrollLeft + reader.clientWidth;
    const id = Date.now() + Math.floor(Math.random() * 1000);
    const cardLeft = left + 358 > visibleRight ? Math.max(reader.scrollLeft + 14, left - 360) : left + 15;
    const cardTop = Math.max(reader.scrollTop + 8, Math.min(reader.scrollTop + reader.clientHeight - 110, top + 15));
    const surrounding = String(page.innerText || formula.text).replace(/\s+/g, " ").slice(0, 2000);
    const annotation: Annotation = { id, kind: "formula", color: "blue", text: formula.text, surrounding, top, left, cardTop, cardLeft, open: true, loading: false, result: "", draft: "", thread: [], pageNumber: formula.pageNumber, pageX: formula.pageX, pageY: formula.pageY, formulaRegionX: formula.regionX, formulaRegionY: formula.regionY, formulaRegionWidth: formula.regionWidth, formulaRegionHeight: formula.regionHeight, formulaRegionLeft, formulaRegionTop, formulaRegionPixelWidth, formulaRegionPixelHeight, pinOffsetX: 0, pinOffsetY: 0, cardOffsetX: cardLeft - left, cardOffsetY: cardTop - top };
    annotationAnchorsRef.current.set(id, { top, left });
    setAnnotations((items) => [...items, annotation]);
    window.setTimeout(() => flashFormulaRegion(id), 0);
    void requestInlineAnswer(id, "formula", formula.text, surrounding);
  }, [flashFormulaRegion, requestInlineAnswer]);

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
    // 中断该批注可能还在进行的划词回答流
    inlineControllersRef.current.get(id)?.abort();
    inlineControllersRef.current.delete(id);
    const stored = annotationRangesRef.current.get(id);
    const timer = flashTimersRef.current.get(id);
    if (timer) window.clearTimeout(timer);
    flashTimersRef.current.delete(id);
    activeRangeIdsRef.current.delete(id);
    setFlashedFormulaIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
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
    setFlashedFormulaIds((current) => {
      if (!current.has(annotation.id)) return current;
      const next = new Set(current);
      next.delete(annotation.id);
      return next;
    });
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
    if (annotation.kind === "formula") flashFormulaRegion(annotation.id);
    else flashAnnotationRange(annotation.id);
  }, [flashAnnotationRange, flashFormulaRegion, updateAnnotation]);

  const clearPaperAnnotations = useCallback(() => {
    // 切换论文时中断所有未完成的划词回答流
    inlineControllersRef.current.forEach((controller) => controller.abort());
    inlineControllersRef.current.clear();
    flashTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    flashTimersRef.current.clear();
    activeRangeIdsRef.current.clear();
    setFlashedFormulaIds(new Set());
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
          const hasFormulaRegion = annotation.kind === "formula"
            && annotation.formulaRegionX !== undefined
            && annotation.formulaRegionY !== undefined
            && annotation.formulaRegionWidth !== undefined
            && annotation.formulaRegionHeight !== undefined;
          const formulaRegionLeft = hasFormulaRegion ? pageRect.left - readerRect.left + reader.scrollLeft + annotation.formulaRegionX! * pageRect.width : annotation.formulaRegionLeft;
          const formulaRegionTop = hasFormulaRegion ? pageRect.top - readerRect.top + reader.scrollTop + annotation.formulaRegionY! * pageRect.height : annotation.formulaRegionTop;
          const formulaRegionPixelWidth = hasFormulaRegion ? annotation.formulaRegionWidth! * pageRect.width : annotation.formulaRegionPixelWidth;
          const formulaRegionPixelHeight = hasFormulaRegion ? annotation.formulaRegionHeight! * pageRect.height : annotation.formulaRegionPixelHeight;
          annotationAnchorsRef.current.set(annotation.id, anchor);
          const formulaRegionAligned = !hasFormulaRegion || (
            Math.abs((formulaRegionLeft || 0) - (annotation.formulaRegionLeft || 0)) < .5
            && Math.abs((formulaRegionTop || 0) - (annotation.formulaRegionTop || 0)) < .5
            && Math.abs((formulaRegionPixelWidth || 0) - (annotation.formulaRegionPixelWidth || 0)) < .5
            && Math.abs((formulaRegionPixelHeight || 0) - (annotation.formulaRegionPixelHeight || 0)) < .5
          );
          if (Math.abs(left - annotation.left) < .5 && Math.abs(top - annotation.top) < .5 && Math.abs(cardLeft - annotation.cardLeft) < .5 && Math.abs(cardTop - annotation.cardTop) < .5 && formulaRegionAligned) return annotation;
          changed = true;
          return { ...annotation, left, top, cardLeft, cardTop, formulaRegionLeft, formulaRegionTop, formulaRegionPixelWidth, formulaRegionPixelHeight };
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
    const readerRect = reader.getBoundingClientRect();
    setAnnotations((items) => {
      let changed = false;
      const next = items.map((annotation) => {
        if (annotation.kind !== "formula" || annotation.formulaRegionX !== undefined) return annotation;
        const page = reader.querySelector(`[data-page-number="${annotation.pageNumber || 1}"]`) as HTMLElement | null;
        if (!page) return annotation;
        const button = Array.from(page.querySelectorAll(".formula-assist")).find((item) => item.getAttribute("data-formula-text") === annotation.text) as HTMLElement | undefined;
        const region = button?.dataset.formulaRegion?.split(",").map(Number);
        if (!button || !region || region.length !== 4 || region.some((value) => !Number.isFinite(value))) return annotation;
        const pageRect = page.getBoundingClientRect();
        const pageX = Math.min(.96, Math.max(.04, Number.parseFloat(button.style.left) / Math.max(1, pageRect.width)));
        const pageY = Math.min(.98, Math.max(.02, Number.parseFloat(button.style.top) / Math.max(1, pageRect.height)));
        const anchor = { left: pageRect.left - readerRect.left + reader.scrollLeft + pageX * pageRect.width, top: pageRect.top - readerRect.top + reader.scrollTop + pageY * pageRect.height };
        const previousAnchor = annotationAnchorsRef.current.get(annotation.id) || { left: annotation.left - (annotation.pinOffsetX || 0), top: annotation.top - (annotation.pinOffsetY || 0) };
        const cardOffsetX = annotation.cardOffsetX ?? annotation.cardLeft - previousAnchor.left;
        const cardOffsetY = annotation.cardOffsetY ?? annotation.cardTop - previousAnchor.top;
        annotationAnchorsRef.current.set(annotation.id, anchor);
        changed = true;
        return {
          ...annotation,
          pageX,
          pageY,
          left: anchor.left + (annotation.pinOffsetX || 0),
          top: anchor.top + (annotation.pinOffsetY || 0),
          cardLeft: anchor.left + cardOffsetX,
          cardTop: anchor.top + cardOffsetY,
          formulaRegionX: region[0],
          formulaRegionY: region[1],
          formulaRegionWidth: region[2],
          formulaRegionHeight: region[3],
          formulaRegionLeft: pageRect.left - readerRect.left + reader.scrollLeft + region[0] * pageRect.width,
          formulaRegionTop: pageRect.top - readerRect.top + reader.scrollTop + region[1] * pageRect.height,
          formulaRegionPixelWidth: region[2] * pageRect.width,
          formulaRegionPixelHeight: region[3] * pageRect.height,
        };
      });
      return changed ? next : items;
    });
  }, [textLayerVersion]);

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
  }, [realignAnnotations, rightOpen, source, textLayerVersion, zoom]);

  useEffect(() => {
    const reader = readerRef.current;
    if (!reader || !annotations.length) return;
    const restoreRanges = () => {
      for (const annotation of annotations) {
        if (annotation.kind === "text-note" || annotation.kind === "formula") continue;
        const page = reader.querySelector(`[data-page-number="${annotation.pageNumber || 1}"]`);
        const textRoot = page?.querySelector(".textLayer") || page;
        if (!textRoot) continue;
        const existing = annotationRangesRef.current.get(annotation.id);
        const existingText = existing?.range.toString().replace(/\s+/g, " ").trim();
        const expectedText = annotation.text.replace(/\s+/g, " ").trim();
        const existingIsValid = Boolean(
          existing
          && !existing.range.collapsed
          && existing.range.commonAncestorContainer.isConnected
          && textRoot.contains(existing.range.commonAncestorContainer)
          && existingText === expectedText
        );
        if (existingIsValid) continue;
        if (existing) annotationRangesRef.current.delete(annotation.id);
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
  }, [addAnnotationRange, annotations, realignAnnotations, source, textLayerVersion]);

  const anyAnnotationLoading = annotations.some((annotation) => annotation.loading);
  useEffect(() => {
    if (!hydrated || !user || !paperId || !paperSourceKind) return;
    // 流式输出期间不调度保存：这些状态变化本身在 deps 里，流结束后会自然触发一次保存
    if (loading || streaming || anyAnnotationLoading) return;
    const timer = window.setTimeout(async () => {
      // 序列化只在真正保存时做一次；论文文本与上次一致时不重复携带
      const annotationsJson = serializePersistentAnnotations(annotations);
      const includePaperText = paperText !== lastSavedTextRef.current;
      const snapshot = workspaceSnapshot({ paperId, title: paperTitle, meta: paperMeta, sourceKind: paperSourceKind, sourceUrl: paperSourceUrl, paperText: includePaperText ? paperText : "", pageCount, currentPage, zoom, rightOpen, messages, annotationsJson });
      // 与上次成功保存（或水合恢复）的内容一致时不重复写回
      if (snapshot === lastSavedSnapshotRef.current) return;
      const seq = ++saveSeqRef.current;
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
              pageCount,
              ...(includePaperText ? { paperText } : {}),
            },
            currentPage,
            zoom,
            rightOpen,
            messages,
            annotations: JSON.parse(annotationsJson),
          }),
        });
        if (!response.ok) throw new Error("save failed");
        if (seq !== saveSeqRef.current) return; // 已有更新的保存发出（如切换论文），丢弃过期响应
        lastSavedSnapshotRef.current = snapshot;
        lastSavedTextRef.current = paperText;
        setSaveStatus("saved");
      } catch {
        if (seq !== saveSeqRef.current) return;
        setSaveStatus("error");
      }
    }, 900);
    return () => window.clearTimeout(timer);
  }, [annotations, anyAnnotationLoading, currentPage, hydrated, loading, messages, pageCount, paperId, paperMeta, paperSourceKind, paperSourceUrl, paperText, paperTitle, rightOpen, streaming, user, zoom]);

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

  const showUsage = useCallback(async () => {
    setUsageOpen(true);
    setUsageLoading(true);
    try {
      const response = await fetch("/api/usage", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "无法读取用量");
      setUsageStats(payload as UsageStats);
    } catch (error: unknown) {
      setToast(errorMessage(error, "用量读取失败"));
    } finally { setUsageLoading(false); }
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

  const setLibraryPaperStatus = useCallback(async (id: string, status: PaperStatus) => {
    try {
      const response = await fetch(`/api/papers/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "状态更新失败");
      setLibraryPapers((papers) => papers.map((paper) => paper.id === id ? { ...paper, status, updatedAt: payload.paper?.updatedAt || paper.updatedAt } : paper));
      setToast(`已标记为${PAPER_STATUS_OPTIONS.find((option) => option.value === status)?.label || "未读"}`);
      return true;
    } catch (error: unknown) {
      setLibraryPapers((papers) => [...papers]);
      setToast(errorMessage(error, "状态更新失败"));
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
      const restoredMessages: ChatMessage[] = Array.isArray(workspace.messages) && workspace.messages.length ? workspace.messages : [{ id: Date.now(), role: "assistant", content: "这篇论文已经打开，可以继续提问。" }];
      const restoredAnnotations: Annotation[] = (Array.isArray(workspace.annotations) ? workspace.annotations : []).map((item: Annotation) => ({ ...item, loading: false, draft: "", thread: Array.isArray(item.thread) ? item.thread : [], pageNumber: item.pageNumber || 1 }));
      setPaperId(paper.id);
      setPaperSourceKind(paper.sourceKind);
      setPaperSourceUrl(paper.sourceUrl || null);
      setPaperTitle(paper.title);
      setPaperMeta(paper.meta);
      setPaperText(paper.paperText || "");
      setPageCount(paper.pageCount || 1);
      setCurrentPage(workspace.currentPage || 1);
      pendingScrollPageRef.current = workspace.currentPage || 1;
      setZoom(workspace.zoom || 0.88);
      setRightOpen(workspace.rightOpen !== false);
      setMessages(restoredMessages);
      setAnnotations(restoredAnnotations);
      // 记录恢复内容的快照，自动保存据此跳过未变更的"原样写回"
      lastSavedSnapshotRef.current = workspaceSnapshot({ paperId: paper.id, title: paper.title, meta: paper.meta, sourceKind: paper.sourceKind, sourceUrl: paper.sourceUrl || null, paperText: "", pageCount: paper.pageCount || 1, currentPage: workspace.currentPage || 1, zoom: workspace.zoom || 0.88, rightOpen: workspace.rightOpen !== false, messages: restoredMessages, annotationsJson: serializePersistentAnnotations(restoredAnnotations) });
      lastSavedTextRef.current = paper.paperText || "";
      if (paper.sourceKind === "upload") {
        setSource(`/api/papers/${paper.id}/file`);
      } else if (paper.sourceUrl) {
        setSource(`/api/pdf?url=${encodeURIComponent(paper.sourceUrl)}`);
      } else {
        // sourceUrl 缺失时不拼 /api/pdf?url=null
        setSource(null);
      }
      setExtractingText(!paper.paperText);
      setLibraryOpen(false);
      setToast(paper.sourceKind === "upload" || paper.sourceUrl ? "已恢复论文的阅读位置、对话和批注" : "这篇论文缺少原始链接，无法重新加载 PDF");
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
    setCurrentPage(1);
    pendingScrollPageRef.current = 1;
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
      setCurrentPage(1);
      pendingScrollPageRef.current = 1;
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

  const startNewChat = useCallback(() => {
    setMessages([{ id: Date.now(), role: "assistant", content: "新的对话已开始。我会基于整篇论文回答总结、方法、实验与结论问题。" }]);
    setToast("已开始新对话，历史记录已清空");
  }, []);

  return (
    <main className={`app-shell font-${uiFontSize} ${rightOpen ? "right-open" : "right-closed"}${panelResizing ? " panel-resizing" : ""}`} style={{ "--panel-w": `${panelWidth}px` } as React.CSSProperties}>
      <aside className="app-rail">
        <BrandMark />
        <nav className="rail-nav">
          <RailButton icon={<BookOpen size={20} />} label="阅读器" active />
          <RailButton icon={<Library size={20} />} label="我的文库" onClick={showLibrary} />
          <RailButton icon={<Receipt size={20} />} label="用量账单" onClick={showUsage} />
        </nav>
        <div className="rail-bottom">
          <RailButton icon={<CircleHelp size={20} />} label="使用帮助" onClick={() => setToast("提示：先选中文字，再选择翻译或解释")} />
          <div className="font-menu">
            <RailButton icon={<Type size={20} />} label="界面字号" active={fontMenuOpen} onClick={() => setFontMenuOpen(!fontMenuOpen)} />
            {fontMenuOpen && <>
              <div className="popover-backdrop" onMouseDown={() => setFontMenuOpen(false)} />
              <div className="font-popover">
                {UI_FONT_OPTIONS.map((option) => (
                  <button key={option.value} className={uiFontSize === option.value ? "selected" : ""} onClick={() => { setUiFontSize(option.value); setFontMenuOpen(false); }}>
                    <strong>{option.label}</strong>
                    <small>{option.desc}</small>
                    {uiFontSize === option.value && <Check size={13} />}
                  </button>
                ))}
              </div>
            </>}
          </div>
          <RailButton icon={<Settings size={20} />} label="设置" onClick={() => setSettingsOpen(true)} />
          <button className="avatar" aria-label="个人资料" onClick={() => setAccountOpen(!accountOpen)}>{(user?.displayName || user?.email || "W").slice(0, 1).toUpperCase()}</button>
          {accountOpen && user && <div className="account-popover"><strong>{user.displayName}</strong><span>{user.isLocal ? "本机私人资料库" : user.isGuest ? "当前浏览器的游客空间" : user.email}</span><div className={`account-sync ${saveStatus}`}><Cloud size={13} />{saveStatus === "saving" ? "正在保存" : saveStatus === "error" ? "保存遇到问题" : user.isLocal ? "已保存到本机" : "已同步到云端"}</div>{!user.isLocal && <a href="/api/auth/logout"><LogOut size={13} />退出登录</a>}</div>}
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="paper-identity">
            <div className="file-badge"><FileText size={17} /></div>
            <div><h1>{paperTitle}</h1></div>
          </div>
          <div className="top-actions">
            <div className={`sync-status ${saveStatus}`} title="内容变化后会自动写入本地数据库；只有实际写入时才短暂显示保存中">{saveStatus === "error" ? <CloudOff size={14} /> : <Cloud size={14} />}<span>{saveStatus === "loading" ? "读取中" : saveStatus === "saving" ? "保存中" : saveStatus === "error" ? "保存失败" : "本机已保存"}</span></div>
            <button className={`model-card ${config.apiKey || config.hasApiKey ? "configured" : ""}`} onClick={() => setSettingsOpen(true)} title={config.apiKey || config.hasApiKey ? `当前模型：${config.model}（点击修改）` : "还没有配置模型，点击去设置"}>
              <span className={`status-dot ${config.apiKey || config.hasApiKey ? "online" : ""}`} />
              <span className="model-card-text">
                <small>{config.apiKey || config.hasApiKey ? "当前模型" : "未配置模型"}</small>
                <strong>{config.apiKey || config.hasApiKey ? config.model : "演示模式 · 点击配置"}</strong>
              </span>
              <ChevronDown size={15} />
            </button>
            <EffortControl effort={effort} onChange={setEffort} />
            <button className="secondary-button compact" onClick={() => setOpenModal(true)}><Plus size={16} />打开论文</button>
            <button className="icon-button" aria-label={rightOpen ? "收起 AI" : "展开 AI"} title={rightOpen ? "收起 AI 面板" : "展开 AI 面板"} onClick={() => setRightOpen(!rightOpen)}>{rightOpen ? <PanelRightClose size={19} /> : <PanelRightOpen size={19} />}</button>
          </div>
        </header>

        <div className="reader-toolbar">
          <div className="toolbar-group"><button className="icon-button small" aria-label="上一页" title="上一页" onClick={() => goToPage(currentPage - 1)}><ChevronLeft size={17} /></button><span className="page-indicator"><input aria-label="当前页" title="输入页码后回车跳转" value={pageInput} onChange={(e) => setPageInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { goToPage(Number(pageInput) || 1); (e.target as HTMLInputElement).blur(); } }} onBlur={() => { const next = Math.floor(Number(pageInput)); if (next && next !== currentPage) goToPage(next); else setPageInput(String(currentPage)); }} /> / {pageCount}</span><button className="icon-button small" aria-label="下一页" title="下一页" onClick={() => goToPage(currentPage + 1)}><ChevronRight size={17} /></button></div>
          <div className="toolbar-divider" />
          <div className="toolbar-group"><button className="icon-button small" aria-label="缩小" title="缩小" onClick={() => setZoom(Math.max(.55, zoom - .1))}><ZoomOut size={17} /></button><button className="zoom-label" title="恢复 100% 缩放" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button><button className="icon-button small" aria-label="放大" title="放大" onClick={() => setZoom(Math.min(1.8, zoom + .1))}><ZoomIn size={17} /></button></div>
          {source && <><div className="toolbar-divider" /><div className="toolbar-group"><button className={`icon-button small ${thumbsOpen === "show" ? "active" : ""}`} aria-label={thumbsOpen === "show" ? "隐藏缩略图" : "显示缩略图"} title={thumbsOpen === "show" ? "隐藏缩略图栏" : "显示缩略图栏"} onClick={() => setThumbsOpen(thumbsOpen === "show" ? "hide" : "show")}><PanelLeft size={17} /></button></div></>}
          <div className="toolbar-spacer" />
          <button className={`icon-button small ${panMode ? "active" : ""}`} aria-label={panMode ? "切换到选择模式" : "切换到抓手平移模式"} title={panMode ? "选择模式：划词翻译/高亮" : "抓手模式：左键拖动平移页面"} onClick={() => { setPanMode(!panMode); setToast(panMode ? "已切回选择模式，可以划词标注" : "抓手模式：按住左键拖动页面，中键也可随时拖动"); }}><Hand size={17} /></button>
          {source && <button className={`icon-button small ${formulaAssist === "show" ? "active" : ""}`} aria-label={formulaAssist === "show" ? "隐藏公式按钮" : "显示公式按钮"} title={formulaAssist === "show" ? "隐藏页面上的「问公式」按钮" : "显示页面上的「问公式」按钮"} onClick={() => setFormulaAssist(formulaAssist === "show" ? "hide" : "show")}><Sparkles size={17} /></button>}
          <button className="icon-button small" aria-label="全屏" title="切换全屏" onClick={toggleFullscreen}><Maximize2 size={17} /></button>
        </div>

        <div className="reader-main">
          {source && thumbsOpen === "show" && (
            <aside ref={thumbRailRef} className={`thumb-rail${thumbResizing ? " resizing" : ""}${thumbPanning ? " panning" : ""}`} aria-label="页面缩略图" style={{ width: thumbWidth }} onPointerDown={startThumbPan} onClickCapture={(event) => { if (thumbPanMovedRef.current) { event.preventDefault(); event.stopPropagation(); } }}>
              {Array.from({ length: pageCount }, (_, index) => index + 1).map((page) => (
                <button key={page} className={`thumb-item ${currentPage === page ? "active" : ""}`} onClick={() => goToPage(page)} title={`跳到第 ${page} 页`} aria-label={`跳到第 ${page} 页`}>
                  {pageThumbs[page]
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={pageThumbs[page]} alt="" draggable={false} />
                    : <span className="thumb-placeholder"><LoaderCircle className="spin" size={13} /></span>}
                  <span className="thumb-page-no">{page}</span>
                </button>
              ))}
            </aside>
          )}
          {source && thumbsOpen === "show" && <div className="thumb-resize-handle" style={{ left: thumbWidth - 4 }} onPointerDown={startThumbResize} title="拖动调整缩略图栏宽度" aria-label="拖动调整缩略图栏宽度" role="separator" aria-orientation="vertical" />}
          <div className={`reader-viewport ${selectionRects.length ? "custom-selection-active" : ""}${panMode ? " pan-mode" : ""}${readerPanning ? " panning" : ""}`} ref={readerRef} onPointerDown={startReaderPan} onMouseUp={handleSelection} onMouseMove={handleSelectionMove} onContextMenu={handlePdfContextMenu} onMouseDown={handleSelectionStart} onScroll={() => { if (selectionPos) setSelectionPos(null); if (selectionRects.length) { setSelectionRects([]); window.getSelection()?.removeAllRanges(); } if (pdfContextMenu) setPdfContextMenu(null); const reader = readerRef.current; if (!reader || scrollFrameRef.current) return; scrollFrameRef.current = window.requestAnimationFrame(() => { scrollFrameRef.current = 0; const probe = reader.scrollTop + 42; let visiblePage = 1; for (const el of Array.from(reader.querySelectorAll<HTMLElement>("[data-page-number]"))) { if (el.offsetTop <= probe) visiblePage = Number(el.dataset.pageNumber || 1); else break; } setCurrentPage((prev) => (prev === visiblePage ? prev : visiblePage)); }); }}>
          {source ? (
            <PdfDocument source={source} zoom={zoom} showFormula={formulaAssist === "show"} onReady={handlePdfReady} onMetadata={handlePaperMetadata} onFormula={createFormulaAnnotation} onTextLayerReady={handleTextLayerReady} onTextExtracted={handleTextExtracted} onError={handlePdfError} onThumbnail={handleThumbnail} />
          ) : <div style={{ transform: `scale(${zoom})`, transformOrigin: "top center", width: "fit-content", minWidth: "calc(100% + 480px)", margin: "0 auto" }}><DemoPaper /></div>}
          {selectionRects.map((rect, index) => <div key={`selection-${index}`} className="selection-overlay-rect" style={rect} aria-hidden="true" />)}
          {annotations.filter((annotation) => annotation.kind === "formula" && flashedFormulaIds.has(annotation.id) && annotation.formulaRegionLeft !== undefined && annotation.formulaRegionTop !== undefined && annotation.formulaRegionPixelWidth !== undefined && annotation.formulaRegionPixelHeight !== undefined).map((annotation) => (
            <div key={`formula-region-${annotation.id}`} className="formula-annotation-region" style={{ left: annotation.formulaRegionLeft, top: annotation.formulaRegionTop, width: annotation.formulaRegionPixelWidth, height: annotation.formulaRegionPixelHeight }} aria-hidden="true" />
          ))}
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
                <section className={`inline-card ${annotation.color} ${draggingId === annotation.id ? "dragging" : ""}`} style={{ top: annotation.cardTop, left: annotation.cardLeft, width: annotation.cardWidth, ...(annotation.cardHeight ? { height: annotation.cardHeight, maxHeight: "none" as const } : {}) }} onMouseDown={(event) => event.stopPropagation()}>
                  <header onPointerDown={(event) => startAnnotationDrag(event, annotation, "card")} title="拖动移动悬浮卡片">
                    <div className="inline-card-title">
                      <MoreHorizontal className="drag-grip" size={15} />
                      <span>{annotation.kind === "translate" ? <Languages size={15} /> : annotation.kind === "formula" || annotation.kind === "explain" ? <Sparkles size={15} /> : annotation.kind === "ask" ? <MessageSquareText size={15} /> : <Highlighter size={15} />}</span>
                      <div><strong>{annotation.kind === "translate" ? "局部翻译" : annotation.kind === "formula" ? "公式解释" : annotation.kind === "explain" ? "段落解释" : annotation.kind === "ask" ? "针对这段提问" : "高亮标记"}</strong><small>{annotation.kind === "translate" && !shouldPersistAnnotation(annotation) ? "临时翻译 · 本次阅读显示" : "仅使用相关原文 · 自动保存"}</small></div>
                    </div>
                    <div className="inline-card-actions">
                      <button className="delete-note-head" onClick={() => removeAnnotation(annotation.id)} aria-label="删除标记" title="删除标记"><Trash2 size={14} /></button>
                      <button onClick={() => closeAnnotation(annotation)} aria-label="收起批注" title="收起批注"><X size={15} /></button>
                    </div>
                  </header>
                  <blockquote>{annotation.text}</blockquote>
                  {annotation.kind === "highlight" && <><p className="highlight-saved"><Check size={14} />已保存为{annotation.color === "yellow" ? "黄色" : annotation.color === "green" ? "绿色" : annotation.color === "blue" ? "蓝色" : "玫红色"}高亮</p><label className="highlight-note"><span>个人批注</span><textarea value={annotation.note || ""} onChange={(event) => updateAnnotation(annotation.id, { note: event.target.value })} placeholder="记录你对这段内容的想法…" rows={3} /></label></>}
                  {annotation.thread.length > 0 && <div className="inline-thread">{annotation.thread.map((message) => <div key={message.id} className={`inline-message ${message.role}`}>{message.role === "assistant" ? <MarkdownContent content={message.content} compact /> : <p>{message.content}</p>}</div>)}</div>}
                  {annotation.loading && <div className="inline-thinking"><LoaderCircle className="spin" size={16} />{annotation.loadingLabel || "正在结合相邻段落分析…"}</div>}
                  {annotation.kind !== "highlight" && !annotation.loading && (
                    <div className="inline-ask follow-up">
                      <textarea rows={2} value={annotation.draft} onChange={(event) => updateAnnotation(annotation.id, { draft: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && annotation.draft.trim()) { event.preventDefault(); requestInlineAnswer(annotation.id, annotation.kind as ToolAction, annotation.text, annotation.surrounding, annotation.draft, annotation.thread); } }} placeholder={annotation.thread.length ? "继续追问这段内容…" : "针对这段内容提问…"} autoFocus={annotation.kind === "ask" && annotation.thread.length === 0} />
                      <button disabled={!annotation.draft.trim()} onClick={() => requestInlineAnswer(annotation.id, annotation.kind as ToolAction, annotation.text, annotation.surrounding, annotation.draft, annotation.thread)}><Send size={14} />发送</button>
                    </div>
                  )}
                  <footer><button onClick={() => navigator.clipboard.writeText(annotation.result || annotation.text)}><Copy size={13} />复制</button><button className="delete-note" onClick={() => removeAnnotation(annotation.id)}>删除标记</button></footer>
                  <div className="card-resize-strip"><button className="card-resize-handle" onPointerDown={(event) => startAnnotationResize(event, annotation)} aria-label="拖动调整卡片大小" title="拖动调整大小" /></div>
                </section>
              )}
            </React.Fragment>
          ))}
          {showReaderTip && <div className="reader-tip"><Sparkles size={14} /><span>选中论文中的任何内容，立即翻译或提问</span><button onClick={() => setShowReaderTip(false)} aria-label="关闭提示"><X size={13} /></button></div>}
        </div>
        </div>
      </section>

      <aside className="ai-panel" aria-hidden={!rightOpen}>
        {rightOpen && <div className="panel-resize-handle" onPointerDown={startPanelResize} title="拖动调整面板宽度" aria-label="拖动调整面板宽度" role="separator" aria-orientation="vertical" />}
        <header className="ai-header">
          <div className="ai-title"><div className="ai-glyph"><Sparkles size={17} /></div><div className="ai-title-text"><h2>全文 AI</h2><span>{extractingText ? "正在解析论文…" : paperText ? "已读入全文，随时提问" : "演示论文 · 可直接体验"}</span></div></div>
          <div className="ai-header-actions">
            <button className="icon-button small" onClick={startNewChat} aria-label="开始新对话" title="清空当前对话，开始新对话"><SquarePen size={15} /></button>
            <button className="icon-button small" onClick={() => setRightOpen(false)} aria-label="收起 AI 面板" title="收起 AI 面板"><PanelRightClose size={16} /></button>
          </div>
        </header>
        <div className="quick-actions">
          <button onClick={() => sendQuestion("请用三点总结这篇论文的核心贡献。")}>总结全文</button>
          <button onClick={() => sendQuestion("请解释这篇论文最重要的方法，并给出直觉理解。")}>解释方法</button>
          <button onClick={() => sendQuestion("请列出阅读这篇论文前需要了解的概念。")}>前置知识</button>
        </div>
        <div className="chat-stream">
          {messages.map((message, messageIndex) => (
            <div key={message.id} className={`message ${message.role}${streaming && message.role === "assistant" && messageIndex === messages.length - 1 ? " streaming" : ""}`}>
              {message.role === "assistant" && <div className="message-avatar"><Sparkles size={14} /></div>}
              <div className="message-body">
                {message.role === "assistant" && message.steps && message.steps.length > 0 && <div className="message-steps"><Zap size={11} /><span>{message.steps.join(" → ")}</span></div>}
                {message.role === "assistant" ? <MarkdownContent content={message.content} /> : <p>{message.content}</p>}
                {message.role === "assistant" && <div className="message-tools"><button aria-label="复制回答" onClick={() => navigator.clipboard.writeText(message.content)}><Copy size={13} /></button><button aria-label="有帮助"><Check size={13} /></button></div>}
              </div>
            </div>
          ))}
          {loading && !streaming && <div className="message assistant"><div className="message-avatar"><Sparkles size={14} /></div><div className="thinking-wrap"><div className="thinking"><span /><span /><span /></div>{statusText && <div className="thinking-status"><Zap size={11} />{statusText}</div>}</div></div>}
        </div>
        <div className="composer-wrap">
          <div className="composer-top-row">
            <div className="global-context-chip"><BookOpen size={13} /><span>整篇论文</span><small>{extractingText ? "解析中" : paperText ? "上下文已就绪" : "等待文字"}</small></div>
          </div>
          <div className="composer">
            <textarea value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendQuestion(question); } }} placeholder="询问整篇论文…" rows={2} />
            <div className="composer-bottom"><span>⌘ ↵</span><button onClick={() => sendQuestion(question)} disabled={!question.trim() || loading || extractingText} aria-label="发送"><Send size={16} /></button></div>
          </div>
          <p className="ai-disclaimer">AI 可能会出错，请核对重要结论</p>
        </div>
      </aside>

      {selectionPos && (
        <div className="selection-menu" style={{ left: selectionPos.x, top: selectionPos.y }}>
          {(() => {
            const inlineIndex = CHAT_EFFORT_LEVELS.findIndex((level) => level.value === inlineEffort);
            const current = CHAT_EFFORT_LEVELS[inlineIndex] || CHAT_EFFORT_LEVELS[0];
            const cycle = () => setInlineEffort(CHAT_EFFORT_LEVELS[(inlineIndex + 1) % CHAT_EFFORT_LEVELS.length].value);
            return (
              <button className={`inline-effort-toggle level-${inlineIndex}`} onClick={cycle} title={`划词力度：${current.label}（点击切换）\n${current.desc}`} aria-label={`划词力度：${current.label}，点击切换`}>
                <Zap size={14} /><i>{current.label}</i>
              </button>
            );
          })()}
          <span />
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
      {libraryOpen && <LibraryModal onClose={() => setLibraryOpen(false)} papers={libraryPapers} folders={libraryFolders} loading={libraryLoading} activePaperId={paperId} onOpenPaper={openLibraryPaper} onAddPaper={() => { setLibraryOpen(false); setOpenModal(true); }} onCreateFolder={createLibraryFolder} onMovePaper={moveLibraryPaper} onSetStatus={setLibraryPaperStatus} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} config={config} setConfig={setConfig} prompts={promptConfig} setPrompts={setPromptConfig} />}
      {usageOpen && <UsageModal onClose={() => setUsageOpen(false)} stats={usageStats} loading={usageLoading} />}
      {toast && <div className="toast"><Check size={15} />{toast}</div>}
      {!authReady && <div className="auth-gate"><div className="auth-card"><BrandMark /><LoaderCircle className="spin" size={22} /><h2>正在确认登录状态</h2><p>正在安全地读取你的论文空间…</p></div></div>}
      {authReady && !user && <div className="auth-gate"><div className="auth-card"><BrandMark /><h2>开始使用文枢</h2><p>暂时不配置登录也没关系，可以先用游客身份继续阅读和测试。</p><button className="primary-button wide auth-guest" onClick={startGuestSession} disabled={guestSubmitting}>{guestSubmitting ? <><LoaderCircle className="spin" size={15} />正在创建游客空间</> : "游客试用"}</button><div className="auth-divider"><span>以后再登录</span></div><a className="auth-google wide" href="/api/auth/google"><span>G</span>使用 Google 继续</a>{authMessage && <div className="auth-message">{authMessage}</div>}<small>游客数据只绑定当前浏览器；清除 Cookie 后无法恢复，也不能跨设备同步。</small></div></div>}
    </main>
  );
}
