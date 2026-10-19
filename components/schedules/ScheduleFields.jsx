"use client";

import { useId, useRef, useState } from "react";
import { IconCalendar, IconPlus, IconTrash } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useUiText } from "@/components/i18n/use-ui-text";
import { WEEKDAYS, defaultWeekly, validDate } from "@/lib/schedules/evaluator.mjs";

export async function schedulesApi(path = "", options = {}) {
  const response = await fetch(`/api/admin/schedules${path}`, { cache: "no-store", ...options, headers: { "Content-Type": "application/json", ...options.headers } });
  const body = await response.json();
  if (!response.ok || body.ok === false) throw Object.assign(new Error(body.error || "Schedule request failed."), body);
  return body;
}
export function ScheduleSelect({ label, value, onChange, options, disabled, placeholder }) {
  const id = useId(), t = useUiText();
  return <div className="space-y-1.5"><Label htmlFor={id} className="text-xs">{t(label)}</Label><Select value={value || ""} onValueChange={onChange} disabled={disabled}><SelectTrigger id={id} className="w-full"><SelectValue placeholder={t(placeholder || "Select...")} /></SelectTrigger><SelectContent>{options.map(o => <SelectItem key={o.value} value={o.value}>{t(o.label)}</SelectItem>)}</SelectContent></Select></div>;
}
export function TimeZoneField({ value, onChange, disabled }) {
  const zones = [...new Set([value, "UTC", ...(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["Europe/Warsaw", "Europe/London", "America/New_York"])].filter(Boolean))].sort();
  return <ScheduleSelect label="Time zone" value={value} onChange={onChange} disabled={disabled} options={zones.map(z => ({ value: z, label: z }))} />;
}
export function ScheduleDateField({ label, value, onChange, disabled }) {
  const id = useId(), t = useUiText();
  const [open, setOpen] = useState(false);
  const selected = validDate(value) ? new Date(`${value}T12:00:00Z`) : undefined;
  const displayValue = selected ? new Intl.DateTimeFormat(t.locale, { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }).format(selected) : t("Choose date");
  return <div className="space-y-1.5">
    <Label htmlFor={id} className="text-xs">{t(label)}</Label>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button id={id} type="button" variant="outline" disabled={disabled} data-date-value={value || ""} className="w-full min-w-0 justify-between font-normal">
          <span>{displayValue}</span><IconCalendar className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-0" aria-label={t("Choose date") + ": " + t(label)}>
        <Calendar mode="single" timeZone="UTC" captionLayout="dropdown" selected={selected} defaultMonth={selected}
          startMonth={new Date("1900-01-01T12:00:00Z")} endMonth={new Date("2199-12-01T12:00:00Z")}
          onSelect={date => { if (date) { onChange(date.toISOString().slice(0, 10)); setOpen(false); } }} />
      </PopoverContent>
    </Popover>
  </div>;
}
export function WeeklyHoursEditor({ value = defaultWeekly(), onChange, disabled = false }) {
  const t = useUiText();
  const change = (day, periods) => onChange(value.map(d => d.day === day ? { ...d, periods } : d));
  return <div className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><Label className="text-xs">{t("Weekly hours")}</Label><Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(value.map(d => d.day <= 5 ? { ...d, periods: structuredClone(value.find(x => x.day === 1).periods) } : d))}>{t("Copy Monday to weekdays")}</Button></div>
    {value.map(day => <div key={day.day} className="space-y-2 border-b pb-3 last:border-0"><div className="flex flex-wrap items-center justify-between gap-2"><label className="flex items-center gap-2 text-sm"><Checkbox checked={day.periods.length > 0} disabled={disabled} onCheckedChange={checked => change(day.day, checked ? [{ start: "09:00", end: "17:00" }] : [])} />{t(WEEKDAYS[day.day - 1])}</label>{!day.periods.length ? <span className="text-xs text-muted-foreground">{t("Closed")}</span> : <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => change(day.day, [{ start: "00:00", end: "24:00" }])}>{t("Open 24 hours")}</Button>}</div>
      {day.periods.map((period, index) => <div className="flex flex-wrap items-center gap-2" key={index}><Input className="min-w-0 flex-1 basis-20" aria-label={`${t(WEEKDAYS[day.day - 1])} ${t("Start time")} ${index + 1}`} value={period.start} placeholder="09:00" inputMode="numeric" disabled={disabled} onChange={e => change(day.day, day.periods.map((p, i) => i === index ? { ...p, start: e.target.value } : p))} /><span className="text-muted-foreground">–</span><Input className="min-w-0 flex-1 basis-20" aria-label={`${t(WEEKDAYS[day.day - 1])} ${t("End time")} ${index + 1}`} value={period.end} placeholder="17:00" inputMode="numeric" disabled={disabled} onChange={e => change(day.day, day.periods.map((p, i) => i === index ? { ...p, end: e.target.value } : p))} />{period.end < period.start && <Badge variant="secondary">+1 {t("day")}</Badge>}<Button type="button" variant="ghost" size="icon" disabled={disabled} aria-label={t("Remove period")} onClick={() => change(day.day, day.periods.filter((_, i) => i !== index))}><IconTrash className="h-4 w-4" /></Button></div>)}
      {day.periods.length > 0 && day.periods.length < 12 && !disabled && <Button type="button" size="sm" variant="outline" onClick={() => change(day.day, [...day.periods, { start: "18:00", end: "20:00" }])}><IconPlus className="mr-1 h-3.5 w-3.5" />{t("Add period")}</Button>}
    </div>)}<p className="text-xs text-muted-foreground">{t("Use HH:mm. 24:00 ends the day. An end before the start continues into the next day. End times are excluded.")}</p></div>;
}
export function ScheduleTester({ config, disabled = false }) {
  const t = useUiText(), id = useId();
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [time, setTime] = useState("10:00"), [fold, setFold] = useState("reject");
  const [response, setResponse] = useState(null), [pending, setPending] = useState(null); const requestId = useRef(0);
  const fingerprint = JSON.stringify({ config, date, time, disambiguation: fold });
  const current = response?.fingerprint === fingerprint ? response : null;
  async function test() {
    const seq = ++requestId.current; setPending(fingerprint); setResponse(null);
    try { const body = await schedulesApi("/test", { method: "POST", body: fingerprint }); if (seq === requestId.current) setResponse({ fingerprint, result: body.result }); }
    catch (error) { if (seq === requestId.current) setResponse({ fingerprint, error: error.message, code: error.code }); }
    finally { if (seq === requestId.current) setPending(null); }
  }
  return <section className="space-y-3 border-t pt-4" aria-label={t("Schedule tester")}><h3 className="text-sm font-medium">{t("Test date and time")}</h3><p className="text-xs text-muted-foreground">{t("Enter local time in the schedule's time zone. This test does not place a call.")}</p><div className="grid grid-cols-1 gap-3 @sm:grid-cols-2"><ScheduleDateField label="Test date" value={date} onChange={setDate} /><div className="space-y-1.5"><Label htmlFor={id} className="text-xs">{t("Test time")}</Label><Input id={id} type="time" value={time} onChange={e => setTime(e.target.value)} /></div></div>
    <ScheduleSelect label="Repeated time during clock change" value={fold} onChange={setFold} options={[{ value: "reject", label: "Ask if this time occurs twice" }, { value: "earlier", label: "Earlier occurrence" }, { value: "later", label: "Later occurrence" }]} />
    <Button type="button" variant="outline" size="sm" disabled={disabled || Boolean(pending) || !date || !time} onClick={test}>{t(pending ? "Testing..." : "Test schedule")}</Button>
    <div aria-live="polite">{pending === fingerprint ? <div className="space-y-2"><Skeleton className="h-6 w-1/2" /><Skeleton className="h-12 w-full" /></div> : current?.error ? <Alert variant="destructive"><AlertTitle>{t("Evaluation error")}</AlertTitle><AlertDescription>{t(current.error)}{current.code === "calendar_coverage_missing" && <><div className="mt-2">{t("Import or define exceptions for the tested year, review coverage, then save and publish the calendar in Admin → System → Schedules & calendars.")}</div><div className="mt-2">{t("A live call would take the error branch")}: {(config.errorBranch || "false").toUpperCase()}</div></>}</AlertDescription></Alert> : current?.result ? <Alert variant={current.result.matched ? "success" : "default"}><AlertTitle>{current.result.branch.toUpperCase()} · {t(current.result.matched ? "In schedule" : "Outside schedule")}</AlertTitle><AlertDescription><div>{current.result.localDate} {current.result.localTime} · {current.result.timeZone}</div><div>{current.result.exceptionName || t(current.result.overnight ? "Overnight weekly hours" : "Weekly hours")}{current.result.calendarName ? ` · ${current.result.calendarName}` : ""}</div><div className="text-xs">{current.result.evaluatedAt}</div>{current.result.versions.map(v => <div key={v.id} className="text-xs">{v.name} · {t("Revision")} {v.revision}</div>)}</AlertDescription></Alert> : null}</div>
  </section>;
}
