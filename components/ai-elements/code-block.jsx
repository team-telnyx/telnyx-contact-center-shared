"use client";
import { Button } from "@/components/ui/button";
import { CheckIcon, CopyIcon } from "lucide-react";
import { cn } from "@/lib/utils";
// moved import above
import { createContext, useContext, useState } from "react";
import dynamic from "next/dynamic";
const SyntaxHighlighter = dynamic(
  () => import("react-syntax-highlighter").then((m) => m.Prism),
  { ssr: false }
);
import {
  oneDark,
  oneLight,
} from "react-syntax-highlighter/dist/esm/styles/prism";

const CodeBlockContext = createContext({
  code: "",
});

export const CodeBlock = ({
  code,
  language,
  showLineNumbers = false,
  className,
  children,
  maxHeight = 360,
  ...props
}) => (
  <CodeBlockContext.Provider value={{ code }}>
    <div
      className={cn(
        "relative w-full max-w-full overflow-auto rounded-md border bg-background text-foreground",
        className
      )}
      style={{ maxHeight }}
      {...props}
    >
      <div className="relative min-w-max">
        <SyntaxHighlighter
          className="overflow-visible dark:hidden"
          codeTagProps={{
            className: "font-mono",
          }}
          customStyle={{
            margin: 0,
            padding: "1rem",
            fontSize:
              String(language).toLowerCase() === "json" ? "11px" : "11px",
            background: "hsl(var(--background))",
            color: "hsl(var(--foreground))",
          }}
          language={language}
          lineNumberStyle={{
            color: "hsl(var(--muted-foreground))",
            paddingRight: "1rem",
            minWidth: "2.5rem",
          }}
          showLineNumbers={showLineNumbers}
          style={oneLight}
        >
          {code}
        </SyntaxHighlighter>
        <SyntaxHighlighter
          className="hidden overflow-visible dark:block"
          codeTagProps={{
            className: "font-mono",
          }}
          customStyle={{
            margin: 0,
            padding: "1rem",
            fontSize:
              String(language).toLowerCase() === "json" ? "11px" : "11px",
            background: "hsl(var(--background))",
            color: "hsl(var(--foreground))",
          }}
          language={language}
          lineNumberStyle={{
            color: "hsl(var(--muted-foreground))",
            paddingRight: "1rem",
            minWidth: "2.5rem",
          }}
          showLineNumbers={showLineNumbers}
          style={oneDark}
        >
          {code}
        </SyntaxHighlighter>
      </div>
      {children && (
        <div className="absolute top-2 right-2 z-10 flex items-center gap-2">
          {children}
        </div>
      )}
    </div>
  </CodeBlockContext.Provider>
);

export const CodeBlockCopyButton = ({
  onCopy,
  onError,
  timeout = 2000,
  children,
  className,
  ...props
}) => {
  const [isCopied, setIsCopied] = useState(false);
  const { code } = useContext(CodeBlockContext);

  const copyToClipboard = async () => {
    if (typeof window === "undefined" || !navigator.clipboard.writeText) {
      onError?.(new Error("Clipboard API not available"));
      return;
    }

    try {
      await navigator.clipboard.writeText(code);
      setIsCopied(true);
      onCopy?.();
      setTimeout(() => setIsCopied(false), timeout);
    } catch (error) {
      onError?.(error);
    }
  };

  const Icon = isCopied ? CheckIcon : CopyIcon;

  return (
    <Button
      className={cn(
        "h-7 w-7 shrink-0 border bg-background/90 shadow-sm backdrop-blur hover:bg-muted",
        isCopied ? "text-telnyx-green" : undefined,
        className
      )}
      onClick={copyToClipboard}
      size="icon"
      variant="ghost"
      {...props}
    >
      {children ?? (
        <Icon
          size={14}
          className={isCopied ? "text-telnyx-green" : undefined}
        />
      )}
    </Button>
  );
};
