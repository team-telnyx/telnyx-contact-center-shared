"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const VOICE_API_COMMANDS = [
  { value: "recording_start", label: "Recording Start" },
  { value: "recording_stop", label: "Recording Stop" },
  { value: "record_pause", label: "Record Pause" },
  { value: "record_resume", label: "Record Resume" },
];

const RECORDING_FORMATS = [
  { value: "mp3", label: "MP3" },
  { value: "wav", label: "WAV" },
];

const RECORDING_CHANNELS = [
  { value: "single", label: "Single" },
  { value: "dual", label: "Dual" },
];

export default function VoiceApiCommandToolEditor({ value, onChange }) {
  const vc = value?.voice_api_command || {};

  function update(partial) {
    onChange?.({
      ...(value || { type: "voice_api_command" }),
      voice_api_command: { ...(value?.voice_api_command || {}), ...partial },
    });
  }

  const command = vc.command || "";
  const isRecordingStart = command === "recording_start";

  return (
    <div className="space-y-4">
      <div>
        <Label className="text-xs">Description (optional)</Label>
        <Textarea
          rows={2}
          value={vc.description || ""}
          onChange={(e) => update({ description: e.target.value })}
          placeholder="Describe when the assistant should invoke this command"
        />
      </div>

      <div>
        <Label className="text-xs">Intent Message (optional)</Label>
        <Input
          value={vc.intent_message || ""}
          onChange={(e) => update({ intent_message: e.target.value })}
          placeholder="Message to speak before executing the command"
        />
        <p className="text-xs text-muted-foreground mt-1">
          Optional message spoken to the caller before the command executes.
        </p>
      </div>

      <div>
        <Label className="text-xs">Command</Label>
        <Select
          value={command}
          onValueChange={(val) => update({ command: val })}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select a command…" />
          </SelectTrigger>
          <SelectContent>
            {VOICE_API_COMMANDS.map(({ value, label }) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Recording-start specific options */}
      {isRecordingStart && (
        <div className="border rounded-md p-3 space-y-3 bg-muted/20">
          <div className="text-xs font-medium">Recording Options</div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Format</Label>
              <Select
                value={vc.format || "mp3"}
                onValueChange={(val) => update({ format: val })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RECORDING_FORMATS.map(({ value, label }) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label className="text-xs">Channels</Label>
              <Select
                value={vc.channels || "single"}
                onValueChange={(val) => update({ channels: val })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RECORDING_CHANNELS.map(({ value, label }) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label className="text-xs">Max Length (seconds)</Label>
            <Input
              type="number"
              min={0}
              value={vc.max_length ?? ""}
              onChange={(e) =>
                update({
                  max_length: e.target.value ? Number(e.target.value) : undefined,
                })
              }
              placeholder="e.g. 600"
            />
          </div>

          <div className="flex items-center gap-2">
            <Switch
              id="vc-beep"
              checked={vc.beep_enabled === true}
              onCheckedChange={(v) => update({ beep_enabled: v })}
            />
            <Label htmlFor="vc-beep" className="text-xs cursor-pointer">
              Beep Enabled
            </Label>
          </div>
        </div>
      )}
    </div>
  );
}
