"use client";

import { useEffect, useState } from "react";
import { IconArrowDown, IconArrowUp, IconTrash } from "@tabler/icons-react";
import { useUiText } from "@/components/i18n/use-ui-text";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { defaultScheduleConfig, normalizeNodeConfig } from "@/lib/schedules/evaluator.mjs";
import { ScheduleSelect, ScheduleTester, TimeZoneField, WeeklyHoursEditor, schedulesApi } from "@/components/schedules/ScheduleFields";

export default function ScheduleNodeEditor({ config, onChange }) {
  const t = useUiText(), { can } = useAuth();
  const c = { ...defaultScheduleConfig(), ...config };
  const [items, setItems] = useState([]), [loading, setLoading] = useState(true), [error, setError] = useState(""), [reload, setReload] = useState(0);
  useEffect(() => { const abort = new AbortController(); schedulesApi("", { signal: abort.signal }).then(data => { if (!abort.signal.aborted) setItems(data.items.filter(i => i.published)); }).catch(e => { if (!abort.signal.aborted) setError(e.message); }).finally(() => { if (!abort.signal.aborted) setLoading(false); }); return () => abort.abort(); }, [reload]);
  const update = patch => onChange({ ...c, ...patch });
  const selected = items.find(i => i.id === c.scheduleId), definition = c.source === "shared" ? selected?.published?.definition : c;
  let validation = ""; try { normalizeNodeConfig(c); } catch (e) { validation = e.message; }
  function move(index, amount) { const ids = [...c.calendarIds]; [ids[index], ids[index + amount]] = [ids[index + amount], ids[index]]; update({ calendarIds: ids }); }
  return <div className="@container space-y-4" data-help-id="admin.call-flows.schedules">
    {loading ? <div className="space-y-2"><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" /></div> : error ? <Alert variant="destructive"><AlertDescription>{t(error)} <Button size="sm" variant="outline" onClick={() => { setLoading(true); setError(""); setReload(n => n + 1); }}>{t("Retry")}</Button></AlertDescription></Alert> : null}
    <ScheduleSelect label="Working hours source" value={c.source} onChange={source => update({ source })} options={[{ value: "custom", label: "Custom hours for this node" }, { value: "shared", label: "Shared schedule" }]} />
    {c.source === "shared" && <ScheduleSelect label="Shared schedule" value={c.scheduleId} disabled={loading || Boolean(error)} onChange={scheduleId => update({ scheduleId })} options={items.filter(i => i.kind === "schedule").map(i => ({ value: i.id, label: `${i.published.name} · v${i.published_revision}` }))} />}
    {!loading && !error && c.source === "shared" && !selected && <Alert variant="warning"><AlertDescription>{t("Select a published schedule. Create and publish one in Admin → System → Schedules & calendars.")}</AlertDescription></Alert>}
    {definition && <><TimeZoneField value={definition.timeZone} disabled={c.source === "shared"} onChange={timeZone => update({ timeZone })} /><WeeklyHoursEditor value={definition.weekly} disabled={c.source === "shared"} onChange={weekly => update({ weekly })} /></>}
    <section className="space-y-3 border-t pt-4"><label className="flex items-center gap-2 text-sm"><Checkbox checked={c.useExceptions} onCheckedChange={useExceptions => update({ useExceptions: Boolean(useExceptions) })} />{t("Use exception calendars")}</label>
      {c.useExceptions && <div className="space-y-2"><p className="text-xs text-muted-foreground">{t("The first calendar with an exception for the date wins. Its hours replace that day's weekly hours.")}</p>{c.calendarIds.map((id, index) => {
        const calendar = items.find(i => i.id === id)?.published;
        return <div key={id} className="flex items-center gap-1 rounded-md border p-2"><div className="min-w-0 flex-1 break-words text-xs"><div>{index + 1}. {calendar?.name || (loading ? t("Loading...") : t("Unavailable calendar"))}</div>{calendar && <div className="mt-1 text-muted-foreground">{t("Published coverage")}: {calendar.definition.coverageStart} – {calendar.definition.coverageEnd}</div>}</div><Button variant="ghost" size="icon" type="button" disabled={!index} aria-label={t("Move calendar up")} onClick={() => move(index, -1)}><IconArrowUp className="h-3.5 w-3.5" /></Button><Button variant="ghost" size="icon" type="button" disabled={index === c.calendarIds.length - 1} aria-label={t("Move calendar down")} onClick={() => move(index, 1)}><IconArrowDown className="h-3.5 w-3.5" /></Button><Button variant="ghost" size="icon" type="button" aria-label={t("Remove calendar")} onClick={() => update({ calendarIds: c.calendarIds.filter(x => x !== id) })}><IconTrash className="h-3.5 w-3.5" /></Button></div>; })}<ScheduleSelect label="Add exception calendar" value="" disabled={loading || Boolean(error) || c.calendarIds.length >= 20} onChange={id => update({ calendarIds: [...c.calendarIds, id] })} options={items.filter(i => i.kind === "calendar" && !c.calendarIds.includes(i.id)).map(i => ({ value: i.id, label: i.published.name }))} /></div>}
      <Button type="button" size="sm" variant="link" className="h-auto p-0" onClick={() => window.open("/admin/system/schedules", "_blank", "noopener,noreferrer")}>{t("Manage schedules and calendars")}</Button>
    </section>
    <details className="space-y-3 border-t pt-3"><summary className="cursor-pointer text-xs text-muted-foreground">{t("Advanced routing")}</summary><ScheduleSelect label="Time to evaluate" value={c.timeSource} onChange={timeSource => update({ timeSource })} options={[{ value: "node_entry", label: "When this node is reached" }, { value: "call_received", label: "When the call was received" }]} /><ScheduleSelect label="If evaluation fails" value={c.errorBranch} onChange={errorBranch => update({ errorBranch })} options={[{ value: "false", label: "Take FALSE and record error" }, { value: "true", label: "Take TRUE and record error" }]} /><Label className="space-y-1.5 text-xs"><span>{t("Result variable")}</span><Input value={c.resultVariable} onChange={e => update({ resultVariable: e.target.value })} /></Label></details>
    {validation && <Alert variant="warning"><AlertDescription>{t(validation)}</AlertDescription></Alert>}
    {can(["schedules:test", "call_flows:test"]) && <ScheduleTester config={c} disabled={Boolean(validation) || loading || Boolean(error)} />}
  </div>;
}
