"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { notify } from "@/components/ToastNotify";
import {
  IconCheck,
  IconChevronDown,
  IconDeviceFloppy,
  IconLoader2,
  IconPhoneCall,
  IconSettings,
  IconShieldCheck,
} from "@tabler/icons-react";

const API = "/api/admin/call-generator/settings";

const DEFAULT_SETTINGS = {
  enabled: false,
  max_concurrent_calls: 10,
  max_cps: 2,
  from_numbers: [],
  dial_timeout_secs: 30,
  max_call_duration_secs: 120,
  pstn_whitelist: [],
};

function SettingCard({ icon: Icon, title, subtitle, children }) {
  return (
    <div className="rounded-2xl border bg-background/85 p-4 shadow-sm">
      <div className="mb-4 flex items-start gap-3">
        <span className="rounded-xl bg-gradient-to-br from-sky-500/15 to-violet-500/15 p-2 text-sky-600">
          <Icon className="h-4 w-4" />
        </span>
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

function MultiSelect({ label, values = [], options = [], onChange = () => {}, emptyLabel = "No options available" }) {
  const [open, setOpen] = useState(false);
  const normalized = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  const selected = normalized.filter((o) => values.includes(o.value));
  const toggle = (value) => onChange(values.includes(value) ? values.filter((v) => v !== value) : [...values, value]);
  return (
    <div className="space-y-2">
      {label ? <Label>{label}</Label> : null}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" className="w-full justify-between">
            <span className="truncate">{selected.length ? `${selected.length} selected` : "Select values"}</span>
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
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition ${checked ? "border-emerald-500 bg-emerald-500 text-white shadow-sm shadow-emerald-500/20" : "border-muted-foreground/35 bg-background text-transparent dark:border-muted-foreground/45 dark:bg-background/80"}`}
                        aria-hidden="true"
                      >
                        {checked ? <IconCheck className="h-3.5 w-3.5 stroke-[3] text-white dark:text-white" /> : null}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-medium text-foreground">{o.label}</span>
                    </button>
                  );
                })
              ) : (
                <div className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">{emptyLabel}</div>
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
        <p className="text-xs text-muted-foreground">{emptyLabel}</p>
      )}
    </div>
  );
}

export default function CallGeneratorSettingsView({ refreshNonce = 0 }) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [inventoryNumbers, setInventoryNumbers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(API);
        if (!res.ok) throw new Error("Failed to load settings");
        const data = await res.json();
        if (!cancelled) {
          setSettings({ ...DEFAULT_SETTINGS, ...(data.settings || {}) });
          setInventoryNumbers(data.inventoryNumbers || []);
        }
      } catch (err) {
        if (!cancelled) {
          notify({ title: "Failed to load settings", description: err.message, variant: "error" });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [refreshNonce]);

  const update = (patch) => setSettings((s) => ({ ...s, ...patch }));

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch(API, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Save failed");
      }
      const data = await res.json();
      setSettings({ ...DEFAULT_SETTINGS, ...(data.settings || {}) });
      notify({ title: "Settings saved", description: "Call generator settings have been persisted.", variant: "success" });
    } catch (err) {
      notify({ title: "Failed to save settings", description: err.message, variant: "error" });
    } finally {
      setSaving(false);
    }
  }, [settings]);

  const fromNumberOptions = inventoryNumbers.map((item) => ({
    value: item.phone_number,
    label: item.connection_name
      ? `${item.phone_number} · ${String(item.connection_name).slice(0, 24)}${String(item.connection_name).length > 24 ? "…" : ""}`
      : item.phone_number,
  }));

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? <IconLoader2 className="mr-2 h-4 w-4 animate-spin" /> : <IconDeviceFloppy className="mr-2 h-4 w-4" />}
          Save settings
        </Button>
      </div>

      <SettingCard icon={IconSettings} title="Generator" subtitle="Master switch and pacing caps for generated test traffic">
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 rounded-lg border bg-background/70 p-3">
            <div>
              <div className="text-sm font-medium">Enable Call Generator</div>
              <div className="text-xs text-muted-foreground">Off by default. Runtime flag CALL_GENERATOR=true must also be set on the server.</div>
            </div>
            <Switch checked={settings.enabled === true} onCheckedChange={(checked) => update({ enabled: checked === true })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Max concurrent calls</Label>
              <Input className="mt-1" type="number" min={1} max={100} value={settings.max_concurrent_calls} onChange={(e) => update({ max_concurrent_calls: Number(e.target.value) || 1 })} />
            </div>
            <div>
              <Label>Max CPS</Label>
              <Input className="mt-1" type="number" min={1} max={20} value={settings.max_cps} onChange={(e) => update({ max_cps: Number(e.target.value) || 1 })} />
            </div>
            <div>
              <Label>Dial timeout (sec)</Label>
              <Input className="mt-1" type="number" min={10} max={120} value={settings.dial_timeout_secs} onChange={(e) => update({ dial_timeout_secs: Number(e.target.value) || 30 })} />
            </div>
            <div>
              <Label>Max call duration (sec)</Label>
              <Input className="mt-1" type="number" min={10} max={3600} value={settings.max_call_duration_secs} onChange={(e) => update({ max_call_duration_secs: Number(e.target.value) || 120 })} />
            </div>
          </div>
        </div>
      </SettingCard>

      <SettingCard icon={IconPhoneCall} title="From Numbers" subtitle="Numbers from the Telnyx account inventory available as caller IDs per scenario">
        <MultiSelect
          values={Array.isArray(settings.from_numbers) ? settings.from_numbers : []}
          options={fromNumberOptions}
          emptyLabel="No active numbers found in the Telnyx inventory."
          onChange={(values) => update({ from_numbers: values })}
        />
      </SettingCard>

      <SettingCard icon={IconShieldCheck} title="PSTN Safety" subtitle="Generated PSTN calls are allowed only to whitelisted numbers">
        <Label>PSTN whitelist (one E.164 number per line)</Label>
        <Textarea
          className="mt-2 font-mono text-xs"
          rows={4}
          placeholder={"+48123456789\n+12025550100"}
          value={(settings.pstn_whitelist || []).join("\n")}
          onChange={(e) => update({ pstn_whitelist: e.target.value.split("\n").map((n) => n.trim()).filter(Boolean) })}
        />
        <p className="mt-2 text-xs text-muted-foreground">SIP destinations (call flows) are not restricted by this list.</p>
      </SettingCard>
    </div>
  );
}
