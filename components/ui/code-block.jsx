"use client";

import { cn } from "@/lib/utils";

export default function CodeBlock({
  data,
  language = "json",
  wrap = false,
  height = "auto",
  className,
}) {
  const content =
    typeof data === "string" ? data : JSON.stringify(data, null, 2);

  return (
    <div
      className={cn(
        "rounded-md border bg-muted/50 overflow-auto",
        className
      )}
      style={{ height, maxHeight: height }}
    >
      <pre
        className={cn(
          "p-4 text-sm font-mono",
          wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"
        )}
      >
        <code>{content}</code>
      </pre>
    </div>
  );
}
