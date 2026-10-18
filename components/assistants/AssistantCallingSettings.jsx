"use client";
import { useUiText } from "@/components/i18n/use-ui-text";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import AssistantConfigurationCard from "./AssistantConfigurationCard";
import { NestedAssistantFields } from "./AssistantSettingsSection";

export default function AssistantCallingSettings({
  values,
  setValues,
  section = "all",
}) {
  const tUi = useUiText();
  const telephony = values.telephony || {};
  const recording = telephony.recording_settings || {};
  const action = telephony.voicemail_detection?.on_voicemail_detected || {};
  const voicemailEnabled = Boolean(
    action.action && action.action !== "continue_assistant",
  );
  const message = action.voicemail_message || { type: "message", message: "" };
  function update(patch) {
    setValues((v) => ({ ...v, telephony: { ...v.telephony, ...patch } }));
  }
  function updateRecording(patch) {
    update({ recording_settings: { ...recording, ...patch } });
  }
  function updateVoicemail(patch) {
    update({
      voicemail_detection: {
        ...telephony.voicemail_detection,
        on_voicemail_detected: { ...action, ...patch },
      },
    });
  }
  if (section === "behavior") return <div className="grid items-start gap-5 lg:grid-cols-2">
    <AssistantConfigurationCard title="Call timing" description="Set the maximum call length and how the assistant reacts to silence.">
      {[["time_limit_secs", "Maximum call duration", 30, 14400, "1800"], ["user_idle_timeout_secs", "End call after silence", 10, 14400, "60"], ["user_idle_reply_secs", "Prompt after silence", 0, undefined, "10"]].map(([key, label, min, max, placeholder]) => <div key={key} className="flex flex-wrap items-center justify-between gap-3" data-setting-path={`telephony_settings.${key}`}><Label htmlFor={`calling-${key}`}>{tUi(label)}</Label><div className="flex items-center gap-2"><Input id={`calling-${key}`} type="number" min={min} max={max} className="w-28" value={telephony[key] ?? ""} placeholder={placeholder} onChange={e => update({ [key]: e.target.value === "" ? undefined : Number(e.target.value) })} /><span className="text-xs text-muted-foreground">{tUi("seconds")}</span></div></div>)}
    </AssistantConfigurationCard>
    <AssistantConfigurationCard title="Routing & keypad" description="Choose where callers go if the assistant cannot continue."><NestedAssistantFields root="telephony_settings" alias="telephony" schemaName="TelephonySettings" fields={["fallback_destination", "disable_dtmf"]} values={values} setValues={setValues} /></AssistantConfigurationCard>
    <AssistantConfigurationCard title="Conversation events" description="Choose which conversation updates are sent to your application."><label className="flex items-center justify-between gap-4 text-sm" data-setting-path="telephony_settings.send_conversation_message_events">{tUi("Send conversation message events")}<Switch checked={telephony.send_conversation_message_events === true} onCheckedChange={checked => update({ send_conversation_message_events: checked })} /></label><NestedAssistantFields root="telephony_settings" alias="telephony" schemaName="TelephonySettings" fields={["send_message_history_updates", "conversation_ended_full_history"]} values={values} setValues={setValues} /></AssistantConfigurationCard>
  </div>;
  const title =
    section === "recording"
      ? "Recording"
      : section === "voicemail"
        ? "On Voicemail Detected"
        : "Call Settings";
  return (
    <Card className="w-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{tUi(title)}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6 pt-0">
        {section === "all" || section === "behavior" ? (
          <>
            <div
              className="flex items-start justify-between gap-4 rounded-lg border p-4"
              data-setting-path="telephony_settings.send_conversation_message_events"
            >
              <div className="space-y-1">
                <Label
                  htmlFor="send-conversation-message-events"
                  className="text-sm font-medium cursor-pointer"
                >
                  {tUi("Send conversation message events")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {tUi(
                    "Send conversation message events during assistant calls.",
                  )}
                </p>
              </div>
              <Switch
                id="send-conversation-message-events"
                checked={telephony.send_conversation_message_events === true}
                onCheckedChange={(checked) =>
                  update({ send_conversation_message_events: checked })
                }
              />
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {[
                ["time_limit_secs", "Max Call Duration", 30, 14400, "1800"],
                [
                  "user_idle_timeout_secs",
                  "User Idle Timeout",
                  10,
                  14400,
                  "60",
                ],
                ["user_idle_reply_secs", "User Idle Reply", 0, undefined, "10"],
              ].map(([key, label, min, max, placeholder]) => (
                <div
                  key={key}
                  className="space-y-1"
                  data-setting-path={`telephony_settings.${key}`}
                >
                  <Label
                    htmlFor={`calling-${key}`}
                    className="text-sm font-medium"
                  >
                    {tUi(label)}
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id={`calling-${key}`}
                      type="number"
                      min={min}
                      max={max}
                      className="w-32"
                      value={telephony[key] ?? ""}
                      placeholder={placeholder}
                      onChange={(e) =>
                        update({
                          [key]:
                            e.target.value === ""
                              ? undefined
                              : Number(e.target.value),
                        })
                      }
                    />
                    <span className="text-sm text-muted-foreground">
                      {tUi("seconds")}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <NestedAssistantFields
              root="telephony_settings"
              alias="telephony"
              schemaName="TelephonySettings"
              fields={[
                "fallback_destination",
                "send_message_history_updates",
                "conversation_ended_full_history",
                "disable_dtmf",
              ]}
              values={values}
              setValues={setValues}
            />
          </>
        ) : null}
        {section === "all" || section === "voicemail" ? (
          <div
            className="space-y-3"
            data-setting-path="telephony_settings.voicemail_detection"
          >
            <div className="flex items-center gap-2">
              <Switch
                id="voicemail-detection"
                checked={voicemailEnabled}
                onCheckedChange={(enabled) =>
                  updateVoicemail({
                    action: enabled ? "stop_assistant" : "continue_assistant",
                  })
                }
              />
              <Label
                htmlFor="voicemail-detection"
                className="text-sm font-medium cursor-pointer"
              >
                {tUi("Voicemail handling")}
              </Label>
            </div>
            <p className="text-xs text-muted-foreground">
              {tUi(
                "The switch controls the assistant's voicemail response. AMD is enabled on the outbound Dial request.",
              )}
            </p>
            {voicemailEnabled ? (
              <div className="ml-6 space-y-3 border-l pl-4">
                <div className="space-y-1">
                  <Label htmlFor="voicemail-action" className="text-xs">
                    {tUi("On Voicemail Detected")}
                  </Label>
                  <Select
                    value={action.action}
                    onValueChange={(next) =>
                      updateVoicemail({
                        action: next,
                        ...(next === "leave_message_and_stop_assistant"
                          ? { voicemail_message: message }
                          : {}),
                      })
                    }
                  >
                    <SelectTrigger
                      id="voicemail-action"
                      className="w-full md:w-64"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="stop_assistant">
                        {tUi("Stop")}
                      </SelectItem>
                      <SelectItem value="leave_message_and_stop_assistant">
                        {tUi("Leave Message")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {action.action === "leave_message_and_stop_assistant" ? (
                  <>
                    <Select
                      value={message.type || "message"}
                      onValueChange={(type) =>
                        updateVoicemail({
                          voicemail_message: {
                            ...message,
                            type,
                            [type]: message[type] || "",
                          },
                        })
                      }
                    >
                      <SelectTrigger aria-label={tUi("Type")}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="message">
                          {tUi("Message")}
                        </SelectItem>
                        <SelectItem value="prompt">{tUi("Prompt")}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Label htmlFor="voicemail-message">
                      {tUi("Voicemail Message")}
                    </Label>
                    <Textarea
                      id="voicemail-message"
                      rows={3}
                      value={message[message.type || "message"] || ""}
                      onChange={(e) =>
                        updateVoicemail({
                          voicemail_message: {
                            ...message,
                            [message.type || "message"]: e.target.value,
                          },
                        })
                      }
                      placeholder={tUi(
                        "The message the assistant will leave on the voicemail",
                      )}
                    />
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {section === "all" || section === "recording" ? (
          <div
            className="space-y-3"
            data-setting-path="telephony_settings.recording_settings"
          >
            <div className="flex items-center gap-2">
              <Switch
                id="call-recording"
                checked={
                  recording.enabled ??
                  Boolean(recording.format || recording.channels)
                }
                onCheckedChange={(enabled) =>
                  updateRecording({
                    enabled,
                    format: recording.format || "mp3",
                    channels: recording.channels || "dual",
                  })
                }
              />
              <Label
                htmlFor="call-recording"
                className="text-sm font-medium cursor-pointer"
              >
                {tUi("Enable Call Recording")}
              </Label>
            </div>
            {(recording.enabled ??
            Boolean(recording.format || recording.channels)) ? (
              <div className="ml-6 space-y-3 border-l pl-4">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {[
                    ["format", "Format", ["mp3", "wav"], "mp3"],
                    ["channels", "Channels", ["single", "dual"], "dual"],
                  ].map(([key, label, options, fallback]) => (
                    <div key={key} className="space-y-1">
                      <Label htmlFor={`recording-${key}`} className="text-xs">
                        {tUi(label)}
                      </Label>
                      <Select
                        value={recording[key] || fallback}
                        onValueChange={(value) =>
                          updateRecording({ [key]: value })
                        }
                      >
                        <SelectTrigger id={`recording-${key}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {options.map((value) => (
                            <SelectItem key={value} value={value}>
                              {key === "format"
                                ? value.toUpperCase()
                                : tUi(value === "dual" ? "Dual" : "Single")}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <Switch
                    id="recording-stop-on-conversation-end"
                    checked={recording.stop_on_conversation_end === true}
                    onCheckedChange={(value) =>
                      updateRecording({ stop_on_conversation_end: value })
                    }
                  />
                  <Label
                    htmlFor="recording-stop-on-conversation-end"
                    className="text-xs font-medium cursor-pointer"
                  >
                    {tUi("Stop recording when conversation ends")}
                  </Label>
                </div>
                <p className="text-xs text-muted-foreground">
                  {tUi(
                    "When enabled, recording stops when the assistant hangs up or the call is transferred. When disabled, recording continues until the call itself ends.",
                  )}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
