"use client";

import * as React from "react";
import { AdminPageContent, AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ToastNotify";

const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"];
const ROTATION_MODES = ["daily", "startup"];
const PRESETS = [
  { id: "normal-production", label: "Normal production", ttl: "" },
  { id: "debug-telnyx-stt", label: "Debug Telnyx STT", ttl: "30" },
  { id: "errors-only", label: "Errors only", ttl: "60" },
];

function bool(value) {
  return value === true;
}

function prettyJson(value) {
  return JSON.stringify(value || {}, null, 2);
}

function parseJsonField(label, text) {
  try {
    const parsed = JSON.parse(text || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed;
  } catch (error) {
    throw new Error(`${label}: ${error.message}`);
  }
}

export default function AdminLoggingPage() {
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [config, setConfig] = React.useState(null);
  const [topicLevelsText, setTopicLevelsText] = React.useState("{}");
  const [topicEnabledText, setTopicEnabledText] = React.useState("{}");

  async function load() {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/logging/config", { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.ok) throw new Error(data?.error || "Failed to load logging config");
      setConfig(data.config);
      setTopicLevelsText(prettyJson(data.config?.topicLevels));
      setTopicEnabledText(prettyJson(data.config?.topicEnabled));
    } catch (error) {
      notify({ title: "Load failed", description: String(error.message || error), variant: "error" });
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    load();
  }, []);

  function updateConfig(key, value) {
    setConfig((prev) => ({ ...(prev || {}), [key]: value }));
  }

  async function save() {
    if (!config) return;
    setSaving(true);
    try {
      const retentionDays = Number(config.retentionDays);
      if (!Number.isFinite(retentionDays) || retentionDays < 1 || retentionDays > 365) {
        throw new Error("Retention days must be between 1 and 365");
      }
      if (config.fileEnabled && !window.confirm("Enable JSONL file logging? Logs are redacted, but may still contain operational call metadata. Continue?")) {
        return;
      }
      const nextConfig = {
        enabled: config.enabled === true,
        globalLevel: config.globalLevel || "info",
        consoleEnabled: config.consoleEnabled !== false,
        consolePretty: config.consolePretty === true,
        fileEnabled: config.fileEnabled === true,
        rotationMode: config.rotationMode || "daily",
        retentionDays,
        topicLevels: parseJsonField("Topic levels", topicLevelsText),
        topicEnabled: parseJsonField("Topic enabled", topicEnabledText),
        redactionEnabled: true,
      };
      const response = await fetch("/api/admin/logging/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: nextConfig }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.ok) throw new Error(data?.error || "Failed to save logging config");
      setConfig(data.config);
      setTopicLevelsText(prettyJson(data.config?.topicLevels));
      setTopicEnabledText(prettyJson(data.config?.topicEnabled));
      notify({ title: "Saved", description: "Logging configuration updated", variant: "success" });
    } catch (error) {
      notify({ title: "Save failed", description: String(error.message || error), variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function applyPreset(preset, ttlMinutes) {
    setSaving(true);
    try {
      if (preset !== "normal-production" && !window.confirm("Apply a troubleshooting logging preset? This may increase log volume and file retention for the preset TTL.")) {
        return;
      }
      const body = { preset };
      if (ttlMinutes) body.ttlMinutes = Number(ttlMinutes);
      const response = await fetch("/api/admin/logging/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.ok) throw new Error(data?.error || "Failed to apply preset");
      setConfig(data.config);
      setTopicLevelsText(prettyJson(data.config?.topicLevels));
      setTopicEnabledText(prettyJson(data.config?.topicEnabled));
      notify({ title: "Preset applied", description: data.preset || preset, variant: "success" });
    } catch (error) {
      notify({ title: "Preset failed", description: String(error.message || error), variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  const headerActions = (
    <div className="flex items-center gap-2">
      <Button variant="outline" onClick={load} disabled={loading || saving}>Refresh</Button>
      <Button onClick={save} disabled={loading || saving || !config}>{saving ? "Saving…" : "Save changes"}</Button>
    </div>
  );

  return (
    <AdminPageShell>
      <AdminPageHeader
        title="Logging"
        actions={headerActions}
      />
      <AdminPageContent>
        {loading ? (
          <div className="space-y-4">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : !config ? (
          <Card><CardContent className="p-6 text-sm text-muted-foreground">Logging configuration unavailable.</CardContent></Card>
        ) : (
          <div className="space-y-6">
            <Card>
              <CardContent className="p-4 text-sm text-muted-foreground">
                Runtime log levels and sinks can be changed without restarting the application. Redaction is always enforced by the backend; the Admin UI cannot disable it. Use debug presets with a TTL and return to Normal production after troubleshooting.
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-6 space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={config.enabled ? "default" : "secondary"}>{config.enabled ? "Enabled" : "Disabled"}</Badge>
                  <Badge variant="outline">Level: {config.globalLevel}</Badge>
                  <Badge variant="outline">Rotation: {config.rotationMode}</Badge>
                  {config.expiresAt ? <Badge variant="destructive">Expires {new Date(config.expiresAt).toLocaleString()}</Badge> : null}
                  <Badge variant="outline">Redaction locked on</Badge>
                </div>
                <div className="grid gap-4 md:grid-cols-3">
                  <label className="space-y-1 text-sm">
                    <span className="font-medium">Global level</span>
                    <select className="w-full rounded-md border bg-background px-3 py-2" value={config.globalLevel || "info"} onChange={(e) => updateConfig("globalLevel", e.target.value)}>
                      {LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
                    </select>
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="font-medium">Rotation mode</span>
                    <select className="w-full rounded-md border bg-background px-3 py-2" value={config.rotationMode || "daily"} onChange={(e) => updateConfig("rotationMode", e.target.value)}>
                      {ROTATION_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
                    </select>
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="font-medium">Retention days</span>
                    <input className="w-full rounded-md border bg-background px-3 py-2" type="number" min="1" max="365" value={config.retentionDays || 14} onChange={(e) => updateConfig("retentionDays", Number(e.target.value))} />
                  </label>
                </div>
                <div className="grid gap-4 md:grid-cols-3">
                  {[
                    ["enabled", "Logging enabled"],
                    ["consoleEnabled", "Console output"],
                    ["consolePretty", "Pretty console"],
                    ["fileEnabled", "JSONL file sink"],
                  ].map(([key, label]) => (
                    <label key={key} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={bool(config[key])} onChange={(e) => updateConfig(key, e.target.checked)} />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
                <div className="space-y-1 text-sm">
                  <span className="font-medium">Log directory</span>
                  <div className="rounded-md border bg-muted px-3 py-2 font-mono text-xs">{config.logDir || "/app/logs"}</div>
                  <p className="text-xs text-muted-foreground">Configured by environment/backend policy; not editable from the Admin UI.</p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-6 space-y-4">
                <div>
                  <h2 className="text-lg font-semibold">Troubleshooting presets</h2>
                  <p className="text-sm text-muted-foreground">Use TTL for noisy debug presets so production logging returns to normal automatically.</p>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  {PRESETS.map((preset) => (
                    <Button key={preset.id} variant="outline" disabled={loading || saving} onClick={() => applyPreset(preset.id, preset.ttl)}>
                      {preset.label}{preset.ttl ? ` (${preset.ttl}m)` : ""}
                    </Button>
                  ))}
                </div>
              </CardContent>
            </Card>

            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <CardContent className="p-6 space-y-2">
                  <h2 className="text-lg font-semibold">Topic levels JSON</h2>
                  <textarea className="min-h-80 w-full rounded-md border bg-background p-3 font-mono text-xs" value={topicLevelsText} onChange={(e) => setTopicLevelsText(e.target.value)} />
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-6 space-y-2">
                  <h2 className="text-lg font-semibold">Topic enabled JSON</h2>
                  <textarea className="min-h-80 w-full rounded-md border bg-background p-3 font-mono text-xs" value={topicEnabledText} onChange={(e) => setTopicEnabledText(e.target.value)} />
                </CardContent>
              </Card>
            </div>
          </div>
        )}
      </AdminPageContent>
    </AdminPageShell>
  );
}
