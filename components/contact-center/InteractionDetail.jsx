"use client";

import { AgentAssist } from "./AgentAssist";

export function InteractionDetail({ interaction }) {
  if (!interaction) {
    return (
      <div className="flex items-center justify-center flex-1 text-muted-foreground">
        <p>Select an interaction to view details</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <AgentAssist interactionId={interaction.id} interaction={interaction} />
    </div>
  );
}

