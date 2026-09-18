function toTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function getAgentStateName(agentState) {
  if (typeof agentState === "string") return agentState;
  return agentState?.state || null;
}

export function getAIWidgetStatus({
  connectionState,
  agentState,
  callState,
  authState,
  isStartingConversation = false,
  isReconnecting = false,
  error = null,
}) {
  if (error) {
    return {
      key: "error",
      label: "Connection error",
      description: error,
      tone: "danger",
    };
  }

  if (isReconnecting) {
    return {
      key: "reconnecting",
      label: "Reconnecting",
      description: "Restoring the connection to the assistant",
      tone: "warning",
      animated: true,
    };
  }

  if (isStartingConversation || ["new", "trying", "requesting", "ringing"].includes(callState)) {
    return {
      key: "starting-call",
      label: "Starting call",
      description: "Establishing the voice conversation",
      tone: "warning",
      animated: true,
    };
  }

  if (callState === "active") {
    switch (getAgentStateName(agentState)) {
      case "listening":
        return {
          key: "listening",
          label: "Listening",
          description: "The assistant is listening to you",
          tone: "info",
          animated: true,
        };
      case "thinking":
        return {
          key: "thinking",
          label: "Thinking",
          description: "The assistant is preparing a response",
          tone: "warning",
          animated: true,
        };
      case "speaking":
        return {
          key: "speaking",
          label: "Speaking",
          description: "The assistant is responding",
          tone: "success",
          animated: true,
        };
      default:
        return {
          key: "in-call",
          label: "In call",
          description: "Voice conversation is active",
          tone: "success",
        };
    }
  }

  if (authState === "authenticating") {
    return {
      key: "authenticating",
      label: "Authenticating",
      description: "Signing in to the voice service",
      tone: "warning",
      animated: true,
    };
  }

  if (connectionState === "connecting") {
    return {
      key: "connecting",
      label: "Connecting",
      description: "Connecting to the voice service",
      tone: "warning",
      animated: true,
    };
  }

  if (connectionState === "connected" && authState === "authenticated") {
    return {
      key: "ready",
      label: "Ready",
      description: "Ready to start a conversation",
      tone: "success",
    };
  }

  if (connectionState === "error" || authState === "error") {
    return {
      key: "error",
      label: "Connection error",
      description: "The assistant could not connect",
      tone: "danger",
    };
  }

  return {
    key: "disconnected",
    label: "Disconnected",
    description: "Connect again to start a conversation",
    tone: "neutral",
  };
}

function appendAssistantDelta(current, delta) {
  const next = String(delta || "");
  if (!current) return next;
  if (!next) return current;
  return `${current}${next}`;
}

function mergeAttachments(left = [], right = []) {
  const seen = new Set();
  return [...left, ...right].filter((attachment) => {
    const key = `${attachment?.type || ""}:${attachment?.url || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return Boolean(attachment?.url);
  });
}

export function normalizeAITranscript(transcript = [], pendingMessages = []) {
  const sourceItems = [];
  const sourceIndexes = new Map();

  for (const [sourceIndex, rawItem] of (transcript || []).entries()) {
    if (!rawItem || !["user", "assistant"].includes(rawItem.role)) continue;

    const content = String(rawItem.content ?? "");
    if (!content.trim() && !rawItem.attachments?.length) continue;

    const id = rawItem.id || `${rawItem.role}-${sourceIndex}`;
    const item = {
      id,
      sourceIds: [id],
      role: rawItem.role,
      content,
      timestamp: rawItem.timestamp || new Date(),
      attachments: rawItem.attachments || [],
      pending: false,
      failed: false,
    };

    if (sourceIndexes.has(id)) {
      sourceItems[sourceIndexes.get(id)] = item;
      continue;
    }

    sourceIndexes.set(id, sourceItems.length);
    sourceItems.push(item);
  }

  const normalized = [];
  for (const item of sourceItems) {
    const previous = normalized.at(-1);
    if (item.role === "assistant" && previous?.role === "assistant" && !previous.pending) {
      previous.content = appendAssistantDelta(previous.content, item.content);
      previous.attachments = mergeAttachments(previous.attachments, item.attachments);
      previous.sourceIds.push(item.id);
      continue;
    }

    normalized.push(item);
  }

  for (const pending of pendingMessages || []) {
    if (!pending?.content?.trim()) continue;
    const echoed = normalized.some(
      (item) =>
        item.role === "user" &&
        item.content.trim() === pending.content.trim() &&
        Math.abs(toTimestamp(item.timestamp) - toTimestamp(pending.timestamp)) < 30_000
    );
    if (echoed) continue;

    normalized.push({
      id: pending.id,
      sourceIds: [pending.id],
      role: "user",
      content: pending.content,
      timestamp: pending.timestamp || new Date(),
      attachments: pending.attachments || [],
      pending: pending.status !== "failed",
      failed: pending.status === "failed",
    });
  }

  return normalized.sort((left, right) => toTimestamp(left.timestamp) - toTimestamp(right.timestamp));
}

export function buildAIDiagnostics({
  agentState,
  client,
  connectionInfo,
  connectionState,
  callState,
}) {
  return {
    connectionState: connectionState || null,
    callState: callState || null,
    sessionId: client?.sessionId || null,
    region: connectionInfo?.region ?? client?.region ?? null,
    datacenter: connectionInfo?.dc ?? client?.dc ?? null,
    callReportId: connectionInfo?.callReportId ?? client?.callReportId ?? null,
    responseLatencyMs: agentState?.userPerceivedLatencyMs ?? null,
    greetingLatencyMs: agentState?.greetingLatencyMs ?? null,
  };
}
