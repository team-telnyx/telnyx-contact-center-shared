"use client";

import { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  IconArrowsLeftRight,
  IconDatabaseSearch,
  IconDialpad,
  IconFlask,
  IconMessage,
  IconPhoneIncoming,
  IconPhoneX,
  IconPlayerSkipForward,
  IconShare2,
  IconUsers,
  IconWebhook,
} from "@tabler/icons-react";
import { ASSISTANT_TOOL_TYPES } from "@/config/assistant-tools";
import WebhookTestSheet from "@/components/assistants/tools/WebhookTestSheet";
import WebhookToolEditor from "@/components/assistants/tools/WebhookToolEditor";
import HangupToolEditor from "@/components/assistants/tools/HangupToolEditor";
import TransferToolEditor from "@/components/assistants/tools/TransferToolEditor";
import HandoffToolEditor from "@/components/assistants/tools/HandoffToolEditor";
import SendMessageToolEditor from "@/components/assistants/tools/SendMessageToolEditor";
import InviteToolEditor from "@/components/assistants/tools/InviteToolEditor";
import ReferToolEditor from "@/components/assistants/tools/ReferToolEditor";
import DTMFToolEditor from "@/components/assistants/tools/DTMFToolEditor";
import RetrievalToolEditor from "@/components/assistants/tools/RetrievalToolEditor";
import SkipTurnToolEditor from "@/components/assistants/tools/SkipTurnToolEditor";

export function labelForAssistantToolType(type) {
  return ASSISTANT_TOOL_TYPES.find((t) => t.type === type)?.label || type;
}

export function descriptionForAssistantToolType(type) {
  switch (type) {
    case "webhook":
      return "Call external API endpoints with optional parameters";
    case "retrieval":
      return "Search knowledge bases for relevant context";
    case "handoff":
      return "Hand off the conversation to another assistant";
    case "transfer":
      return "Transfer the call to a destination";
    case "refer":
      return "Send a SIP REFER to a target SIP address";
    case "send_dtmf":
      return "Send DTMF digits on the call";
    case "hangup":
      return "Hang up the call";
    case "send_message":
      return "Send an SMS message to the caller";
    case "invite":
      return "Invite a third party to join the active call";
    case "skip_turn":
      return "Skip the assistant's turn to allow the user to speak";
    default:
      return "";
  }
}

export function renderAssistantToolIcon(type, className = "size-4") {
  switch (type) {
    case "webhook":
      return <IconWebhook className={`${className} text-orange-500`} />;
    case "handoff":
      return <IconUsers className={`${className} text-blue-500`} />;
    case "transfer":
      return <IconArrowsLeftRight className={`${className} text-purple-500`} />;
    case "refer":
      return <IconShare2 className={`${className} text-cyan-500`} />;
    case "send_dtmf":
      return <IconDialpad className={`${className} text-emerald-500`} />;
    case "hangup":
      return <IconPhoneX className={`${className} text-red-500`} />;
    case "retrieval":
      return <IconDatabaseSearch className={`${className} text-amber-500`} />;
    case "send_message":
      return <IconMessage className={`${className} text-green-500`} />;
    case "invite":
      return <IconPhoneIncoming className={`${className} text-indigo-500`} />;
    case "skip_turn":
      return <IconPlayerSkipForward className={`${className} text-gray-500`} />;
    default:
      return null;
  }
}

export function getAssistantToolDisplay(tool) {
  const type = tool?.type || "";
  const name =
    type === "webhook"
      ? tool?.webhook?.name || tool?.display_name || ""
      : tool?.display_name || labelForAssistantToolType(type);

  let description = "";
  if (type === "webhook") {
    description = tool?.webhook?.description || "";
  } else if (type === "hangup") {
    description =
      tool?.hangup?.description ||
      tool?.hangup?.intent_message ||
      descriptionForAssistantToolType(type);
  } else {
    description = descriptionForAssistantToolType(type);
  }

  return {
    type,
    name,
    label: labelForAssistantToolType(type),
    description,
  };
}

export function renderAssistantToolEditor(
  type,
  tool,
  onChange,
  assistantId,
  availableVariables = []
) {
  switch (type) {
    case "webhook":
      return (
        <WebhookToolEditor
          value={tool}
          onChange={onChange}
          assistantId={assistantId}
          toolId={tool?.tool_id}
          availableVariables={availableVariables}
        />
      );
    case "retrieval":
      return <RetrievalToolEditor value={tool} onChange={onChange} />;
    case "handoff":
      return <HandoffToolEditor value={tool} onChange={onChange} />;
    case "transfer":
      return (
        <TransferToolEditor
          value={tool}
          onChange={onChange}
          availableVariables={availableVariables}
        />
      );
    case "refer":
      return (
        <ReferToolEditor
          value={tool}
          onChange={onChange}
          availableVariables={availableVariables}
        />
      );
    case "send_dtmf":
      return <DTMFToolEditor value={tool} onChange={onChange} />;
    case "hangup":
      return (
        <HangupToolEditor
          value={tool}
          onChange={onChange}
          availableVariables={availableVariables}
        />
      );
    case "send_message":
      return (
        <SendMessageToolEditor
          value={tool}
          onChange={onChange}
          availableVariables={availableVariables}
        />
      );
    case "invite":
      return (
        <InviteToolEditor
          value={tool}
          onChange={onChange}
          availableVariables={availableVariables}
        />
      );
    case "skip_turn":
      return (
        <SkipTurnToolEditor
          value={tool}
          onChange={onChange}
          availableVariables={availableVariables}
        />
      );
    default:
      return (
        <div className="text-xs text-muted-foreground">
          Unsupported tool type
        </div>
      );
  }
}

export default function AssistantToolEditSheet({
  open,
  onOpenChange,
  tool,
  onSave,
  assistantId,
  availableVariables = [],
  showTrigger,
  trigger,
}) {
  const [draft, setDraft] = useState(tool);
  const [testOpen, setTestOpen] = useState(false);
  const type = tool?.type || "";
  const label = labelForAssistantToolType(type);
  const canShowTestIcon = type === "webhook" && assistantId && tool?.tool_id;
  const testWebhookConfig = open ? draft?.webhook : tool?.webhook;

  useEffect(() => {
    if (open) setDraft(tool);
  }, [open, tool]);

  function handleOpenChange(nextOpen) {
    onOpenChange(nextOpen);
  }

  return (
    <>
      <Sheet open={open} onOpenChange={handleOpenChange}>
        {showTrigger && trigger}
        <SheetContent className="w-[90vw] sm:w-[800px] h-full flex flex-col overflow-hidden">
          <SheetHeader>
            <SheetTitle className="inline-flex items-center gap-2">
              {renderAssistantToolIcon(type)}
              Edit {label}
            </SheetTitle>
            <SheetDescription>
              Configure the {label.toLowerCase()} tool settings
            </SheetDescription>
          </SheetHeader>

          <div className="mt-6 flex flex-col flex-1 min-h-0">
            <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
              <Card className="p-6 mx-4 flex-1 min-h-0 overflow-visible">
                {renderAssistantToolEditor(
                  type,
                  draft,
                  setDraft,
                  assistantId,
                  availableVariables
                )}
              </Card>
            </div>

            <div className="flex items-center gap-2 pt-4 border-t mt-4 mx-4 mb-4">
              {canShowTestIcon && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setTestOpen(true)}
                >
                  <IconFlask className="size-4 mr-2" />
                  Test
                </Button>
              )}
              <div className="flex gap-2 ml-auto">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    onOpenChange(false);
                    setDraft(tool);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={() => {
                    onSave(draft);
                    onOpenChange(false);
                  }}
                >
                  Save
                </Button>
              </div>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {type === "webhook" && (
        <WebhookTestSheet
          open={testOpen}
          onOpenChange={setTestOpen}
          webhookConfig={testWebhookConfig}
          assistantId={assistantId}
          toolId={tool?.tool_id || `tool-${crypto.randomUUID()}`}
        />
      )}
    </>
  );
}

export function AssistantToolEditIconButton({ onClick }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className="inline-flex items-center text-telnyx-green"
            aria-label="Edit tool"
            onClick={onClick}
            type="button"
          >
            Edit
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <p>Edit tool</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
