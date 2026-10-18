"use client";
import AssistantSchemaFields from "./AssistantSchemaFields";
import {
  assistantSchemas,
  resolveAssistantSchema,
} from "@/lib/ai/assistant-contract.mjs";
const toolSchemas = {
  webhook: "WebhookTool",
  transfer: "TransferTool",
  retrieval: "RetrievalTool",
  handoff: "HandoffTool",
  refer: "SIPReferTool",
  send_dtmf: "DTMFTool",
  send_message: "SendMessageTool",
  invite: "InviteTool",
  hangup: "HangupTool",
  skip_turn: "SkipTurnTool",
  client_side_tool: "ClientSideTool",
};
const additionalFields = {
  webhook: ["preset_body_fields", "preset_query_params", "async_timeout_ms"],
  transfer: [
    "diversion",
    "description",
    "warm_transfer_acceptance",
    "warm_message_delay_ms",
    "voicemail_detection",
  ],
  send_message: ["message_template"],
};
export default function AssistantToolAdditionalSettings({
  type,
  tool,
  onChange,
}) {
  const schema = assistantSchemas[toolSchemas[type]];
  const fields = additionalFields[type] || [];
  if (!schema || !fields.length) return null;
  const params = resolveAssistantSchema(schema.properties[type]);
  return (
    <div className="space-y-4 border-t pt-4">
      {fields.length ? (
        <AssistantSchemaFields
          fields={fields}
          schemas={params.properties}
          pathPrefix={type}
          values={tool[type] || {}}
          setValues={(update) =>
            onChange({ ...tool, [type]: update(tool[type] || {}) })
          }
        />
      ) : null}
    </div>
  );
}
