import { VOICE_FLOW_NODES } from "@/config/voice-flow-nodes";
import { getEntitySchema } from "@/lib/data-sources-schema.js";
import { getWebhookSchema } from "@/config/webhook-schemas";
import {
  DEFAULT_FORM_SUBMIT_PAYLOAD_VARIABLE,
  DEFAULT_HTTP_REQUEST_PAYLOAD_VARIABLE,
  DEFAULT_INCOMING_CALL_PAYLOAD_VARIABLE,
} from "@/lib/variable-utils";

const WEBHOOK_OPTION_NODE_TYPES = new Set([
  "incoming_call",
  "answer",
  "dial",
  "bridge",
  "gather",
  "gather_speak",
  "playback_start",
  "recording_start",
  "transcription_start",
  "streaming_start",
  "outbound_campaign",
]);

export function buildExpressionTestPayloadOptions({ nodes = [], edges = [] } = {}) {
  const options = [];
  const seen = new Set();

  const addOption = (option) => {
    if (!option?.payload || !option?.id) return;
    const key = `${option.id}:${JSON.stringify(option.payload)}`;
    if (seen.has(key)) return;
    seen.add(key);
    options.push(option);
  };

  nodes.forEach((node) => {
    const nodeType = node?.data?.nodeType;
    const config = node?.data?.config || {};
    const nodeLabel = node?.data?.label || getNodeDisplayName(nodeType) || "Node";

    if (nodeType === "http_request_action") {
      const responseVariable = config.responseVariable || "http_response";
      const responsePayload = getStoredResponseBody(config.testResponse);
      if (responsePayload !== undefined) {
        addOption({
          id: `${node.id}:http-response`,
          group: "HTTP Request responses",
          label: `${nodeLabel} → ${responseVariable}`,
          description: "Saved response from Test Request",
          payload: {
            [responseVariable]: responsePayload,
            http_status: config.testResponse?.status ?? config.testResponse?.response?.status ?? 200,
          },
        });
      }
    }

    if (nodeType === "data_action") {
      const responseVariable = config.responseVariable || "data_response";
      const responsePayload = getStoredResponseBody(config.testResponse);
      addOption({
        id: `${node.id}:data-action-response`,
        group: "Data Action responses",
        label: `${nodeLabel} → ${responseVariable}`,
        description: responsePayload !== undefined
          ? "Saved response from Test Data Action"
          : "Generated example from Data Action schema",
        payload: {
          [responseVariable]: responsePayload !== undefined
            ? responsePayload
            : buildDataActionExample(config.dataSource, config.action),
          [`${responseVariable}_status`]: config.testResponse?.status ?? config.testResponse?.response?.status ?? 200,
        },
      });
    }

    if (nodeType === "http_request") {
      edges
        .filter((edge) => edge?.source === node.id && edge?.data?.samplePayload)
        .forEach((edge, index) => {
          const parsed = parseJson(edge.data.samplePayload);
          if (parsed === undefined) return;
          const payloadVariable =
            config.payloadVariable ||
            config.payloadVariableName ||
            DEFAULT_HTTP_REQUEST_PAYLOAD_VARIABLE;
          const httpMethod = config.http_method || "POST";
          const rootPath = httpMethod === "GET" ? "query" : "payload";
          addOption({
            id: `${node.id}:${edge.id || index}:http-request-payload`,
            group: "HTTP Request payloads",
            label: `${nodeLabel} ${rootPath} → ${payloadVariable}`,
            description: "Saved request sample from edge mapping",
            payload: {
              [payloadVariable]: parsed,
              [rootPath]: parsed,
              trigger_type: nodeType,
            },
          });
        });
    }

    if (nodeType === "form_submit") {
      const payloadVariable =
        config.payloadVariable ||
        config.payloadVariableName ||
        DEFAULT_FORM_SUBMIT_PAYLOAD_VARIABLE;
      addOption({
        id: `${node.id}:form-submit-payload`,
        group: "Webhook payloads",
        label: `${nodeLabel} → ${payloadVariable}`,
        description: "Generated form submit payload example",
        payload: {
          [payloadVariable]: {
            form_id: "example-form-id",
            submission_id: "example-submission-id",
            fields: {},
            submitted_at: new Date(0).toISOString(),
          },
          trigger_type: nodeType,
        },
      });
    }

    if (WEBHOOK_OPTION_NODE_TYPES.has(nodeType)) {
      getNodeWebhookEvents(node, edges).forEach((eventType) => {
        const webhookPayload = buildWebhookPayload(eventType);
        if (!webhookPayload) return;
        const runtimePayload = buildWebhookRuntimeVariables({
          eventType,
          payload: webhookPayload.payload,
          node,
        });
        addOption({
          id: `${node.id}:${eventType}:webhook-payload`,
          group: "Webhook payloads",
          label: `${nodeLabel} • ${eventType}`,
          description: "Generated Telnyx webhook payload example",
          payload: runtimePayload,
        });
      });
    }
  });

  return options;
}

function getStoredResponseBody(testResponse) {
  if (!testResponse) return undefined;
  if (testResponse.body !== undefined) return testResponse.body;
  if (testResponse.response?.body !== undefined) return testResponse.response.body;
  return undefined;
}

function parseJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function getNodeWebhookEvents(node, edges) {
  const nodeType = node?.data?.nodeType;
  const nodeDef = VOICE_FLOW_NODES[nodeType];
  const events = new Set();

  if (nodeType === "incoming_call" || nodeType === "outbound_campaign") {
    events.add("call.initiated");
  }

  if (!nodeDef?.outputEvents) {
    return [...events];
  }

  edges
    .filter((edge) => edge?.source === node.id)
    .forEach((edge) => {
      const sourceHandle = edge.sourceHandle || "output-0";
      const outputIndex = parseInt(sourceHandle.replace("output-", ""), 10);
      const eventType = nodeDef.outputEvents[outputIndex];
      if (eventType) events.add(eventType);
    });

  return [...events];
}

function buildWebhookRuntimeVariables({ eventType, payload, node }) {
  const occurredAt = new Date(0).toISOString();
  const nodeType = node?.data?.nodeType;
  const config = node?.data?.config || {};
  const variables = {
    event_type: eventType,
    occurred_at: occurredAt,
    record_type: "event",
    call_control_id: payload.call_control_id,
    call_leg_id: payload.call_leg_id,
    call_session_id: payload.call_session_id,
    connection_id: payload.connection_id,
    client_state: payload.client_state,
    from: payload.from,
    to: payload.to,
    direction: payload.direction,
    state: payload.state,
    payload,
    trigger_type: nodeType,
  };

  if (nodeType === "incoming_call") {
    const payloadVariable =
      config.payloadVariable ||
      config.payloadVariableName ||
      DEFAULT_INCOMING_CALL_PAYLOAD_VARIABLE;
    variables[payloadVariable] = payload;
  }

  if (nodeType === "outbound_campaign") {
    const payloadVariable = config.payloadVariable || "contact_record";
    const contactRecord = buildOutboundContactExample();
    variables[payloadVariable] = contactRecord;
    variables.contact_record = contactRecord;
    variables.contact_data = contactRecord;
  }

  return variables;
}

function buildWebhookPayload(eventType) {
  const schema = getWebhookSchema(eventType);
  if (!schema) return null;
  const payload = {};
  Object.entries(schema).forEach(([fieldName, fieldDef]) => {
    payload[fieldName] = buildExampleValue(fieldDef);
  });
  return {
    event_type: eventType,
    id: "0ccc7b54-4df3-4bca-a65a-3da1ecc777f0",
    occurred_at: new Date(0).toISOString(),
    payload,
  };
}

function buildDataActionExample(dataSource, action = "list") {
  const schema = dataSource ? getEntitySchema(dataSource) : {};
  const rowExample = {};

  Object.entries(schema).forEach(([fieldName, fieldDef]) => {
    rowExample[fieldName] = buildExampleValue(fieldDef);
  });

  if (action === "list") {
    return {
      success: true,
      status: 200,
      rows: [rowExample],
      total: 1,
      page: 1,
      pageSize: 25,
    };
  }

  return {
    success: true,
    status: action === "delete" ? 204 : 200,
    data: action === "delete" ? { deleted: true } : rowExample,
  };
}

function buildOutboundContactExample() {
  return {
    first_name: "John",
    last_name: "Doe",
    display_name: "John Doe",
    phone_number: "+15551234567",
    company: "Acme Corp",
  };
}

function buildExampleValue(fieldDef = {}) {
  if (fieldDef.example !== undefined) return fieldDef.example;
  if (fieldDef.enum?.length) return fieldDef.enum[0];

  switch (fieldDef.type) {
    case "string":
    case "enum":
      return "example_value";
    case "number":
      return 0;
    case "boolean":
      return true;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return null;
  }
}

function getNodeDisplayName(nodeType) {
  return VOICE_FLOW_NODES[nodeType]?.label || nodeType;
}
