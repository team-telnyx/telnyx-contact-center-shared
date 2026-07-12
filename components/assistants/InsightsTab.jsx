"use client";

import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import Switch from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";

export default function InsightsTab({ values, setValues, isCreate = false }) {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(false);
  const [insightsById, setInsightsById] = useState({});

  const selectedId = useMemo(
    () => values?.insight_settings?.insight_group_id || "",
    [values?.insight_settings]
  );

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const res = await fetch("/api/ai/conversations/insight-groups", {
          cache: "no-store",
        });
        const data = await res.json();
        if (res.ok && data?.ok) {
          const groupsList = Array.isArray(data.items) ? data.items : [];
          setGroups(groupsList);

          // Auto-select "Default" group if creating new assistant and no group is selected
          if (
            isCreate &&
            groupsList.length > 0 &&
            (!selectedId || selectedId === "default")
          ) {
            // Look for a group named "Default" (case-insensitive)
            const defaultGroup = groupsList.find(
              (g) => g.name?.toLowerCase() === "default"
            );
            if (defaultGroup?.id) {
              setValues?.((v) => ({
                ...v,
                insight_settings: {
                  ...(v.insight_settings || {}),
                  insight_group_id: defaultGroup.id,
                },
              }));
            }
          }
        }
      } catch (_) {}
      setLoading(false);
    }
    load();
  }, [isCreate, selectedId, setValues]);

  // Load all insights once to show instructions in hover cards
  useEffect(() => {
    let aborted = false;
    async function loadInsights() {
      try {
        const res = await fetch("/api/ai/conversations/insights", {
          cache: "no-store",
        });
        const data = await res.json().catch(() => ({}));
        if (!aborted && res.ok && data?.ok && Array.isArray(data.items)) {
          const map = {};
          for (const ins of data.items) {
            if (ins?.id) map[ins.id] = ins;
          }
          setInsightsById(map);
        }
      } catch (_) {}
    }
    loadInsights();
    return () => {
      aborted = true;
    };
  }, []);

  function toggle(groupId, on) {
    setValues?.((v) => {
      const current = v?.insight_settings?.insight_group_id || "";
      const nextId = on ? groupId : current === groupId ? "" : current;
      const nextSettings = nextId
        ? { ...(v.insight_settings || {}), insight_group_id: nextId }
        : { ...(v.insight_settings || {}) };
      if (!nextId) delete nextSettings.insight_group_id;
      return { ...v, insight_settings: nextSettings };
    });
  }

  return (
    <div className="space-y-3">
      <div className="text-sm text-muted-foreground">
        Select an Insight Group to run automatically for this assistant’s
        conversations.
      </div>
      <Card className="p-3">
        {loading ? (
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex items-center justify-between">
                <Skeleton className="h-4 w-56" />
                <Skeleton className="h-6 w-11 rounded-full" />
              </div>
            ))}
          </div>
        ) : groups.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No insight groups found. Create them in AI → Insights.
          </div>
        ) : (
          <div className="space-y-1">
            {groups.map((g) => {
              const checked = String(selectedId || "") === String(g.id);
              const insightItems = Array.isArray(g.insights) ? g.insights : [];
              return (
                <div
                  key={g.id}
                  className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center py-1 px-1 rounded hover:bg-muted"
                >
                  <div
                    className="md:col-span-4 text-sm truncate"
                    title={g.name || g.id}
                  >
                    {g.name || g.id}
                  </div>
                  <div className="md:col-span-7 flex flex-wrap gap-1">
                    {insightItems.length === 0 ? (
                      <span className="text-xs text-muted-foreground">
                        No insights
                      </span>
                    ) : (
                      insightItems.map((ins, i) => {
                        const id = ins?.id;
                        const info = (id && insightsById[id]) || undefined;
                        const name = ins?.name || info?.name || id || "";
                        const isStructured = !!info?.json_schema;
                        const instructions = info?.instructions || "";
                        return (
                          <HoverCard key={`${g.id}-${id || i}`}>
                            <HoverCardTrigger asChild>
                              <Badge variant="secondary">{name}</Badge>
                            </HoverCardTrigger>
                            <HoverCardContent className="w-80 text-xs whitespace-pre-wrap">
                              {info
                                ? isStructured
                                  ? "Structured insight (JSON Schema)"
                                  : instructions || "No instructions defined"
                                : "Loading…"}
                            </HoverCardContent>
                          </HoverCard>
                        );
                      })
                    )}
                  </div>
                  <div className="md:col-span-1 flex justify-end">
                    <Switch
                      checked={checked}
                      onCheckedChange={(v) => toggle(g.id, Boolean(v))}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
