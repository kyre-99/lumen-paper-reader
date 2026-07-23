"use client";

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

// 把模型常用的 \(...\) 和 \[...\] 公式写法统一转成 $...$ / $$...$$，跳过代码块
function normalizeMathDelimiters(content: string) {
  return content.split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part) => {
    if (part.startsWith("`")) return part;
    return part
      .replace(/\\\[([\s\S]*?)\\\]/g, (_match, tex) => `$$${tex}$$`)
      .replace(/\\\(([\s\S]*?)\\\)/g, (_match, tex) => `$${tex}$`);
  }).join("");
}

// 把回答里的页码引用转成 markdown 链接（#cite-page-N），渲染时变成可点击 chip，点击跳到对应页。
// 支持三种写法：输出契约的【P1, P3】、自然语言的「第 3 页」、英文的 p.3 / P3；
// 页码超出 1..maxPage 时不转链接（模型偶尔会引用不存在的页）；
// 跳过代码块与 $...$ 公式段，避免误替换代码/公式里的文本
function linkifyPageCitations(content: string, maxPage?: number) {
  const inRange = (raw: string) => {
    const page = Number(raw);
    return page >= 1 && (!maxPage || page <= maxPage);
  };
  return content.split(/(```[\s\S]*?```|`[^`\n]*`|\$\$[\s\S]*?\$\$|\$[^$\n]+?\$)/g).map((part) => {
    if (part.startsWith("`") || part.startsWith("$")) return part;
    return part
      .replace(/【\s*P((?:\d+\s*[,，、]?\s*P?)+)】/g, (_match, inner: string) => {
        const pages = (inner.match(/\d+/g) || []).filter(inRange);
        return pages.map((page) => `[【P${page}】](#cite-page-${page})`).join(" ");
      })
      .replace(/第\s*(\d{1,4})\s*页/g, (match, num: string) => inRange(num) ? `[${match}](#cite-page-${Number(num)})` : match)
      .replace(/(^|[^\w./(【])p\.?\s*(\d{1,4})(?!\d)/gi, (match, prefix: string, num: string) => inRange(num) ? `${prefix}[${match.slice(prefix.length)}](#cite-page-${Number(num)})` : match);
  }).join("");
}

// memo 包裹：流式输出时只有当前消息变化，历史消息不必重新跑 Markdown/KaTeX 解析
const MarkdownContent = React.memo(function MarkdownContent({ content, compact = false, maxPage, onPageJump }: { content: string; compact?: boolean; maxPage?: number; onPageJump?: (page: number) => void }) {
  return (
    <div className={`markdown-content${compact ? " compact" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
        components={{
          a: ({ children, href, ...props }) => {
            const cite = href?.match(/^#cite-page-(\d+)$/);
            if (cite && onPageJump) {
              return <button type="button" className="page-cite" title={`跳转到第 ${cite[1]} 页`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); onPageJump(Number(cite[1])); }}>{children}</button>;
            }
            return <a href={href} {...props} target="_blank" rel="noreferrer">{children}</a>;
          },
        }}
      >
        {linkifyPageCitations(normalizeMathDelimiters(content), maxPage)}
      </ReactMarkdown>
    </div>
  );
});

export default MarkdownContent;
