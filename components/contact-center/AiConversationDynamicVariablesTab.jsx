"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";

export default function AiConversationDynamicVariablesTab({
  conversation,
  enabled,
}) {
  const [webhookLoading, setWebhookLoading] = useState(false);
  const [webhookLogs, setWebhookLogs] = useState(null);

  useEffect(() => {
    if (!enabled) return;
    if (!conversation?.id) return;
    let cancelled = false;
    async function loadWebhookLogs() {
      setWebhookLoading(true);
      try {
        const sp = new URLSearchParams();
        sp.set("page[number]", "1");
        sp.set("page[size]", "1");
        sp.set("sort", "-created_at");
        const res = await fetch(
          `/api/ai/conversations/${encodeURIComponent(
            conversation.id
          )}/webhook-logs?${sp.toString()}`,
          { cache: "no-store" }
        );
        const data = await res.json();
        if (!cancelled && res.ok && data?.ok) {
          setWebhookLogs(data?.data ?? data);
        }
      } catch (_) {}
      if (!cancelled) setWebhookLoading(false);
    }
    loadWebhookLogs();
    return () => {
      cancelled = true;
    };
  }, [conversation?.id, enabled]);

  if (webhookLoading) {
    return (
      <div className="space-y-2">
        {[...Array(2)].map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }
  if (!webhookLogs) {
    return <div className="text-sm text-muted-foreground">No logs</div>;
  }
  return (
    <CodeBlock code={JSON.stringify(webhookLogs, null, 2)} language="json">
      <CodeBlockCopyButton />
    </CodeBlock>
  );
}

