"use client";
import { useUiText } from "@/components/i18n/use-ui-text";


import { VariableTextarea } from "@/components/voice-flow/VariableTextarea";

export default function SkipTurnToolEditor({
  value,
  onChange,
  availableVariables = [],
}) {
  const tUi = useUiText();
  const st = value?.skip_turn || {};
  function update(partial) {
    onChange?.({
      ...(value || { type: "skip_turn" }),
      skip_turn: { ...(value?.skip_turn || {}), ...partial },
    });
  }
  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs">{tUi("Description")}</label>
        <VariableTextarea
          rows={3}
          value={st.description || ""}
          availableVariables={availableVariables}
          secrets={[]}
          onChange={(next) => update({ description: next })}
          placeholder={tUi("This tool is used to skip the assistant turn without producing a response.")}
        />
        <p className="text-xs text-muted-foreground mt-1">{tUi("The description passed to the LLM to explain when this tool should be invoked. Type ")}{"{{"}{tUi(" to insert a system or custom dynamic variable.")}</p>
      </div>
    </div>
  );
}
