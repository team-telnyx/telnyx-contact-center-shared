"use client";
import { useCallback, useEffect, useState } from "react";
import { Clock3, Save } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { InteractionChannel } from "./InteractionChannel";
import { notify } from "@/components/ToastNotify";
import { channelDefinition } from "@/lib/acd/channel-registry.mjs";
export function useSlaSettings(queueId = null) {
  const [data, setData] = useState(null),
    [draft, setDraft] = useState({}),
    [error, setError] = useState(null),
    [saving, setSaving] = useState(false),
    [saved, setSaved] = useState(false),
    [units, setUnits] = useState({});
  const load = useCallback(
    async (signal) => {
      setError(null);
      const response = await fetch(
        `/api/admin/sla${queueId ? "?queueId=" + encodeURIComponent(queueId) : ""}`,
        { cache: "no-store", signal },
      );
      const next = await response.json();
      if (!response.ok) throw new Error(next.error);
      if (signal?.aborted) return;
      setData(next);
      setDraft(
        Object.fromEntries(
          next.channels.map((channel) => [
            channel,
            queueId
              ? next.policies[channel] || {
                  mode:
                    next.effective[channel].source === "queue"
                      ? "override"
                      : "inherit",
                  policy: next.effective[channel],
                }
              : next.policies[channel] || null,
          ]),
        ),
      );
    },
    [queueId],
  );
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    load(controller.signal).catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => controller.abort();
  }, [load]);
  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch("/api/admin/sla", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queueId,
          revision: data.revision,
          policies: Object.fromEntries(
            Object.entries(draft).filter(([, value]) => value),
          ),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      await load();
      setSaved(true);
      notify({ title: "SLA settings saved", description: "Existing deadlines are unchanged.", variant: "success" });
    } catch (e) {
      setError(e.message);
      notify({ title: "SLA save failed", description: e.message, variant: "error" });
    } finally {
      setSaving(false);
    }
  }
  const update = (channel, value) => {
    setDraft((previous) => ({ ...previous, [channel]: value }));
    setSaved(false);
  };
  return { data, draft, error, saving, saved, units, setUnits, load, setError, save, update };
}

export function SlaSettingsFields({ controller, queueId = null, compact = false, showSave = true }) {
  const { data, draft, error, saving, saved, units, setUnits, load, setError, save, update } = controller;
  const Body = compact ? "div" : CardContent;
  return (
      <Body className="space-y-4">
        {error && (
          <div
            role="alert"
            className="rounded-lg border border-destructive/40 p-3 text-sm"
          >
            {error}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => load().catch((e) => setError(e.message))}
            >
              Reload
            </Button>
          </div>
        )}
        {!data && !error ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          data?.channels.map((channel) => {
            const entry = draft[channel],
              mode = queueId
                ? entry?.mode
                : entry
                  ? "configured"
                  : "unconfigured",
              effective =
                mode === "inherit"
                  ? data.inherited?.[channel] || data.effective[channel]
                  : data.effective[channel];
            const policy = queueId ? entry?.policy : entry,
              canEdit = queueId ? mode === "override" : mode === "configured";
            const changePolicy = (patch) => {
              const next = { ...policy, ...patch };
              update(
                channel,
                queueId ? { mode: "override", policy: next } : next,
              );
            };
            const initial = () => ({
              enabled: true,
              thresholdSeconds: effective.thresholdSeconds || 60,
              targetPercentage: effective.targetPercentage || 80,
              warningPercentage: effective.warningPercentage || 80,
              clock: "24x7",
            });
            return (
              <div key={channel} className="space-y-3 rounded-xl border p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <InteractionChannel channel={channel} label />
                  {queueId ? (
                    <select
                      aria-label={`${channel} SLA mode`}
                      value={mode}
                      onChange={(e) =>
                        update(channel, {
                          mode: e.target.value,
                          ...(e.target.value === "override"
                            ? {
                                policy: {
                                  ...initial(),
                                  ...(policy?.thresholdSeconds ? policy : {}),
                                },
                              }
                            : {}),
                        })
                      }
                      className="rounded-lg border bg-background p-2 text-xs"
                    >
                      <option value="inherit">Inherit global</option>
                      <option value="override">Queue override</option>
                      <option value="disabled">Disabled</option>
                    </select>
                  ) : !entry ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => update(channel, initial())}
                    >
                      Configure target
                    </Button>
                  ) : (
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={entry.enabled}
                        onChange={(e) =>
                          changePolicy({ enabled: e.target.checked })
                        }
                      />
                      Enabled
                    </label>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {channelDefinition(channel).serviceEvent === "human_answer"
                    ? "Human answer from queue entry"
                    : channelDefinition(channel).serviceEvent ===
                        "human_send_accepted"
                      ? "First provider-accepted human reply"
                      : "First persisted human reply"}
                </p>
                {queueId && canEdit && (
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={policy?.enabled !== false}
                      onChange={(e) =>
                        changePolicy({ enabled: e.target.checked })
                      }
                    />
                    Enabled
                  </label>
                )}
                {canEdit ? (
                  <div className={compact ? "grid gap-3" : "grid gap-3 sm:grid-cols-3"}>
                    <div className="space-y-1 text-xs">
                      <label
                        htmlFor={`sla-threshold-${queueId || "global"}-${channel}`}
                      >
                        Response time
                      </label>
                      <div className="flex gap-1">
                        <Input
                          id={`sla-threshold-${queueId || "global"}-${channel}`}
                          type="number"
                          min={1 / (units[channel] || 1)}
                          max={2678400 / (units[channel] || 1)}
                          step="any"
                          value={
                            (policy?.thresholdSeconds || 0) /
                            (units[channel] || 1)
                          }
                          onChange={(e) =>
                            changePolicy({
                              thresholdSeconds: Math.round(
                                Number(e.target.value) * (units[channel] || 1),
                              ),
                            })
                          }
                        />
                        <select
                          aria-label={`${channel} response time unit`}
                          className="rounded-lg border bg-background p-2"
                          value={units[channel] || 1}
                          onChange={(e) =>
                            setUnits((previous) => ({
                              ...previous,
                              [channel]: Number(e.target.value),
                            }))
                          }
                        >
                          <option value={1}>sec</option>
                          <option value={60}>min</option>
                          <option value={3600}>hours</option>
                        </select>
                      </div>
                    </div>
                    {[
                      ["targetPercentage", "Target (%)", 1, 100],
                      ["warningPercentage", "Warn at (%)", 1, 99],
                    ].map(([key, label, min, max]) => (
                      <label key={key} className="space-y-1 text-xs">
                        <span>{label}</span>
                        <Input
                          type="number"
                          min={min}
                          max={max}
                          value={policy?.[key] ?? ""}
                          onChange={(e) =>
                            changePolicy({ [key]: Number(e.target.value) })
                          }
                        />
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs font-medium">
                    {mode === "disabled"
                      ? "Measurement disabled"
                      : effective.status === "configured"
                        ? `${effective.targetPercentage}% within ${effective.thresholdSeconds}s · ${effective.source}`
                        : "No target configured"}
                  </p>
                )}
              </div>
            );
          })
        )}
        {data && showSave && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {saved
                ? "Saved. Existing deadlines are unchanged."
                : "SLA settings are saved separately."}
            </p>
            <Button type="button" size="sm" disabled={saving} onClick={save}>
              <Save className="mr-2 size-3" />
              {saving ? "Saving…" : "Save SLA"}
            </Button>
          </div>
        )}
      </Body>
  );
}

export default function SlaSettings({ queueId = null }) {
  const controller = useSlaSettings(queueId);
  return <Card>
    <CardHeader>
      <CardTitle className="flex items-center gap-2 text-base"><Clock3 className="size-4" />{queueId ? "Queue SLA policies" : "Service level agreements"}</CardTitle>
      <p className="text-xs text-muted-foreground">{queueId ? "Inherit a channel default, override it for this queue, or disable measurement." : "Set a separate response target for each released channel."} Changes apply to new measurements. Clock: 24×7.</p>
    </CardHeader>
    <SlaSettingsFields controller={controller} queueId={queueId} />
  </Card>;
}
