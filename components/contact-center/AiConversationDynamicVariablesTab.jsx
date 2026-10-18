"use client";
import { useUiText } from "@/components/i18n/use-ui-text";


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
  const tUi = useUiText();
  const [webhookLoading, setWebhookLoading] = useState(Boolean(enabled && conversation?.id));
  const [webhookError, setWebhookError] = useState(false);
  const [webhookLogs, setWebhookLogs] = useState(null);

  useEffect(() => {
    if (!enabled) return;
    if (!conversation?.id) return;
    let cancelled = false;
    async function loadWebhookLogs() {
      setWebhookLoading(true);
      setWebhookLogs(null);
      setWebhookError(false);
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
            } else if (!cancelled) setWebhookError(true);
          }
        } else if (!cancelled) setWebhookError(true);
      } catch (_) { if (!cancelled) setWebhookError(true); }
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
  if (webhookError) return <div role="alert" className="rounded-xl border p-5 text-sm text-muted-foreground">{tUi("Variable lookup history is currently unavailable.")}</div>;
  const logs = Array.isArray(webhookLogs) ? webhookLogs : Array.isArray(webhookLogs?.data) ? webhookLogs.data : [];
  if (!logs.length) return <div className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">{tUi("No variable lookup logs for this conversation.")}</div>;
  return <div className="space-y-4">{logs.map((log, index) => <section key={log.id || index} className="space-y-3 rounded-xl border p-4"><div className="text-sm font-medium">{tUi("Variable lookup")}</div>{log.created_at ? <p className="text-xs text-muted-foreground">{new Date(log.created_at).toLocaleString(tUi.locale)}</p> : null}<details><summary className="cursor-pointer text-sm text-muted-foreground">{tUi("Request and response details")}</summary><div className="mt-3"><CodeBlock code={JSON.stringify(log, null, 2)} language="json"><CodeBlockCopyButton /></CodeBlock></div></details></section>)}</div>;
}
