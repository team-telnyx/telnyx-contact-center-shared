"use client";

import { useRef, useState } from "react";
import { AlignCenter, AlignLeft, AlignRight, Check, ChevronsUpDown, FileImage, Info, RotateCcw, StretchHorizontal, Trash2, UploadCloud } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  getPreviewDevice,
  previewBackground,
  previewVariantKey,
  previewViewport,
} from "@/lib/widgets/preview-devices";
import { isValidWidgetAllowedOrigin } from "@/lib/widgets/config";
import { localizeWidgetConfig, WIDGET_LOCALES } from "@/lib/widgets/locales";
import IconPicker from "./IconPicker";
import RulesDecisionBuilder from "./RulesDecisionBuilder";
import AvatarPicker, { AVATAR_EXPAND_OPTIONS, AVATAR_PROVIDER_OPTIONS, expandOptionToConfig, expandOptionValue } from "./AvatarSection";
import VideoWaitingPlaylist from "./VideoWaitingPlaylist";

const FONT_OPTIONS = ["Inter", "Roboto", "Open Sans", "Lato", "Montserrat", "Source Sans 3", "system-ui"];
const ATTACHMENT_TYPES = [
  ["image/jpeg", "JPEG images"], ["image/png", "PNG images"], ["image/gif", "GIF images"], ["image/webp", "WebP images"],
  ["application/pdf", "PDF documents"], ["text/plain", "Plain text"], ["text/csv", "CSV files"],
  ["text/markdown", "Markdown (.md, .markdown)"],
  ["application/msword", "Microsoft Word (.doc)"], ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Microsoft Word (.docx)"],
  ["application/vnd.ms-excel", "Microsoft Excel (.xls)"], ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Microsoft Excel (.xlsx)"],
  ["audio/mpeg", "MP3 audio"], ["audio/wav", "WAV audio"], ["video/mp4", "MP4 video"], ["application/zip", "ZIP archives"],
];

function Field({ label, hint, children, className = "" }) {
  return (
    <div className={`grid gap-1.5 ${className}`}>
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

export const VIDEO_PREVIEW_SCENARIOS = [
  { value: "prejoin", label: "Before the call (camera preview and Start call)" },
  { value: "connected", label: "Connected with the agent" },
  { value: "waiting", label: "Waiting in the queue" },
  { value: "screen", label: "Agent shares a screen" },
  { value: "supervisor", label: "Supervisor barged in (three participants)" },
];
const VIDEO_SCENE_OPTIONS = [
  { value: "remote", label: "Remote only", hint: "Only the other side (or a shared screen); the visitor's own preview is hidden." },
  { value: "split", label: "Side by side", hint: "Equal frames: two stacked in the panel, side by side when enlarged; three as two plus one." },
  { value: "pip", label: "Picture in picture", hint: "The other side full frame with the visitor's preview (and a third participant) as thumbnails." },
  { value: "spotlight", label: "Spotlight", hint: "The main frame large with the other participants in a strip beside or below it." },
];

function parseLineList(value) {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function LineListField({ label, hint, value, onChange, validate, validationMessage }) {
  const serializedValue = value.join("\n");
  const [draft, setDraft] = useState(serializedValue);
  const [lastSerializedValue, setLastSerializedValue] = useState(serializedValue);
  const invalid = Boolean(validate && parseLineList(draft).some((item) => !validate(item)));

  if (serializedValue !== lastSerializedValue) {
    setLastSerializedValue(serializedValue);
    if (parseLineList(draft).join("\n") !== serializedValue) setDraft(serializedValue);
  }

  return (
    <Field label={label} hint={hint}>
      <textarea
        aria-invalid={invalid}
        className={`min-h-24 rounded-md border bg-background p-3 font-mono text-xs outline-none focus-visible:ring-2 ${invalid ? "border-amber-500 focus-visible:ring-amber-500/30" : "focus-visible:ring-ring/50"}`}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          onChange(parseLineList(event.target.value));
        }}
      />
      {invalid && <p role="alert" className="text-xs leading-relaxed text-amber-700 dark:text-amber-300">{validationMessage}</p>}
    </Field>
  );
}

function SelectField({ label, value, onChange, options, hint, placeholder = "Select an option" }) {
  const items = options.map((option) => (
    typeof option === "string" ? { value: option, label: option } : option
  ));

  return (
    <Field label={label} hint={hint}>
      <Select value={String(value)} onValueChange={onChange}>
        <SelectTrigger className="h-9 w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={String(item.value)} disabled={item.disabled}>{item.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function NumberField({ label, value, onChange, min, max, step = 1, suffix = "px", hint }) {
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <Input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} />
        {suffix && <span className="min-w-8 text-xs text-muted-foreground">{suffix}</span>}
      </div>
    </Field>
  );
}

function RangeField({ label, value, onChange, min, max, step = 1, suffix = "px" }) {
  return (
    <Field label={label}>
      <div className="flex items-center gap-3">
        <input className="min-w-0 flex-1 accent-emerald-500" type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} />
        <span className="w-14 text-right text-xs tabular-nums text-muted-foreground">{value}{suffix}</span>
      </div>
    </Field>
  );
}

function ColorField({ label, value, onChange }) {
  return (
    <Field label={label}>
      <div className="flex gap-2">
        <Input type="color" value={value} onChange={(event) => onChange(event.target.value)} className="w-12 shrink-0 p-1" />
        <Input value={value} maxLength={7} onChange={(event) => onChange(event.target.value)} className="font-mono text-xs" />
      </div>
    </Field>
  );
}

function ToggleField({ label, hint, checked, onChange, checkedTrackColor }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} checkedTrackColor={checkedTrackColor} />
    </div>
  );
}

const INDICATOR_ALIGNMENTS = [
  { value: "left", label: "Align left", Icon: AlignLeft },
  { value: "center", label: "Align center", Icon: AlignCenter },
  { value: "right", label: "Align right", Icon: AlignRight },
  { value: "full", label: "Full width", Icon: StretchHorizontal },
];

function IndicatorAlignmentField({ value, onChange }) {
  return (
    <Field label="Badge alignment">
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={(nextValue) => nextValue && onChange(nextValue)}
        variant="outline"
        className="w-full"
        aria-label="Badge alignment"
      >
        {INDICATOR_ALIGNMENTS.map(({ value: optionValue, label, Icon }) => (
          <ToggleGroupItem
            key={optionValue}
            value={optionValue}
            aria-label={label}
            title={label}
            className="h-9"
          >
            <Icon className="size-4" aria-hidden="true" />
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </Field>
  );
}

function LocalePicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const selected = WIDGET_LOCALES.find((locale) => locale.id === value) || WIDGET_LOCALES[0];

  return (
    <Field
      label="Language and country"
      hint="Changing the locale applies the complete widget language pack. Existing visual settings and routing are preserved."
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="h-auto min-h-11 w-full justify-between px-3 py-2 font-normal"
          >
            <span className="flex min-w-0 items-center gap-3 text-left">
              <span className="text-xl leading-none" aria-hidden="true">{selected.flag}</span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{selected.language}</span>
                <span className="block truncate text-xs text-muted-foreground">{selected.country} · {selected.id}</span>
              </span>
            </span>
            <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
          <Command>
            <CommandInput placeholder="Search language or country…" />
            <CommandList>
              <CommandEmpty>No matching locale.</CommandEmpty>
              {WIDGET_LOCALES.map((locale) => (
                <CommandItem
                  key={locale.id}
                  value={locale.id}
                  keywords={[locale.language, locale.country, locale.id]}
                  onSelect={() => {
                    onChange(locale.id);
                    setOpen(false);
                  }}
                  className="gap-3 py-2.5"
                >
                  <Check className={`size-4 shrink-0 ${locale.id === selected.id ? "opacity-100" : "opacity-0"}`} />
                  <span className="text-xl leading-none" aria-hidden="true">{locale.flag}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{locale.language}</span>
                    <span className="block truncate text-xs text-muted-foreground">{locale.country} · {locale.id}{locale.direction === "rtl" ? " · RTL" : ""}</span>
                  </span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </Field>
  );
}


function AssistantPicker({ value, assistants, onChange }) {
  const [open, setOpen] = useState(false);
  const selected = assistants.find((assistant) => assistant.id === value) || null;
  return (
    <Field label="Widget AI assistant" hint="This assignment belongs to this widget and is used by every enabled AI channel in its revision.">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" role="combobox" aria-expanded={open} aria-label="Widget AI assistant" className="h-auto min-h-11 w-full justify-between px-3 py-2 font-normal">
            <span className="min-w-0 text-left">
              <span className="block truncate font-medium">{selected?.name || value || "Select an assistant"}</span>
              {selected?.id && <span className="block truncate text-xs text-muted-foreground">{selected.id}</span>}
            </span>
            <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
          <Command>
            <CommandInput placeholder="Search assistants…" />
            <CommandList>
              <CommandEmpty>No matching assistant.</CommandEmpty>
              {assistants.map((assistant) => (
                <CommandItem
                  key={assistant.id}
                  value={assistant.id}
                  keywords={[assistant.name, assistant.id]}
                  onSelect={() => {
                    onChange(assistant.id);
                    setOpen(false);
                  }}
                >
                  <Check className={`size-4 shrink-0 ${assistant.id === value ? "opacity-100" : "opacity-0"}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{assistant.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{assistant.id}</span>
                  </span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </Field>
  );
}

function Section({ title, description, children }) {
  return (
    <section className="space-y-4">
      <div>
        <h3 className="font-semibold">{title}</h3>
        {description && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      <div className="grid gap-4">{children}</div>
    </section>
  );
}

function Divider() {
  return <div className="border-t" />;
}

function MimeTypePicker({ label, value, onChange }) {
  const selected = new Set(value);
  return (
    <Field label={label} hint="This list is written to the widget's Contact Center Supported Content Profile.">
      <div className="grid max-h-72 gap-1 overflow-y-auto rounded-lg border p-2">
        {ATTACHMENT_TYPES.map(([mime, name]) => (
          <label key={mime} className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted">
            <input
              type="checkbox"
              checked={selected.has(mime)}
              onChange={(event) => onChange(event.target.checked ? [...value, mime] : value.filter((item) => item !== mime))}
              className="mt-0.5 accent-emerald-500"
            />
            <span className="min-w-0"><span className="block text-xs font-medium">{name}</span><span className="block truncate font-mono text-[10px] text-muted-foreground">{mime}</span></span>
          </label>
        ))}
      </div>
    </Field>
  );
}

function screenshotBlob(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      try {
        const scale = Math.min(1, 1920 / image.naturalWidth, 1200 / image.naturalHeight);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error("The selected screenshot could not be encoded."));
        }, "image/webp", 0.84);
      } catch (error) {
        reject(error);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("The selected screenshot could not be read."));
    };
    image.src = objectUrl;
  });
}

async function screenshotResponse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Screenshot request returned ${response.status}`);
  return body;
}

function ScreenshotField({ widgetId, variantKey, deviceLabel, dimensionsLabel, value, onChange }) {
  const [error, setError] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [uploadedFile, setUploadedFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);
  const storedAsset = /^\/api\/admin\/widgets\/[0-9a-f-]{36}\/preview-background/i.test(value);
  const uploaded = storedAsset || /^data:image\//i.test(value);

  const upload = async (file) => {
    if (!file) return;
    if (!widgetId) {
      setError("Select a widget before uploading its screenshot.");
      return;
    }
    if (file.size > 25 * 1_048_576) {
      setError("Choose an image smaller than 25 MB.");
      return;
    }
    if (!/^image\/(?:png|jpeg|webp)$/i.test(file.type)) {
      setError("Choose a PNG, JPEG, or WebP image.");
      return;
    }
    try {
      setError("");
      setUploading(true);
      const form = new FormData();
      form.set("file", await screenshotBlob(file), "preview-background.webp");
      const body = await screenshotResponse(await fetch(`/api/admin/widgets/${widgetId}/preview-background?variant=${encodeURIComponent(variantKey)}`, {
        method: "POST",
        body: form,
      }));
      onChange(body.url);
      setUploadedFile({ name: file.name, size: file.size });
    } catch (uploadError) {
      setError(uploadError.message);
    } finally {
      setUploading(false);
    }
  };

  const chooseFile = (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    upload(file);
  };

  const dropFile = (event) => {
    event.preventDefault();
    setDragActive(false);
    upload(event.dataTransfer.files?.[0]);
  };

  const removeUpload = async () => {
    try {
      setUploading(true);
      setError("");
      if (storedAsset) {
        await screenshotResponse(await fetch(`/api/admin/widgets/${widgetId}/preview-background?variant=${encodeURIComponent(variantKey)}`, { method: "DELETE" }));
      }
      setUploadedFile(null);
      onChange("");
    } catch (removeError) {
      setError(removeError.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="grid gap-4">
      <Field label={`Screenshot for ${deviceLabel}`} hint={`Independent background for this exact ${dimensionsLabel} preview. It is stored with this widget configuration and is not reused by another device or orientation.`}>
        <div
          className={`grid min-h-36 place-items-center rounded-xl border-2 border-dashed p-5 text-center transition-colors ${dragActive ? "border-emerald-500 bg-emerald-50" : "border-muted-foreground/25 bg-muted/20 hover:border-muted-foreground/50"}`}
          onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
          onDragOver={(event) => { event.preventDefault(); setDragActive(true); }}
          onDragLeave={(event) => { event.preventDefault(); setDragActive(false); }}
          onDrop={dropFile}
        >
          <div className="grid justify-items-center gap-2">
            {uploaded ? <FileImage className="text-emerald-600" size={28} /> : <UploadCloud className="text-muted-foreground" size={28} />}
            <div>
              <p className="text-sm font-medium">{uploaded ? "Screenshot uploaded for this preview" : "No screenshot for this preview"}</p>
              <p className="mt-1 text-xs text-muted-foreground">PNG, JPEG or WebP</p>
            </div>
            {uploadedFile && <p className="max-w-64 truncate text-xs text-muted-foreground">{uploadedFile.name} · {(uploadedFile.size / 1_048_576).toFixed(2)} MB</p>}
            <div className="flex flex-wrap justify-center gap-2">
              <Button type="button" variant={uploaded ? "outline" : "default"} size="sm" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
                {uploading ? "Uploading…" : uploaded ? "Replace file" : "Choose from computer"}
              </Button>
              {uploaded && <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => void removeUpload()}>Remove</Button>}
            </div>
            <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={chooseFile} className="sr-only" aria-label="Choose screenshot from computer" />
          </div>
        </div>
        {uploaded && <p className="text-xs text-emerald-600">Uploaded screenshot is active.</p>}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </Field>
      <Field label="Direct image URL" hint="This must return image bytes directly. A normal page URL such as https://www.telnyx.com returns HTML and cannot be used as a CSS background image.">
        <Input type="url" value={uploaded ? "" : value} onChange={(event) => onChange(event.target.value)} placeholder="https://cdn.example.com/page-screenshot.webp" />
      </Field>
    </div>
  );
}

export default function WidgetStudioControls({
  widgetId,
  section,
  config,
  name,
  enabled,
  queues = [],
  assistants = [],
  inventoryError = null,
  callbackProfile = null,
  decisionResult,
  onRunDecisionSimulation,
  setName,
  setEnabled,
  set,
  resetSection, videoScenario = "connected", setVideoScenario }) {
  const colors = config.theme.colors;
  const typography = config.theme.typography;
  const shape = config.theme.shape;
  const dimensions = config.dimensions;
  const previewDevice = getPreviewDevice(config.preview.activeDeviceId);
  const previewViewportSize = previewViewport(previewDevice, config.preview.orientation);
  const previewKey = previewVariantKey(previewDevice.id, previewViewportSize.orientation);
  const activePreviewBackground = previewBackground(config, previewDevice.id, previewViewportSize.orientation);
  const widgetAssistantId = config.channels.messaging.assistantId || config.channels.voice.assistantId;
  const setWidgetAssistant = (assistantId) => set(["channels"], {
    ...config.channels,
    messaging: { ...config.channels.messaging, assistantId },
    voice: { ...config.channels.voice, assistantId, assistantVersionId: "main" },
  });
  const callbackTopics = config.callbacks.topics?.length ? config.callbacks.topics : [{ key: "general", label: "General enquiry" }];
  const updateCallbackTopic = (index, property, value) => set(["callbacks", "topics"], callbackTopics.map((topic, topicIndex) => topicIndex === index ? { ...topic, [property]: value } : topic));
  const setPreviewBackground = (property, value) => set(["preview", "backgrounds"], {
    ...config.preview.backgrounds,
    [previewKey]: { ...activePreviewBackground, [property]: value },
  });

  if (section === "rules") {
    return (
      <RulesDecisionBuilder
        config={config}
        set={set}
        result={decisionResult}
        onRunSimulation={onRunDecisionSimulation}
      />
    );
  }

  const sectionTitles = {
    general: ["General", "Widget identity, language and session behavior."],
    channels: ["Channels & routing", "Choose channels for this visual configuration and bind their runtime resources."],
    callbacks: ["Callbacks", "Configure the callback form and scheduling experience published with this widget revision."],
    dimensions: ["Dimensions", "Control the widget, header, footer, launcher and its position on the page."],
    theme: ["Theme", "Brand colors, typography and shared component geometry."],
    launcher: ["Launcher / FAB", "Appearance and behavior of the button used to open the widget."],
    header: ["Header", "Header content, alignment, icon and visibility rules."],
    chat: ["Chat", "Message bubbles, avatars and conversation metadata."],
    handoff: ["Handoff", "Configure the Contact Center queue and agent transition shown in the conversation timeline."],
    voice: ["Voice", "Waveform rendering, transcript and voice call controls."],
    video: ["Video", "Voice & Video Call straight to a Contact Center queue: routing, camera, recording and the waiting playlist."],
    avatars: ["Avatars", "Real-time HeyGen or Anam avatar shown in the web call panel, its expanded view and embedded appearance."],
    attachments: ["Attachments", "Preview attachment cards and define the inbound/outbound MIME types enforced by Contact Center."],
    content: ["Copy & localization", "Text displayed throughout chat, voice and handoff states."],
    headsup: ["Heads-up", "A proactive prompt presented above the launcher."],
    triggers: ["Triggers & initiation", "Decide when the launcher, heads-up and widget are shown."],
    targeting: ["Targeting", "Limit this configuration to page paths and device classes."],
    accessibility: ["Accessibility & features", "Motion, metadata and optional interaction features."],
  };
  const [title, description] = sectionTitles[section] || sectionTitles.general;

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-background">
      <div className="flex items-start justify-between gap-3 border-b px-4 py-4">
        <div>
          <h2 className="font-semibold">{title}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
        </div>
        <Button type="button" size="icon" variant="ghost" onClick={() => resetSection(section)} aria-label={`Reset ${title}`}><RotateCcw size={16} /></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {section === "general" && (
          <Section title="Widget">
            <Field label="Widget name"><Input value={name} onChange={(event) => setName(event.target.value)} /></Field>
            <ToggleField label="Enabled" checked={enabled} onChange={setEnabled} />
            <LocalePicker
              value={config.locale}
              onChange={(locale) => {
                const localized = localizeWidgetConfig(config, locale);
                set(["locale"], localized.locale);
                set(["content"], localized.content);
                set(["components", "messages"], localized.components.messages);
                set(["components", "launcher"], localized.components.launcher);
                set(["engagement", "headsUp"], localized.engagement.headsUp);
              }}
            />
            <SelectField label="Default surface" value={config.behavior.defaultSurface} onChange={(value) => set(["behavior", "defaultSurface"], value)} options={["home", "chat", "voice"]} />
            <SelectField label="When reopened" value={config.behavior.reopenBehavior} onChange={(value) => set(["behavior", "reopenBehavior"], value)} options={[{ value: "resume", label: "Resume previous session" }, { value: "new", label: "Start a new session" }]} />
            <ToggleField label="Persist session" checked={config.behavior.persistSession} onChange={(value) => set(["behavior", "persistSession"], value)} />
            <NumberField label="Inactivity timeout" value={config.behavior.inactivityMinutes} min={5} max={1440} suffix="min" onChange={(value) => set(["behavior", "inactivityMinutes"], value)} />
          </Section>
        )}

        {section === "channels" && (
          <Section title="Available channels" description="This widget revision uses one AI assistant for all enabled channels.">
            <ToggleField label="Messaging" checked={config.channels.messaging.enabled} onChange={value => set(["channels", "messaging", "enabled"], value)} checkedTrackColor="#00d6a0" />
            <ToggleField label="Voice" checked={config.channels.voice.enabled} onChange={value => set(["channels", "voice", "enabled"], value)} checkedTrackColor="#00d6a0" />
            <ToggleField label="Voice & Video Call" hint="Web video call routed to a Contact Center video queue (no AI assistant). Configure it in the Video section." checked={config.channels.video.enabled} onChange={value => set(["channels", "video", "enabled"], value)} checkedTrackColor="#00d6a0" />
            {(config.channels.messaging.enabled || config.channels.voice.enabled) && <AssistantPicker value={widgetAssistantId} assistants={assistants} onChange={setWidgetAssistant} />}
            {config.channels.messaging.assistantId && config.channels.voice.assistantId && config.channels.messaging.assistantId !== config.channels.voice.assistantId && <p role="alert" className="text-xs text-destructive">Select the Widget AI assistant to replace the previous per-channel assignments.</p>}
            {inventoryError && <p role="alert" className="rounded-lg border border-destructive p-3 text-xs text-destructive">{inventoryError}</p>}
          </Section>
        )}

        {section === "callbacks" && (
          <div className="space-y-6">
            <Section title="Callback availability" description="Contact Center campaign infrastructure is managed in AI & Channels. This widget owns the customer-facing experience.">
              <ToggleField label="Enable callbacks" checked={config.callbacks.enabled} onChange={(value) => set(["callbacks", "enabled"], value)} />
              <Field label="Callback campaign" hint="Assistant, calling identity and Contact Center Dialer resources are managed centrally."><Input readOnly className="bg-muted/30" value={callbackProfile?.source === "desired" ? `Default managed callback campaign · revision ${callbackProfile.desiredRevision}` : "Default callback campaign is not configured"} /></Field>
              {callbackProfile?.source === "desired" && <div className="grid gap-3 rounded-lg border bg-muted/20 p-4"><Field label="AI assistant"><Input readOnly className="bg-background" value={callbackProfile.assistantName || callbackProfile.assistantId} /></Field><Field label="Outbound caller ID"><Input readOnly className="bg-background" value={callbackProfile.callerAddress} /></Field></div>}
            </Section>
            <Divider />
            <Section title="Callback form" description="Topics and consent are versioned together with the widget.">
              <Field label="Conversation topics">
                <div className="space-y-2">
                  {callbackTopics.map((topic, index) => <div key={index} className="grid grid-cols-[minmax(90px,0.7fr)_minmax(120px,1.3fr)_36px] gap-2"><Input aria-label={`Callback topic ${index + 1} key`} value={topic.key} placeholder="sales" onChange={(event) => updateCallbackTopic(index, "key", event.target.value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"))} /><Input aria-label={`Callback topic ${index + 1} label`} value={topic.label} placeholder="Sales enquiry" onChange={(event) => updateCallbackTopic(index, "label", event.target.value)} /><Button type="button" size="icon" variant="ghost" disabled={callbackTopics.length === 1} onClick={() => set(["callbacks", "topics"], callbackTopics.filter((_, topicIndex) => topicIndex !== index))} aria-label={`Remove callback topic ${index + 1}`}><Trash2 className="size-4" /></Button></div>)}
                  <Button type="button" size="sm" variant="outline" onClick={() => set(["callbacks", "topics"], [...callbackTopics, { key: `topic-${callbackTopics.length + 1}`, label: "New topic" }])}>Add topic</Button>
                </div>
              </Field>
              <Field label="Phone contact consent" hint={`${config.callbacks.consentText.length}/512 characters`}><Textarea rows={4} maxLength={512} value={config.callbacks.consentText} onChange={(event) => set(["callbacks", "consentText"], event.target.value)} /></Field>
              <Field label="Consent policy version"><Input value={config.callbacks.consentPolicyVersion} onChange={(event) => set(["callbacks", "consentPolicyVersion"], event.target.value)} /></Field>
              <ToggleField label="Offer SMS consent" checked={config.callbacks.showSmsConsent} onChange={(value) => set(["callbacks", "showSmsConsent"], value)} />
              <ToggleField label="Offer email consent" checked={config.callbacks.showEmailConsent} onChange={(value) => set(["callbacks", "showEmailConsent"], value)} />
            </Section>
            <Divider />
            <Section title="Scheduling policy" description="Immediate and scheduled callbacks share the same availability window. Times are shown in the website visitor's detected IANA timezone and submitted to Contact Center in UTC.">
              <ToggleField label="Immediate callback" checked={config.callbacks.allowImmediate} onChange={(value) => set(["callbacks", "allowImmediate"], value)} />
              <ToggleField label="Scheduled callback" checked={config.callbacks.allowScheduled} onChange={(value) => set(["callbacks", "allowScheduled"], value)} />
              <div className="grid grid-cols-2 gap-3"><Field label="Availability start"><Input type="time" value={config.callbacks.availabilityWindowStart} onChange={(event) => set(["callbacks", "availabilityWindowStart"], event.target.value)} /></Field><Field label="Availability end"><Input type="time" value={config.callbacks.availabilityWindowEnd} onChange={(event) => set(["callbacks", "availabilityWindowEnd"], event.target.value)} /></Field></div>
              <NumberField label="Slot interval" value={config.callbacks.scheduleStepMinutes} min={5} max={60} step={5} suffix="min" onChange={(value) => set(["callbacks", "scheduleStepMinutes"], value)} />
              <NumberField label="Maximum callbacks per slot" value={config.callbacks.maxCallbacksPerSlot} min={1} max={1000} suffix="callbacks" hint="A slot becomes unavailable when this many callback records already exist for the same time." onChange={(value) => set(["callbacks", "maxCallbacksPerSlot"], value)} />
              <NumberField label="Minimum lead" value={config.callbacks.minimumLeadMinutes} min={0} max={1440} suffix="min" onChange={(value) => set(["callbacks", "minimumLeadMinutes"], value)} />
              <NumberField label="Maximum horizon" value={config.callbacks.maximumScheduleDays} min={1} max={30} suffix="days" onChange={(value) => set(["callbacks", "maximumScheduleDays"], value)} />
            </Section>
            <Divider />
            <Section title="Callback copy">
              <Field label="Entry button"><Input value={config.callbacks.copy.buttonLabel} onChange={(event) => set(["callbacks", "copy", "buttonLabel"], event.target.value)} /></Field>
              <Field label="Form title"><Input value={config.callbacks.copy.title} onChange={(event) => set(["callbacks", "copy", "title"], event.target.value)} /></Field>
              <Field label="Submit button"><Input value={config.callbacks.copy.submitLabel} onChange={(event) => set(["callbacks", "copy", "submitLabel"], event.target.value)} /></Field>
              <Field label="Success title"><Input value={config.callbacks.copy.successTitle} onChange={(event) => set(["callbacks", "copy", "successTitle"], event.target.value)} /></Field>
            </Section>
          </div>
        )}

        {section === "dimensions" && (
          <div className="space-y-6">
            <Section title="Widget panel">
              <RangeField label="Width" value={dimensions.panelWidth} min={320} max={720} onChange={(value) => set(["dimensions", "panelWidth"], value)} />
              <RangeField label="Height" value={dimensions.panelHeight} min={420} max={900} onChange={(value) => set(["dimensions", "panelHeight"], value)} />
              <RangeField label="Message maximum width" value={dimensions.messageMaxWidth} min={50} max={92} suffix="%" onChange={(value) => set(["dimensions", "messageMaxWidth"], value)} />
              <ToggleField label="Fullscreen on mobile" checked={config.behavior.mobileFullscreen} onChange={(value) => set(["behavior", "mobileFullscreen"], value)} />
            </Section>
            <Divider />
            <Section title="Widget panel placement" description="Position of the open chat, home or voice panel on the customer page.">
              <SelectField label="Page corner" value={dimensions.panelPosition} onChange={(value) => set(["dimensions", "panelPosition"], value)} options={[{ value: "bottom-right", label: "Bottom right" }, { value: "bottom-left", label: "Bottom left" }]} />
              <RangeField label={dimensions.panelPosition === "bottom-left" ? "Distance from left edge" : "Distance from right edge"} value={dimensions.panelOffsetX} min={0} max={160} onChange={(value) => set(["dimensions", "panelOffsetX"], value)} />
              <RangeField label="Distance from bottom edge" value={dimensions.panelOffsetY} min={0} max={160} onChange={(value) => set(["dimensions", "panelOffsetY"], value)} />
            </Section>
            <Divider />
            <Section title="Header and footer">
              <RangeField label="Header height" value={dimensions.headerHeight} min={52} max={180} onChange={(value) => set(["dimensions", "headerHeight"], value)} />
              <RangeField label="Header horizontal padding" value={dimensions.headerPaddingX} min={8} max={48} onChange={(value) => set(["dimensions", "headerPaddingX"], value)} />
              <RangeField label="Footer height" value={dimensions.footerHeight} min={56} max={160} onChange={(value) => set(["dimensions", "footerHeight"], value)} />
              <RangeField label="Footer horizontal padding" value={dimensions.footerPaddingX} min={8} max={48} onChange={(value) => set(["dimensions", "footerPaddingX"], value)} />
            </Section>
            <Divider />
            <Section title="Launcher / FAB placement" description="Independent position of the closed launcher button on the customer page.">
              <SelectField label="Page corner" value={dimensions.launcherPosition} onChange={(value) => set(["dimensions", "launcherPosition"], value)} options={[{ value: "bottom-right", label: "Bottom right" }, { value: "bottom-left", label: "Bottom left" }]} />
              <RangeField label="FAB size" value={dimensions.fabSize} min={44} max={96} onChange={(value) => set(["dimensions", "fabSize"], value)} />
              <RangeField label={dimensions.launcherPosition === "bottom-left" ? "Distance from left edge" : "Distance from right edge"} value={dimensions.launcherOffsetX} min={0} max={160} onChange={(value) => set(["dimensions", "launcherOffsetX"], value)} />
              <RangeField label="Distance from bottom edge" value={dimensions.launcherOffsetY} min={0} max={160} onChange={(value) => set(["dimensions", "launcherOffsetY"], value)} />
            </Section>
            <Divider />
            <Section title="Preview page background" description="Use the built-in page mockup or place the widget over an HTTPS screenshot of the customer website. This preview-only setting is not published to the widget runtime.">
              <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                Editing <span className="font-medium text-foreground">{previewDevice.name}</span> · {previewViewportSize.width} × {previewViewportSize.height} CSS px · {previewViewportSize.orientation}
              </div>
              <SelectField label="Background" value={activePreviewBackground.backgroundMode} onChange={(value) => setPreviewBackground("backgroundMode", value)} options={[{ value: "schematic", label: "Built-in website mockup" }, { value: "image", label: "Website screenshot" }]} />
              {activePreviewBackground.backgroundMode === "image" && <>
                <ScreenshotField
                  widgetId={widgetId}
                  variantKey={previewKey}
                  deviceLabel={`${previewDevice.name} (${previewViewportSize.orientation})`}
                  dimensionsLabel={`${previewViewportSize.width} × ${previewViewportSize.height} CSS px`}
                  value={activePreviewBackground.backgroundImageUrl}
                  onChange={(value) => setPreviewBackground("backgroundImageUrl", value)}
                />
                <SelectField label="Image fit" value={activePreviewBackground.backgroundFit} onChange={(value) => setPreviewBackground("backgroundFit", value)} options={[{ value: "cover", label: "Cover viewport" }, { value: "contain", label: "Show full screenshot" }]} />
                <SelectField label="Vertical position" value={activePreviewBackground.backgroundPosition} onChange={(value) => setPreviewBackground("backgroundPosition", value)} options={[{ value: "top", label: "Top" }, { value: "center", label: "Center" }, { value: "bottom", label: "Bottom" }]} />
                <RangeField label="White overlay" value={activePreviewBackground.overlayPercent} min={0} max={90} suffix="%" onChange={(value) => setPreviewBackground("overlayPercent", value)} />
              </>}
            </Section>
          </div>
        )}

        {section === "theme" && (
          <div className="space-y-6">
            <Section title="Brand palette">
              <ColorField label="Primary" value={colors.primary} onChange={(value) => set(["theme", "colors", "primary"], value)} />
              <ColorField label="On primary" value={colors.onPrimary} onChange={(value) => set(["theme", "colors", "onPrimary"], value)} />
              <ColorField label="Surface" value={colors.surface} onChange={(value) => set(["theme", "colors", "surface"], value)} />
              <ColorField label="Muted surface" value={colors.surfaceMuted} onChange={(value) => set(["theme", "colors", "surfaceMuted"], value)} />
              <ColorField label="Text" value={colors.text} onChange={(value) => set(["theme", "colors", "text"], value)} />
              <ColorField label="Muted text" value={colors.mutedText} onChange={(value) => set(["theme", "colors", "mutedText"], value)} />
              <ColorField label="Borders" value={colors.border} onChange={(value) => set(["theme", "colors", "border"], value)} />
            </Section>
            <Divider />
            <Section title="Typography">
              <SelectField label="Font family" value={typography.fontFamily} onChange={(value) => set(["theme", "typography", "fontFamily"], value)} options={FONT_OPTIONS} />
              <RangeField label="Base size" value={typography.baseSize} min={12} max={20} onChange={(value) => set(["theme", "typography", "baseSize"], value)} />
              <RangeField label="Title size" value={typography.titleSize} min={14} max={30} onChange={(value) => set(["theme", "typography", "titleSize"], value)} />
              <RangeField label="Description size" value={typography.descriptionSize} min={10} max={20} onChange={(value) => set(["theme", "typography", "descriptionSize"], value)} />
              <RangeField label="Message size" value={typography.messageSize} min={11} max={22} onChange={(value) => set(["theme", "typography", "messageSize"], value)} />
              <RangeField label="Participant name size" value={typography.participantSize} min={9} max={16} onChange={(value) => set(["theme", "typography", "participantSize"], value)} />
              <RangeField label="Timestamp size" value={typography.metaSize} min={8} max={14} onChange={(value) => set(["theme", "typography", "metaSize"], value)} />
            </Section>
            <Divider />
            <Section title="Shape">
              <RangeField label="Panel radius" value={shape.panelRadius} min={0} max={40} onChange={(value) => set(["theme", "shape", "panelRadius"], value)} />
              <RangeField label="Bubble radius" value={shape.bubbleRadius} min={0} max={32} onChange={(value) => set(["theme", "shape", "bubbleRadius"], value)} />
              <RangeField label="Input radius" value={shape.inputRadius} min={0} max={32} onChange={(value) => set(["theme", "shape", "inputRadius"], value)} />
              <RangeField label="Button radius" value={shape.buttonRadius} min={0} max={32} onChange={(value) => set(["theme", "shape", "buttonRadius"], value)} />
            </Section>
          </div>
        )}

        {section === "launcher" && (
          <Section title="Launcher appearance">
            <SelectField label="Style" value={config.components.launcher.style} onChange={(value) => set(["components", "launcher", "style"], value)} options={[{ value: "icon", label: "Icon button" }, { value: "icon-label", label: "Icon with label" }]} />
            <IconPicker label="Icon" value={config.components.launcher.icon} onChange={(value) => set(["components", "launcher", "icon"], value)} />
            <Field label="Label"><Input value={config.components.launcher.label} onChange={(event) => set(["components", "launcher", "label"], event.target.value)} /></Field>
            <SelectField label="Shape" value={config.components.launcher.shape} onChange={(value) => set(["components", "launcher", "shape"], value)} options={["round", "rounded", "square"]} />
            <ColorField label="Background" value={config.components.launcher.backgroundColor} onChange={(value) => set(["components", "launcher", "backgroundColor"], value)} />
            <ColorField label="Icon and text" value={config.components.launcher.textColor} onChange={(value) => set(["components", "launcher", "textColor"], value)} />
            <SelectField label="Attention loop" hint="Runs continuously once the launcher is on the page. Its entrance is set in Engagement → Triggers." value={config.components.launcher.animation} onChange={(value) => set(["components", "launcher", "animation"], value)} options={["none", "pulse", "bounce", "fade"]} />
            <ToggleField label="Unread badge" checked={config.components.launcher.showUnreadBadge} onChange={(value) => set(["components", "launcher", "showUnreadBadge"], value)} />
          </Section>
        )}

        {section === "header" && (
          <div className="space-y-6">
            <Section title="Elements">
              <ToggleField label="Assistant icon" checked={config.components.header.showIcon} onChange={(value) => set(["components", "header", "showIcon"], value)} />
              <ToggleField label="Description" checked={config.components.header.showDescription} onChange={(value) => set(["components", "header", "showDescription"], value)} />
              <ToggleField label="Close button" checked={config.components.header.showClose} onChange={(value) => set(["components", "header", "showClose"], value)} />
              <IconPicker label="Header icon" value={config.components.header.icon} onChange={(value) => set(["components", "header", "icon"], value)} />
              <IconPicker label="Close icon" value={config.components.header.closeIcon} onChange={(value) => set(["components", "header", "closeIcon"], value)} />
              <SelectField label="Alignment" value={config.components.header.alignment} onChange={(value) => set(["components", "header", "alignment"], value)} options={["left", "center"]} />
              <RangeField label="Icon size" value={config.components.header.iconSize} min={24} max={72} onChange={(value) => set(["components", "header", "iconSize"], value)} />
            </Section>
            <Divider />
            <Section title="Header colors">
              <ColorField label="Background" value={colors.headerBackground} onChange={(value) => set(["theme", "colors", "headerBackground"], value)} />
              <ColorField label="Text" value={colors.headerText} onChange={(value) => set(["theme", "colors", "headerText"], value)} />
            </Section>
          </div>
        )}

        {section === "chat" && (
          <div className="space-y-6">
            <Section
              title="Assistant reply indicator"
              description="Shown after the customer sends a message and while the AI assistant prepares its response."
            >
              <ToggleField
                label="Enable rotating messages"
                hint="Cycles through predefined, localized Thinking, Brewing and progress messages."
                checked={config.components.messages.typingIndicator.rotatingMessages}
                onChange={(value) => set(["components", "messages", "typingIndicator", "rotatingMessages"], value)}
              />
              <IndicatorAlignmentField
                value={config.components.messages.typingIndicator.alignment}
                onChange={(value) => set(["components", "messages", "typingIndicator", "alignment"], value)}
              />
              {config.components.messages.typingIndicator.rotatingMessages ? (
                <div className="flex gap-2 rounded-lg bg-muted/50 p-3 text-xs leading-relaxed text-muted-foreground">
                  <Info className="mt-0.5 size-4 shrink-0" />
                  Messages rotate automatically and follow the widget language. Turn this off to use custom copy.
                </div>
              ) : (
                <Field label="Custom message">
                  <Input
                    maxLength={120}
                    value={config.content.assistantTypingMessage}
                    onChange={(event) => set(["content", "assistantTypingMessage"], event.target.value)}
                  />
                </Field>
              )}
              <IconPicker
                label="Spinner icon"
                hint="The selected icon rotates while the assistant is preparing a response."
                value={config.components.messages.typingIndicator.spinnerIcon}
                onChange={(value) => set(["components", "messages", "typingIndicator", "spinnerIcon"], value)}
              />
              <ColorField label="Badge background" value={config.components.messages.typingIndicator.backgroundColor} onChange={(value) => set(["components", "messages", "typingIndicator", "backgroundColor"], value)} />
              <ColorField label="Text and spinner" value={config.components.messages.typingIndicator.textColor} onChange={(value) => set(["components", "messages", "typingIndicator", "textColor"], value)} />
              <ColorField label="Badge border" value={config.components.messages.typingIndicator.borderColor} onChange={(value) => set(["components", "messages", "typingIndicator", "borderColor"], value)} />
              <RangeField label="Font size" value={config.components.messages.typingIndicator.fontSize} min={9} max={20} onChange={(value) => set(["components", "messages", "typingIndicator", "fontSize"], value)} />
            </Section>
            <Divider />
            <Section
              title="Contact Center agent typing indicator"
              description="Shown during a live handoff when Contact Center reports that the assigned agent is typing."
            >
              <ToggleField
                label="Show agent typing"
                hint="Displays the outbound Open Messaging typing event in the customer widget."
                checked={config.components.messages.agentTypingIndicator.enabled}
                onChange={(value) => set(["components", "messages", "agentTypingIndicator", "enabled"], value)}
              />
              <ToggleField
                label="Send customer typing to Contact Center"
                hint="Lets the connected Contact Center agent see that the customer is composing a reply."
                checked={config.components.messages.agentTypingIndicator.sendCustomerTyping}
                onChange={(value) => set(["components", "messages", "agentTypingIndicator", "sendCustomerTyping"], value)}
              />
              {config.components.messages.agentTypingIndicator.enabled && (
                <>
                  <IndicatorAlignmentField
                    value={config.components.messages.agentTypingIndicator.alignment}
                    onChange={(value) => set(["components", "messages", "agentTypingIndicator", "alignment"], value)}
                  />
                  <Field label="Indicator message">
                    <Input
                      maxLength={120}
                      value={config.content.agentTypingMessage}
                      onChange={(event) => set(["content", "agentTypingMessage"], event.target.value)}
                    />
                  </Field>
                  <IconPicker
                    label="Indicator icon"
                    value={config.components.messages.agentTypingIndicator.spinnerIcon}
                    onChange={(value) => set(["components", "messages", "agentTypingIndicator", "spinnerIcon"], value)}
                  />
                  <ColorField label="Badge background" value={config.components.messages.agentTypingIndicator.backgroundColor} onChange={(value) => set(["components", "messages", "agentTypingIndicator", "backgroundColor"], value)} />
                  <ColorField label="Text and icon" value={config.components.messages.agentTypingIndicator.textColor} onChange={(value) => set(["components", "messages", "agentTypingIndicator", "textColor"], value)} />
                  <ColorField label="Badge border" value={config.components.messages.agentTypingIndicator.borderColor} onChange={(value) => set(["components", "messages", "agentTypingIndicator", "borderColor"], value)} />
                  <RangeField label="Font size" value={config.components.messages.agentTypingIndicator.fontSize} min={9} max={20} onChange={(value) => set(["components", "messages", "agentTypingIndicator", "fontSize"], value)} />
                </>
              )}
            </Section>
            <Divider />
            <Section title="Message metadata">
              <ToggleField label="Avatars" checked={config.components.messages.showAvatars} onChange={(value) => set(["components", "messages", "showAvatars"], value)} />
              {config.components.messages.showAvatars && <RangeField label="Avatar size" value={config.components.messages.avatarSize} min={20} max={56} onChange={(value) => set(["components", "messages", "avatarSize"], value)} />}
              <ToggleField label="Participant names" checked={config.components.messages.showParticipantNames} onChange={(value) => set(["components", "messages", "showParticipantNames"], value)} />
              <ToggleField label="Timestamps" checked={config.components.messages.showTimestamps} onChange={(value) => set(["components", "messages", "showTimestamps"], value)} />
              <ToggleField label="Delivery status" checked={config.components.messages.showDeliveryStatus} onChange={(value) => set(["components", "messages", "showDeliveryStatus"], value)} />
              <RangeField label="Message spacing" value={config.components.messages.spacing} min={4} max={32} onChange={(value) => set(["components", "messages", "spacing"], value)} />
            </Section>
            {config.components.messages.showAvatars && <>
              <Divider />
              <Section title="Avatar icons">
                <IconPicker label="AI assistant" value={config.avatars.bot.type === "icon" ? config.avatars.bot.value : "bot"} onChange={(value) => set(["avatars", "bot"], { type: "icon", value })} />
                <ToggleField
                  label="Use Contact Center agent profile picture"
                  hint="When the assigned agent has a Contact Center profile picture, show it in the conversation. The icon below remains the fallback."
                  checked={Boolean(config.avatars.human.useAgentProfilePicture)}
                  onChange={(value) => set(["avatars", "human", "useAgentProfilePicture"], value)}
                />
                <IconPicker label="Human consultant fallback" value={config.avatars.human.type === "icon" ? config.avatars.human.value : "headset"} onChange={(value) => set(["avatars", "human"], { ...config.avatars.human, type: "icon", value })} />
                <IconPicker label="Customer" value={config.avatars.customer.type === "icon" ? config.avatars.customer.value : "user"} onChange={(value) => set(["avatars", "customer"], { type: "icon", value })} />
              </Section>
            </>}
            <Divider />
            <Section title="Participant labels">
              <Field label="AI assistant"><Input value={config.components.messages.assistantLabel} onChange={(event) => set(["components", "messages", "assistantLabel"], event.target.value)} /></Field>
              <Field label="Human consultant"><Input value={config.components.messages.humanLabel} onChange={(event) => set(["components", "messages", "humanLabel"], event.target.value)} /></Field>
              <Field label="Customer"><Input value={config.components.messages.customerLabel} onChange={(event) => set(["components", "messages", "customerLabel"], event.target.value)} /></Field>
            </Section>
            <Section title="Bubble colors">
              <ColorField label="AI background" value={colors.assistantBubble} onChange={(value) => set(["theme", "colors", "assistantBubble"], value)} />
              <ColorField label="AI text" value={colors.assistantText} onChange={(value) => set(["theme", "colors", "assistantText"], value)} />
              <ColorField label="Human background" value={colors.humanBubble} onChange={(value) => set(["theme", "colors", "humanBubble"], value)} />
              <ColorField label="Human text" value={colors.humanText} onChange={(value) => set(["theme", "colors", "humanText"], value)} />
              <ColorField label="Customer background" value={colors.customerBubble} onChange={(value) => set(["theme", "colors", "customerBubble"], value)} />
              <ColorField label="Customer text" value={colors.customerText} onChange={(value) => set(["theme", "colors", "customerText"], value)} />
            </Section>
            <Divider />
            <Section title="Composer buttons">
              <RangeField label="Button size" value={config.components.footer.buttonSize} min={32} max={64} onChange={(value) => set(["components", "footer", "buttonSize"], value)} />
              <RangeField label="Icon size" value={config.components.footer.iconSize} min={14} max={32} onChange={(value) => set(["components", "footer", "iconSize"], value)} />
              <RangeField label="Attachment / emoji gap" value={config.components.footer.utilityButtonGap} min={0} max={32} onChange={(value) => set(["components", "footer", "utilityButtonGap"], value)} />
              <RangeField label="Tools to message input gap" value={config.components.footer.utilityInputGap} min={0} max={40} onChange={(value) => set(["components", "footer", "utilityInputGap"], value)} />
              <RangeField label="Message input to send gap" value={config.components.footer.inputSendGap} min={0} max={40} onChange={(value) => set(["components", "footer", "inputSendGap"], value)} />
              <IconPicker label="Attachment icon" value={config.components.footer.attachmentIcon} onChange={(value) => set(["components", "footer", "attachmentIcon"], value)} />
              <IconPicker label="Emoji icon" value={config.components.footer.emojiIcon} onChange={(value) => set(["components", "footer", "emojiIcon"], value)} />
              <IconPicker label="Send icon" value={config.components.footer.sendIcon} onChange={(value) => set(["components", "footer", "sendIcon"], value)} />
              <ColorField label="Send background" value={config.components.footer.buttonBackgroundColor} onChange={(value) => set(["components", "footer", "buttonBackgroundColor"], value)} />
              <ColorField label="Send icon" value={config.components.footer.buttonTextColor} onChange={(value) => set(["components", "footer", "buttonTextColor"], value)} />
            </Section>
          </div>
        )}

        {section === "handoff" && (
          <div className="space-y-6">
            {config.channels.messaging.enabled && <Section title={widgetAssistantId ? "AI chat handoff routing" : "Direct chat routing"}
              description={widgetAssistantId ? "Choose the queues your AI assistant can hand the conversation to. Publishing automatically connects the shared handoff tool." : "Route native chat directly to a Contact Center queue."}>
              <Field label="Default chat queue" hint="Only queues with chat enabled are available.">
                <Select value={config.channels.messaging.routing.queueId || undefined} onValueChange={value => {
                  const queue = queues.find(item => item.id === value);
                  const allowed = config.channels.messaging.routing.queues;
                  set(["channels", "messaging", "routing"], { queueId: value, queueName: queue?.name || value,
                    queues: allowed.some(item => item.id === value) ? allowed : [...allowed, { id: value, name: queue?.name || value }] });
                }}><SelectTrigger className="w-full"><SelectValue placeholder="Select a chat queue" /></SelectTrigger><SelectContent>
                  {queues.map(queue => <SelectItem key={queue.id} value={queue.id}>{queue.name}</SelectItem>)}
                </SelectContent></Select>
              </Field>
              {widgetAssistantId&&<Button type="button" variant="outline" size="sm" onClick={()=>set(["channels","messaging","routing"],{queueId:"",queueName:"",queues:[]})}>Use all Chat-enabled queues</Button>}
              <Section title="Routing allowlist" description={widgetAssistantId ? "Select queues to restrict handoff. An empty list allows all Chat-enabled queues; page context can select the destination." : "Rules can route visitors only to the queues selected here."}>
                {queues.map(queue => <ToggleField key={queue.id} label={queue.name}
                  checked={config.channels.messaging.routing.queues.some(item => item.id === queue.id)} onChange={enabled => {
                    if (!enabled && queue.id === config.channels.messaging.routing.queueId) return;
                    const allowed = config.channels.messaging.routing.queues.filter(item => item.id !== queue.id);
                    set(["channels", "messaging", "routing", "queues"], enabled ? [...allowed, { id: queue.id, name: queue.name }] : allowed);
                  }} />)}
              </Section>
            </Section>}
            <Section title="Timeline presentation" description="The preview switches to chat and shows every enabled phase. Runtime only shows phases reached by the current handoff.">
              <SelectField label="Visualization" value={config.components.handoff.style} onChange={(value) => set(["components", "handoff", "style"], value)} options={[{ value: "divider", label: "Timeline divider" }, { value: "card", label: "Full-width cards" }, { value: "compact", label: "Compact pills" }]} />
              <RangeField label="Phase spacing" value={config.components.handoff.spacing} min={4} max={32} onChange={(value) => set(["components", "handoff", "spacing"], value)} />
              <RangeField label="Icon size" value={config.components.handoff.iconSize} min={12} max={32} onChange={(value) => set(["components", "handoff", "iconSize"], value)} />
              <RangeField label="Text size" value={config.components.handoff.fontSize} min={9} max={18} onChange={(value) => set(["components", "handoff", "fontSize"], value)} />
              <RangeField label="Corner radius" value={config.components.handoff.radius} min={0} max={32} onChange={(value) => set(["components", "handoff", "radius"], value)} />
            </Section>
            <Divider />
            <Section title="Queue transfer" description="Use {queue} to insert the selected Contact Center queue name.">
              <ToggleField label="Show transfer / waiting message" checked={config.components.handoff.queue.enabled} onChange={(value) => set(["components", "handoff", "queue", "enabled"], value)} />
              <Field label="Message"><Input value={config.content.handoffWaitingMessage} onChange={(event) => set(["content", "handoffWaitingMessage"], event.target.value)} /></Field>
              <IconPicker label="Icon" value={config.components.handoff.queue.icon} onChange={(value) => set(["components", "handoff", "queue", "icon"], value)} />
              <ColorField label="Background" value={config.components.handoff.queue.backgroundColor} onChange={(value) => set(["components", "handoff", "queue", "backgroundColor"], value)} />
              <ColorField label="Text" value={config.components.handoff.queue.textColor} onChange={(value) => set(["components", "handoff", "queue", "textColor"], value)} />
              <ColorField label="Border" value={config.components.handoff.queue.borderColor} onChange={(value) => set(["components", "handoff", "queue", "borderColor"], value)} />
            </Section>
            <Divider />
            <Section title="Agent assigned" description="Use {agent} to insert the agent name supplied by Contact Center.">
              <ToggleField label="Show agent assigned message" checked={config.components.handoff.assigned.enabled} onChange={(value) => set(["components", "handoff", "assigned", "enabled"], value)} />
              <Field label="Message"><Input value={config.content.handoffAssignedMessage} onChange={(event) => set(["content", "handoffAssignedMessage"], event.target.value)} /></Field>
              <IconPicker label="Icon" value={config.components.handoff.assigned.icon} onChange={(value) => set(["components", "handoff", "assigned", "icon"], value)} />
              <ColorField label="Background" value={config.components.handoff.assigned.backgroundColor} onChange={(value) => set(["components", "handoff", "assigned", "backgroundColor"], value)} />
              <ColorField label="Text" value={config.components.handoff.assigned.textColor} onChange={(value) => set(["components", "handoff", "assigned", "textColor"], value)} />
              <ColorField label="Border" value={config.components.handoff.assigned.borderColor} onChange={(value) => set(["components", "handoff", "assigned", "borderColor"], value)} />
            </Section>
            <Divider />
            <Section title="Agent connected" description="This phase is reached when the agent accepts the chat in Contact Center.">
              <ToggleField label="Show agent connected message" checked={config.components.handoff.connected.enabled} onChange={(value) => set(["components", "handoff", "connected", "enabled"], value)} />
              <Field label="Message"><Input value={config.content.handoffConnectedMessage} onChange={(event) => set(["content", "handoffConnectedMessage"], event.target.value)} /></Field>
              <IconPicker label="Icon" value={config.components.handoff.connected.icon} onChange={(value) => set(["components", "handoff", "connected", "icon"], value)} />
              <ColorField label="Background" value={config.components.handoff.connected.backgroundColor} onChange={(value) => set(["components", "handoff", "connected", "backgroundColor"], value)} />
              <ColorField label="Text" value={config.components.handoff.connected.textColor} onChange={(value) => set(["components", "handoff", "connected", "textColor"], value)} />
              <ColorField label="Border" value={config.components.handoff.connected.borderColor} onChange={(value) => set(["components", "handoff", "connected", "borderColor"], value)} />
            </Section>
            <Divider />
            <Section title="Agent disconnected" description="Shown when the agent leaves the Contact Center interaction. The chat session is closed and the customer can no longer send messages.">
              <ToggleField label="Show agent disconnected message" checked={config.components.handoff.disconnected.enabled} onChange={(value) => set(["components", "handoff", "disconnected", "enabled"], value)} />
              <Field label="Message"><Input value={config.content.handoffDisconnectedMessage} onChange={(event) => set(["content", "handoffDisconnectedMessage"], event.target.value)} /></Field>
              <IconPicker label="Icon" value={config.components.handoff.disconnected.icon} onChange={(value) => set(["components", "handoff", "disconnected", "icon"], value)} />
              <ColorField label="Background" value={config.components.handoff.disconnected.backgroundColor} onChange={(value) => set(["components", "handoff", "disconnected", "backgroundColor"], value)} />
              <ColorField label="Text" value={config.components.handoff.disconnected.textColor} onChange={(value) => set(["components", "handoff", "disconnected", "textColor"], value)} />
              <ColorField label="Border" value={config.components.handoff.disconnected.borderColor} onChange={(value) => set(["components", "handoff", "disconnected", "borderColor"], value)} />
            </Section>
            <Divider />
            <Section title="Transfer failed">
              <ToggleField label="Show failure message" checked={config.components.handoff.failed.enabled} onChange={(value) => set(["components", "handoff", "failed", "enabled"], value)} />
              <Field label="Message"><Input value={config.content.handoffFailedMessage} onChange={(event) => set(["content", "handoffFailedMessage"], event.target.value)} /></Field>
              <IconPicker label="Icon" value={config.components.handoff.failed.icon} onChange={(value) => set(["components", "handoff", "failed", "icon"], value)} />
              <ColorField label="Background" value={config.components.handoff.failed.backgroundColor} onChange={(value) => set(["components", "handoff", "failed", "backgroundColor"], value)} />
              <ColorField label="Text" value={config.components.handoff.failed.textColor} onChange={(value) => set(["components", "handoff", "failed", "textColor"], value)} />
              <ColorField label="Border" value={config.components.handoff.failed.borderColor} onChange={(value) => set(["components", "handoff", "failed", "borderColor"], value)} />
            </Section>
          </div>
        )}

        {section === "voice" && (
          <div className="space-y-6">
            <Section title="Web Calls" description="Enable unauthenticated web calls in the selected assistant's Widget settings.">
              <SelectField label="Voice media region" value={config.channels.voice.region} onChange={value => set(["channels", "voice", "region"], value)} options={["auto","eu","us-east","us-central","us-west","ca-central","apac","south-asia"]} />
            </Section>
            <Section title="Connection status badge">
              <ToggleField label="Show call status" hint="Session state on the left, what the agent is doing on the right." checked={config.components.voice.statusBadge.enabled} onChange={(value) => set(["components", "voice", "statusBadge", "enabled"], value)} />
              <IconPicker label="Session icon" hint="Shown on the left badge before a call is connected." value={config.components.voice.statusBadge.icon} onChange={(value) => set(["components", "voice", "statusBadge", "icon"], value)} />
              <IconPicker label="Listening icon" value={config.components.voice.statusBadge.listeningIcon} onChange={(value) => set(["components", "voice", "statusBadge", "listeningIcon"], value)} />
              <IconPicker label="Speaking icon" value={config.components.voice.statusBadge.speakingIcon} onChange={(value) => set(["components", "voice", "statusBadge", "speakingIcon"], value)} />
              <IconPicker label="Thinking icon" value={config.components.voice.statusBadge.thinkingIcon} onChange={(value) => set(["components", "voice", "statusBadge", "thinkingIcon"], value)} />
              <RangeField label="Text size" value={config.components.voice.statusBadge.fontSize} min={9} max={18} onChange={(value) => set(["components", "voice", "statusBadge", "fontSize"], value)} />
              <RangeField label="Icon size" value={config.components.voice.statusBadge.iconSize} min={10} max={28} onChange={(value) => set(["components", "voice", "statusBadge", "iconSize"], value)} />
              <NumberField label="Corner radius" value={config.components.voice.statusBadge.radius} min={0} max={999} onChange={(value) => set(["components", "voice", "statusBadge", "radius"], value)} />
              <ColorField label="Background" value={config.components.voice.statusBadge.backgroundColor} onChange={(value) => set(["components", "voice", "statusBadge", "backgroundColor"], value)} />
              <ColorField label="Text" value={config.components.voice.statusBadge.textColor} onChange={(value) => set(["components", "voice", "statusBadge", "textColor"], value)} />
              <ColorField label="Border" value={config.components.voice.statusBadge.borderColor} onChange={(value) => set(["components", "voice", "statusBadge", "borderColor"], value)} />
            </Section>
            <Divider />
            <Section title="Call controls" description="Icon-only controls shown directly below the top bar.">
              <RangeField label="Side button size" value={config.components.voice.controls.buttonSize} min={36} max={84} onChange={(value) => set(["components", "voice", "controls", "buttonSize"], value)} />
              <RangeField label="Call button size" value={config.components.voice.controls.callButtonSize} min={44} max={96} onChange={(value) => set(["components", "voice", "controls", "callButtonSize"], value)} />
              <RangeField label="Icon size" value={config.components.voice.controls.iconSize} min={14} max={40} onChange={(value) => set(["components", "voice", "controls", "iconSize"], value)} />
              <RangeField label="Gap" value={config.components.voice.controls.gap} min={4} max={40} onChange={(value) => set(["components", "voice", "controls", "gap"], value)} />
              <NumberField label="Button corner radius" value={config.components.voice.controls.radius} min={0} max={999} onChange={(value) => set(["components", "voice", "controls", "radius"], value)} />
              <RangeField label="Controls vertical padding" value={config.components.voice.controls.verticalPadding} min={4} max={32} onChange={(value) => set(["components", "voice", "controls", "verticalPadding"], value)} />
              <IconPicker label="Mute microphone" value={config.components.voice.controls.muteIcon} onChange={(value) => set(["components", "voice", "controls", "muteIcon"], value)} />
              <IconPicker label="Muted microphone" value={config.components.voice.controls.unmuteIcon} onChange={(value) => set(["components", "voice", "controls", "unmuteIcon"], value)} />
              <IconPicker label="Start call" value={config.components.voice.controls.callIcon} onChange={(value) => set(["components", "voice", "controls", "callIcon"], value)} />
              <IconPicker label="End call" value={config.components.voice.controls.endCallIcon} onChange={(value) => set(["components", "voice", "controls", "endCallIcon"], value)} />
              <IconPicker label="Speaker" value={config.components.voice.controls.speakerIcon} onChange={(value) => set(["components", "voice", "controls", "speakerIcon"], value)} />
              <IconPicker label="Muted speaker" value={config.components.voice.controls.speakerMutedIcon} onChange={(value) => set(["components", "voice", "controls", "speakerMutedIcon"], value)} />
              <ColorField label="Idle background" value={config.components.voice.controls.backgroundColor} onChange={(value) => set(["components", "voice", "controls", "backgroundColor"], value)} />
              <ColorField label="Idle icon" value={config.components.voice.controls.textColor} onChange={(value) => set(["components", "voice", "controls", "textColor"], value)} />
              <ColorField label="Border" value={config.components.voice.controls.borderColor} onChange={(value) => set(["components", "voice", "controls", "borderColor"], value)} />
              <ColorField label="Selected background" value={config.components.voice.controls.activeBackgroundColor} onChange={(value) => set(["components", "voice", "controls", "activeBackgroundColor"], value)} />
              <ColorField label="Selected icon" value={config.components.voice.controls.activeTextColor} onChange={(value) => set(["components", "voice", "controls", "activeTextColor"], value)} />
              <ColorField label="Start background" value={config.components.voice.controls.callBackgroundColor} onChange={(value) => set(["components", "voice", "controls", "callBackgroundColor"], value)} />
              <ColorField label="Start icon" value={config.components.voice.controls.callTextColor} onChange={(value) => set(["components", "voice", "controls", "callTextColor"], value)} />
              <ColorField label="End background" value={config.components.voice.controls.endBackgroundColor} onChange={(value) => set(["components", "voice", "controls", "endBackgroundColor"], value)} />
              <ColorField label="End icon" value={config.components.voice.controls.endTextColor} onChange={(value) => set(["components", "voice", "controls", "endTextColor"], value)} />
            </Section>
            <Divider />
            <Section title="Audio visualization">
              <ToggleField label="Waveform" checked={config.components.voice.waveform.enabled} onChange={(value) => set(["components", "voice", "waveform", "enabled"], value)} />
              <SelectField label="Style" value={config.components.voice.waveform.style} onChange={(value) => set(["components", "voice", "waveform", "style"], value)} options={[{ value: "bars", label: "Equalizer bars" }, { value: "mirrored", label: "Mirrored wave" }, { value: "line", label: "Signal line" }, { value: "radial", label: "Radial pulse" }, { value: "ribbon", label: "Aurora ribbon" }, { value: "dots", label: "Spectrum dots" }, { value: "rings", label: "Concentric rings" }]} />
              <ColorField label="Primary color" value={config.components.voice.waveform.primaryColor} onChange={(value) => set(["components", "voice", "waveform", "primaryColor"], value)} />
              <ColorField label="Secondary color" value={config.components.voice.waveform.secondaryColor} onChange={(value) => set(["components", "voice", "waveform", "secondaryColor"], value)} />
              <ColorField label="Background" value={config.components.voice.waveform.backgroundColor} onChange={(value) => set(["components", "voice", "waveform", "backgroundColor"], value)} />
              <RangeField label="Density" value={config.components.voice.waveform.bars} min={8} max={96} suffix="" onChange={(value) => set(["components", "voice", "waveform", "bars"], value)} />
              <RangeField label="Smoothing" value={config.components.voice.waveform.smoothing} min={0} max={0.99} step={0.01} suffix="" onChange={(value) => set(["components", "voice", "waveform", "smoothing"], value)} />
              <RangeField label="Amplitude" value={config.components.voice.waveform.amplitude} min={0.25} max={2} step={0.05} suffix="×" onChange={(value) => set(["components", "voice", "waveform", "amplitude"], value)} />
              <RangeField label="Visualization height" value={config.components.voice.waveform.height} min={56} max={220} onChange={(value) => set(["components", "voice", "waveform", "height"], value)} />
              <RangeField label="Padding" value={config.components.voice.waveform.padding} min={0} max={40} onChange={(value) => set(["components", "voice", "waveform", "padding"], value)} />
              <RangeField label="Corner radius" value={config.components.voice.waveform.radius} min={0} max={32} onChange={(value) => set(["components", "voice", "waveform", "radius"], value)} />
              <ToggleField label="Glow" checked={config.components.voice.waveform.glow} onChange={(value) => set(["components", "voice", "waveform", "glow"], value)} />
              <ToggleField label="Live transcript" checked={config.features.voiceTranscript} onChange={(value) => set(["features", "voiceTranscript"], value)} />
              <ToggleField label="Text input during call" checked={config.features.voiceTextInput} onChange={(value) => set(["features", "voiceTextInput"], value)} />
            </Section>
          </div>
        )}

        {section === "video" && (
          <div className="space-y-6">
            <Section title="Preview" description="The panel on the left renders the video surface live: switch the call state to see every scene, the thumbnail size, the controls and the notices.">
              <SelectField label="Call state in the preview" value={videoScenario} onChange={value => setVideoScenario?.(value)} options={VIDEO_PREVIEW_SCENARIOS} />
            </Section>
            <Divider />
            <Section title="Routing" description="The visitor waits in this queue; only agents with the Video channel enabled receive the offer.">
              <SelectField label="Contact Center video queue" value={config.channels.video.routing.queueId || "__none__"} placeholder="Select a queue"
                onChange={value => { const queue = queues.find(item => item.id === value); set(["channels", "video", "routing"], value === "__none__" ? { queueId: "", queueName: "" } : { queueId: value, queueName: queue?.name || value }); }}
                options={[{ value: "__none__", label: "Not selected" }, ...queues.map(queue => ({ value: queue.id, label: queue.name }))]}
                hint="Enable the Video channel for the queue in Admin → Queues → Channels first." />
              <ToggleField label="Record calls" hint="Telnyx records both participants and composes one mp4 with audio after the call." checked={config.channels.video.recording.enabled} onChange={value => set(["channels", "video", "recording", "enabled"], value)} />
              <SelectField label="Recording layout" value={config.channels.video.recording.layout} onChange={value => set(["channels", "video", "recording", "layout"], value)} options={[{ value: "pip", label: "Customer with agent picture-in-picture" }, { value: "split", label: "Side by side (customer left, agent right)" }]} />
            </Section>
            <Divider />
            <Section title="Call experience">
              <SelectField label="Camera before the call" value={config.channels.video.camera} onChange={value => set(["channels", "video", "camera"], value)} options={[{ value: "on", label: "Camera on (visitor can turn it off)" }, { value: "off", label: "Camera off (audio call, visitor can turn it on)" }]} />
              <ToggleField label="Screen sharing" hint="Adds a share button to the visitor's controls; the shared screen becomes the main frame on both sides." checked={config.channels.video.allowScreenShare} onChange={value => set(["channels", "video", "allowScreenShare"], value)} />
            </Section>
            <Divider />
            <Section title="Scenes" description="Layouts the visitor can switch between. Every frame keeps 4:3; a third participant (supervisor) or a shared screen joins the scene automatically.">
              {VIDEO_SCENE_OPTIONS.map(option => (
                <ToggleField key={option.value} label={option.label} hint={option.hint} checked={config.channels.video.scenes.available.includes(option.value)}
                  onChange={value => { const available = VIDEO_SCENE_OPTIONS.map(item => item.value).filter(id => id === option.value ? value : config.channels.video.scenes.available.includes(id)); if (!available.length) return; set(["channels", "video", "scenes"], { ...config.channels.video.scenes, available, default: available.includes(config.channels.video.scenes.default) ? config.channels.video.scenes.default : available[0] }); }} />
              ))}
              <SelectField label="Scene after the agent connects" value={config.channels.video.scenes.default} onChange={value => set(["channels", "video", "scenes", "default"], value)}
                options={VIDEO_SCENE_OPTIONS.filter(option => config.channels.video.scenes.available.includes(option.value)).map(option => ({ value: option.value, label: option.label }))} />
              <RangeField label="Picture-in-picture thumbnail" value={config.channels.video.scenes.pipThumbnail} min={10} max={50} suffix="%" onChange={value => set(["channels", "video", "scenes", "pipThumbnail"], value)} />
            </Section>
            <Divider />
            <Section title="Enlarged view" description="A translucent button in the corner of the video grows the panel into a centered modal over the page.">
              <ToggleField label="Enlarge button" checked={config.channels.video.modal.enabled} onChange={value => set(["channels", "video", "modal", "enabled"], value)} />
              <SelectField label="Modal size" value={config.channels.video.modal.size} onChange={value => set(["channels", "video", "modal", "size"], value)}
                options={[{ value: "small", label: "Small · 50% of the page width" }, { value: "medium", label: "Medium · 75%" }, { value: "large", label: "Large · 90%" }, { value: "fullscreen", label: "Fullscreen · 100%" }]}
                hint="The height follows the scene so the frames keep their proportions; on phones the modal always fills the page." />
            </Section>
            <Divider />
            <Section title="Panel size" description="Keep the widget at the size from Dimensions, or give the video surface its own size so the scenes have room.">
              <SelectField label="While the video surface is open" value={config.channels.video.sizing.mode} onChange={value => set(["channels", "video", "sizing", "mode"], value)}
                options={[{ value: "widget", label: "Static · use the widget dimensions" }, { value: "video", label: "Dynamic · resize the panel for video" }]} />
              {config.channels.video.sizing.mode === "video" && (
                <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
                  <RangeField label="Video panel width" value={config.channels.video.sizing.width} min={320} max={960} onChange={value => set(["channels", "video", "sizing", "width"], value)} />
                  <RangeField label="Video panel height" value={config.channels.video.sizing.height} min={420} max={900} onChange={value => set(["channels", "video", "sizing", "height"], value)} />
                </div>
              )}
              <SelectField label="Call controls" value={config.channels.video.controls.position} onChange={value => set(["channels", "video", "controls", "position"], value)}
                options={[{ value: "bottom", label: "Docked at the bottom of the widget" }, { value: "top", label: "Above the video" }, { value: "overlay", label: "Floating over the video" }]} />
              {config.channels.video.controls.position === "overlay" && (
                <div className="grid gap-3">
                  <RangeField label="Panel opacity" value={config.channels.video.controls.overlay.opacity} min={0} max={100} suffix="%" onChange={value => set(["channels", "video", "controls", "overlay", "opacity"], value)} />
                  <SelectField label="Panel size" value={config.channels.video.controls.overlay.size} onChange={value => set(["channels", "video", "controls", "overlay", "size"], value)}
                    options={[{ value: "compact", label: "Compact" }, { value: "regular", label: "Regular" }, { value: "large", label: "Large" }]} />
                </div>
              )}
              <ToggleField label="Handoff notices on the video" hint="Queued, assigned and connected messages appear over the video frame, above the controls, then hide." checked={config.channels.video.notices.enabled} onChange={value => set(["channels", "video", "notices", "enabled"], value)} />
              {config.channels.video.notices.enabled && (
                <NumberField label="Notice duration" value={config.channels.video.notices.seconds} min={1} max={30} suffix="s" onChange={value => set(["channels", "video", "notices", "seconds"], Math.max(1, Math.min(30, Math.round(value) || 3)))} />
              )}
            </Section>
            <Divider />
            <Section title="Waiting playlist" description="Muted videos shown while the visitor waits for an agent: links to mp4 or webm files or uploads from the media library, played in this order.">
              <SelectField label="Playback" value={config.channels.video.waiting.mode} onChange={value => set(["channels", "video", "waiting", "mode"], value)}
                options={[{ value: "rotate", label: "Rotate · play the list in order, then start over" }, { value: "loop", label: "Loop · repeat the first file" }]} />
              <ToggleField label="Play with sound" hint="The visitor has already pressed Start call, so browsers allow sound. Off keeps the playlist muted; the Studio preview is always muted." checked={config.channels.video.waiting.sound} onChange={value => set(["channels", "video", "waiting", "sound"], value)} />
              <VideoWaitingPlaylist items={config.channels.video.waiting.items} onChange={items => set(["channels", "video", "waiting", "items"], items)} />
              <Field label="Copy"><Input value={config.content.videoWaitingMessage} onChange={event => set(["content", "videoWaitingMessage"], event.target.value)} /></Field>
            </Section>
          </div>
        )}

        {section === "avatars" && (() => {
          const avatar = config.channels.voice.avatar;
          const look = config.components.voice.avatar;
          const setAvatar = (patch) => set(["channels", "voice", "avatar"], { ...avatar, ...patch });
          const setLook = (key, value) => set(["components", "voice", "avatar"], { ...look, [key]: value });
          return (
            <div className="space-y-6">
              <Section title="Web call avatar" description="A real-time avatar driven by the assistant audio replaces the waveform in the voice panel. Any provider credit, capacity or connection error falls back to the waveform.">
                {!config.channels.voice.enabled && (
                  <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-800">Enable the Voice channel in Channels & routing to show the avatar to visitors.</p>
                )}
                <ToggleField label="Show avatar in web calls" hint="Streams the assistant audio through the avatar; the visitor hears the avatar instead of the plain WebRTC audio." checked={avatar.enabled} onChange={(value) => setAvatar({ enabled: value })} checkedTrackColor="#00d6a0" />
                <SelectField label="Avatar provider" value={avatar.provider} onChange={(value) => setAvatar({ provider: value, avatarId: null, name: "", previewUrl: "", portraitPreviewUrl: "", landscapePreviewUrl: "", avatarModel: "" })} options={Object.entries(AVATAR_PROVIDER_OPTIONS).map(([value, option]) => ({ value, label: option.label }))} />
                <AvatarPicker avatar={avatar} onChange={(next) => set(["channels", "voice", "avatar"], next)} />
                <SelectField label="Avatar format" hint="Aspect ratio of the avatar embedded in the panel and used to size the modal." value={avatar.displayFormat} onChange={(value) => setAvatar({ displayFormat: value, previewUrl: (value === "landscape" ? avatar.landscapePreviewUrl : avatar.portraitPreviewUrl) || avatar.previewUrl })} options={[{ value: "portrait", label: "Portrait (9:16)" }, { value: "landscape", label: "Landscape (16:9)" }]} />
                <SelectField label="Expanded view" hint="What the expand button on the embedded avatar opens over the visitor's page." value={expandOptionValue(avatar)} onChange={(value) => setAvatar(expandOptionToConfig(value))} options={AVATAR_EXPAND_OPTIONS} />
              </Section>
              <Divider />
              <Section title="Embedded avatar" description="Size and look of the avatar inside the web call panel before it is expanded.">
                <SelectField label="Position" hint="Above the call controls, or below them like the waveform." value={look.position} onChange={(value) => setLook("position", value)} options={[{ value: "top", label: "Top · above the call controls" }, { value: "middle", label: "Middle · below the call controls" }]} />
                <ToggleField label="Subtitles on the embedded avatar" hint="Shows the latest transcript line over the small avatar, not only in the expanded view." checked={look.showSubtitles} onChange={(value) => setLook("showSubtitles", value)} />
                {look.showSubtitles && (
                  <>
                    <SelectField label="Subtitle position" value={look.subtitlePosition} onChange={(value) => setLook("subtitlePosition", value)} options={[{ value: "bottom", label: "Bottom of the avatar" }, { value: "top", label: "Top of the avatar" }]} />
                    <RangeField label="Subtitle text size" value={look.subtitleFontSize} min={10} max={24} onChange={(value) => setLook("subtitleFontSize", value)} />
                  </>
                )}
                <RangeField label="Maximum height" value={look.maxHeight} min={120} max={800} onChange={(value) => setLook("maxHeight", value)} />
                <RangeField label="Corner radius" value={look.radius} min={0} max={32} onChange={(value) => setLook("radius", value)} />
                <RangeField label="Padding" value={look.padding} min={0} max={40} onChange={(value) => setLook("padding", value)} />
                <ColorField label="Background" value={look.backgroundColor} onChange={(value) => setLook("backgroundColor", value)} />
                <SelectField label="Video fit" hint="Fill crops the video to the box; Fit shows the whole frame with bars." value={look.fit} onChange={(value) => setLook("fit", value)} options={[{ value: "cover", label: "Fill (crop)" }, { value: "contain", label: "Fit (letterbox)" }]} />
                <RangeField label="Crop focus" value={look.focusY} min={0} max={100} suffix="%" onChange={(value) => setLook("focusY", value)} />
                <ToggleField label="Expand button" hint="Lets the visitor open the expanded view." checked={look.showExpandButton} onChange={(value) => setLook("showExpandButton", value)} />
              </Section>
            </div>
          );
        })()}

        {section === "attachments" && (
          <div className="space-y-6">
            <Section title="Contact Center content policy" description="Published policies control accepted file types and sizes for customer and agent uploads.">
              <ToggleField label="Attachments after agent handoff" checked={config.features.attachmentsAfterHandoff} onChange={(value) => set(["features", "attachmentsAfterHandoff"], value)} />
              <MimeTypePicker label="Inbound: customer to Contact Center" value={config.features.attachmentPolicy.inboundMimeTypes} onChange={(value) => set(["features", "attachmentPolicy", "inboundMimeTypes"], value)} />
              <MimeTypePicker label="Outbound: Contact Center to customer" value={config.features.attachmentPolicy.outboundMimeTypes} onChange={(value) => set(["features", "attachmentPolicy", "outboundMimeTypes"], value)} />
              <NumberField label="Maximum file size" hint="Applied by the widget before upload; Contact Center channel limits still apply." value={config.features.attachmentPolicy.maximumFileSizeMb} min={1} max={100} suffix="MB" onChange={(value) => set(["features", "attachmentPolicy", "maximumFileSizeMb"], value)} />
              <ToggleField label="Show image and document examples in preview" checked={config.features.attachmentPolicy.showPreviewExamples} onChange={(value) => set(["features", "attachmentPolicy", "showPreviewExamples"], value)} />
            </Section>
            <Divider />
            <Section title="Attachment card">
              <IconPicker label="Document icon" value={config.components.attachments.documentIcon} onChange={(value) => set(["components", "attachments", "documentIcon"], value)} />
              <IconPicker label="Image icon" value={config.components.attachments.imageIcon} onChange={(value) => set(["components", "attachments", "imageIcon"], value)} />
              <RangeField label="Icon size" value={config.components.attachments.iconSize} min={14} max={36} onChange={(value) => set(["components", "attachments", "iconSize"], value)} />
              <RangeField label="Corner radius" value={config.components.attachments.radius} min={0} max={32} onChange={(value) => set(["components", "attachments", "radius"], value)} />
              <ColorField label="Background" value={config.components.attachments.backgroundColor} onChange={(value) => set(["components", "attachments", "backgroundColor"], value)} />
              <ColorField label="Text" value={config.components.attachments.textColor} onChange={(value) => set(["components", "attachments", "textColor"], value)} />
              <ColorField label="Border" value={config.components.attachments.borderColor} onChange={(value) => set(["components", "attachments", "borderColor"], value)} />
            </Section>
            <Divider />
            <Section title="File preview" description="How an attachment opens when the customer taps its card.">
              <SelectField
                label="Opens"
                hint="Expanding grows the embedded frame over the host page while the preview is open, then restores the panel."
                value={config.components.attachments.preview.placement}
                onChange={(value) => set(["components", "attachments", "preview", "placement"], value)}
                options={[
                  { value: "page", label: "Expanded over the page" },
                  { value: "panel", label: "Inside the widget panel" },
                ]}
              />
              {config.components.attachments.preview.placement === "page" && (
                <>
                  <RangeField label="Width" value={config.components.attachments.preview.pageWidthPercent} min={30} max={100} suffix="%" onChange={(value) => set(["components", "attachments", "preview", "pageWidthPercent"], value)} />
                  <RangeField label="Height" value={config.components.attachments.preview.pageHeightPercent} min={30} max={100} suffix="%" onChange={(value) => set(["components", "attachments", "preview", "pageHeightPercent"], value)} />
                </>
              )}
            </Section>
          </div>
        )}

        {section === "content" && (
          <Section title="Visible text">
            {[
              ["title", "Title"], ["messagingSubtitle", "Messaging description"], ["voiceSubtitle", "Voice description"],
              ["welcomeMessage", "Welcome message"], ["chatLabel", "Chat action"], ["callLabel", "Voice action"],
              ["inputPlaceholder", "Input placeholder"],
              ["voiceReadyMessage", "Voice ready"],
              ["voiceConnectingMessage", "Voice connecting"], ["voiceActiveMessage", "Voice active"],
            ].map(([key, label]) => <Field key={key} label={label}><Input value={config.content[key]} onChange={(event) => set(["content", key], event.target.value)} /></Field>)}
          </Section>
        )}

        {section === "headsup" && (
          <Section title="Proactive prompt">
            <ToggleField label="Enable heads-up" checked={config.engagement.headsUp.enabled} onChange={(value) => set(["engagement", "headsUp", "enabled"], value)} />
            <SelectField label="Type" value={config.engagement.headsUp.type} onChange={(value) => set(["engagement", "headsUp", "type"], value)} options={[{ value: "text", label: "Text" }, { value: "quick-replies", label: "Quick replies" }]} />
            <Field label="Headline"><Input value={config.engagement.headsUp.headline} onChange={(event) => set(["engagement", "headsUp", "headline"], event.target.value)} /></Field>
            <Field label="Body"><textarea className="min-h-24 rounded-md border bg-background p-3 text-sm" value={config.engagement.headsUp.body} onChange={(event) => set(["engagement", "headsUp", "body"], event.target.value)} /></Field>
            <NumberField label="Delay" value={config.engagement.headsUp.delaySeconds} min={0} max={3600} suffix="sec" onChange={(value) => set(["engagement", "headsUp", "delaySeconds"], value)} />
            <ToggleField label="Close button" checked={config.engagement.headsUp.showClose} onChange={(value) => set(["engagement", "headsUp", "showClose"], value)} />
            <ToggleField label="Sound" hint="Browsers may block sound before a user gesture." checked={config.engagement.headsUp.sound} onChange={(value) => set(["engagement", "headsUp", "sound"], value)} />
          </Section>
        )}

        {section === "triggers" && (
          <div className="space-y-6">
            <Section title="1. Show launcher">
              <NumberField label="Delay after page load" value={config.engagement.triggers.launcher.delaySeconds} min={0} max={3600} suffix="sec" onChange={(value) => set(["engagement", "triggers", "launcher", "delaySeconds"], value)} />
              <RangeField label="Scroll depth" value={config.engagement.triggers.launcher.scrollPercent} min={0} max={100} suffix="%" onChange={(value) => set(["engagement", "triggers", "launcher", "scrollPercent"], value)} />
              <ToggleField label="Exit intent" checked={config.engagement.triggers.launcher.exitIntent} onChange={(value) => set(["engagement", "triggers", "launcher", "exitIntent"], value)} />
            </Section>
            <Divider />
            <Section title="2. Show heads-up">
              <ToggleField label="Heads-up enabled" checked={config.engagement.headsUp.enabled} onChange={(value) => set(["engagement", "headsUp", "enabled"], value)} />
              <NumberField label="Delay after launcher" value={config.engagement.headsUp.delaySeconds} min={0} max={3600} suffix="sec" onChange={(value) => set(["engagement", "headsUp", "delaySeconds"], value)} />
            </Section>
            <Divider />
            <Section title="3. Open widget">
              <ToggleField label="Open automatically" checked={config.engagement.triggers.autoOpen.enabled} onChange={(value) => set(["engagement", "triggers", "autoOpen", "enabled"], value)} />
              <NumberField label="Delay" value={config.engagement.triggers.autoOpen.delaySeconds} min={0} max={3600} suffix="sec" onChange={(value) => set(["engagement", "triggers", "autoOpen", "delaySeconds"], value)} />
              <SelectField
                label="Surface"
                value={config.engagement.triggers.autoOpen.surface}
                onChange={(value) => set(["engagement", "triggers", "autoOpen", "surface"], value)}
                options={[
                  { value: "home", label: "Home" },
                  { value: "chat", label: "Chat" },
                  { value: "voice", label: "Voice" },
                  { value: "callbacks", label: "Callback" },
                ]}
              />
              <ToggleField label="Once per browser session" checked={config.engagement.triggers.oncePerSession} onChange={(value) => set(["engagement", "triggers", "oncePerSession"], value)} />
              <NumberField label="Cooldown" value={config.engagement.triggers.cooldownMinutes} min={0} max={10080} suffix="min" onChange={(value) => set(["engagement", "triggers", "cooldownMinutes"], value)} />
            </Section>
            <Divider />
            <Section title="Appearance animation" description="How the launcher and the panel come onto the page. Every option is skipped for visitors who ask for reduced motion.">
              <SelectField
                label="Launcher appears"
                value={config.engagement.animation.launcherEntrance}
                onChange={(value) => set(["engagement", "animation", "launcherEntrance"], value)}
                options={[
                  { value: "none", label: "No animation" },
                  { value: "fade", label: "Fade in" },
                  { value: "scale", label: "Scale up" },
                  { value: "slide-up", label: "Slide up" },
                  { value: "drop", label: "Drop in" },
                ]}
              />
              <SelectField
                label="Panel appears"
                hint="Scale grows the panel out of the launcher corner."
                value={config.engagement.animation.panelEntrance}
                onChange={(value) => set(["engagement", "animation", "panelEntrance"], value)}
                options={[
                  { value: "none", label: "No animation" },
                  { value: "fade", label: "Fade in" },
                  { value: "scale", label: "Scale up" },
                  { value: "slide-up", label: "Slide up" },
                  { value: "slide-right", label: "Slide in from the side" },
                ]}
              />
              <RangeField label="Duration" value={config.engagement.animation.durationMs} min={80} max={1200} step={20} suffix="ms" onChange={(value) => set(["engagement", "animation", "durationMs"], value)} />
            </Section>
          </div>
        )}

        {section === "targeting" && (
          <Section title="Audience">
            <ToggleField label="Desktop" checked={config.targeting.devices.desktop} onChange={(value) => set(["targeting", "devices", "desktop"], value)} />
            <ToggleField label="Tablet" checked={config.targeting.devices.tablet} onChange={(value) => set(["targeting", "devices", "tablet"], value)} />
            <ToggleField label="Mobile" checked={config.targeting.devices.mobile} onChange={(value) => set(["targeting", "devices", "mobile"], value)} />
            <LineListField key={`${widgetId}:include-paths`} label="Include paths" hint="One exact path or wildcard ending in * per line." value={config.targeting.includePaths} onChange={(value) => set(["targeting", "includePaths"], value)} />
            <LineListField key={`${widgetId}:exclude-paths`} label="Exclude paths" value={config.targeting.excludePaths} onChange={(value) => set(["targeting", "excludePaths"], value)} />
            <LineListField
              key={`${widgetId}:allowed-origins`}
              label="Allowed embedding origins"
              hint="Required for publishing. Enter one customer website origin per line, for example https://shop.example.com or https://*.example.com."
              value={config.allowedOrigins}
              validate={isValidWidgetAllowedOrigin}
              validationMessage="Incorrect format. Use an exact HTTP(S) origin such as https://shop.example.com or an HTTPS wildcard such as https://*.example.com. Do not include a path."
              onChange={(value) => set(["allowedOrigins"], value)}
            />
          </Section>
        )}

        {section === "accessibility" && (
          <Section title="Interaction features">
            <ToggleField label="Emoji picker" checked={config.features.emoji} onChange={(value) => set(["features", "emoji"], value)} />
            <ToggleField label="Auto-focus message input" checked={config.behavior.autoFocusInput} onChange={(value) => set(["behavior", "autoFocusInput"], value)} />
            <ColorField label="Footer background" value={colors.footerBackground} onChange={(value) => set(["theme", "colors", "footerBackground"], value)} />
            <ColorField label="Footer text" value={colors.footerText} onChange={(value) => set(["theme", "colors", "footerText"], value)} />
            <ColorField label="Input background" value={colors.inputBackground} onChange={(value) => set(["theme", "colors", "inputBackground"], value)} />
            <ColorField label="Input text" value={colors.inputText} onChange={(value) => set(["theme", "colors", "inputText"], value)} />
            <div className="flex gap-2 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground"><Info className="mt-0.5 size-4 shrink-0" /> Runtime animations honor the visitor’s reduced-motion preference.</div>
          </Section>
        )}
      </div>
    </aside>
  );
}
