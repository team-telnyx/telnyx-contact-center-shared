"use client";
import { useUiText } from "@/components/i18n/use-ui-text";


import { useCallback, useEffect, useMemo, useState } from "react";
import { IconCheck, IconCopy, IconTerminal2 } from "@tabler/icons-react";

function toCodeText(children) {
  return Array.isArray(children) ? children.join("") : String(children || "");
}

export function DocsTerminal({ children, title = "Terminal" }) {
  const tUi = useUiText();
  const code = useMemo(() => toCodeText(children), [children]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;

    const timeout = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const copyCode = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = code;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
      setCopied(true);
    }
  }, [code]);

  return (
    <figure className="help-terminal">
      <figcaption>
        <span>
          <IconTerminal2 className="size-4" />
          {title}
        </span>
        <button
          type="button"
          className="help-terminal-copy"
          onClick={copyCode}
          aria-label={tUi("Copy {value0} command", { value0: title })}
        >
          {copied ? <IconCheck className="size-4" /> : <IconCopy className="size-4" />}
          {copied ? tUi("Copied") : tUi("Copy")}
        </button>
      </figcaption>
      <pre>{code}</pre>
    </figure>
  );
}
