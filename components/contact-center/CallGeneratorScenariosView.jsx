"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { notify } from "@/components/ToastNotify";
import {
  IconCheck,
  IconChevronDown,
  IconEdit,
  IconPlayerPlay,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";

const API = "/api/admin/call-generator/scenarios";
const SETTINGS_API = "/api/admin/call-generator/settings";

const TARGET_TYPES = [
  { value: "call_flow", label: "Call Flow (SIP)" },
  { value: "sip", label: "SIP URI" },
  { value: "pstn", label: "PSTN number" },
];

function FromNumbersMultiSelect({ values = [], options = [], onChange = () => {} }) {
  const [open, setOpen] = useState(false);
  const normalized = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  const selected = normalized.filter((o) => values.includes(o.value));
  const toggle = (value) => onChange(values.includes(value) ? values.filter((v) => v !== value) : [...values, value]);
  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" className="w-full justify-between">
            <span className="truncate">{selected.length ? `${selected.length} selected` : "Select from numbers"}</span>
            <IconChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[--radix-popover-trigger-width] p-2">
          <div className="max-h-64 overflow-y-auto pr-1">
            <div className="space-y-1">
              {normalized.length ? (
                normalized.map((o) => {
                  const checked = values.includes(o.value);
                  return (
                    <button
                      key={o.value}
                      type="button"
                      onClick={() => toggle(o.value)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition hover:bg-muted"
                    >
                      <span
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition ${checked ? "border-emerald-500 bg-emerald-500 text-white shadow-sm shadow-emerald-500/20" : "border-muted-foreground/35 bg-background text-transparent"}`}
                        aria-hidden="true"
                      >
                        {checked ? <IconCheck className="h-3.5 w-3.5 stroke-[3] text-white" /> : null}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-medium text-foreground">{o.label}</span>
                    </button>
                  );
                })
              ) : (
                <div className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                  No numbers enabled. Pick From Numbers in Settings first.
                </div>
              )}
            </div>
          </div>
        </PopoverContent>
      </Popover>
      {selected.length ? (
        <div className="flex flex-wrap gap-1">
          {selected.map((o) => (
            <Badge key={o.value} variant="outline" className="font-normal">{o.label}</Badge>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No from numbers selected — runs will use the global Settings caller IDs.</p>
      )}
    </div>
  );
}

const emptyDraft = () => ({
  name: "",
  description: "",
  target_type: "call_flow",
  target: "",
  total_calls: 5,
  from_numbers: [],
  assert_queue: "",
  assert_answer_within: "",
  assert_max_abandon: "",
  assert_min_answer: "",
});

function assertionsFromDraft(draft) {
  const assertions = [];
  if (draft.assert_queue.trim()) assertions.push({ type: "routed_to_queue", queue: draft.assert_queue.trim() });
  if (Number(draft.assert_answer_within) > 0) assertions.push({ type: "answer_within_secs", seconds: Number(draft.assert_answer_within) });
  if (draft.assert_max_abandon !== "" && Number(draft.assert_max_abandon) >= 0) assertions.push({ type: "max_abandon_rate", percent: Number(draft.assert_max_abandon) });
  if (draft.assert_min_answer !== "" && Number(draft.assert_min_answer) >= 0) assertions.push({ type: "min_answer_rate", percent: Number(draft.assert_min_answer) });
  return assertions;
}

function draftAssertionFields(config) {
  const assertions = Array.isArray(config?.assertions) ? config.assertions : [];
  const find = (type) => assertions.find((a) => a?.type === type);
  return {
    assert_queue: find("routed_to_queue")?.queue || "",
    assert_answer_within: find("answer_within_secs")?.seconds ?? "",
    assert_max_abandon: find("max_abandon_rate")?.percent ?? "",
    assert_min_answer: find("min_answer_rate")?.percent ?? "",
  };
}

export default function CallGeneratorScenariosView({ refreshNonce = 0 }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState(emptyDraft());
  const [allowedFromNumbers, setAllowedFromNumbers] = useState([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [scenarioRes, settingsRes] = await Promise.all([
          fetch(API),
          fetch(SETTINGS_API).catch(() => null),
        ]);
        if (!scenarioRes.ok) throw new Error("Failed to load scenarios");
        const data = await scenarioRes.json();
        let fromNumbers = [];
        if (settingsRes?.ok) {
          const settingsData = await settingsRes.json();
          fromNumbers = Array.isArray(settingsData?.settings?.from_numbers) ? settingsData.settings.from_numbers : [];
        }
        if (!cancelled) {
          setItems(data.scenarios || []);
          setAllowedFromNumbers(fromNumbers);
        }
      } catch {
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [refreshNonce]);

  const update = (patch) => setDraft((d) => ({ ...d, ...patch }));

  async function save() {
    if (!draft.name.trim()) {
      notify({ title: "Name is required", description: "Give the scenario a name before saving.", variant: "warning" });
      return;
    }
    if (!draft.target.trim()) {
      notify({ title: "Target is required", description: "Provide a call flow ID, SIP URI, or PSTN number.", variant: "warning" });
      return;
    }
    const payload = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      config: {
        target_type: draft.target_type,
        target: draft.target.trim(),
        total_calls: Math.max(1, Math.min(1000, Number(draft.total_calls) || 1)),
        from_numbers: Array.isArray(draft.from_numbers) ? draft.from_numbers : [],
        assertions: assertionsFromDraft(draft),
      },
    };
    try {
      const url = editing ? `${API}/${editing.id}` : API;
      const method = editing ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Save failed");
      }
      const data = await res.json();
      notify({ title: editing ? "Scenario updated" : "Scenario created", description: payload.name, variant: "success" });
      setFormOpen(false);
      setEditing(null);
      setDraft(emptyDraft());
      setItems((prev) => (editing ? prev.map((i) => (i.id === editing.id ? data.scenario : i)) : [data.scenario, ...prev]));
    } catch (err) {
      notify({ title: "Save failed", description: err.message, variant: "error" });
    }
  }

  async function remove(id) {
    if (!window.confirm("Delete this scenario?")) return;
    try {
      const res = await fetch(`${API}/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      notify({ title: "Scenario deleted", variant: "success" });
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (err) {
      notify({ title: "Delete failed", description: err.message, variant: "error" });
    }
  }

  async function startRun(item) {
    try {
      const res = await fetch("/api/admin/call-generator/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario_id: item.id }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to start run");
      }
      notify({ title: "Run started", description: item.name, variant: "success" });
    } catch (err) {
      notify({ title: "Run failed", description: err.message, variant: "error" });
    }
  }

  function openNew() {
    setEditing(null);
    setDraft(emptyDraft());
    setFormOpen(true);
  }

  function openEdit(item) {
    setEditing(item);
    setDraft({
      name: item.name || "",
      description: item.description || "",
      target_type: item.config?.target_type || "call_flow",
      target: item.config?.target || "",
      total_calls: item.config?.total_calls || 5,
      from_numbers: Array.isArray(item.config?.from_numbers) ? item.config.from_numbers : [],
      ...draftAssertionFields(item.config),
    });
    setFormOpen(true);
  }

  const fromNumberOptions = allowedFromNumbers.map((n) => ({ value: n, label: n }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold">Scenarios</h4>
        <Button size="sm" onClick={openNew}>
          <IconPlus className="mr-2 h-4 w-4" />
          New scenario
        </Button>
      </div>

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No scenarios yet. Use New scenario to create one.</p>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <Card key={item.id} className="rounded-xl">
              <CardContent className="flex items-center justify-between p-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{item.name}</span>
                    <Badge variant="outline" className={
                      item.status === "active"
                        ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                        : "border-slate-400/40 bg-slate-500/10 text-slate-600 dark:text-slate-300"
                    }>
                      {item.status || "draft"}
                    </Badge>
                    {item.config?.target_type ? (
                      <Badge variant="outline" className="border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300">
                        {TARGET_TYPES.find((t) => t.value === item.config.target_type)?.label || item.config.target_type}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {item.config?.target ? `${item.config.target} · ${item.config?.total_calls || 0} calls · ${(item.config?.from_numbers || []).length} from numbers` : item.description || "No configuration"}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="icon" variant="ghost" onClick={() => openEdit(item)} title="Edit">
                    <IconEdit className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => startRun(item)} title="Start run">
                    <IconPlayerPlay className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => remove(item.id)} title="Delete">
                    <IconTrash className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {formOpen && (
        <div className="rounded-2xl border bg-card p-5 shadow-sm">
          <h4 className="text-sm font-semibold">{editing ? "Edit scenario" : "New scenario"}</h4>
          <div className="mt-4 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Name</Label>
                <Input className="mt-1" value={draft.name} onChange={(e) => update({ name: e.target.value })} placeholder="Scenario name" />
              </div>
              <div>
                <Label>Total calls</Label>
                <Input className="mt-1" type="number" min={1} max={1000} value={draft.total_calls} onChange={(e) => update({ total_calls: Number(e.target.value) || 1 })} />
              </div>
              <div>
                <Label>Target type</Label>
                <Select value={draft.target_type} onValueChange={(v) => update({ target_type: v })}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TARGET_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>{draft.target_type === "call_flow" ? "Call flow ID" : draft.target_type === "sip" ? "SIP URI" : "PSTN number (E.164)"}</Label>
                <Input className="mt-1" value={draft.target} onChange={(e) => update({ target: e.target.value })} placeholder={draft.target_type === "call_flow" ? "flow-id" : draft.target_type === "sip" ? "sip:test@example.sip.telnyx.com" : "+48123456789"} />
              </div>
            </div>
            <div>
              <Label>From numbers (caller IDs for this scenario)</Label>
              <div className="mt-1">
                <FromNumbersMultiSelect
                  values={draft.from_numbers}
                  options={fromNumberOptions}
                  onChange={(values) => update({ from_numbers: values })}
                />
              </div>
            </div>
            <div>
              <Label>Description</Label>
              <Textarea className="mt-1" value={draft.description} onChange={(e) => update({ description: e.target.value })} placeholder="Optional description" />
            </div>
            <div className="rounded-xl border bg-background/70 p-3">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">Assertions (optional — evaluated in the run report)</Label>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <div>
                  <Label className="text-xs">Routed to queue</Label>
                  <Input className="mt-1" value={draft.assert_queue} onChange={(e) => update({ assert_queue: e.target.value })} placeholder="queue name" />
                </div>
                <div>
                  <Label className="text-xs">Answer within (sec)</Label>
                  <Input className="mt-1" type="number" min={1} max={600} value={draft.assert_answer_within} onChange={(e) => update({ assert_answer_within: e.target.value })} placeholder="e.g. 20" />
                </div>
                <div>
                  <Label className="text-xs">Max abandon rate (%)</Label>
                  <Input className="mt-1" type="number" min={0} max={100} value={draft.assert_max_abandon} onChange={(e) => update({ assert_max_abandon: e.target.value })} placeholder="e.g. 5" />
                </div>
                <div>
                  <Label className="text-xs">Min answer rate (%)</Label>
                  <Input className="mt-1" type="number" min={0} max={100} value={draft.assert_min_answer} onChange={(e) => update({ assert_min_answer: e.target.value })} placeholder="e.g. 80" />
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={save}>{editing ? "Update" : "Create"}</Button>
              <Button size="sm" variant="outline" onClick={() => { setFormOpen(false); setEditing(null); }}>Cancel</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
