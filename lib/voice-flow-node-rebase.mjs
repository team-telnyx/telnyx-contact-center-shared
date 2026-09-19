function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").trim().replace(/\/+$/, "");
}

/**
 * Replace flow-owned node URLs and resource identifiers when a flow is
 * created from an existing set of nodes. External integration URLs and all
 * unrelated node configuration remain untouched.
 */
export function rebaseFlowOwnedNodeConfig(
  nodes,
  { baseUrl, flowId, voiceApplicationId },
) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!Array.isArray(nodes)) return [];

  return nodes.map((node) => {
    const nodeType = node?.data?.nodeType || node?.type;
    const existingConfig = node?.data?.config;
    if (!existingConfig || typeof existingConfig !== "object") return node;

    let config = existingConfig;

    if (nodeType === "incoming_call") {
      config = {
        ...existingConfig,
        webhook_url: `${normalizedBaseUrl}/api/voice/webhook/incoming/${flowId}`,
        ...(voiceApplicationId
          ? { voice_application_id: String(voiceApplicationId) }
          : {}),
      };
    } else if (nodeType === "http_request") {
      config = {
        ...existingConfig,
        endpoint_path: `${normalizedBaseUrl}/api/voice/flows/trigger/${flowId}`,
      };
    } else if (nodeType === "dial") {
      config = {
        ...existingConfig,
        webhook_url: `${normalizedBaseUrl}/api/voice/webhook/flows/${flowId}`,
      };
    } else {
      return node;
    }

    return {
      ...node,
      data: {
        ...node.data,
        config,
      },
    };
  });
}
