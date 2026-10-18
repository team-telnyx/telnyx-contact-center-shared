"use client";
import { useUiText } from "@/components/i18n/use-ui-text";


import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { VariableTextarea } from "@/components/voice-flow/VariableTextarea";

export default function SendMessageToolEditor({
  value,
  onChange,
  availableVariables = [],
}) {
  const tUi = useUiText();
  const sm = value?.send_message || {};
  const name = sm?.name || "";
  const description = sm?.description || "";

  function update(partial) {
    onChange?.({
      ...(value || { type: "send_message" }),
      send_message: { ...(value?.send_message || {}), ...partial },
    });
  }

  return (
    <div className="space-y-3">
      <div>
        <Label className="text-xs">{tUi("Tool Name")}</Label>
        <Input
          value={name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder={tUi("send_sms")}
        />
      </div>
      <div>
        <Label className="text-xs">{tUi("Description")}</Label>
        <VariableTextarea
          value={description}
          availableVariables={availableVariables}
          secrets={[]}
          onChange={(next) => update({ description: next })}
          placeholder={tUi("Send an SMS message to the caller during the conversation")}
          rows={3}
        />
        <p className="text-xs text-muted-foreground mt-1">{tUi("Describe when the assistant should send an SMS (e.g. to send confirmation, follow-up info, or links).")}</p>
      </div>
    </div>
  );
}
