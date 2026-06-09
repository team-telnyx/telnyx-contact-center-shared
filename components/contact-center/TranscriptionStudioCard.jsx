"use client";

import { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Combobox } from "@/components/ui/combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  IconClipboard,
  IconFileText,
  IconLanguage,
  IconLoader2,
  IconMessages,
  IconSparkles,
  IconUsersGroup,
  IconWand,
} from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import TranscriptionSheet from "./TranscriptionSheet";
import {
  TRANSCRIPTION_MODELS,
  DEFAULT_TRANSCRIPTION_MODEL,
  NOVA3_OPTION_DEFAULTS,
  getTranscriptionModel,
} from "@/config/transcription-models";

// ── Language helpers (flags + pretty names, mirrored from the demo portal) ────

const LANG_FLAGS = {
  en: "🇺🇸", es: "🇪🇸", fr: "🇫🇷", de: "🇩🇪", pt: "🇧🇷", it: "🇮🇹",
  nl: "🇳🇱", ja: "🇯🇵", ko: "🇰🇷", zh: "🇨🇳", ar: "🇸🇦", hi: "🇮🇳",
  pl: "🇵🇱", ru: "🇷🇺", tr: "🇹🇷", sv: "🇸🇪", da: "🇩🇰", fi: "🇫🇮",
  no: "🇳🇴", cs: "🇨🇿", ro: "🇷🇴", hu: "🇭🇺", el: "🇬🇷", he: "🇮🇱",
  th: "🇹🇭", vi: "🇻🇳", id: "🇮🇩", ms: "🇲🇾", uk: "🇺🇦", bg: "🇧🇬",
  hr: "🇭🇷", sk: "🇸🇰", sl: "🇸🇮", lt: "🇱🇹", lv: "🇱🇻", et: "🇪🇪",
  ca: "🇪🇸", be: "🇧🇾", bn: "🇧🇩", bs: "🇧🇦", ka: "🇬🇪", gu: "🇮🇳",
  kn: "🇮🇳", mk: "🇲🇰", ml: "🇮🇳", mr: "🇮🇳", fa: "🇮🇷", sr: "🇷🇸",
  ta: "🇮🇳", te: "🇮🇳", ur: "🇵🇰", tl: "🇵🇭", auto: "🌐", multi: "🌐",
};

const DEFAULT_REGION = {
  en: "US", es: "ES", fr: "FR", de: "DE", it: "IT", pt: "PT", nl: "NL",
  sv: "SE", da: "DK", fi: "FI", no: "NO", pl: "PL", ro: "RO", cs: "CZ",
  sk: "SK", sl: "SI", hu: "HU", lt: "LT", lv: "LV", et: "EE", bg: "BG",
  hr: "HR", sr: "RS", ru: "RU", uk: "UA", ar: "SA", he: "IL", tr: "TR",
  hi: "IN", ja: "JP", ko: "KR", zh: "CN", th: "TH", vi: "VN", id: "ID",
  ms: "MY", el: "GR", ka: "GE", fa: "IR",
};

function regionToFlag(region) {
  const r = String(region || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(r)) return "🌐";
  const cps = [...r].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65));
  return String.fromCodePoint(...cps);
}

function flagForLocale(locale) {
  if (!locale) return "🌐";
  const tag = String(locale).replace(/_/g, "-");
  const parts = tag.split("-");
  const lang = parts[0].toLowerCase();
  for (let i = 1; i < parts.length; i++) {
    if (/^[A-Z]{2}$/i.test(parts[i])) return regionToFlag(parts[i].toUpperCase());
  }
  if (lang === "zh") return parts[1]?.toLowerCase() === "hans" ? "🇨🇳" : "🇹🇼";
  return LANG_FLAGS[lang] || (DEFAULT_REGION[lang] ? regionToFlag(DEFAULT_REGION[lang]) : "🌐");
}

function prettyLanguageName(locale) {
  if (!locale) return "";
  if (/^auto$/i.test(locale)) return "Auto-detect";
  if (/^multi$/i.test(locale)) return "Multilingual";
  try {
    const langNames = new Intl.DisplayNames(undefined, { type: "language" });
    const regionNames = new Intl.DisplayNames(undefined, { type: "region" });
    const tag = String(locale).replace(/_/g, "-");
    const parts = tag.split("-");
    let label = langNames.of(parts[0].toLowerCase()) || parts[0].toUpperCase();
    for (let i = 1; i < parts.length; i++) {
      if (/^[A-Z]{2}$/i.test(parts[i])) {
        label += ` (${regionNames.of(parts[i].toUpperCase()) || parts[i]})`;
        break;
      }
    }
    return label;
  } catch {
    return locale;
  }
}

function buildLanguageOptions(languages) {
  const seen = new Set();
  const items = [];
  for (const raw of languages || []) {
    const key = String(raw).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ value: raw, label: `${flagForLocale(raw)} ${prettyLanguageName(raw)}` });
  }
  return items;
}

function formatConfidence(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const normalized = num > 1 ? num / 100 : num;
  return `${Math.round(Math.max(0, Math.min(1, normalized)) * 100)}%`;
}

function formatSeconds(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const total = Math.max(0, Math.round(num));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

const NOVA3_OPTION_LABELS = [
  ["diarize", "Diarize speakers", "Tag each speaker turn"],
  ["smart_format", "Smart format", "Dates, numbers, currency"],
  ["punctuate", "Punctuate", "Sentence punctuation"],
  ["numerals", "Numerals", "Numbers as digits"],
];

function StatChip({ icon: Icon, label, value }) {
  if (value == null || value === "") return null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground">
      {Icon ? <Icon className="h-3 w-3 shrink-0" /> : null}
      <span className="font-medium text-foreground/70">{label}</span>
      <span>{value}</span>
    </span>
  );
}

export default function TranscriptionStudioCard({
  recordingId,
  interactionId,
  transcriptionText,
  transcriptionSegments,
  transcriptionSummary,
  transcriptionSpeakerTurns,
  transcriptionDetails,
}) {
  const [model, setModel] = useState(
    transcriptionDetails?.model && TRANSCRIPTION_MODELS.some((m) => m.value === transcriptionDetails.model)
      ? transcriptionDetails.model
      : DEFAULT_TRANSCRIPTION_MODEL,
  );
  const [language, setLanguage] = useState(transcriptionDetails?.language || "auto");
  const [options, setOptions] = useState({ ...NOVA3_OPTION_DEFAULTS });
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [result, setResult] = useState({
    text: transcriptionText || null,
    segments: transcriptionSegments || null,
    summary: transcriptionSummary || null,
    speakerTurns: transcriptionSpeakerTurns || [],
    details: transcriptionDetails || null,
  });

  const modelMeta = getTranscriptionModel(model);
  const languageOptions = useMemo(
    () => buildLanguageOptions(modelMeta.languages),
    [modelMeta],
  );
  const effectiveLanguage = modelMeta.languages.includes(language) ? language : "auto";
  const isNova3 = model === "deepgram/nova-3";
  const hasTranscript = Boolean(result.text);
  const speakerCount = new Set((result.speakerTurns || []).map((turn) => turn.speaker)).size;
  const confidenceLabel = formatConfidence(result.details?.confidence);

  const handleTranscribe = async () => {
    if (!recordingId || !interactionId) {
      notify({ title: "Recording ID and Interaction ID are required", variant: "error" });
      return;
    }
    setIsTranscribing(true);
    try {
      const response = await fetch(
        `/api/voice/recordings/${encodeURIComponent(recordingId)}/transcribe`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            interactionId,
            model,
            language: effectiveLanguage,
            options: isNova3 ? options : undefined,
          }),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to transcribe recording");
      }
      if (!data.transcription_text) {
        throw new Error("No transcription text received");
      }
      setResult({
        text: data.transcription_text,
        segments: data.transcription_segments || null,
        summary: data.transcription_summary || null,
        speakerTurns: data.transcription_speaker_turns || [],
        details: data.transcription_details || null,
      });
      notify({ title: "Transcription completed successfully", variant: "success" });
    } catch (error) {
      console.error("[TranscriptionStudio] Transcription error:", error);
      notify({ title: error.message || "Failed to transcribe recording", variant: "error" });
    } finally {
      setIsTranscribing(false);
    }
  };

  return (
    <Card className="overflow-hidden border-border/70 bg-card shadow-sm dark:bg-zinc-950/70" data-testid="transcription-studio-card">
      <CardContent className="p-0">
        {/* Header strip */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 bg-muted/30 px-5 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300">
              <IconWand className="h-5 w-5" />
            </span>
            <div>
              <div className="text-sm font-semibold leading-tight">Transcription Studio</div>
              <div className="text-xs text-muted-foreground">
                {hasTranscript
                  ? "Transcript ready — open the conversation view or re-run with different settings"
                  : "AI transcription with speaker diarization and multilingual support"}
              </div>
            </div>
          </div>
          {hasTranscript ? (
            <Button
              size="sm"
              onClick={() => setSheetOpen(true)}
              className="h-8 rounded-lg bg-violet-600 px-3 text-xs text-white shadow-md shadow-violet-600/25 hover:bg-violet-500"
              data-testid="view-conversation-button"
            >
              <IconMessages className="mr-1.5 h-3.5 w-3.5" />
              View Conversation
            </Button>
          ) : null}
        </div>

        {/* Settings */}
        <div className="grid gap-4 px-5 py-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <div className="space-y-3">
            <div>
              <Label className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">Model</Label>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select model" />
                </SelectTrigger>
                <SelectContent>
                  {TRANSCRIPTION_MODELS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      <div className="flex items-center gap-2">
                        <span>{item.label}</span>
                        {item.recommended ? (
                          <Badge variant="outline" className="border-violet-500/40 bg-violet-500/10 px-1.5 py-0 text-[10px] text-violet-700 dark:text-violet-300">
                            Recommended
                          </Badge>
                        ) : null}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">{modelMeta.description}</p>
            </div>
            <div>
              <Label className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">Language</Label>
              <Combobox
                options={languageOptions}
                value={effectiveLanguage}
                onChange={(value) => setLanguage(value || "auto")}
                placeholder="Select language"
                triggerClassName="w-full"
              />
            </div>
          </div>

          <div>
            <Label className="mb-1.5 block text-xs uppercase tracking-wide text-muted-foreground">
              Nova 3 options
            </Label>
            <div className="grid gap-2 sm:grid-cols-2">
              {NOVA3_OPTION_LABELS.map(([key, label, hint]) => (
                <label
                  key={key}
                  className={`flex cursor-pointer items-center justify-between gap-2 rounded-xl border px-3 py-2 transition ${
                    isNova3
                      ? "border-border/70 bg-muted/30 hover:border-foreground/20"
                      : "pointer-events-none border-border/40 bg-muted/10 opacity-50"
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block text-xs font-medium">{label}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">{hint}</span>
                  </span>
                  <Switch
                    checked={isNova3 ? Boolean(options[key]) : false}
                    onCheckedChange={(checked) => setOptions((prev) => ({ ...prev, [key]: checked }))}
                    disabled={!isNova3}
                  />
                </label>
              ))}
            </div>
            {!isNova3 ? (
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Speaker diarization and formatting options are available with Deepgram Nova 3.
              </p>
            ) : null}
          </div>
        </div>

        {/* Action row */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 bg-muted/20 px-5 py-3">
          <Button
            onClick={handleTranscribe}
            disabled={isTranscribing || !recordingId || !interactionId}
            className="rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 px-5 text-white shadow-md shadow-violet-600/25 transition hover:from-violet-500 hover:to-fuchsia-500 disabled:opacity-50"
            data-testid="transcribe-button"
          >
            {isTranscribing ? (
              <>
                <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
                Transcribing…
              </>
            ) : (
              <>
                <IconSparkles className="mr-2 h-4 w-4" />
                {hasTranscript ? "Re-transcribe" : "Transcribe Recording"}
              </>
            )}
          </Button>

          {hasTranscript ? (
            <div className="flex flex-wrap items-center gap-1.5" data-testid="transcription-stats">
              <StatChip icon={IconFileText} label="Model" value={getTranscriptionModel(result.details?.model || model).label} />
              <StatChip
                icon={IconLanguage}
                label="Language"
                value={
                  result.details?.detected_language
                    ? `${flagForLocale(result.details.detected_language)} ${prettyLanguageName(result.details.detected_language)}`
                    : result.details?.language && result.details.language !== "auto"
                      ? `${flagForLocale(result.details.language)} ${prettyLanguageName(result.details.language)}`
                      : null
                }
              />
              <StatChip icon={IconUsersGroup} label="Speakers" value={speakerCount > 0 ? speakerCount : null} />
              <StatChip icon={IconSparkles} label="Confidence" value={confidenceLabel} />
              <StatChip icon={IconClipboard} label="Audio" value={formatSeconds(result.details?.duration)} />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Runs on Telnyx AI · verbose JSON with timestamps{isNova3 && options.diarize ? " · speaker turns" : ""}
            </p>
          )}
        </div>

        {/* Summary preview */}
        {hasTranscript && result.summary ? (
          <div className="border-t border-border/60 px-5 py-4">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <IconClipboard className="h-3.5 w-3.5" />
              Call Summary
            </div>
            <p className="mt-1.5 line-clamp-3 text-sm text-muted-foreground">{result.summary}</p>
          </div>
        ) : null}
      </CardContent>

      <TranscriptionSheet
        transcriptionText={result.text}
        transcriptionSegments={result.segments}
        transcriptionSummary={result.summary}
        speakerTurns={result.speakerTurns}
        details={result.details}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
      />
    </Card>
  );
}
