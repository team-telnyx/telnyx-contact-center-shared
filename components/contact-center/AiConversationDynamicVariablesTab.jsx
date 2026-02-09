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
  useDemoApiKey = false,
  hasAiCallControlId = false,
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
        if (useDemoApiKey) {
          sp.set("useDemoApiKey", "true");
        }
        const res = await fetch(
          `/api/ai/conversations/${encodeURIComponent(
            conversation.id
          )}/webhook-logs?${sp.toString()}`,
          { cache: "no-store" }
        );
        const data = await res.json();
        if (!cancelled && res.ok && data?.ok) {
          setWebhookLogs(data?.data ?? data);
        } else if (!cancelled && hasAiCallControlId && !useDemoApiKey) {
          // Check if we should retry with demo API key
          // Retry if: 502 (gateway error), 403, 404, or error message indicates "not found"
          const shouldRetry = !res.ok || 
            res.status === 403 || 
            res.status === 404 || 
            res.status === 502 ||
            (data?.error && (
              data.error.includes("404") || 
              data.error.includes("not found") || 
              data.error.includes("Resource not found")
            ));
          
          if (shouldRetry) {
            // Fallback: try with demo API key if regular fetch failed
            const demoSp = new URLSearchParams();
            demoSp.set("page[number]", "1");
            demoSp.set("page[size]", "1");
            demoSp.set("sort", "-created_at");
            demoSp.set("useDemoApiKey", "true");
            const demoRes = await fetch(
              `/api/ai/conversations/${encodeURIComponent(
                conversation.id
              )}/webhook-logs?${demoSp.toString()}`,
              { cache: "no-store" }
            );
            const demoData = await demoRes.json();
            if (!cancelled && demoRes.ok && demoData?.ok) {
              setWebhookLogs(demoData?.data ?? demoData);
            }
          }
        }
      } catch (_) {}
      if (!cancelled) setWebhookLoading(false);
    }
    loadWebhookLogs();
    return () => {
      cancelled = true;
    };
  }, [conversation?.id, enabled, useDemoApiKey, hasAiCallControlId]);

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

