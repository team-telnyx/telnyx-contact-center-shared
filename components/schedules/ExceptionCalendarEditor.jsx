"use client";

import { useRef, useState } from "react";
import Papa from "papaparse";
import { IconPlus, IconTrash, IconUpload } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Calendar } from "@/components/ui/calendar";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useUiText } from "@/components/i18n/use-ui-text";
import { useAuth } from "@/components/auth-provider";
import { mergeCalendarImport } from "@/lib/schedules/calendar-import.mjs";
import { normalizeCalendar, validDate } from "@/lib/schedules/evaluator.mjs";
import { ScheduleDateField, ScheduleSelect, schedulesApi } from "./ScheduleFields";

export default function ExceptionCalendarEditor({ value, onChange, disabled }) {
  const t = useUiText(), { can } = useAuth(), file = useRef();
  const [selected, setSelected] = useState(null), [error, setError] = useState("");
  const [country, setCountry] = useState("PL"), [year, setYear] = useState(() => new Date().getFullYear()), [region, setRegion] = useState("");
  const [countries, setCountries] = useState(null), [regions, setRegions] = useState([]), [pending, setPending] = useState(false), [imported, setImported] = useState(null);
  const changeEntry = (id, patch) => onChange({ ...value, entries: value.entries.map(e => e.id === id ? { ...e, ...patch } : e) });
  function add() {
    const date = selected ? selected.toISOString().slice(0, 10) : value.coverageStart;
    onChange({ ...value, entries: [...value.entries, { id: crypto.randomUUID(), name: "", startDate: date, endDate: date, repeat: "once", availability: "closed", periods: [] }] });
  }
  async function loadCountries() {
    if (countries) return; setPending(true); setError("");
    try { const data = await schedulesApi("/holidays"); setCountries(data.countries); }
    catch (e) { setError(e.message); } finally { setPending(false); }
  }
  async function loadHolidays() {
    setPending(true); setError(""); setImported(null);
    try { const data = await schedulesApi(`/holidays?country=${encodeURIComponent(country)}&year=${year}&region=${encodeURIComponent(region)}`); setRegions(data.regions); setImported(data.definition); }
    catch (e) { setError(e.message); } finally { setPending(false); }
  }
  function mergeImport() {
    try { onChange(mergeCalendarImport(value, imported)); setImported(null); setError(""); }
    catch (e) { setError(e.message); }
  }
  async function readFile(event) {
    const f = event.target.files?.[0]; event.target.value = ""; if (!f) return;
    setError(""); setImported(null);
    try {
      if (f.size > 512000) throw new Error("Import file must be smaller than 500 KB.");
      const content = await f.text(); let definition;
      if (f.name.toLowerCase().endsWith(".json")) { const parsed = JSON.parse(content); definition = parsed.definition || parsed; }
      else {
        const parsed = Papa.parse(content, { header: true, skipEmptyLines: true });
        if (parsed.errors.length) throw new Error("Invalid CSV. Check the header and row lengths.");
        const entries = parsed.data.map(row => ({ id: crypto.randomUUID(), name: row.name, startDate: row.start_date, endDate: row.end_date || row.start_date, repeat: row.repeat || "once", availability: row.availability || "closed", periods: row.availability === "hours" ? [{ start: row.start, end: row.end }] : [] }));
        definition = { coverageStart: value.coverageStart, coverageEnd: value.coverageEnd, entries };
      }
      setImported(normalizeCalendar(definition));
    } catch (e) { setError(e.message); }
  }
  const matches = (entry, date) => entry.repeat === "once" ? date >= entry.startDate && date <= entry.endDate : entry.startDate.slice(5) <= entry.endDate.slice(5) ? date.slice(5) >= entry.startDate.slice(5) && date.slice(5) <= entry.endDate.slice(5) : date.slice(5) >= entry.startDate.slice(5) || date.slice(5) <= entry.endDate.slice(5);
  const selectedEntries = selected ? value.entries.filter(e => matches(e, selected.toISOString().slice(0, 10))).sort((a, b) => (a.repeat === "once" ? -1 : 1) - (b.repeat === "once" ? -1 : 1)) : [];
  return <div className="space-y-4">
    <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2"><ScheduleDateField label="Coverage from" value={value.coverageStart} disabled={disabled} onChange={coverageStart => onChange({ ...value, coverageStart })} /><ScheduleDateField label="Coverage through" value={value.coverageEnd} disabled={disabled} onChange={coverageEnd => onChange({ ...value, coverageEnd })} /></div>
    <p className="text-xs text-muted-foreground">{t("Coverage confirms that dates without exceptions use weekly hours. Outside coverage, routing uses the configured error branch.")}</p>
    {validDate(value.coverageStart) && validDate(value.coverageEnd) && value.coverageStart <= value.coverageEnd && <div className="rounded-md border p-2"><Calendar className="mx-auto bg-transparent" mode="single" timeZone="UTC" captionLayout="dropdown" selected={selected} onSelect={setSelected} startMonth={new Date(`${value.coverageStart}T12:00Z`)} endMonth={new Date(`${value.coverageEnd}T12:00Z`)} defaultMonth={new Date(`${value.coverageStart}T12:00Z`)} modifiers={{ exception: date => value.entries.some(e => matches(e, date.toISOString().slice(0, 10))) }} modifiersClassNames={{ exception: "font-bold underline decoration-primary decoration-2 underline-offset-4" }} /><p className="px-2 text-xs text-muted-foreground">{selectedEntries[0] ? `${selectedEntries[0].name} · ${t(selectedEntries[0].availability === "closed" ? "Closed" : selectedEntries[0].availability === "open" ? "Open 24 hours" : "Custom hours")}` : t("Underlined dates have exceptions. Select a date to inspect or add an exception.")}</p></div>}
    {can("schedules:import") && !disabled && <details className="space-y-3 rounded-md border p-3" onToggle={e => { if (e.currentTarget.open) void loadCountries(); }}><summary className="cursor-pointer text-sm font-medium">{t("Import holidays or calendar file")}</summary>
      {countries ? <ScheduleSelect label="Country" disabled={pending} value={country} onChange={v => { setCountry(v); setRegion(""); setRegions([]); setImported(null); }} options={countries.map(c => ({ value: c.code, label: c.name }))} /> : pending ? <Skeleton className="h-9 w-full" /> : <Button variant="outline" size="sm" onClick={loadCountries}>{t("Load countries")}</Button>}
      <Label className="space-y-1.5 text-xs"><span>{t("Year")}</span><Input type="number" disabled={pending} min="2000" max="2100" value={year} onChange={e => { setYear(Number(e.target.value)); setImported(null); setRegions([]); setRegion(""); }} /></Label>
      <p className="text-xs text-muted-foreground">{t("Holiday imports cover only the selected year. Import each year you need before publishing the calendar.")}</p>
      {regions.length > 0 && <ScheduleSelect label="Region" disabled={pending} value={region || "national"} onChange={v => { setRegion(v === "national" ? "" : v); setImported(null); }} options={[{ value: "national", label: "National holidays only" }, ...regions.map(r => ({ value: r, label: r }))]} />}
      <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" disabled={pending} onClick={loadHolidays}>{t("Preview holiday import")}</Button><Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => file.current.click()}><IconUpload className="mr-1 h-4 w-4" />{t("Import CSV or JSON")}</Button><input ref={file} type="file" className="hidden" accept=".csv,.json" onChange={readFile} /></div>
      <p className="text-xs text-muted-foreground">{t("CSV columns: name, start_date, end_date, availability, repeat, start, end. Dates use YYYY-MM-DD. Set calendar coverage before importing CSV.")}</p>
      {pending && <Skeleton className="h-20 w-full" />}
      {imported && <div className="space-y-2 rounded-md bg-muted p-3"><p className="text-sm">{imported.entries.length} {t("imported exceptions to review")}</p><p className="text-xs">{t("Imported coverage")}: {imported.coverageStart} – {imported.coverageEnd}</p>{!value.entries.length && <p className="text-xs text-muted-foreground">{t("This empty calendar will use the imported coverage dates.")}</p>}<div className="max-h-40 space-y-1 overflow-auto text-xs">{imported.entries.map(e => <div key={e.id}>{e.startDate} · {e.name}</div>)}</div><p className="text-xs text-muted-foreground">{t("Existing dates and manual corrections are preserved. Only missing dates will be added to the draft.")}</p><Button type="button" size="sm" onClick={mergeImport}>{t("Add missing dates to draft")}</Button></div>}
    </details>}
    {error && <Alert variant="destructive"><AlertDescription>{t(error)}</AlertDescription></Alert>}
    <div className="flex items-center justify-between gap-2"><Label>{t("Date exceptions")}</Label><Button type="button" size="sm" variant="outline" disabled={disabled || value.entries.length >= 1000} onClick={add}><IconPlus className="mr-1 h-4 w-4" />{t("Add exception")}</Button></div>
    {!value.entries.length && <p className="text-sm text-muted-foreground">{t("No date exceptions. Weekly hours apply throughout the covered dates.")}</p>}
    {value.entries.map((entry, index) => <div key={entry.id} className="space-y-3 rounded-md border p-3"><div className="flex items-end gap-2"><Label className="min-w-0 flex-1 space-y-1.5 text-xs"><span>{t("Exception name")} {index + 1}</span><Input value={entry.name} disabled={disabled} onChange={e => changeEntry(entry.id, { name: e.target.value })} /></Label><Button type="button" variant="ghost" size="icon" disabled={disabled} aria-label={t("Remove exception")} onClick={() => onChange({ ...value, entries: value.entries.filter(e => e.id !== entry.id) })}><IconTrash className="h-4 w-4" /></Button></div>
      <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2"><ScheduleDateField label="From date" value={entry.startDate} disabled={disabled} onChange={startDate => changeEntry(entry.id, { startDate, ...(entry.endDate === entry.startDate ? { endDate: startDate } : {}) })} /><ScheduleDateField label="Through date" value={entry.endDate} disabled={disabled} onChange={endDate => changeEntry(entry.id, { endDate })} /></div>
      <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2"><ScheduleSelect label="Availability" value={entry.availability} disabled={disabled} onChange={availability => changeEntry(entry.id, { availability, periods: availability === "hours" ? [{ start: "09:00", end: "13:00" }] : [] })} options={[{ value: "closed", label: "Closed all day" }, { value: "open", label: "Open 24 hours" }, { value: "hours", label: "Custom hours" }]} /><ScheduleSelect label="Repeat" value={entry.repeat} disabled={disabled} onChange={repeat => changeEntry(entry.id, { repeat })} options={[{ value: "once", label: "One time" }, { value: "annual", label: "Every year on these dates" }]} /></div>
      {entry.availability === "hours" && <div className="space-y-2">{entry.periods.map((p, i) => <div key={i} className="flex items-center gap-2"><Input aria-label={t("Exception start time")} value={p.start} disabled={disabled} onChange={e => changeEntry(entry.id, { periods: entry.periods.map((x, j) => j === i ? { ...x, start: e.target.value } : x) })} /><span>–</span><Input aria-label={t("Exception end time")} value={p.end} disabled={disabled} onChange={e => changeEntry(entry.id, { periods: entry.periods.map((x, j) => j === i ? { ...x, end: e.target.value } : x) })} /><Button type="button" variant="ghost" size="icon" disabled={disabled} aria-label={t("Remove period")} onClick={() => changeEntry(entry.id, { periods: entry.periods.filter((_, j) => j !== i) })}><IconTrash className="h-4 w-4" /></Button></div>)}<Button type="button" variant="outline" size="sm" disabled={disabled || entry.periods.length >= 12} onClick={() => changeEntry(entry.id, { periods: [...entry.periods, { start: "14:00", end: "17:00" }] })}>{t("Add period")}</Button><p className="text-xs text-muted-foreground">{t("Exception hours replace the entire day. For an overnight exception, add an entry for each date.")}</p></div>}
    </div>)}
  </div>;
}
