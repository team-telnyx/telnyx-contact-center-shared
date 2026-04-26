"use client";

import { useEffect, useState } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { IconCurrencyDollar, IconAlertCircle } from "@tabler/icons-react";
import { Skeleton } from "@/components/ui/skeleton";

// Telnyx-style color palette for cost breakdown (matches portal screenshot)
const PRODUCT_COLORS = [
  "#f59e0b", // amber  – WebRTC / first product
  "#22c55e", // green  – SIP Trunking
  "#3b82f6", // blue   – Call Control
  "#ec4899", // pink   – Recording
  "#a855f7", // purple – AI/LLM
  "#06b6d4", // cyan   – STT
  "#f97316", // orange – TTS
  "#84cc16", // lime   – extra
  "#6366f1", // indigo – extra
];

function formatUsd(val) {
  if (val === undefined || val === null || isNaN(Number(val))) return "—";
  const num = Number(val);
  // Use dynamic precision: show at least 4 decimal places for small amounts
  if (num === 0) return "$0.0000";
  if (num < 0.001) return `$${num.toFixed(6)}`;
  if (num < 0.01) return `$${num.toFixed(5)}`;
  if (num < 1) return `$${num.toFixed(4)}`;
  return `$${num.toFixed(2)}`;
}

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return null;
  const s = Number(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

/** Flatten an EventNode tree into a list of leaf products with costs */
function flattenEventTree(node, result = [], depth = 0) {
  if (!node) return result;

  const cost = parseFloat(node.cost?.event_cost ?? "0");
  if (cost > 0 || depth === 0) {
    result.push({
      id: node.id,
      product: node.product || node.event_name || "Unknown",
      eventName: node.event_name,
      cost,
      cumulativeCost: parseFloat(node.cost?.cumulative_cost ?? "0"),
      currency: node.cost?.currency ?? "USD",
      record: node.record ?? {},
      children: node.children ?? [],
      depth,
    });
  }

  for (const child of node.children ?? []) {
    flattenEventTree(child, result, depth + 1);
  }

  return result;
}

/** Aggregate flat events by product name (for pie chart) */
// Products that should always appear first in the cost breakdown
const PRIORITY_PRODUCTS = ["AI Voice Assistant", "LLM Inference"];

function aggregateByProduct(events) {
  const map = {};
  for (const ev of events) {
    if (ev.cost <= 0) continue;
    const key = humanizeProduct(ev.product);
    if (!map[key]) {
      map[key] = { name: key, value: 0, events: [] };
    }
    map[key].value += ev.cost;
    map[key].events.push(ev);
  }
  return Object.values(map).sort((a, b) => {
    const aPriority = PRIORITY_PRODUCTS.indexOf(a.name);
    const bPriority = PRIORITY_PRODUCTS.indexOf(b.name);
    // Both are priority — sort by index (AI Voice first, then LLM)
    if (aPriority !== -1 && bPriority !== -1) return aPriority - bPriority;
    // Only a is priority
    if (aPriority !== -1) return -1;
    // Only b is priority
    if (bPriority !== -1) return 1;
    // Neither is priority — sort by cost descending
    return b.value - a.value;
  });
}

/** Convert Telnyx product slugs to human-readable names */
function humanizeProduct(product) {
  const MAP = {
    "callcontrol-cdrs": "Call Control",
    "ai-voice-assistant": "AI Voice Assistant",
    "sip-trunking": "SIP Trunking",
    "siptrunking-cdrs": "SIP Trunking",
    "webrtc": "WebRTC",
    "webrtc-cdrs": "WebRTC",
    "recording": "Recording",
    "recording-cdrs": "Recording",
    "transcription": "Transcription",
    "inference": "LLM Inference",
    "tts": "Text-to-Speech",
    "stt": "Speech-to-Text",
    "storage": "Storage",
    "number-lookup": "Number Lookup",
  };
  
  if (MAP[product]) return MAP[product];
  
  // Fallback cleanup (e.g. remove -cdrs if it's there but not mapped)
  let name = product || "Unknown";
  name = name.replace(/-cdrs$/i, "");
  return name
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Extract metadata details from an event record (duration, units, etc.) */
function extractRecordDetails(event) {
  const details = [];
  const r = event.record ?? {};

  // For LLM Inference specifically, we want to show prompt / cached / completion tokens
  if (event.product === "inference" || event.event_name === "inference-event") {
    if (r.model) details.push({ label: "Model", value: r.model });
    if (r.user_prompt_tokens != null) {
      details.push({ label: "User Prompt Tokens", value: Number(r.user_prompt_tokens).toLocaleString() });
    }
    if (r.cached_user_prompt_tokens != null) {
      details.push({ label: "Cached Tokens", value: Number(r.cached_user_prompt_tokens).toLocaleString() });
    }
    if (r.completion_tokens != null) {
      details.push({ label: "Completion Tokens", value: Number(r.completion_tokens).toLocaleString() });
    }
    return details;
  }

  // Billed duration (preferred) then actual duration
  if (r.billed_sec != null) {
    details.push({ label: "Duration", value: formatDuration(r.billed_sec) });
  } else if (r.duration_sec != null) {
    details.push({ label: "Duration", value: formatDuration(r.duration_sec) });
  } else {
    for (const f of ["duration_secs", "duration", "billable_duration_secs", "billable_secs"]) {
      if (r[f] != null) { details.push({ label: "Duration", value: formatDuration(r[f]) }); break; }
    }
  }

  // Character / token / unit counts
  if (r.characters != null) details.push({ label: "Characters", value: Number(r.characters).toLocaleString() });
  if (r.tokens != null && event.product !== "inference") details.push({ label: "Tokens", value: Number(r.tokens).toLocaleString() });
  if (r.units != null) details.push({ label: "Units", value: Number(r.units).toLocaleString() });

  // Rates
  if (r.rate != null && event.product !== "inference") details.push({ label: "Rate", value: `$${parseFloat(r.rate).toFixed(6)}/unit` });

  // Model info for generic events
  if (r.model && !details.some(d => d.label === "Model")) details.push({ label: "Model", value: r.model });
  if (r.llm_model) details.push({ label: "LLM", value: r.llm_model });
  if (r.stt_model) details.push({ label: "STT", value: r.stt_model });
  if (r.tts_model_id) {
    const ttsLabel = [r.tts_provider, r.tts_model_id].filter(Boolean).join("/");
    details.push({ label: "TTS", value: ttsLabel });
  }

  return details;
}

/** Custom donut chart center label */
function DonutLabel({ cx, cy, total }) {
  return (
    <g>
      <text x={cx} y={cy - 8} textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: 11 }}>
        Total
      </text>
      <text x={cx} y={cy + 12} textAnchor="middle" className="fill-foreground font-bold" style={{ fontSize: 15, fontWeight: 700 }}>
        {formatUsd(total)}
      </text>
    </g>
  );
}

/** Custom Tooltip for the pie chart */
function CustomTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const { name, value } = payload[0];
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-lg">
      <p className="text-xs font-semibold">{name}</p>
      <p className="text-xs font-mono text-muted-foreground">{formatUsd(value)}</p>
    </div>
  );
}

export default function AiConversationCostsTab({ conversation }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sessionData, setSessionData] = useState(null);

  const conversationId = conversation?.id;

  useEffect(() => {
    if (!conversationId) return;

    setLoading(true);
    setError(null);
    setSessionData(null);

    // Get call_session_id from conversation — CC stores it at top level
    const callSessionId =
      conversation?.call_session_id ||
      conversation?.metadata?.call_session_id ||
      conversation?.metadata?.telnyx_call_session_id;

    // We only support session analysis for conversations that have a call_session_id 
    // or we can fallback to trying the conversation ID if it's missing (though it might fail).
    const eventId = callSessionId || conversationId;
    
    // Extract date for faster lookups (date_time parameter)
    let dateTimeParams = "";
    if (conversation?.created_at) {
      // Just send the date portion, e.g. 2026-04-22
      const dateStr = conversation.created_at.split('T')[0];
      dateTimeParams = `&date_time=${encodeURIComponent(dateStr)}`;
    }

    // Always use call-session and max_depth=5 as per API requirements for full tree
    const fetchAnalysis = async () => {
      const res = await fetch(
        `/api/ai/conversations/${encodeURIComponent(eventId)}/session-analysis?record_type=call-session&max_depth=5${dateTimeParams}`,
        { cache: "no-store" }
      );
      return res.json();
    };

    (async () => {
      try {
        let result = await fetchAnalysis();

        if (!result.ok) {
          setError(result.error || "Session analysis not available");
        } else {
          setSessionData(result.data);
        }
      } catch (e) {
        setError(e?.message || "Failed to fetch session analysis");
      } finally {
        setLoading(false);
      }
    })();
  }, [conversation]);

  // ── Loading state ──────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="space-y-4 py-2">
        <Skeleton className="h-20 w-full rounded-xl" />
        <div className="flex gap-4">
          <Skeleton className="h-44 w-44 rounded-full shrink-0" />
          <div className="flex-1 space-y-3 pt-2">
            <Skeleton className="h-4 w-32" />
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  // ── Error / fallback to legacy ─────────────────────────────────────────────
  if (error || !sessionData) {
    return <LegacyCostsView conversation={conversation} apiError={error} />;
  }

  // ── Parse session analysis response ───────────────────────────────────────
  const totalCost = parseFloat(sessionData.cost?.total ?? "0");
  const currency = sessionData.cost?.currency ?? "USD";
  const allEvents = flattenEventTree(sessionData.root);
  const productGroups = aggregateByProduct(allEvents);
  const meta = sessionData.meta ?? {};

  if (productGroups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
        <IconCurrencyDollar className="size-10 opacity-40" />
        <p className="text-sm">No cost data available for this conversation</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 py-2">
      {/* ── Total Cost Banner ────────────────────────────────────────────── */}
      <div className="rounded-xl bg-card border border-border px-6 py-4 text-center shadow-sm">
        <p className="text-xs text-muted-foreground mb-1">Total Call Cost</p>
        <p className="text-2xl font-bold font-mono tracking-tight">
          {formatUsd(totalCost)}
        </p>
        {currency && currency !== "USD" && (
          <p className="text-xs text-muted-foreground mt-0.5">{currency}</p>
        )}
      </div>

      {/* ── Donut Chart + Cost Breakdown ─────────────────────────────────── */}
      <div className="flex gap-6 items-center">
        {/* Donut */}
        <div className="shrink-0" style={{ width: 180, height: 180 }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={productGroups}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={55}
                outerRadius={82}
                paddingAngle={2}
                startAngle={90}
                endAngle={-270}
              >
                {productGroups.map((entry, index) => (
                  <Cell
                    key={`cell-${index}`}
                    fill={PRODUCT_COLORS[index % PRODUCT_COLORS.length]}
                    stroke="transparent"
                  />
                ))}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Legend + Breakdown */}
        <div className="flex-1 space-y-2 min-w-0">
          <p className="text-sm font-semibold mb-3">Cost Breakdown</p>
          {productGroups.map((group, index) => {
            const pct = totalCost > 0 ? (group.value / totalCost) * 100 : 0;
            const color = PRODUCT_COLORS[index % PRODUCT_COLORS.length];
            return (
              <div key={group.name} className="flex items-center gap-2 text-sm">
                <span
                  className="inline-block size-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: color }}
                />
                <span className="flex-1 truncate text-sm">{group.name}</span>
                <span className="font-mono font-semibold text-xs shrink-0">
                  {formatUsd(group.value)}
                </span>
                <span className="text-muted-foreground text-xs w-10 text-right shrink-0">
                  {pct.toFixed(1)}%
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Component Details Cards ───────────────────────────────────────── */}
      <div>
        <p className="text-sm font-semibold mb-3">Component Details</p>
        <div className="grid grid-cols-2 gap-3">
          {productGroups.map((group, index) => {
            const color = PRODUCT_COLORS[index % PRODUCT_COLORS.length];
            // Gather details from all events in this group
            const allDetails = group.events.flatMap(extractRecordDetails);
            // Deduplicate same labels (keep first occurrence)
            const seen = new Set();
            const details = allDetails.filter((d) => {
              if (seen.has(d.label)) return false;
              seen.add(d.label);
              return true;
            });

            return (
              <div
                key={group.name}
                className="rounded-xl bg-card border border-border p-3 space-y-2 relative overflow-hidden shadow-sm"
              >
                {/* Colored left indicator matching Telnyx portal style */}
                <div 
                  className="absolute left-0 top-0 bottom-0 w-[3px]" 
                  style={{ backgroundColor: color }} 
                />
                
                <div className="flex items-center justify-between pl-1">
                  <span className="text-sm font-semibold">{group.name}</span>
                  <span className="text-sm font-mono font-bold">
                    {formatUsd(group.value)}
                  </span>
                </div>
                {details.length > 0 ? (
                  <div className="space-y-1 pt-1 pl-1">
                    {details.map((d) => (
                      <div
                        key={d.label}
                        className="flex items-center justify-between text-xs text-muted-foreground"
                      >
                        <span>{d.label}</span>
                        <span className="font-mono">{d.value}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground pl-1">
                    {group.events.length} event{group.events.length !== 1 ? "s" : ""}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Fallback: legacy cost view (for conversations without session analysis) ──
function LegacyCostsView({ conversation, apiError }) {
  const cost =
    conversation?.cost ||
    conversation?.data?.cost ||
    conversation?.billing ||
    conversation?.data?.billing ||
    null;

  if (!cost) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground">
        <IconCurrencyDollar className="size-10 opacity-40" />
        {apiError && (
          <div className="flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2 max-w-xs text-center">
            <IconAlertCircle className="size-3.5 shrink-0" />
            <span>{apiError}</span>
          </div>
        )}
        <p className="text-sm">Cost data not available for this conversation</p>
      </div>
    );
  }

  const rows = [];
  const LEGACY_COLORS = { STT: "#3b82f6", LLM: "#22c55e", TTS: "#a855f7" };

  const stt = cost?.stt || cost?.transcription || null;
  const llm = cost?.llm || cost?.language_model || null;
  const tts = cost?.tts || cost?.text_to_speech || null;

  if (stt) rows.push({ type: "STT", label: "Speech-to-Text", total: parseFloat(stt.total ?? stt.amount ?? 0), color: LEGACY_COLORS.STT });
  if (llm) rows.push({ type: "LLM", label: "Language Model", total: parseFloat(llm.total ?? llm.amount ?? 0), color: LEGACY_COLORS.LLM });
  if (tts) rows.push({ type: "TTS", label: "Text-to-Speech", total: parseFloat(tts.total ?? tts.amount ?? 0), color: LEGACY_COLORS.TTS });

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground">
        <IconCurrencyDollar className="size-10 opacity-40" />
        <p className="text-sm">Cost data not available for this conversation</p>
      </div>
    );
  }

  const grandTotal = rows.reduce((s, r) => s + r.total, 0);
  const pieData = rows.filter((r) => r.total > 0);

  return (
    <div className="space-y-6 py-2">
      <div className="rounded-xl bg-muted/50 border border-border px-6 py-4 text-center">
        <p className="text-xs text-muted-foreground mb-1">Total Cost</p>
        <p className="text-2xl font-bold font-mono">{formatUsd(grandTotal)}</p>
      </div>

      {apiError && (
        <div className="flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2">
          <IconAlertCircle className="size-3.5 shrink-0" />
          <span>Detailed analysis unavailable: {apiError}</span>
        </div>
      )}

      {pieData.length > 0 && (
        <div className="flex gap-6 items-center">
          <div className="shrink-0" style={{ width: 160, height: 160 }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={pieData} dataKey="total" nameKey="label" cx="50%" cy="50%" innerRadius={48} outerRadius={72} paddingAngle={2}>
                  {pieData.map((e, i) => (
                    <Cell key={i} fill={e.color} stroke="transparent" />
                  ))}
                </Pie>
                <Tooltip content={<CustomTooltip />} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="flex-1 space-y-2">
            <p className="text-sm font-semibold mb-3">Cost Breakdown</p>
            {rows.map((r) => {
              const pct = grandTotal > 0 ? (r.total / grandTotal) * 100 : 0;
              return (
                <div key={r.type} className="flex items-center gap-2 text-sm">
                  <span className="inline-block size-2.5 rounded-full shrink-0" style={{ backgroundColor: r.color }} />
                  <span className="flex-1 text-sm">{r.label}</span>
                  <span className="font-mono font-semibold text-xs">{formatUsd(r.total)}</span>
                  <span className="text-muted-foreground text-xs w-10 text-right">{pct.toFixed(1)}%</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
