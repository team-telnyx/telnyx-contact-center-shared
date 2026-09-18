"use client";
import { useState } from "react";
import { Eye } from "lucide-react";
import { interactionCapabilities } from "@/lib/acd/interaction-channels.mjs";
import ConversationPreview from "./ConversationPreview";
import { SupervisionModal } from "./SupervisionModal";
import VideoSupervisionModal from "./VideoSupervisionModal";
import LiveInteractionDetails from "./LiveInteractionDetails";
export default function InteractionPreviewAction({ interaction }) {
  const [open, setOpen] = useState(false),
    capabilities =
      interaction.capabilities || interactionCapabilities(interaction);
  const video = (interaction.channel || interaction.interaction_type) === "video";
  const label = capabilities.conversation
    ? "Preview conversation"
    : capabilities.supervision ? (video ? "Supervise video call" : "Supervise voice call") : "Preview interaction";
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={label}
        aria-label={label}
        data-testid={
          capabilities.conversation ? "preview-conversation" : capabilities.supervision ? "supervise-call" : "preview-interaction"
        }
        data-interaction-id={interaction.workItemId || interaction.id}
        className="rounded-lg p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-ring"
      >
        <Eye className="size-4" />
      </button>
      {capabilities.conversation ? (
        <ConversationPreview
          open={open}
          onOpenChange={setOpen}
          interaction={interaction}
        />
      ) : capabilities.supervision && video ? (
        open && <VideoSupervisionModal open={open} onOpenChange={setOpen} interaction={interaction} />
      ) : capabilities.supervision ? (
        <SupervisionModal
          open={open}
          onOpenChange={setOpen}
          call={interaction}
        />
      ) : (
        <LiveInteractionDetails open={open} onOpenChange={setOpen} interaction={interaction} />
      )}
    </>
  );
}
