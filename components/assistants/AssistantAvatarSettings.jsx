"use client";

import { useEffect, useRef, useState } from "react";
import {
  Check,
  CircleUserRound,
  Info,
  LockKeyhole,
  Volume2,
} from "lucide-react";
import { useUiText } from "@/components/i18n/use-ui-text";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import TelnyxAvatarLibrary from "./TelnyxAvatarLibrary";
import { assistantVoiceSettings } from "@/lib/ai/assistant-draft.mjs";
import {
  applySuggestedAvatarVoice,
  avatarVoiceDetails,
  defaultAssistantAvatar,
  hasCompatibleAvatarVoice,
  suggestedAvatarVoice,
} from "@/lib/ai/assistant-avatar-ui.mjs";

const BACKGROUNDS = [
  { value: "studio", label: "Studio" },
  { value: "office", label: "Office" },
  { value: "reception", label: "Reception" },
];

function AssistantVoiceSummary({ voice }) {
  const tUi = useUiText();
  const [catalog, setCatalog] = useState({ status: "loading", providers: [] });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/tts/voices", { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok || !data.ok || !Array.isArray(data.providers)) throw new Error("catalog");
        if (!controller.signal.aborted) setCatalog({ status: "ready", providers: data.providers });
      } catch {
        if (!controller.signal.aborted) setCatalog({ status: "error", providers: [] });
      }
    }
    load();
    return () => controller.abort();
  }, [attempt]);

  if (catalog.status === "loading") return (
    <div role="status" aria-label={tUi("Loading voice details")} className="space-y-2 py-1">
      <Skeleton className="h-4 w-48 max-w-full" />
      <Skeleton className="h-3 w-24" />
    </div>
  );
  const details = avatarVoiceDetails(voice, catalog.providers);
  if (details) return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="text-sm font-medium">{details.name}</span>
      <span className="text-xs text-muted-foreground">{details.provider} · {details.model === "Default" ? tUi("Default") : details.model}</span>
    </div>
  );
  if (catalog.status === "error") return (
    <div className="flex flex-wrap items-center gap-2" role="status">
      <p className="text-sm text-muted-foreground">{tUi("Could not load the voice name.")}</p>
      <Button variant="outline" size="sm" onClick={() => { setCatalog({ status: "loading", providers: [] }); setAttempt(current => current + 1); }}>{tUi("Retry")}</Button>
    </div>
  );
  return <p className="text-sm text-muted-foreground">{tUi("This saved voice is not listed in the current catalog. Review it in Voice settings.")}</p>;
}

export default function AssistantAvatarSettings({
  values,
  setValues,
  onVoiceSettings,
}) {
  const tUi = useUiText();
  const previous = useRef(null);
  const avatar = values.avatar_settings;
  const enabled = Boolean(avatar);
  const voice = assistantVoiceSettings(values);
  const suggested = suggestedAvatarVoice(avatar?.avatar_id);
  const usingSuggested = suggested?.voice === voice?.voice;

  function toggle(checked) {
    if (!checked) previous.current = avatar;
    const restored =
      previous.current ||
      values._original?.avatar_settings ||
      defaultAssistantAvatar();
    setValues((current) => ({
      ...current,
      avatar_settings: checked ? restored : null,
    }));
  }
  function update(patch) {
    setValues((current) => ({
      ...current,
      avatar_settings: { ...current.avatar_settings, ...patch },
    }));
  }

  return (
    <div
      data-avatar-panel
      data-setting-path="avatar_settings"
      className="space-y-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-4 border-b pb-5">
        <div className="flex items-center gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-700 dark:text-telnyx-green">
            <CircleUserRound className="size-6" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">{tUi("Avatar")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {tUi("Choose how your assistant appears in video conversations.")}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Label
            htmlFor="assistant-avatar-enabled"
            className="cursor-pointer text-sm"
          >
            {tUi("Enable avatar")}
          </Label>
          <Switch
            id="assistant-avatar-enabled"
            checked={enabled}
            onCheckedChange={toggle}
          />
        </div>
      </div>

      {!enabled ? (
        <div className="rounded-xl border border-dashed bg-muted/20 px-6 py-12 text-center">
          <CircleUserRound className="mx-auto mb-4 size-9 text-muted-foreground" />
          <h3 className="font-medium">{tUi("Avatar is off")}</h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            {tUi(
              "Enable an avatar to choose a portrait, background and optional voice pairing.",
            )}
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            {[
              {
                key: "provider",
                label: "Provider",
                value:
                  avatar.provider === "telnyx" ? "Telnyx" : avatar.provider,
              },
              { key: "model", label: "Model", value: avatar.model },
            ].map((field) => (
              <div
                key={field.key}
                data-setting-path={`avatar_settings.${field.key}`}
                className="space-y-2"
              >
                <Label>{tUi(field.label)}</Label>
                <div
                  role="textbox"
                  aria-label={tUi(field.label)}
                  aria-readonly="true"
                  className="flex h-10 items-center justify-between rounded-md border bg-muted/30 px-3 text-sm"
                >
                  <span>{field.value || "—"}</span>
                  <LockKeyhole
                    className="size-3.5 text-muted-foreground"
                    aria-hidden="true"
                  />
                </div>
              </div>
            ))}
            <div
              data-setting-path="avatar_settings.background_id"
              className="space-y-2"
            >
              <Label htmlFor="assistant-avatar-background">
                {tUi("Background")}
              </Label>
              <Select
                value={avatar.background_id || ""}
                onValueChange={(background_id) => update({ background_id })}
              >
                <SelectTrigger
                  id="assistant-avatar-background"
                  className="h-10 w-full"
                >
                  <SelectValue placeholder={tUi("Select background")} />
                </SelectTrigger>
                <SelectContent>
                  {avatar.background_id &&
                  !BACKGROUNDS.some(
                    (entry) => entry.value === avatar.background_id,
                  ) ? (
                    <SelectItem value={avatar.background_id} disabled>
                      {avatar.background_id}
                    </SelectItem>
                  ) : null}
                  {BACKGROUNDS.map((entry) => (
                    <SelectItem key={entry.value} value={entry.value}>
                      {tUi(entry.label)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <fieldset
            data-setting-path="avatar_settings.avatar_id"
            className="min-w-0 space-y-3"
          >
            <TelnyxAvatarLibrary carousel selectedId={avatar.avatar_id} onSelect={entry => update({ avatar_id: entry.id, provider: "telnyx", model: entry.avatarModel })} />
          </fieldset>

          <div className="rounded-xl border bg-muted/20 p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex min-w-0 items-start gap-3">
                <Volume2 className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 space-y-1">
                  <h3 className="text-sm font-medium">
                    {tUi("Assistant voice")}
                  </h3>
                  {voice?.voice ? <AssistantVoiceSummary voice={voice.voice} /> : <p className="text-sm text-muted-foreground">{tUi("No voice selected")}</p>}
                  <p className="text-xs text-muted-foreground">
                    {tUi("Choosing a portrait keeps your current voice.")}
                  </p>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={onVoiceSettings}>
                {tUi("Voice settings")}
              </Button>
            </div>
            {suggested ? (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                <p className="text-sm">
                  <span className="text-muted-foreground">
                    {tUi("Suggested voice")}:{" "}
                  </span>
                  {suggested.name}
                  <span className="ml-2 text-xs text-muted-foreground">
                    Telnyx Ultra
                  </span>
                </p>
                {usingSuggested ? (
                  <span
                    role="status"
                    className="flex items-center gap-1.5 text-sm text-emerald-700 dark:text-telnyx-green"
                  >
                    <Check className="size-4" />
                    {tUi("Suggested voice selected")}
                  </span>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setValues(applySuggestedAvatarVoice)}
                  >
                    {tUi("Use suggested voice")}
                  </Button>
                )}
              </div>
            ) : null}
            {!hasCompatibleAvatarVoice(voice) ? (
              <div
                role="status"
                className="mt-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200"
              >
                <Info className="mt-0.5 size-4 shrink-0" />
                <p>
                  {tUi(
                    "Avatar conversations require a Telnyx voice, including any language-specific voices. Choose a compatible voice before starting a video conversation.",
                  )}
                </p>
              </div>
            ) : null}
          </div>
          <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" />
            {tUi(
              "Save to apply your avatar settings. Phone calls remain voice-only; supported video conversations use the saved avatar.",
            )}
          </p>
        </>
      )}
    </div>
  );
}
