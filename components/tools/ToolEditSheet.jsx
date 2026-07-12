"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import {
  IconTools,
  IconWebhook,
  IconPhoneX,
  IconArrowsLeftRight,
  IconShare2,
  IconMessage,
  IconLoader2,
  IconPhoneIncoming,
  IconDialpad,
  IconDatabaseSearch,
  IconPlayerSkipForward,
  IconFlask,
} from "@tabler/icons-react";
import { toast } from "@/lib/toast";
import WebhookTestSheet from "@/components/assistants/tools/WebhookTestSheet";

// Reuse the EXACT same tool editors from the AI Assistants Integrations tab
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
// ============================================================
// Tool type definitions (all 10 supported types)
// ============================================================
const TOOL_TYPES = [
  {
    value: "webhook",
    label: "Webhook",
    description: "Call an external HTTP endpoint",
    icon: IconWebhook,
    color: "text-blue-500",
  },
  {
    value: "hangup",
    label: "Hangup",
    description: "End the call",
    icon: IconPhoneX,
    color: "text-red-500",
  },
  {
    value: "transfer",
    label: "Transfer",
    description: "Transfer call to a phone number or SIP URI",
    icon: IconArrowsLeftRight,
    color: "text-orange-500",
  },
  {
    value: "handoff",
    label: "Handoff",
    description: "Hand off to another AI assistant",
    icon: IconShare2,
    color: "text-purple-500",
  },
  {
    value: "send_message",
    label: "Send Message",
    description: "Send SMS/MMS to the caller",
    icon: IconMessage,
    color: "text-green-500",
  },
  {
    value: "invite",
    label: "Invite",
    description: "Invite a third party into the call",
    icon: IconPhoneIncoming,
    color: "text-cyan-500",
  },
  {
    value: "refer",
    label: "SIP Refer",
    description: "Transfer via SIP REFER",
    icon: IconArrowsLeftRight,
    color: "text-amber-500",
  },
  {
    value: "send_dtmf",
    label: "Send DTMF",
    description: "Send DTMF tones",
    icon: IconDialpad,
    color: "text-indigo-500",
  },
  {
    value: "retrieval",
    label: "Retrieval",
    description: "Search knowledge base",
    icon: IconDatabaseSearch,
    color: "text-telnyx-green",
  },
  {
    value: "skip_turn",
    label: "Skip Turn",
    description: "Skip assistant's turn silently",
    icon: IconPlayerSkipForward,
    color: "text-slate-500",
  },
];

// ============================================================
// Map API response shape → form state
// Telnyx GET returns { type, display_name, tool_definition: {...} }
// but also may return { type, display_name, [type_key]: {...} }
// ============================================================
function apiToFormState(tool) {
  if (!tool) {
    return {
      type: "webhook",
      display_name: "",
      webhook: { name: "", description: "", url: "", method: "POST" },
    };
  }

  const type = tool.type || "webhook";
  const display_name = tool.display_name || tool.name || "";

  // Helper: get the type-specific data.
  // Telnyx returns it as tool_definition OR under the type key directly.
  function getTypeData(key) {
    return tool[key] || tool.tool_definition || {};
  }

  return {
    type,
    display_name,
    _originalTypeData: getTypeData(type),
    async: tool.async,
    warm_transfer_instructions: tool.warm_transfer_instructions,
    webhook: type === "webhook" ? getTypeData("webhook") : {},
    hangup: type === "hangup" ? getTypeData("hangup") : {},
    transfer: type === "transfer" ? getTypeData("transfer") : { targets: [] },
    handoff: type === "handoff" ? getTypeData("handoff") : { ai_assistants: [] },
    send_message: type === "send_message" ? getTypeData("send_message") : {},
    invite: type === "invite" ? getTypeData("invite") : { targets: [] },
    refer: type === "refer" ? getTypeData("refer") : { targets: [] },
    send_dtmf: type === "send_dtmf" ? getTypeData("send_dtmf") : {},
    retrieval: type === "retrieval" ? getTypeData("retrieval") : { bucket_ids: [] },
    skip_turn: type === "skip_turn" ? getTypeData("skip_turn") : {},
  };
}

// ============================================================
// Build POST/PATCH payload from form state
// ============================================================
function buildPayload(formData) {
  const { type, display_name } = formData;
  const payload = { type, display_name };

  switch (type) {
    case "webhook": {
      const wh = { ...(formData.webhook || {}) };
      if (wh.timeout_secs !== undefined) {
        const timeoutSecs = Number(wh.timeout_secs);
        if (Number.isFinite(timeoutSecs) && timeoutSecs > 0) {
          wh.timeout_ms = Math.round(timeoutSecs * 1000);
        }
        delete wh.timeout_secs;
      }
      if (!wh.timeout_ms) delete wh.timeout_ms;
      if (!wh.headers?.length) delete wh.headers;
      if (!Object.keys(wh.path_parameters?.properties || {}).length) delete wh.path_parameters;
      if (!Object.keys(wh.query_parameters?.properties || {}).length) delete wh.query_parameters;
      if (!Object.keys(wh.body_parameters?.properties || {}).length) delete wh.body_parameters;
      if (formData.async !== undefined) wh.async = Boolean(formData.async);
      payload.webhook = wh;
      break;
    }
    case "hangup":
      payload.hangup = formData.hangup || {};
      break;
    case "transfer":
      payload.transfer = formData.transfer || {};
      if (formData.warm_transfer_instructions) {
        payload.warm_transfer_instructions = formData.warm_transfer_instructions;
      }
      break;
    case "handoff":
      payload.handoff = formData.handoff || {};
      break;
    case "send_message":
      payload.send_message = formData.send_message || {};
      break;
    case "invite":
      payload.invite = formData.invite || {};
      break;
    case "refer":
      payload.refer = formData.refer || {};
      break;
    case "send_dtmf":
      payload.send_dtmf = formData.send_dtmf || {};
      break;
    case "retrieval":
      payload.retrieval = formData.retrieval || {};
      break;
    case "skip_turn":
      payload.skip_turn = formData.skip_turn || {};
      break;
    default:
      if (formData._originalTypeData && Object.keys(formData._originalTypeData).length) {
        payload[type] = formData._originalTypeData;
      }
      break;
  }

  return payload;
}

// ============================================================
// Type-specific editor renderer
// Adapts the formData <-> each editor's value/onChange API
// ============================================================
function ToolTypeEditor({ type, formData, setFormData }) {
  // Each editor expects: value = full tool object (with type key + nested data)
  // onChange receives the same shape back
  const value = { type, ...formData };

  function onChange(next) {
    setFormData((prev) => ({ ...prev, ...next }));
  }

  switch (type) {
    case "webhook":
      return (
        <WebhookToolEditor
          value={value}
          onChange={onChange}
          availableVariables={[]}
        />
      );

    case "hangup":
      return (
        <HangupToolEditor
          value={value}
          onChange={onChange}
          availableVariables={[]}
        />
      );

    case "transfer":
      return (
        <TransferToolEditor
          value={value}
          onChange={onChange}
          availableVariables={[]}
        />
      );

    case "handoff":
      return (
        <HandoffToolEditor
          value={value}
          onChange={onChange}
        />
      );

    case "send_message":
      return (
        <SendMessageToolEditor
          value={value}
          onChange={onChange}
          availableVariables={[]}
        />
      );

    case "invite":
      return (
        <InviteToolEditor
          value={value}
          onChange={onChange}
          availableVariables={[]}
        />
      );

    case "refer":
      return (
        <ReferToolEditor
          value={value}
          onChange={onChange}
          availableVariables={[]}
        />
      );

    case "send_dtmf":
      return (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Send DTMF tones during the call. No additional configuration required —
            the AI assistant will determine the appropriate DTMF sequence based on the
            conversation context.
          </p>
          <DTMFToolEditor value={value} onChange={onChange} />
        </div>
      );

    case "retrieval":
      return (
        <RetrievalToolEditor
          value={value}
          onChange={onChange}
        />
      );

    case "skip_turn":
      return (
        <SkipTurnToolEditor
          value={value}
          onChange={onChange}
          availableVariables={[]}
        />
      );

    default:
      return (
        <p className="text-xs text-muted-foreground">
          Unknown tool type: {type}
        </p>
      );
  }
}

// ============================================================
// Main ToolEditSheet component
// ============================================================
export default function ToolEditSheet({ open, onOpenChange, tool, onSaved }) {
  const isEditing = !!tool?.id;
  const [formData, setFormData] = useState({});
  const [saving, setSaving] = useState(false);
  const [testOpen, setTestOpen] = useState(false);

  // Initialize form when sheet opens
  useEffect(() => {
    if (open) {
      setFormData(apiToFormState(tool));
    }
  }, [open, tool]);

  const handleTypeChange = useCallback((newType) => {
    setFormData((prev) => ({
      ...prev,
      type: newType,
    }));
  }, []);

  async function handleSave() {
    setSaving(true);
    try {
      const payload = buildPayload(formData);

      const url = isEditing
        ? `/api/ai/tools/${encodeURIComponent(tool.id)}`
        : "/api/ai/tools";
      const method = isEditing ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false)
        throw new Error(data?.error || "Save failed");

      toast.success(isEditing ? "Tool updated" : "Tool created");
      onSaved?.();
    } catch (err) {
      console.error(err);
      toast.error("Failed to save tool", { description: err?.message });
    } finally {
      setSaving(false);
    }
  }

  const type = formData.type || "webhook";
  const typeDef = TOOL_TYPES.find((t) => t.value === type);
  const TypeIcon = typeDef?.icon || IconTools;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[90vw] sm:w-[800px] h-full flex flex-col overflow-hidden p-0">
        {/* Header */}
        <div className="px-6 pt-4 pb-3 border-b shrink-0">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <TypeIcon className={`size-5 ${typeDef?.color || "text-telnyx-green"}`} />
              {isEditing ? "Edit Tool" : "New Tool"}
            </SheetTitle>
            <SheetDescription>
              {isEditing
                ? `Editing: ${tool?.display_name || tool?.name || tool?.id}`
                : "Create a new reusable tool for AI Assistants"}
            </SheetDescription>
          </SheetHeader>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="flex flex-col gap-3 p-4">
            {/* Display Name */}
            <Card className="p-4">
              <Label className="text-xs text-muted-foreground uppercase tracking-wide mb-1 block">Display Name</Label>
              <Input
                value={formData.display_name || ""}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, display_name: e.target.value }))
                }
                placeholder="My Tool"
              />
            </Card>

            {/* Tool Type Selector — only when creating new tool */}
            {!isEditing && (
              <Card className="p-4">
                <Label className="text-xs text-muted-foreground uppercase tracking-wide mb-1 block">Tool Type</Label>
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                  {TOOL_TYPES.map(({ value, label, description, icon: Icon, color }) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => handleTypeChange(value)}
                      className={`flex flex-col items-center gap-1 p-3 rounded-md border text-xs transition-colors text-center ${
                        type === value
                          ? "border-telnyx-green bg-telnyx-green/10 text-telnyx-green"
                          : "border-border hover:border-telnyx-green/50 text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Icon className={`size-5 ${type === value ? "text-telnyx-green" : color}`} />
                      <span className="font-medium leading-tight">{label}</span>
                      <span className="text-[10px] leading-tight opacity-70 hidden sm:block">
                        {description}
                      </span>
                    </button>
                  ))}
                </div>
              </Card>
            )}

            {/* Type-specific editor — wrapped in dark card */}
            <Card className="p-4">
              <Label className="text-xs text-muted-foreground uppercase tracking-wide mb-1 block">Configuration</Label>
              <ToolTypeEditor
                type={type}
                formData={formData}
                setFormData={setFormData}
              />
            </Card>
          </div>
        </div>

        {/* Test sheet — for webhook tools in edit mode */}
        {isEditing && (
          <WebhookTestSheet
            open={testOpen}
            onOpenChange={setTestOpen}
            webhookConfig={tool?.webhook || tool?.tool_definition}
            standaloneToolId={tool?.id}
          />
        )}

        {/* Sticky footer */}
        <div className="flex items-center gap-2 border-t px-6 py-4 shrink-0">
          {isEditing && type === "webhook" && (
            <Button
              variant="outline"
              onClick={() => setTestOpen(true)}
              disabled={saving}
            >
              <IconFlask className="size-4 mr-2" />
              Test
            </Button>
          )}
          <div className="flex gap-2 ml-auto">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <>
                <IconLoader2 className="size-4 mr-2 animate-spin" />
                Saving…
              </>
            ) : isEditing ? (
              "Save Changes"
            ) : (
              "Create Tool"
            )}
          </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
