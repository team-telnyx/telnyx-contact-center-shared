"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import { Response } from "@/components/ai-elements/response";
import { IconBulb } from "@tabler/icons-react";

function formatTimestamp(value) {
  if (!value) return "";
  try {
    const d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    const pad2 = (n) => String(n).padStart(2, "0");
    const pad3 = (n) => String(n).padStart(3, "0");
    const yyyy = d.getFullYear();
    const MM = pad2(d.getMonth() + 1);
    const DD = pad2(d.getDate());
    const HH = pad2(d.getHours());
    const mm = pad2(d.getMinutes());
    const ss = pad2(d.getSeconds());
    const SSS = pad3(d.getMilliseconds());
    return `${yyyy}-${MM}-${DD} ${HH}:${mm}:${ss}.${SSS}`;
  } catch {
    return String(value);
  }
}

export default function AiConversationInsightsTab({ 
  conversation, 
  enabled,
  useDemoApiKey = false,
  hasAiCallControlId = false,
}) {
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [insights, setInsights] = useState([]);
  const [insightNames, setInsightNames] = useState({});

  useEffect(() => {
    if (!enabled) return;
    if (!conversation?.id) return;
    let cancelled = false;
    async function loadInsights() {
      setInsightsLoading(true);
      try {
        const url = `/api/ai/conversations/${encodeURIComponent(
          conversation.id
        )}/conversations-insights${useDemoApiKey ? "?useDemoApiKey=true" : ""}`;
        const res = await fetch(url, { cache: "no-store" });
        const data = await res.json();
        if (!cancelled && res.ok && data?.ok) {
          const next = Array.isArray(data?.insights)
            ? data.insights
            : data?.data || [];
          setInsights(next);
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
            const demoUrl = `/api/ai/conversations/${encodeURIComponent(
              conversation.id
            )}/conversations-insights?useDemoApiKey=true`;
            const demoRes = await fetch(demoUrl, { cache: "no-store" });
            const demoData = await demoRes.json();
            if (!cancelled && demoRes.ok && demoData?.ok) {
              const next = Array.isArray(demoData?.insights)
                ? demoData.insights
                : demoData?.data || [];
              setInsights(next);
            }
          }
        }
        
        // Load insight groups (this doesn't need demo API key as it's a general endpoint)
        const groupsRes = await fetch(`/api/ai/conversations/insight-groups`, {
          cache: "no-store",
        });
        const groupsData = await groupsRes.json();
        if (
          !cancelled &&
          groupsRes.ok &&
          groupsData?.ok &&
          groupsData?.insightNameById
        ) {
          setInsightNames(groupsData.insightNameById || {});
        }
      } catch (_) {}
      if (!cancelled) setInsightsLoading(false);
    }
    loadInsights();
    return () => {
      cancelled = true;
    };
  }, [conversation?.id, enabled, useDemoApiKey, hasAiCallControlId]);

  return (
    <div className="flex-1 min-h-0 overflow-auto py-2 space-y-2">
      {insightsLoading && (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      )}
      {!insightsLoading && (!insights || insights.length === 0) && (
        <div className="text-sm text-muted-foreground">No insights</div>
      )}
      {!insightsLoading &&
        Array.isArray(insights) &&
        insights.flatMap((entry) => {
          const created = entry?.created_at;
          const list = Array.isArray(entry?.conversation_insights)
            ? entry.conversation_insights
            : [];
          return list.map((ins, idx) => {
            let parsed;
            let isJson = false;
            try {
              parsed = JSON.parse(ins?.result ?? "");
              isJson = typeof parsed === "object" && parsed !== null;
            } catch {
              parsed = ins?.result ?? "";
              isJson = false;
            }
            const title =
              (isJson && typeof parsed?.title === "string" && parsed.title) ||
              (ins?.insight_id && insightNames[ins.insight_id]) ||
              ins?.insight_id ||
              "Insight";
            return (
              <Card key={`${entry?.id || "e"}-${idx}`}>
                <CardHeader className="flex-row items-center justify-between gap-2">
                  <CardTitle className="truncate inline-flex items-center gap-2">
                    <IconBulb className="size-4 text-amber-500" />
                    <span className="truncate">{title}</span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {isJson ? (
                    <CodeBlock
                      code={JSON.stringify(parsed, null, 2)}
                      language="json"
                    >
                      <CodeBlockCopyButton />
                    </CodeBlock>
                  ) : (
                    <Response className="text-sm">{String(parsed)}</Response>
                  )}
                  {created && (
                    <div className="text-[10px] text-muted-foreground mt-2">
                      {formatTimestamp(created)}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          });
        })}
    </div>
  );
}

