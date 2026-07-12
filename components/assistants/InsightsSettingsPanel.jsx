"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

export default function InsightsSettingsPanel({ values, setValues }) {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const selectedId = values.insight_settings?.insight_group_id || "";
  useEffect(() => {
    fetch("/api/ai/conversations/insight-groups", { cache: "no-store" }).then((response) => response.json()).then((data) => setGroups(Array.isArray(data.items) ? data.items : [])).catch(() => setGroups([])).finally(() => setLoading(false));
  }, []);
  function select(id, enabled) { setValues((current) => { const next = { ...(current.insight_settings || {}) }; if (enabled) next.insight_group_id = id; else delete next.insight_group_id; return { ...current, insight_settings: next }; }); }
  return <Card><CardHeader><CardTitle>Conversation insights</CardTitle><CardDescription>Select one insight group to run automatically after this assistant’s conversations.</CardDescription></CardHeader><CardContent className="space-y-2">
    {loading ? Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-14 w-full" />) : groups.map((group) => <div key={group.id} className="grid items-center gap-3 rounded-lg border p-3 md:grid-cols-[minmax(180px,0.6fr)_1fr_auto]"><div><div className="font-medium">{group.name || group.id}</div><div className="text-xs text-muted-foreground">{group.description || group.id}</div></div><div className="flex flex-wrap gap-1">{(group.insights || []).map((insight, index) => <Badge key={insight.id || index} variant="secondary">{insight.name || insight.id}</Badge>)}{!(group.insights || []).length ? <span className="text-xs text-muted-foreground">No insights</span> : null}</div><Switch checked={String(selectedId) === String(group.id)} onCheckedChange={(checked) => select(group.id, checked)} /></div>)}
    {!loading && !groups.length ? <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">No insight groups found.</div> : null}
  </CardContent></Card>;
}
