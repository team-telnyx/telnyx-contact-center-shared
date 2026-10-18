"use client";
import { useId } from "react";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUiText } from "@/components/i18n/use-ui-text";
import { backgroundAudioEnabled } from "@/lib/ai/assistant-audio-ui.mjs";

export default function AssistantToolAudioSettings({ value, backgroundAudio, onChange }) {
  const tUi = useUiText();
  const id = useId();
  const blocked = backgroundAudioEnabled(backgroundAudio);
  return (
    <div
      className="space-y-4 border-t pt-5"
      data-setting-path="voice_settings.tool_call_audio"
    >
      <div className="flex items-center justify-between gap-4">
        <label htmlFor={id} className="text-sm font-medium">
          {tUi("Audio while tools run")}
        </label>
        <Switch
          id={id}
          checked={!blocked && value != null}
          disabled={blocked}
          aria-describedby={blocked ? `${id}-reason` : undefined}
          onCheckedChange={(enabled) =>
            onChange(
              enabled
                ? { type: "predefined_media", value: "typing", volume: 0.5 }
                : null,
            )
          }
        />
      </div>
      {blocked ? <p id={`${id}-reason`} className="text-xs leading-relaxed text-muted-foreground">
        {tUi("Audio while tools run is turned off while background audio is enabled. Choose Silence as the background sound to enable it.")}
      </p> : null}
      {!blocked && value ? (
        <>
          <div className="space-y-2">
            <label htmlFor={`${id}-sound`} className="text-xs">
              {tUi("Sound")}
            </label>
            <Select
              value={value.type || "predefined_media"}
              onValueChange={(type) =>
                onChange(
                  type === "media_url"
                    ? { type, value: "" }
                    : { type, value: "typing", volume: 0.5 },
                )
              }
            >
              <SelectTrigger id={`${id}-sound`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="predefined_media">
                  {tUi("Keyboard typing")}
                </SelectItem>
                <SelectItem value="media_url">{tUi("Audio URL")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {value.type === "media_url" ? (
            <label className="block space-y-2 text-xs">
              {tUi("Audio URL")}
              <Input
                type="url"
                value={value.value || ""}
                onChange={(e) => onChange({ ...value, value: e.target.value })}
                placeholder="https://example.com/audio.mp3"
              />
            </label>
          ) : (
            <div className="space-y-3">
              <div className="flex justify-between text-xs">
                <label htmlFor={`${id}-volume`}>{tUi("Volume")}</label>
                <span>{Math.round((value.volume ?? 0.5) * 100)}%</span>
              </div>
              <Slider
                id={`${id}-volume`}
                min={0}
                max={1}
                step={0.1}
                value={[value.volume ?? 0.5]}
                onValueChange={([volume]) =>
                  onChange({ ...value, volume: Math.round(volume * 10) / 10 })
                }
              />
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
