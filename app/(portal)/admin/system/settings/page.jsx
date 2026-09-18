"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconArrowsExchange,
  IconBellRinging,
  IconBrain,
  IconCheck,
  IconClockHour4,
  IconFileMusic,
  IconMessage,
  IconPhoneCall,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerStop,
  IconSettings,
  IconUserCog,
  IconVolumeOff,
} from "@tabler/icons-react";
import { SystemSectionPage } from "@/components/admin/SystemSectionNav";
import {
  AdminPageHeader,
  AdminPageShell,
} from "@/components/contact-center/WorkspacePageLayout";
import { CompactTtsVoiceSelector } from "@/components/tts/CompactTtsVoiceSelector";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SlaSettingsFields, useSlaSettings } from "@/components/contact-center/SlaSettings";
import { InteractionChannel } from "@/components/contact-center/InteractionChannel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { notify } from "@/components/ToastNotify";
import { cn } from "@/lib/utils";
import ChatCopilotSettings from "@/components/admin/ChatCopilotSettings";
import { DEFAULT_CHAT_COPILOT_SETTINGS } from "@/lib/contact-center/chat-copilot-settings.mjs";
import NotificationSoundSettings from "@/components/admin/NotificationSoundSettings";
import { DEFAULT_NOTIFICATION_SOUNDS, NOTIFICATION_CHANNELS, NOTIFICATION_SOUNDS } from "@/lib/contact-center/notification-sounds.mjs";

const CONSULT_EMPTY = {
  media_name: null,
  announcement_enabled: true,
  announcement_text: "Please stay on the line while we connect your call.",
  announcement_voice: "AWS.Polly.Joanna",
  announcement_language: "en-US",
  announcement_voice_api_key_ref: null,
  announcement_interval_seconds: 60,
};

const AGENT_EMPTY = {
  media_name: null,
  announcement_enabled: false,
  announcement_text: "Please stay on the line. Your call is on hold.",
  announcement_voice: "AWS.Polly.Joanna",
  announcement_language: "en-US",
  announcement_voice_api_key_ref: null,
  announcement_interval_seconds: 60,
};

const LIFECYCLE_EMPTY = {
  wrapup_timeout_seconds: 120,
  after_wrapup_status: "available",
  no_answer_status: "agent_not_answering",
  default_answer_timeout_seconds: 30,
  max_call_duration_seconds: 28800,
};

const OPTIONS = [
  {
    id: "consultHold",
    title: "Consult transfer",
    description: "Media for whichever remote party is waiting while the agent talks privately to the other party.",
    icon: IconArrowsExchange,
  },
  {
    id: "agentHold",
    title: "Hold",
    description: "Media played to the customer when an agent uses Hold in the WebRTC softphone.",
    icon: IconPlayerPause,
  },
];

const LIFECYCLE_OPTION = {
  id: "agentLifecycle",
  title: "Agent lifecycle",
  description: "Global timing and status behavior from offer through wrap-up.",
  icon: IconUserCog,
};

const SETTINGS_OPTIONS = [
  ...OPTIONS,
  LIFECYCLE_OPTION,
  { id: "notificationSounds", title: "Interaction sounds", description: "Global sounds for messaging offers. Preview ringtones and configure playback in this panel.", icon: IconBellRinging },
  { id: "copilot", title: "AI Copilot", description: "Model and knowledge sources for chat reply suggestions. Changes apply to future generations.", icon: IconBrain },
  { id: "sla", title: "Service level agreements", description: "Response targets for each released channel. Changes apply to new measurements. Clock: 24×7.", icon: IconClockHour4 },
];

function SettingsSummary({ option, selected, onSelect, children }) {
  const Icon = option.icon;
  return <Card className={cn("min-w-0 border bg-card shadow-sm transition-colors hover:border-foreground/30", selected && "border-telnyx-green ring-1 ring-telnyx-green/20")}>
    <button type="button" aria-label={`Configure ${option.title}`} aria-pressed={selected} aria-controls="system-settings-editor" onClick={onSelect}
      className="w-full rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="rounded-lg border bg-background p-2"><Icon className="size-5" /></div>
          <div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-3"><CardTitle>{option.title}</CardTitle>{selected && <IconCheck className="size-5 shrink-0 text-telnyx-green" />}</div><p className="mt-2 text-xs text-muted-foreground">Select to edit in the configuration panel.</p></div>
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </button>
  </Card>;
}

function SummaryValue({ label, children }) {
  return <div className="min-w-0 rounded-lg bg-muted/40 px-3 py-2 text-sm"><span className="text-muted-foreground">{label}</span><div className="break-words font-medium">{children}</div></div>;
}

export default function SystemSettingsPage() {
  const [settings, setSettings] = useState({
    consultHold: CONSULT_EMPTY,
    agentHold: AGENT_EMPTY,
    agentLifecycle: LIFECYCLE_EMPTY,
    copilot: DEFAULT_CHAT_COPILOT_SETTINGS,
    notificationSounds: DEFAULT_NOTIFICATION_SOUNDS,
  });
  const [selectedId, setSelectedId] = useState("consultHold");
  const [media, setMedia] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef(null);
  const editorRef = useRef(null);
  const sla = useSlaSettings();
  const selected = settings[selectedId];
  const selectedOption = useMemo(() => SETTINGS_OPTIONS.find(option => option.id === selectedId), [selectedId]);
  const lifecycleSelected = selectedId === LIFECYCLE_OPTION.id;

  const stopMedia = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(false);
  }, []);

  useEffect(() => stopMedia, [stopMedia]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [settingsResponse, mediaResponse] = await Promise.all([
        fetch("/api/admin/system-settings", { cache: "no-store" }),
        fetch("/api/admin/media-library?pageSize=1000", { cache: "no-store" }),
      ]);
      const settingsPayload = await settingsResponse.json();
      const mediaPayload = await mediaResponse.json().catch(() => ({ items: [] }));
      if (!settingsResponse.ok) throw new Error(settingsPayload?.error || "Could not load settings");
      setSettings({
        consultHold: settingsPayload.consultHold || CONSULT_EMPTY,
        agentHold: settingsPayload.agentHold || AGENT_EMPTY,
        agentLifecycle: settingsPayload.agentLifecycle || LIFECYCLE_EMPTY,
        copilot: settingsPayload.copilot || DEFAULT_CHAT_COPILOT_SETTINGS,
        notificationSounds: settingsPayload.notificationSounds || DEFAULT_NOTIFICATION_SOUNDS,
      });
      setMedia(Array.isArray(mediaPayload?.items) ? mediaPayload.items : []);
    } catch (error) {
      setLoadError(error.message);
      notify({ title: "Settings unavailable", description: error.message, variant: "error" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function selectSection(id) {
    stopMedia();
    setSelectedId(id);
    // Wait for the selected editor to render before measuring its new height.
    window.requestAnimationFrame(() => {
      editorRef.current?.scrollTo({ top: 0 });
      if (window.matchMedia("(max-width: 1279px)").matches) editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function update(patch) {
    setSettings((current) => ({
      ...current,
      [selectedId]: { ...current[selectedId], ...patch },
    }));
  }

  async function save() {
    setSaving(true);
    try {
      const response = await fetch("/api/admin/system-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Could not save settings");
      setSettings({
        consultHold: payload.consultHold,
        agentHold: payload.agentHold,
        agentLifecycle: payload.agentLifecycle,
        copilot: payload.copilot || DEFAULT_CHAT_COPILOT_SETTINGS,
        notificationSounds: payload.notificationSounds || DEFAULT_NOTIFICATION_SOUNDS,
      });
      notify({ title: "Settings saved", description: "Global settings will apply to new interactions and hold sessions.", variant: "success" });
    } catch (error) {
      notify({ title: "Save failed", description: error.message, variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  function toggleMediaPreview() {
    if (playing) return stopMedia();
    if (lifecycleSelected || !selected.media_name) return;
    const audio = new Audio(`/api/admin/media-library/${encodeURIComponent(selected.media_name)}/stream`);
    audio.loop = true;
    audio.onended = stopMedia;
    audio.onerror = stopMedia;
    audioRef.current = audio;
    setPlaying(true);
    audio.play().catch(stopMedia);
  }

  return (
    <AdminPageShell>
      <AdminPageHeader
        title="System Settings"
        icon={IconSettings}
        actions={<Button onClick={selectedId === "sla" ? sla.save : save} disabled={loading || saving || sla.saving || Boolean(loadError) || (selectedId === "sla" && !sla.data)}>{saving || sla.saving ? "Saving…" : selectedId === "sla" ? "Save SLA" : "Save settings"}</Button>}
      />
      <SystemSectionPage activeId="settings">
        {loading ? <div role="status" aria-label="Loading system settings" className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-4">{[0, 1, 2].map(index => <Card key={index}><CardHeader><Skeleton className="h-6 w-48" /></CardHeader><CardContent className="space-y-3"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></CardContent></Card>)}</div>
          <Card className="h-fit"><CardHeader><Skeleton className="h-5 w-40" /></CardHeader><CardContent className="space-y-5">{[0, 1, 2].map(index => <Skeleton key={index} className="h-12 w-full" />)}</CardContent></Card>
        </div> : loadError ? <Card><CardContent className="flex items-center justify-between gap-3 pt-6"><p role="alert" className="text-sm text-destructive">{loadError}</p><Button variant="outline" onClick={load}>Retry settings</Button></CardContent></Card> :
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto pb-5 pr-1 xl:grid-cols-[minmax(0,1fr)_380px] xl:grid-rows-[minmax(0,1fr)] xl:overflow-hidden">
          <section aria-label="Settings overview" className="min-w-0 space-y-4 xl:overflow-y-auto xl:p-1">
            <SettingsSummary option={SETTINGS_OPTIONS.find(option => option.id === "sla")} selected={selectedId === "sla"} onSelect={() => selectSection("sla")}>
              {!sla.data && !sla.error ? <div role="status" aria-label="Loading SLA overview" className="grid gap-2 sm:grid-cols-3">{[0, 1, 2].map(index => <Skeleton key={index} className="h-16 w-full" />)}</div> : sla.error ? <p role="alert" className="text-sm text-destructive">{sla.error} Select this card to reload SLA settings.</p> :
                <div className="grid gap-2 sm:grid-cols-3">{sla.data.channels.map(channel => {
                  const policy = sla.draft[channel];
                  return <SummaryValue key={channel} label={<InteractionChannel channel={channel} label />}>
                    {!policy ? "No target configured" : !policy.enabled ? "Measurement disabled" : `${policy.targetPercentage}% within ${policy.thresholdSeconds}s`}
                  </SummaryValue>;
                })}</div>}
            </SettingsSummary>
            <Card className="border bg-card shadow-sm">
              <CardHeader>
                <CardTitle>Hold experiences</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Choose an experience to configure. Each card shows the effective music and announcement behavior.
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-3 md:grid-cols-2">
                  {OPTIONS.map((option) => {
                const value = settings[option.id];
                const Icon = option.icon;
                const isSelected = option.id === selectedId;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => selectSection(option.id)}
                    aria-label={`Configure ${option.title}`}
                    aria-pressed={isSelected}
                    aria-controls="system-settings-editor"
                    className={cn(
                      "h-full w-full rounded-xl border p-4 text-left transition-colors hover:border-foreground/30 hover:bg-muted/30",
                      isSelected && "border-telnyx-green bg-telnyx-green/5 ring-1 ring-telnyx-green/20",
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <div className="rounded-lg border bg-background p-2"><Icon className="size-5" /></div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-semibold">{option.title}</span>
                          {isSelected ? <IconCheck className="size-5 text-telnyx-green" /> : null}
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">{option.description}</p>
                        <div className="mt-4 flex flex-wrap gap-2">
                          <Badge variant="outline" className="gap-1.5">
                            {value.media_name ? <IconFileMusic className="size-3.5" /> : <IconVolumeOff className="size-3.5" />}
                            {value.media_name || "No music"}
                          </Badge>
                          <Badge variant="outline" className="gap-1.5">
                            <IconMessage className="size-3.5" />
                            {value.announcement_enabled ? `Announcement every ${value.announcement_interval_seconds}s` : "No announcement"}
                          </Badge>
                        </div>
                        {value.announcement_enabled ? (
                          <div className="mt-3 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                            “{value.announcement_text}”
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </button>
                );
                  })}
                </div>
                <div className="rounded-xl border border-dashed bg-muted/20 p-4 text-sm text-muted-foreground">
                  For consult transfer, the configured experience follows the waiting party on every switch. Queue hold music overrides only the consult music selection; the system announcement remains active.
                </div>
              </CardContent>
            </Card>

            <SettingsSummary option={SETTINGS_OPTIONS.find(option => option.id === "notificationSounds")} selected={selectedId === "notificationSounds"} onSelect={() => selectSection("notificationSounds")}>
              <div className="mb-3 flex flex-wrap gap-2"><Badge variant="outline">Volume {settings.notificationSounds.volume}%</Badge><Badge variant="outline">1-second loop pause</Badge></div>
              <div className="grid gap-2 sm:grid-cols-2">{NOTIFICATION_CHANNELS.map(channel => {
                const config = settings.notificationSounds.channels[channel];
                return <SummaryValue key={channel} label={<InteractionChannel channel={channel} label />}>
                  <span>{config.enabled ? NOTIFICATION_SOUNDS.find(sound => sound.id === config.sound)?.name : "Disabled"}</span>
                  {config.enabled && <span className="ml-2 text-xs text-muted-foreground">{config.loop ? "Loop" : "Play once"}</span>}
                </SummaryValue>;
              })}</div>
            </SettingsSummary>

            <SettingsSummary option={LIFECYCLE_OPTION} selected={lifecycleSelected} onSelect={() => selectSection(LIFECYCLE_OPTION.id)}>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                <SummaryValue label="Wrap-up">{settings.agentLifecycle.wrapup_timeout_seconds}s</SummaryValue>
                <SummaryValue label="Offer timeout">{settings.agentLifecycle.default_answer_timeout_seconds}s</SummaryValue>
                <SummaryValue label="Maximum call">{Math.round(settings.agentLifecycle.max_call_duration_seconds / 60)} min</SummaryValue>
                <SummaryValue label="After wrap-up">{settings.agentLifecycle.after_wrapup_status === "previous" ? "Keep previous status" : "Available"}</SummaryValue>
                <SummaryValue label="After no answer">{settings.agentLifecycle.no_answer_status === "available" ? "Available" : "Agent Not Answering"}</SummaryValue>
              </div>
            </SettingsSummary>

            <SettingsSummary option={SETTINGS_OPTIONS.find(option => option.id === "copilot")} selected={selectedId === "copilot"} onSelect={() => selectSection("copilot")}>
              <div className="grid gap-2 sm:grid-cols-2">
                <SummaryValue label="AI model">{settings.copilot.model}</SummaryValue>
                <SummaryValue label="Max tokens">{settings.copilot.maxTokens}</SummaryValue>
              </div>
              <div className="mt-3 space-y-2"><span className="text-sm text-muted-foreground">Knowledge sources · {settings.copilot.bucketIds.length} / 5</span><div className="flex flex-wrap gap-2">{settings.copilot.bucketIds.length ? settings.copilot.bucketIds.map(bucket => <Badge key={bucket} variant="outline" className="max-w-full break-all whitespace-normal">{bucket}</Badge>) : <p className="text-sm">Conversation context only</p>}</div></div>
            </SettingsSummary>
          </section>

          <aside id="system-settings-editor" aria-label="Settings configuration" ref={editorRef} className="min-w-0 xl:min-h-0 xl:overflow-y-auto xl:p-1">
          <Card className="border bg-card shadow-sm">
            <CardHeader className="pb-4">
              <CardTitle className="text-base">Configure {selectedOption.title}</CardTitle>
              <p className="text-xs text-muted-foreground">{selectedOption.description}</p>
              <p className="text-xs text-muted-foreground">{selectedId === "sla" ? "Use Save SLA in the page header. SLA policies are saved separately from other settings." : "Use Save settings in the page header to apply your changes."}</p>
            </CardHeader>
            <CardContent className="space-y-5">
              <fieldset disabled={saving || sla.saving} className="min-w-0 space-y-5">
              {selectedId === "notificationSounds" ? <NotificationSoundSettings value={settings.notificationSounds} onChange={notificationSounds => setSettings(current => ({ ...current, notificationSounds }))} embedded disabled={saving} /> : selectedId === "copilot" ? <ChatCopilotSettings value={settings.copilot} onChange={copilot => setSettings(current => ({ ...current, copilot }))} embedded disabled={saving} /> : selectedId === "sla" ? <SlaSettingsFields controller={sla} compact showSave={false} /> :
              lifecycleSelected ? (
                <div className="divide-y">
                  <section className="space-y-2 pb-5">
                    <div className="flex items-center gap-2"><IconClockHour4 className="size-4 text-muted-foreground" /><Label>Wrap-up timeout (seconds)</Label></div>
                    <Input type="number" min={15} max={3600} value={selected.wrapup_timeout_seconds} onChange={(event) => update({ wrapup_timeout_seconds: Number(event.target.value) })} disabled={loading} />
                    <p className="text-xs text-muted-foreground">Automatically ends wrap-up when the agent does not submit it.</p>
                  </section>

                  <section className="space-y-2 py-5">
                    <Label>Status after wrap-up</Label>
                    <Select value={selected.after_wrapup_status} onValueChange={(value) => update({ after_wrapup_status: value })} disabled={loading}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="available">Available</SelectItem>
                        <SelectItem value="previous">Keep previous status</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">Status used after wrap-up is submitted or times out.</p>
                  </section>

                  <section className="space-y-2 py-5">
                    <Label>Status after no answer</Label>
                    <Select value={selected.no_answer_status} onValueChange={(value) => update({ no_answer_status: value })} disabled={loading}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="agent_not_answering">Agent Not Answering</SelectItem>
                        <SelectItem value="available">Available</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">Controls whether a missed offer removes the agent from routing.</p>
                  </section>

                  <section className="space-y-2 py-5">
                    <div className="flex items-center gap-2"><IconPhoneCall className="size-4 text-muted-foreground" /><Label>Default answer timeout (seconds)</Label></div>
                    <Input type="number" min={5} max={120} value={selected.default_answer_timeout_seconds} onChange={(event) => update({ default_answer_timeout_seconds: Number(event.target.value) })} disabled={loading} />
                    <p className="text-xs text-muted-foreground">Default offer time. A queue-specific value can override it.</p>
                  </section>

                  <section className="space-y-2 pt-5">
                    <Label>Maximum call duration (minutes)</Label>
                    <Input type="number" min={1} max={720} value={Math.round(selected.max_call_duration_seconds / 60)} onChange={(event) => update({ max_call_duration_seconds: Number(event.target.value) * 60 })} disabled={loading} />
                    <p className="text-xs text-muted-foreground">Safety limit for a single connected voice interaction.</p>
                  </section>
                </div>
              ) : (
                <>
              <section className="space-y-2">
                <Label>Hold music</Label>
                <div className="flex gap-2">
                  <Select value={selected.media_name || "__none__"} onValueChange={(value) => { stopMedia(); update({ media_name: value === "__none__" ? null : value }); }} disabled={loading}>
                    <SelectTrigger className="min-w-0 flex-1"><SelectValue placeholder="Select from Media Library" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">None — silence</SelectItem>
                      {media.filter((item) => item?.media_name).map((item) => (
                        <SelectItem key={item.media_name} value={item.media_name}>
                          <span className="flex items-center gap-2"><IconFileMusic className="size-4 text-telnyx-green" />{item.media_name}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button type="button" variant="outline" size="icon" disabled={!selected.media_name} onClick={toggleMediaPreview} title={playing ? "Stop preview" : "Preview hold music"}>
                    {playing ? <IconPlayerStop className="size-4" /> : <IconPlayerPlay className="size-4" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">The selected Media Library file loops while the remote party waits.</p>
              </section>

              <section className="space-y-4 border-t pt-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <Label>Recurring announcement</Label>
                    <p className="mt-1 text-xs text-muted-foreground">Play TTS first, then resume music until the next interval.</p>
                  </div>
                  <Switch checked={selected.announcement_enabled} onCheckedChange={(checked) => update({ announcement_enabled: checked === true })} />
                </div>
                {selected.announcement_enabled ? (
                  <>
                    <div className="space-y-2">
                      <Label>Announcement message</Label>
                      <Textarea rows={4} maxLength={3000} value={selected.announcement_text} onChange={(event) => update({ announcement_text: event.target.value })} />
                    </div>
                    <div className="space-y-2">
                      <Label>TTS voice</Label>
                      <CompactTtsVoiceSelector
                        value={selected.announcement_voice}
                        language={selected.announcement_language}
                        previewText={selected.announcement_text}
                        voiceApiKeyRef={selected.announcement_voice_api_key_ref || ""}
                        providerModelFullWidth
                        onChange={({ voice, language }) => update({ announcement_voice: voice, announcement_language: language })}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Repeat every (seconds)</Label>
                      <Input type="number" min={10} max={300} value={selected.announcement_interval_seconds} onChange={(event) => update({ announcement_interval_seconds: Number(event.target.value) })} />
                    </div>
                  </>
                ) : null}
              </section>
                </>
              )}
              </fieldset>
            </CardContent>
          </Card>
          </aside>
        </div>}
      </SystemSectionPage>
    </AdminPageShell>
  );
}
