"use client";

import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { parseTtsExpressionText } from "@/lib/ai/tts-expression-text.mjs";

const BADGE_CLASS =
  "mx-0.5 inline-flex translate-y-[-1px] items-center rounded-md border px-1.5 py-0.5 text-[11px] font-semibold leading-none";

function ExpressionBadge({ expression, style }) {
  return (
    <span
      title={expression.raw}
      className={BADGE_CLASS}
      style={style || { borderColor: "currentColor", opacity: 0.85 }}
      data-tts-expression={expression.kind}
    >
      {expression.label}
    </span>
  );
}

// Assistant text with TTS expression tags (<break time="0.3s" />, <emotion>,
// [laughter], …) shown as small badges instead of raw markup, as in the Demo
// Portal transcript. Plain-text variant for simple bubbles.
export function TtsExpressionInline({ children, badgeStyle }) {
  const parts = useMemo(() => parseTtsExpressionText(children), [children]);
  return parts.map((part, index) =>
    part.type === "text" ? (
      <span key={index}>{part.value}</span>
    ) : (
      <ExpressionBadge key={index} expression={part} style={badgeStyle} />
    )
  );
}

// Markdown variant: expressions become links to synthetic anchors that a
// custom link renderer turns into badges, so markdown formatting is kept.
export function TtsExpressionMarkdown({ children, badgeStyle, linkClassName = "underline underline-offset-2" }) {
  const { expressionByHref, markdown } = useMemo(() => {
    const expressions = new Map();
    let index = 0;
    const nextMarkdown = parseTtsExpressionText(children)
      .map((part) => {
        if (part.type === "text") return part.value;
        const href = `#telnyx-tts-expression-${index++}`;
        expressions.set(href, part);
        return `[${part.label}](${href})`;
      })
      .join("");
    return { expressionByHref: expressions, markdown: nextMarkdown };
  }, [children]);

  const components = useMemo(
    () => ({
      a({ href, children: linkChildren, ...props }) {
        const expression = expressionByHref.get(href);
        if (expression) return <ExpressionBadge expression={expression} style={badgeStyle} />;
        return (
          <a className={linkClassName} href={href} rel="noreferrer noopener" target="_blank" {...props}>
            {linkChildren}
          </a>
        );
      },
    }),
    [badgeStyle, expressionByHref, linkClassName]
  );

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {markdown}
    </ReactMarkdown>
  );
}
