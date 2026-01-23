"use client";

import { cn } from "@/lib/utils";
import { memo, Fragment } from "react";
import dynamic from "next/dynamic";
const ReactMarkdown = dynamic(() => import("react-markdown"), { ssr: false });
import remarkGfm from "remark-gfm";
import {
  CodeBlock as AICodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";

const MarkdownComponents = {
  pre({ children }) {
    return <Fragment>{children}</Fragment>;
  },
  p({ children, className }) {
    return <p className={cn("leading-relaxed my-2", className)}>{children}</p>;
  },
  h1({ children, className }) {
    return (
      <h1 className={cn("text-xl font-semibold mt-4 mb-2", className)}>
        {children}
      </h1>
    );
  },
  h2({ children, className }) {
    return (
      <h2 className={cn("text-lg font-semibold mt-4 mb-2", className)}>
        {children}
      </h2>
    );
  },
  h3({ children, className }) {
    return (
      <h3 className={cn("text-base font-semibold mt-3 mb-2", className)}>
        {children}
      </h3>
    );
  },
  h4({ children, className }) {
    return (
      <h4 className={cn("text-sm font-semibold mt-3 mb-2", className)}>
        {children}
      </h4>
    );
  },
  ul({ children, className }) {
    return (
      <ul className={cn("list-disc pl-6 my-2 space-y-1", className)}>
        {children}
      </ul>
    );
  },
  ol({ children, className }) {
    return (
      <ol className={cn("list-decimal pl-6 my-2 space-y-1", className)}>
        {children}
      </ol>
    );
  },
  li({ children, className }) {
    return <li className={cn("my-0.5", className)}>{children}</li>;
  },
  a({ href, children, className, ...props }) {
    return (
      <a
        className={cn("underline text-blue-600 hover:text-blue-700", className)}
        href={href}
        rel="noreferrer noopener"
        target="_blank"
        {...props}
      >
        {children}
      </a>
    );
  },
  blockquote({ children, className }) {
    return (
      <blockquote
        className={cn(
          "border-l-2 border-border pl-4 italic text-muted-foreground my-3",
          className
        )}
      >
        {children}
      </blockquote>
    );
  },
  hr({ className }) {
    return <hr className={cn("my-4 border-border", className)} />;
  },
  table({ children, className }) {
    return (
      <div className="overflow-x-auto my-3">
        <table className={cn("w-full text-sm border border-border", className)}>
          {children}
        </table>
      </div>
    );
  },
  thead({ children, className }) {
    return (
      <thead className={cn("bg-muted text-foreground", className)}>
        {children}
      </thead>
    );
  },
  th({ children, className }) {
    return (
      <th className={cn("px-2 py-1 border border-border text-left", className)}>
        {children}
      </th>
    );
  },
  td({ children, className }) {
    return (
      <td className={cn("px-2 py-1 border border-border", className)}>
        {children}
      </td>
    );
  },
  code({ inline, className, children, ...props }) {
    const languageMatch = /language-(\w+)/.exec(className || "");
    const raw = String(children ?? "");
    const code = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    const isBlock = Boolean(languageMatch) || (!inline && /\n/.test(code));

    if (isBlock) {
      return (
        <AICodeBlock
          code={code}
          language={languageMatch?.[1] || "text"}
          showLineNumbers
        >
          <CodeBlockCopyButton />
        </AICodeBlock>
      );
    }

    return (
      <code
        className={cn(
          "rounded bg-muted px-1.5 py-0.5 font-mono text-xs",
          className
        )}
        {...props}
      >
        {children}
      </code>
    );
  },
};

export const Response = memo(
  ({ className, children, ...props }) => {
    const text =
      typeof children === "string" ? children : String(children ?? "");

    const segments = [];
    const fenceRe = /```([^\n`]*)\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match;
    while ((match = fenceRe.exec(text)) !== null) {
      if (match.index > lastIndex) {
        const before = text.slice(lastIndex, match.index);
        if (before.trim()) {
          segments.push({ type: "markdown", content: before });
        }
      }
      const language = (match[1] || "text").trim() || "text";
      const code = (match[2] || "").replace(/\n$/, "");
      segments.push({ type: "code", language, code });
      lastIndex = fenceRe.lastIndex;
    }
    if (lastIndex < text.length) {
      const rest = text.slice(lastIndex);
      if (rest.trim()) segments.push({ type: "markdown", content: rest });
    }

    const hasFences = segments.some((s) => s.type === "code");

    return (
      <div
        className={cn(
          "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
          className
        )}
        {...props}
      >
        {hasFences ? (
          segments.map((seg, idx) =>
            seg.type === "code" ? (
              <AICodeBlock
                key={`code-${idx}`}
                code={seg.code}
                language={seg.language}
                showLineNumbers
              >
                <CodeBlockCopyButton />
              </AICodeBlock>
            ) : (
              <ReactMarkdown
                components={MarkdownComponents}
                remarkPlugins={[remarkGfm]}
                key={`md-${idx}`}
              >
                {seg.content}
              </ReactMarkdown>
            )
          )
        ) : (
          <ReactMarkdown
            components={MarkdownComponents}
            remarkPlugins={[remarkGfm]}
          >
            {text}
          </ReactMarkdown>
        )}
      </div>
    );
  },
  (prevProps, nextProps) => prevProps.children === nextProps.children
);

Response.displayName = "Response";

