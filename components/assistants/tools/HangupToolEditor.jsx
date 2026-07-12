"use client";

import { VariableTextarea } from "@/components/voice-flow/VariableTextarea";

export default function HangupToolEditor({
  value,
  onChange,
  availableVariables = [],
}) {
  const hp = value?.hangup || {};
  function update(partial) {
    onChange?.({
      ...(value || { type: "hangup" }),
      hangup: { ...(value?.hangup || {}), ...partial },
    });
  }
  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs">Description (optional)</label>
        <VariableTextarea
          rows={2}
          value={hp.description || ""}
          availableVariables={availableVariables}
          secrets={[]}
          onChange={(next) => update({ description: next })}
        />
      </div>
      <div>
        <label className="text-xs">Hangup Message (optional)</label>
        <VariableTextarea
          rows={2}
          placeholder="e.g., Thank you for your call! Goodbye!"
          value={hp.intent_message || ""}
          availableVariables={availableVariables}
          secrets={[]}
          onChange={(next) => update({ intent_message: next })}
        />
        <p className="text-xs text-muted-foreground mt-1">
          The message that will be spoken to the user before hanging up the
          call.
        </p>
      </div>
    </div>
  );
}
