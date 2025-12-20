"use client";

import { useState, useEffect } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { IconChevronRight } from "@tabler/icons-react";

const RINGTONE_OPTIONS = [
  { value: "at", label: "Austria" },
  { value: "au", label: "Australia" },
  { value: "be", label: "Belgium" },
  { value: "bg", label: "Bulgaria" },
  { value: "br", label: "Brazil" },
  { value: "ch", label: "Switzerland" },
  { value: "cl", label: "Chile" },
  { value: "cn", label: "China" },
  { value: "cz", label: "Czech Republic" },
  { value: "de", label: "Germany" },
  { value: "dk", label: "Denmark" },
  { value: "ee", label: "Estonia" },
  { value: "es", label: "Spain" },
  { value: "fi", label: "Finland" },
  { value: "fr", label: "France" },
  { value: "gr", label: "Greece" },
  { value: "hu", label: "Hungary" },
  { value: "il", label: "Israel" },
  { value: "in", label: "India" },
  { value: "it", label: "Italy" },
  { value: "jp", label: "Japan" },
  { value: "lt", label: "Lithuania" },
  { value: "mx", label: "Mexico" },
  { value: "my", label: "Malaysia" },
  { value: "nl", label: "Netherlands" },
  { value: "no", label: "Norway" },
  { value: "nz", label: "New Zealand" },
  { value: "ph", label: "Philippines" },
  { value: "pl", label: "Poland" },
  { value: "pt", label: "Portugal" },
  { value: "ru", label: "Russia" },
  { value: "se", label: "Sweden" },
  { value: "sg", label: "Singapore" },
  { value: "th", label: "Thailand" },
  { value: "tw", label: "Taiwan" },
  { value: "uk", label: "United Kingdom" },
  { value: "us-old", label: "US (Old)" },
  { value: "us", label: "US" },
  { value: "ve", label: "Venezuela" },
  { value: "za", label: "South Africa" },
];

export default function BridgeNodeEditor({ config = {}, onChange }) {
  // Basic fields
  const [callControlId, setCallControlId] = useState(
    config.call_control_id || ""
  );
  const [queue, setQueue] = useState(config.queue || "");
  const [clientState, setClientState] = useState(config.client_state || "");
  const [commandId, setCommandId] = useState(config.command_id || "");

  // Bridge Options
  const [parkAfterUnbridge, setParkAfterUnbridge] = useState(
    config.park_after_unbridge || ""
  );
  const [playRingtone, setPlayRingtone] = useState(
    config.play_ringtone || false
  );
  const [ringtone, setRingtone] = useState(config.ringtone || "us");
  const [muteDtmf, setMuteDtmf] = useState(config.mute_dtmf || "none");

  // Recording
  const [record, setRecord] = useState(config.record || "");
  const [recordChannels, setRecordChannels] = useState(
    config.record_channels || "dual"
  );
  const [recordFormat, setRecordFormat] = useState(
    config.record_format || "mp3"
  );
  const [recordMaxLength, setRecordMaxLength] = useState(
    config.record_max_length || ""
  );
  const [recordTimeoutSecs, setRecordTimeoutSecs] = useState(
    config.record_timeout_secs || ""
  );
  const [recordTrack, setRecordTrack] = useState(config.record_track || "both");
  const [recordTrim, setRecordTrim] = useState(config.record_trim || "");
  const [recordCustomFileName, setRecordCustomFileName] = useState(
    config.record_custom_file_name || ""
  );

  // Collapsible states
  const [bridgeOptionsExpanded, setBridgeOptionsExpanded] = useState(false);
  const [recordingExpanded, setRecordingExpanded] = useState(false);

  // Sync state from config changes
  useEffect(() => {
    if (config.call_control_id !== undefined)
      setCallControlId(config.call_control_id);
    if (config.queue !== undefined) setQueue(config.queue);
    if (config.client_state !== undefined) setClientState(config.client_state);
    if (config.command_id !== undefined) setCommandId(config.command_id);
    if (config.park_after_unbridge !== undefined)
      setParkAfterUnbridge(config.park_after_unbridge);
    if (config.play_ringtone !== undefined) setPlayRingtone(config.play_ringtone);
    if (config.ringtone !== undefined) setRingtone(config.ringtone);
    if (config.mute_dtmf !== undefined) setMuteDtmf(config.mute_dtmf);
    if (config.record !== undefined) setRecord(config.record);
    if (config.record_channels !== undefined)
      setRecordChannels(config.record_channels);
    if (config.record_format !== undefined) setRecordFormat(config.record_format);
    if (config.record_max_length !== undefined)
      setRecordMaxLength(config.record_max_length);
    if (config.record_timeout_secs !== undefined)
      setRecordTimeoutSecs(config.record_timeout_secs);
    if (config.record_track !== undefined) setRecordTrack(config.record_track);
    if (config.record_trim !== undefined) setRecordTrim(config.record_trim);
    if (config.record_custom_file_name !== undefined)
      setRecordCustomFileName(config.record_custom_file_name);
  }, [config]);

  const buildConfig = () => {
    return {
      call_control_id: callControlId || undefined,
      queue: queue || undefined,
      client_state: clientState || undefined,
      command_id: commandId || undefined,
      park_after_unbridge: parkAfterUnbridge || undefined,
      play_ringtone: playRingtone || undefined,
      ringtone: playRingtone ? (ringtone || "us") : undefined,
      mute_dtmf: muteDtmf !== "none" ? muteDtmf : undefined,
      record: record || undefined,
      record_channels: record ? (recordChannels || "dual") : undefined,
      record_format: record ? (recordFormat || "mp3") : undefined,
      record_max_length: record
        ? recordMaxLength
          ? Number(recordMaxLength)
          : undefined
        : undefined,
      record_timeout_secs: record
        ? recordTimeoutSecs
          ? Number(recordTimeoutSecs)
          : undefined
        : undefined,
      record_track: record ? (recordTrack || "both") : undefined,
      record_trim: record ? (recordTrim || undefined) : undefined,
      record_custom_file_name: record ? (recordCustomFileName || undefined) : undefined,
    };
  };

  const updateConfig = () => {
    const newConfig = buildConfig();
    onChange?.(newConfig);
  };

  // Update config when any field changes
  useEffect(() => {
    updateConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    callControlId,
    queue,
    clientState,
    commandId,
    parkAfterUnbridge,
    playRingtone,
    ringtone,
    muteDtmf,
    record,
    recordChannels,
    recordFormat,
    recordMaxLength,
    recordTimeoutSecs,
    recordTrack,
    recordTrim,
    recordCustomFileName,
  ]);

  return (
    <div className="space-y-4">
      {/* Basic Bridge Settings */}
      <div className="space-y-3">
        <div>
          <Label>Call Control ID</Label>
          <Input
            type="text"
            value={callControlId}
            onChange={(e) => {
              setCallControlId(e.target.value);
            }}
            placeholder="v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg"
            className="mt-1"
          />
          <p className="text-xs text-muted-foreground mt-1">
            The Call Control ID of the call you want to bridge with, can't be
            used together with queue parameter or video_room_id parameter
          </p>
        </div>

        <div>
          <Label>Queue</Label>
          <Input
            type="text"
            value={queue}
            onChange={(e) => {
              setQueue(e.target.value);
            }}
            placeholder="support"
            className="mt-1"
          />
          <p className="text-xs text-muted-foreground mt-1">
            The name of the queue you want to bridge with, can't be used
            together with call_control_id parameter or video_room_id parameter.
            Bridging with a queue means bridging with the first call in the
            queue.
          </p>
        </div>

        <div>
          <Label>Client State</Label>
          <Input
            type="text"
            value={clientState}
            onChange={(e) => {
              setClientState(e.target.value);
            }}
            placeholder="aGF2ZSBhIG5pY2UgZGF5ID1d"
            className="mt-1"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Base-64 encoded string to add state to every subsequent webhook
          </p>
        </div>

        <div>
          <Label>Command ID</Label>
          <Input
            type="text"
            value={commandId}
            onChange={(e) => {
              setCommandId(e.target.value);
            }}
            placeholder="891510ac-f3e4-11e8-af5b-de00688a4901"
            className="mt-1"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Use this field to avoid duplicate commands. Telnyx will ignore any
            command with the same command_id for the same call_control_id.
          </p>
        </div>
      </div>

      {/* Bridge Options - Collapsible */}
      <Collapsible
        open={bridgeOptionsExpanded}
        onOpenChange={setBridgeOptionsExpanded}
        className="border rounded-md"
      >
        <CollapsibleTrigger className="flex items-center justify-between w-full p-3 hover:bg-muted/50 transition-colors">
          <div className="flex items-center gap-2">
            <IconChevronRight
              className={`h-4 w-4 transition-transform ${
                bridgeOptionsExpanded ? "rotate-90" : ""
              }`}
            />
            <Label className="text-xs font-semibold cursor-pointer">
              Bridge Options
            </Label>
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="p-3 pt-0 space-y-3">
          <div>
            <Label>Park After Unbridge</Label>
            <Select
              value={parkAfterUnbridge}
              onValueChange={(value) => {
                setParkAfterUnbridge(value);
              }}
            >
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Select option" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="self">Self</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              Specifies behavior after the bridge ends. If supplied with the
              value 'self', the current leg will be parked after unbridge. If
              not set, the default behavior is to hang up the leg.
            </p>
          </div>

          <div className="flex items-center space-x-2">
            <Checkbox
              id="play_ringtone"
              checked={playRingtone}
              onCheckedChange={(checked) => {
                setPlayRingtone(checked);
              }}
            />
            <Label
              htmlFor="play_ringtone"
              className="text-sm font-normal cursor-pointer"
            >
              Play Ringtone
            </Label>
          </div>
          <p className="text-xs text-muted-foreground -mt-2">
            Specifies whether to play a ringtone if the call you want to
            bridge with has not yet been answered
          </p>

          {playRingtone && (
            <div>
              <Label>Ringtone</Label>
              <Select
                value={ringtone}
                onValueChange={(value) => {
                  setRingtone(value);
                }}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Select ringtone" />
                </SelectTrigger>
                <SelectContent>
                  {RINGTONE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                Specifies which country ringtone to play when play_ringtone is
                set to true. If not set, the US ringtone will be played.
              </p>
            </div>
          )}

          <div>
            <Label>Mute DTMF</Label>
            <Select
              value={muteDtmf}
              onValueChange={(value) => {
                setMuteDtmf(value);
              }}
            >
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Select option" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="both">Both</SelectItem>
                <SelectItem value="self">Self</SelectItem>
                <SelectItem value="opposite">Opposite</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              When enabled, DTMF tones are not passed to the call participant.
              The webhooks containing the DTMF information will be sent.
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Recording - Collapsible */}
      <Collapsible
        open={recordingExpanded}
        onOpenChange={setRecordingExpanded}
        className="border rounded-md"
      >
        <CollapsibleTrigger className="flex items-center justify-between w-full p-3 hover:bg-muted/50 transition-colors">
          <div className="flex items-center gap-2">
            <IconChevronRight
              className={`h-4 w-4 transition-transform ${
                recordingExpanded ? "rotate-90" : ""
              }`}
            />
            <Label className="text-xs font-semibold cursor-pointer">
              Recording
            </Label>
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="p-3 pt-0 space-y-3">
          <div>
            <Label>Record</Label>
            <Select
              value={record}
              onValueChange={(value) => {
                setRecord(value);
              }}
            >
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Select recording option" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="record-from-answer">
                  Record From Answer
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              Start recording automatically after an event. Disabled by default.
            </p>
          </div>

          {record && (
            <>
              <div>
                <Label>Record Channels</Label>
                <Select
                  value={recordChannels}
                  onValueChange={(value) => {
                    setRecordChannels(value);
                  }}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select channels" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="single">Single</SelectItem>
                    <SelectItem value="dual">Dual</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">
                  Defines which channel should be recorded ('single' or 'dual')
                  when record is specified.
                </p>
              </div>

              <div>
                <Label>Record Format</Label>
                <Select
                  value={recordFormat}
                  onValueChange={(value) => {
                    setRecordFormat(value);
                  }}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select format" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mp3">MP3</SelectItem>
                    <SelectItem value="wav">WAV</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">
                  Defines the format of the recording ('wav' or 'mp3') when
                  record is specified.
                </p>
              </div>

              <div>
                <Label>Record Max Length (seconds)</Label>
                <Input
                  type="number"
                  value={recordMaxLength}
                  onChange={(e) => {
                    setRecordMaxLength(e.target.value);
                  }}
                  placeholder="0 (infinite)"
                  min={0}
                  max={43200}
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Defines the maximum length for the recording in seconds when
                  record is specified. The minimum value is 0. The maximum value
                  is 43200. The default value is 0 (infinite).
                </p>
              </div>

              <div>
                <Label>Record Timeout (seconds)</Label>
                <Input
                  type="number"
                  value={recordTimeoutSecs}
                  onChange={(e) => {
                    setRecordTimeoutSecs(e.target.value);
                  }}
                  placeholder="0 (infinite)"
                  min={0}
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  The number of seconds that Telnyx will wait for the recording
                  to be stopped if silence is detected when record is specified.
                  The timer only starts when the speech is detected. Please note
                  that call transcription is used to detect silence and the
                  related charge will be applied. The minimum value is 0. The
                  default value is 0 (infinite).
                </p>
              </div>

              <div>
                <Label>Record Track</Label>
                <Select
                  value={recordTrack}
                  onValueChange={(value) => {
                    setRecordTrack(value);
                  }}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select track" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inbound">Inbound</SelectItem>
                    <SelectItem value="outbound">Outbound</SelectItem>
                    <SelectItem value="both">Both</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">
                  The audio track to be recorded. Can be either 'both', 'inbound'
                  or 'outbound'. If only single track is specified ('inbound',
                  'outbound'), 'channels' configuration is ignored and it will
                  be recorded as mono (single channel).
                </p>
              </div>

              <div>
                <Label>Record Trim</Label>
                <Select
                  value={recordTrim}
                  onValueChange={(value) => {
                    setRecordTrim(value);
                  }}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select option" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="trim-silence">Trim Silence</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">
                  When set to 'trim-silence', silence will be removed from the
                  beginning and end of the recording.
                </p>
              </div>

              <div>
                <Label>Record Custom File Name</Label>
                <Input
                  type="text"
                  value={recordCustomFileName}
                  onChange={(e) => {
                    setRecordCustomFileName(e.target.value);
                  }}
                  placeholder="my_recording_file_name"
                  maxLength={40}
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  The custom recording file name to be used instead of the
                  default call_leg_id. Telnyx will still add a Unix timestamp
                  suffix. Maximum 40 characters.
                </p>
              </div>
            </>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

