"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  IconActivity,
  IconBrain,
  IconChartBar,
  IconChecklist,
  IconDatabase,
  IconMessageCircle,
  IconPhone,
  IconPlugConnected,
  IconRobot,
  IconServerCog,
  IconSparkles,
  IconTool,
  IconWaveSine,
} from "@tabler/icons-react";

const LATENCY_BUCKETS = [
  { key: "sub500", label: "<500 ms", min: 0, max: 500 },
  { key: "500to1s", label: "0.5–1s", min: 500, max: 1000 },
  { key: "1to2s", label: "1–2s", min: 1000, max: 2000 },
  { key: "2to4s", label: "2–4s", min: 2000, max: 4000 },
  { key: "over4s", label: ">4s", min: 4000, max: Infinity },
];

const INTERACTION_RANGES = [
  { key: "1d", label: "1 day", days: 1, points: 24 },
  { key: "7d", label: "7 days", days: 7, points: 7 },
  { key: "30d", label: "30 days", days: 30, points: 30 },
];

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function displayValue(value, fallback = "Not configured") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function summarizeInstructions(instructions) {
  const text = String(instructions || "")
    .replace(/#+\s*/g, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "Add instructions to let the dashboard generate a sharper use-case review.";
  return text.length > 260 ? `${text.slice(0, 257)}…` : text;
}

function getChannel(conversation) {
  const metadata = conversation?.metadata || {};
  const raw = String(
    metadata.telnyx_conversation_channel ||
      metadata.channel ||
      conversation?.channel ||
      conversation?.type ||
      ""
  ).toLowerCase();

  if (raw.includes("sms")) return "sms";
  if (raw.includes("chat") || raw.includes("web")) return "chat";
  if (raw.includes("phone") || raw.includes("voice") || raw.includes("call")) return "voice";
  return "chat";
}

function extractLatencyFromMetadata(metadata = {}) {
  const candidates = [
    metadata.end_user_perceived_latency_ms,
    metadata.average_latency_ms,
    metadata.avg_latency_ms,
    metadata.response_latency_ms,
    metadata.assistant_latency_ms,
    metadata.total_latency_ms,
    metadata.latency_ms,
    metadata.time_to_first_response_ms,
    metadata.time_to_first_token_ms,
    metadata.llm_first_token_duration_ms,
    metadata.audio_first_token_duration_ms,
    metadata.transcription_duration_ms,
  ];

  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function getLatencyMs(conversation) {
  const metadataLatency = extractLatencyFromMetadata(conversation?.metadata || {});
  if (metadataLatency) return metadataLatency;

  const candidates = [
    conversation?.average_latency_ms,
    conversation?.latency_ms,
    conversation?.duration_ms,
  ];

  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function extractMessageLatencySamples(messages) {
  return asArray(messages)
    .filter((message) => message?.role === "assistant" || message?.metadata)
    .map((message) => extractLatencyFromMetadata(message?.metadata || {}))
    .filter((latency) => Number.isFinite(latency) && latency > 0);
}

function getConversationTimestamp(conversation) {
  const metadata = conversation?.metadata || {};
  const value =
    conversation?.last_message_at ||
    conversation?.updated_at ||
    conversation?.created_at ||
    conversation?.createdAt ||
    metadata.last_message_at ||
    metadata.created_at;
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

function formatLatency(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} s`;
}

function buildStats(conversations, latencySamplesByConversationId = {}) {
  const stats = {
    total: conversations.length,
    voice: 0,
    sms: 0,
    chat: 0,
    avgLatencyMs: null,
    latencySamples: 0,
    buckets: LATENCY_BUCKETS.map((bucket) => ({ ...bucket, count: 0 })),
  };

  let latencyTotal = 0;
  conversations.forEach((conversation) => {
    stats[getChannel(conversation)] += 1;
    const messageSamples = latencySamplesByConversationId[conversation?.id] || [];
    const samples = messageSamples.length ? messageSamples : [getLatencyMs(conversation)].filter(Boolean);
    samples.forEach((latency) => {
      latencyTotal += latency;
      stats.latencySamples += 1;
      const bucket = stats.buckets.find((item) => latency >= item.min && latency < item.max);
      if (bucket) bucket.count += 1;
    });
  });

  if (stats.latencySamples > 0) {
    stats.avgLatencyMs = Math.round(latencyTotal / stats.latencySamples);
  }
  return stats;
}

function buildInteractionTimeline(conversations, rangeKey) {
  const range = INTERACTION_RANGES.find((item) => item.key === rangeKey) || INTERACTION_RANGES[0];
  const now = new Date();
  const start = new Date(now.getTime() - range.days * 24 * 60 * 60 * 1000);
  const points = Array.from({ length: range.points }, (_, index) => {
    if (range.key === "1d") {
      const date = new Date(start.getTime() + index * 60 * 60 * 1000);
      return { key: date.toISOString(), label: `${String(date.getHours()).padStart(2, "0")}:00`, count: 0 };
    }
    const date = new Date(start);
    date.setDate(start.getDate() + index + 1);
    return {
      key: date.toISOString().slice(0, 10),
      label: `${date.getDate()} ${MONTH_LABELS[date.getMonth()]}`,
      count: 0,
    };
  });

  conversations.forEach((conversation) => {
    const date = getConversationTimestamp(conversation);
    if (!date || date < start || date > now) return;
    let index;
    if (range.key === "1d") {
      index = Math.min(range.points - 1, Math.max(0, Math.floor((date - start) / (60 * 60 * 1000))));
    } else {
      index = Math.min(range.points - 1, Math.max(0, Math.ceil((date - start) / (24 * 60 * 60 * 1000)) - 1));
    }
    points[index].count += 1;
  });

  return points;
}

function ConfigPill({ icon: Icon, label, value, accent = "text-telnyx-green" }) {
  return (
    <div className="rounded-xl border bg-card p-3 shadow-sm transition-colors hover:bg-muted/30">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className={`size-4 shrink-0 ${accent}`} />
        <span>{label}</span>
      </div>
      <div className="mt-2 min-h-5 break-all text-sm font-semibold leading-snug" title={displayValue(value)}>
        {displayValue(value)}
      </div>
    </div>
  );
}

function StatTile({ icon: Icon, label, value, helper, className = "" }) {
  return (
    <div className={`rounded-2xl border bg-card p-4 shadow-sm transition-colors hover:bg-muted/30 ${className}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="rounded-xl bg-muted p-2 text-telnyx-green">
          <Icon className="size-5" />
        </div>
        <Badge variant="outline" className="text-telnyx-green">
          Live review
        </Badge>
      </div>
      <div className="mt-4 text-2xl font-semibold tracking-tight">{value}</div>
      <div className="mt-1 text-sm font-medium">{label}</div>
      {helper && <div className="mt-1 text-xs text-muted-foreground">{helper}</div>}
    </div>
  );
}

export default function AssistantDashboardTab({
  assistantId,
  values,
  summaryState,
  onSummaryStateChange,
  analyticsState,
  onAnalyticsStateChange,
}) {
  const [interactionRange, setInteractionRange] = useState("7d");
  const latencySamplesRequestRef = useRef(0);
  const attemptedAnalyticsLoadRef = useRef(null);
  const analyticsKey = assistantId || "draft";
  const conversations = asArray(analyticsState?.conversations);
  const conversationsLoading = analyticsState?.conversationsLoading || false;
  const latencyDetailsLoading = analyticsState?.latencyDetailsLoading || false;
  const latencySamplesByConversationId = useMemo(
    () => analyticsState?.latencySamplesByConversationId || {},
    [analyticsState?.latencySamplesByConversationId]
  );

  const tools = asArray(values?.tools);
  const integrations = asArray(values?.integrations);
  const mcpServers = asArray(values?.mcp_servers);
  const dynamicVariablesCount = Object.keys(values?.dynamic_variables || {}).length;
  const enabledFeatures = asArray(values?.enabled_features);
  const stats = useMemo(
    () => buildStats(conversations, latencySamplesByConversationId),
    [conversations, latencySamplesByConversationId]
  );
  const maxBucketCount = Math.max(1, ...stats.buckets.map((bucket) => bucket.count));
  const timeline = useMemo(
    () => buildInteractionTimeline(conversations, interactionRange),
    [conversations, interactionRange]
  );
  const maxTimelineCount = Math.max(1, ...timeline.map((point) => point.count));
  const summaryKey = assistantId || "draft";
  const summary = summaryState?.summary || "";
  const summaryLoading = summaryState?.loading || false;
  const summaryError = summaryState?.error || "";

  const updateSummaryState = useCallback(
    (next) => {
      onSummaryStateChange?.((previous) => ({
        ...(previous || {}),
        [summaryKey]: {
          ...((previous || {})[summaryKey] || {}),
          ...next,
        },
      }));
    },
    [onSummaryStateChange, summaryKey]
  );

  const updateAnalyticsState = useCallback(
    (next) => {
      onAnalyticsStateChange?.((previous) => ({
        ...(previous || {}),
        [analyticsKey]: {
          ...((previous || {})[analyticsKey] || {}),
          ...next,
        },
      }));
    },
    [analyticsKey, onAnalyticsStateChange]
  );

  const loadSummary = useCallback(
    async ({ force = false } = {}) => {
      if (!assistantId && !values?.instructions) return;
      if (!force && (summaryState?.summary || summaryState?.loading || summaryState?.loaded)) return;
      updateSummaryState({ loading: true, error: "", loaded: false });
      try {
        const res = await fetch(
          `/api/ai/assistants/${encodeURIComponent(assistantId || "draft")}/dashboard-summary`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ assistant: values }),
            cache: "no-store",
          }
        );
        const data = await res.json();
        if (!res.ok || data?.ok === false) throw new Error(data?.error || "Summary failed");
        updateSummaryState({ summary: data.summary || "", loading: false, error: "", loaded: true });
      } catch (error) {
        updateSummaryState({
          summary: "",
          loading: false,
          error: error?.message || String(error),
          loaded: true,
        });
      }
    },
    [
      assistantId,
      values,
      summaryState?.summary,
      summaryState?.loading,
      summaryState?.loaded,
      updateSummaryState,
    ]
  );

  const loadMessageLatencySamples = useCallback(
    async (conversationItems) => {
      const requestId = latencySamplesRequestRef.current + 1;
      latencySamplesRequestRef.current = requestId;
      const ids = conversationItems.map((conversation) => conversation?.id).filter(Boolean);
      if (!ids.length) {
        updateAnalyticsState({ latencySamplesByConversationId: {}, latencyDetailsLoading: false });
        return;
      }

      updateAnalyticsState({ latencyDetailsLoading: true });
      const next = {};
      try {
        for (let index = 0; index < ids.length; index += 6) {
          const chunk = ids.slice(index, index + 6);
          const results = await Promise.all(
            chunk.map(async (id) => {
              try {
                const res = await fetch(`/api/ai/conversations/${encodeURIComponent(id)}/messages`, {
                  cache: "no-store",
                });
                const data = await res.json();
                if (!res.ok || data?.ok === false) return [id, []];
                return [id, extractMessageLatencySamples(data.messages || data.data || [])];
              } catch (_) {
                return [id, []];
              }
            })
          );
          results.forEach(([id, samples]) => {
            if (samples.length) next[id] = samples;
          });
        }
        if (latencySamplesRequestRef.current === requestId) {
          updateAnalyticsState({ latencySamplesByConversationId: next, latencyDetailsLoading: false });
        }
      } finally {
        if (latencySamplesRequestRef.current === requestId) {
          updateAnalyticsState({ latencyDetailsLoading: false });
        }
      }
    },
    [updateAnalyticsState]
  );

  const loadConversations = useCallback(
    async ({ force = false } = {}) => {
      if (!assistantId) return;
      if (analyticsState?.conversationsLoading) return;
      if (!force) {
        if (analyticsState?.loaded) return;
        if (attemptedAnalyticsLoadRef.current === analyticsKey) return;
      }
      attemptedAnalyticsLoadRef.current = analyticsKey;
      updateAnalyticsState({
        conversationsLoading: true,
        latencyDetailsLoading: force ? true : analyticsState?.latencyDetailsLoading || false,
        error: "",
      });
      try {
        const sp = new URLSearchParams();
        sp.set("page", "1");
        sp.set("pageSize", "100");
        sp.set("metadata->assistant_id", assistantId);
        const res = await fetch(`/api/ai/conversations?${sp.toString()}`, { cache: "no-store" });
        const data = await res.json();
        if (!res.ok || data?.ok === false) throw new Error(data?.error || "Failed to fetch conversations");
        const items = data.items || data.data || [];
        const nextConversations = Array.isArray(items) ? items : [];
        updateAnalyticsState({ conversations: nextConversations, conversationsLoading: false, loaded: true, error: "" });
        await loadMessageLatencySamples(nextConversations);
      } catch (error) {
        updateAnalyticsState({
          conversations: [],
          conversationsLoading: false,
          latencyDetailsLoading: false,
          latencySamplesByConversationId: {},
          loaded: false,
          error: error?.message || String(error),
        });
      }
    },
    [
      analyticsState?.conversationsLoading,
      analyticsState?.latencyDetailsLoading,
      analyticsState?.loaded,
      analyticsKey,
      assistantId,
      loadMessageLatencySamples,
      updateAnalyticsState,
    ]
  );

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  const fallbackSummary = values?.description || summarizeInstructions(values?.instructions);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="shrink-0 overflow-hidden rounded-3xl border bg-card shadow-sm">
        <div className="space-y-5 p-5 md:p-6">
          <div className="grid gap-5 2xl:grid-cols-[minmax(0,1fr)_46rem] 2xl:items-stretch">
            <div className="flex h-full flex-col rounded-2xl border bg-background p-4 shadow-sm">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <IconBrain className="size-4 text-telnyx-green" /> Use case summary
              </div>
              <div className="mt-2 min-h-[9.75rem] flex-1 overflow-y-auto pr-2 text-sm leading-6 text-muted-foreground">
                {summaryLoading ? (
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-5/6" />
                    <Skeleton className="h-4 w-2/3" />
                  </div>
                ) : summary ? (
                  summary
                ) : (
                  fallbackSummary
                )}
              </div>
              {summaryError && (
                <div className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                  Telnyx summary unavailable, showing local configuration summary.
                </div>
              )}
            </div>

            <div className="grid h-full gap-3 md:grid-cols-2 xl:grid-cols-3">
              <ConfigPill icon={IconRobot} label="LLM model" value={values?.model} />
              <ConfigPill icon={IconWaveSine} label="STT provider/model" value={values?.transcription?.model} accent="text-sky-500" />
              <ConfigPill icon={IconSparkles} label="TTS voice" value={values?.voice} accent="text-fuchsia-500" />
              <ConfigPill icon={IconBrain} label="Fallback model" value={values?.fallback_enabled ? values?.fallback_model : "Disabled"} accent="text-amber-500" />
              <ConfigPill icon={IconChecklist} label="Enabled features" value={enabledFeatures.length ? enabledFeatures.join(", ") : "None"} accent="text-emerald-500" />
              <ConfigPill icon={IconDatabase} label="Variables" value={dynamicVariablesCount} accent="text-amber-500" />
              <ConfigPill icon={IconTool} label="Tools" value={tools.length} />
              <ConfigPill icon={IconPlugConnected} label="Integrations" value={integrations.length} accent="text-fuchsia-500" />
              <ConfigPill icon={IconServerCog} label="MCP servers" value={mcpServers.length} accent="text-sky-500" />
            </div>
          </div>
        </div>
      </div>

      <div className="grid shrink-0 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatTile icon={IconActivity} label="Total interactions" value={conversationsLoading ? "…" : stats.total} helper="Latest 100 conversations" />
        <StatTile icon={IconPhone} label="Voice calls" value={conversationsLoading ? "…" : stats.voice} helper="Phone/Voice channels" />
        <StatTile icon={IconMessageCircle} label="SMS + Chat" value={conversationsLoading ? "…" : stats.sms + stats.chat} helper={`${stats.sms} SMS · ${stats.chat} chat`} />
        <StatTile icon={IconWaveSine} label="Average latency" value={formatLatency(stats.avgLatencyMs)} helper={latencyDetailsLoading ? "Reading message latency…" : `${stats.latencySamples} measured samples`} />
      </div>

      <div className="grid min-h-[20rem] flex-1 gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <Card className="h-full overflow-hidden py-0">
          <CardContent className="flex h-full flex-col p-0">
            <div className="flex items-start justify-between gap-3 p-4">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <IconChartBar className="size-4 text-telnyx-green" /> Interactions over time
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Conversation volume from recent assistant history.
                </p>
              </div>
              <div className="flex rounded-lg border bg-background p-1">
                {INTERACTION_RANGES.map((range) => (
                  <Button
                    key={range.key}
                    type="button"
                    variant={interactionRange === range.key ? "default" : "ghost"}
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => setInteractionRange(range.key)}
                  >
                    {range.label}
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col p-4">
              <div className="flex min-h-[14rem] flex-1 items-end gap-1 rounded-xl border bg-background p-3">
                {timeline.map((point) => {
                  const height = `${Math.max(point.count ? 8 : 2, Math.round((point.count / maxTimelineCount) * 100))}%`;
                  return (
                    <div key={point.key} className="flex h-full min-w-0 flex-1 flex-col justify-end gap-2">
                      <div className="flex flex-1 items-end">
                        <div
                          className="w-full rounded-t-md bg-telnyx-green"
                          style={{ height }}
                          title={`${point.label}: ${point.count} interactions`}
                        />
                      </div>
                      <div className="truncate text-center text-[10px] text-muted-foreground">
                        {point.label}
                      </div>
                    </div>
                  );
                })}
              </div>
              {stats.total === 0 && (
                <div className="mt-3 rounded-xl border border-dashed p-3 text-xs text-muted-foreground">
                  No interactions found for this assistant yet.
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="h-full overflow-hidden py-0">
          <CardContent className="flex h-full flex-col p-0">
            <div className="p-4">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <IconChartBar className="size-4 text-telnyx-green" /> Latency distribution
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Buckets use conversation metadata and assistant message latency fields from recent calls.
              </p>
            </div>
            <div className="flex-1 space-y-3 p-4">
              {stats.buckets.map((bucket) => {
                const width = `${Math.max(bucket.count ? 4 : 0, Math.round((bucket.count / maxBucketCount) * 100))}%`;
                return (
                  <div key={bucket.key} className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium">{bucket.label}</span>
                      <span className="text-muted-foreground">{bucket.count}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-telnyx-green" style={{ width }} />
                    </div>
                  </div>
                );
              })}
              {stats.latencySamples === 0 && (
                <div className="rounded-xl border border-dashed p-3 text-xs text-muted-foreground">
                  {latencyDetailsLoading
                    ? "Reading message-level latency from conversation history…"
                    : "No latency metadata found yet. Once conversations include response timing, this panel will render a real distribution."}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
