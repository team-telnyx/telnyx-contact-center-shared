"use client";

import { VariableTextarea } from "@/components/voice-flow/VariableTextarea";

export default function SkipTurnToolEditor({
  value,
  onChange,
  availableVariables = [],
}) {
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
        <label className="text-xs">Description</label>
        <VariableTextarea
          rows={3}
          value={st.description || ""}
          availableVariables={availableVariables}
          secrets={[]}
          onChange={(next) => update({ description: next })}
          placeholder="This tool is used to skip the assistant turn without producing a response."
        />
        <p className="text-xs text-muted-foreground mt-1">
          The description passed to the LLM to explain when this tool should be
          invoked. Type {"{{"} to insert a system or custom dynamic variable.
        </p>
      </div>
    </div>
  );
}
