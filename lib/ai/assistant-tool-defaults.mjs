import { assistantSchemas, initialSchemaValue } from "./assistant-contract.mjs";

export function createDefaultTool(type) {
  const schemaName = {function:"FunctionTool",pay:"PayTool",update_dynamic_variables:"UpdateDynamicVariablesTool"}[type];
  if (schemaName) return initialSchemaValue(assistantSchemas[schemaName]);
  switch (type) {
    case "vision": return {type:"vision",vision:{max_frame_age_secs:10}};
    case "webhook":
      return {
        type: "webhook",
        webhook: {
          name: "custom_webhook",
          description: "A custom webhook tool for external API calls",
          url: "https://api.example.com/endpoint",
          method: "POST",
          timeout_secs: 30,
          headers: [
            {
              name: "Content-Type",
              value: "application/json",
            },
          ],
          path_parameters: {
            type: "object",
            properties: {},
            required: [],
          },
          query_parameters: {
            type: "object",
            properties: {},
            required: [],
          },
          body_parameters: {
            type: "object",
            properties: {},
            required: [],
          },
        },
      };
    case "handoff":
      return {
        type: "handoff",
        handoff: {
          voice_mode: "unified",
          ai_assistants: [],
        },
      };
    case "retrieval":
      return {
        type: "retrieval",
        retrieval: { bucket_ids: [], max_num_results: 3 },
      };
    case "transfer":
      return {
        type: "transfer",
        transfer: {
          from: "",
          targets: [],
          sip_headers: [],
          custom_headers: [],
        },
      };
    case "refer":
      return {
        type: "refer",
        refer: {
          targets: [],
          sip_headers: [],
          custom_headers: [],
        },
      };
    case "send_dtmf":
      return { type: "send_dtmf", send_dtmf: {} };
    case "hangup":
      return {
        type: "hangup",
        hangup: { description: "This tool is used to hang up the call." },
      };
    case "send_message":
      return {
        type: "send_message",
        send_message: {
          name: "send_message",
          description: "",
        },
      };
    case "whatsapp_template":
      return {
        type: "whatsapp_template",
        display_name: "WhatsApp Templates",
        whatsapp_template: {
          templates: [
            {
              name: "",
              template_name: "",
              template_id: "",
              language: "",
              description: "",
              variables: [],
            },
          ],
        },
        timeout_ms: 5000,
      };
    case "client_side_tool":
      return {
        type: "client_side_tool",
        display_name: "",
        client_side_tool: {
          name: "",
          description: "",
          parameters: {
            type: "object",
            properties: {},
            required: [],
          },
        },
        timeout_ms: 5000,
      };
    case "invite":
      return {
        type: "invite",
        invite: {
          from: "",
          targets: [],
          custom_headers: [],
          voicemail_detection: {
            detection_mode: "disabled",
          },
        },
      };
    case "skip_turn":
      return {
        type: "skip_turn",
        skip_turn: {
          description:
            "This tool is used to skip the assistant turn without producing a response.",
        },
      };
    default:
      return null;
  }
}
