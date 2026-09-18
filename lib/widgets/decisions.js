import { localizeWidgetConfig } from "./locales.js";

export const BUILT_IN_DECISION_VARIABLES = Object.freeze([
  { key: "page.path", label: "Page path", type: "string", source: "browser" },
  { key: "page.host", label: "Page host", type: "string", source: "browser" },
  { key: "page.url", label: "Page URL", type: "string", source: "browser" },
  { key: "device.type", label: "Device type", type: "string", source: "browser" },
  { key: "visitor.locale", label: "Visitor locale", type: "string", source: "browser" },
]);

export const DECISION_OPERATORS = Object.freeze([
  { value: "equals", label: "equals" },
  { value: "not-equals", label: "does not equal" },
  { value: "contains", label: "contains" },
  { value: "not-contains", label: "does not contain" },
  { value: "starts-with", label: "starts with" },
  { value: "ends-with", label: "ends with" },
  { value: "exists", label: "has a value" },
  { value: "not-exists", label: "has no value" },
  { value: "greater-than", label: "is greater than" },
  { value: "greater-or-equal", label: "is at least" },
  { value: "less-than", label: "is less than" },
  { value: "less-or-equal", label: "is at most" },
  { value: "in", label: "is one of" },
]);

export const DECISION_ACTION_TYPES = Object.freeze([
  { value: "visibility", label: "Widget visibility" },
  { value: "channels", label: "Available channels" },
  { value: "locale", label: "Widget language" },
  { value: "surface", label: "Opening view" },
  { value: "launcher-delay", label: "Launcher delay" },
  { value: "auto-open", label: "Auto-open widget" },
  { value: "route-queue", label: "Contact Center handoff queue" },
  { value: "customer-label", label: "Customer display name" },
]);

function contextValue(context, path) {
  if (Object.prototype.hasOwnProperty.call(context || {}, path)) return context[path];
  return String(path || "").split(".").reduce((value, key) => value?.[key], context);
}

function normalizedText(value) {
  return String(value ?? "").trim().toLocaleLowerCase();
}

function numericComparison(actual, expected, predicate) {
  const left = Number(actual);
  const right = Number(expected);
  return Number.isFinite(left) && Number.isFinite(right) && predicate(left, right);
}

export function matchesDecisionCondition(condition, context) {
  const actual = contextValue(context, condition.field);
  const expected = condition.value;
  const actualText = normalizedText(actual);
  const expectedText = normalizedText(expected);
  switch (condition.operator) {
    case "exists": return actual !== undefined && actual !== null && actualText !== "";
    case "not-exists": return actual === undefined || actual === null || actualText === "";
    case "not-equals": return actualText !== expectedText;
    case "contains": return actualText.includes(expectedText);
    case "not-contains": return !actualText.includes(expectedText);
    case "starts-with": return actualText.startsWith(expectedText);
    case "ends-with": return actualText.endsWith(expectedText);
    case "greater-than": return numericComparison(actual, expected, (a, b) => a > b);
    case "greater-or-equal": return numericComparison(actual, expected, (a, b) => a >= b);
    case "less-than": return numericComparison(actual, expected, (a, b) => a < b);
    case "less-or-equal": return numericComparison(actual, expected, (a, b) => a <= b);
    case "in": return String(expected ?? "").split(",").map(normalizedText).includes(actualText);
    case "equals":
    default:
      if (typeof actual === "boolean") return actual === (expected === true || expectedText === "true");
      return actualText === expectedText;
  }
}

export function interpolateDecisionValue(value, context) {
  return String(value ?? "").replace(/\{\{\s*([a-z0-9_.-]+)\s*\}\}/gi, (_, key) => {
    const replacement = contextValue(context, key);
    return replacement === undefined || replacement === null ? "" : String(replacement);
  });
}

function applyDecisionAction(result, action, context, baseConfig) {
  const value = interpolateDecisionValue(action.value, context);
  switch (action.type) {
    case "visibility":
      result.visible = value !== "hidden" && value !== "false";
      break;
    case "channels": {
      // "both" keeps its historical meaning (messaging + voice); "all" adds video
      // and a comma-separated list selects channels explicitly.
      const allowed = value === "both" ? new Set(["messaging", "voice"])
        : value === "all" ? new Set(["messaging", "voice", "video"])
        : new Set(String(value || "").split(/[\s,]+/).filter(Boolean));
      result.config.channels.messaging.enabled = baseConfig.channels.messaging.enabled && allowed.has("messaging");
      result.config.channels.voice.enabled = baseConfig.channels.voice.enabled && allowed.has("voice");
      result.config.channels.video.enabled = baseConfig.channels.video.enabled && allowed.has("video");
      result.channels = [
        result.config.channels.messaging.enabled && "messaging",
        result.config.channels.voice.enabled && "voice",
        result.config.channels.video.enabled && "video",
      ].filter(Boolean);
      if (!result.channels.length) result.visible = false;
      break;
    }
    case "locale":
      result.config = localizeWidgetConfig(result.config, value);
      result.locale = result.config.locale;
      break;
    case "surface":
      result.surface = value;
      if (value !== "launcher") result.config.behavior.defaultSurface = value;
      break;
    case "launcher-delay": {
      const delay = Math.max(0, Math.min(3600, Number(value) || 0));
      result.launcherDelaySeconds = delay;
      result.config.engagement.triggers.launcher.delaySeconds = delay;
      break;
    }
    case "auto-open": {
      const delay = Math.max(0, Math.min(3600, Number(value) || 0));
      result.autoOpenDelaySeconds = delay;
      result.config.engagement.triggers.autoOpen.enabled = true;
      result.config.engagement.triggers.autoOpen.delaySeconds = delay;
      result.config.engagement.triggers.autoOpen.surface = result.surface === "launcher"
        ? result.config.behavior.defaultSurface
        : result.surface;
      break;
    }
    case "route-queue": {
      const queues = baseConfig.channels.messaging.routing.queues || [];
      const queue = queues.find((candidate) => candidate.id === action.value || candidate.name === action.value || candidate.id === value || candidate.name === value);
      if (queue) {
        result.routeQueue = queue;
        result.config.channels.messaging.routing.queueId = queue.id;
        result.config.channels.messaging.routing.queueName = queue.name;
        result.config.channels.messaging.routing.queues = [queue];
      }
      break;
    }
    case "customer-label":
      result.config.components.messages.customerLabel = value;
      result.customerLabel = value;
      break;
    default:
      break;
  }
}

export function evaluateWidgetDecisions(config, context = {}) {
  const baseConfig = structuredClone(config);
  const result = {
    config: structuredClone(config),
    context,
    enabled: Boolean(config.decisions?.enabled),
    visible: true,
    matched: false,
    matchedRule: null,
    surface: config.behavior.defaultSurface,
    locale: config.locale,
    channels: [config.channels.messaging.enabled && "messaging", config.channels.voice.enabled && "voice", config.channels.video?.enabled && "video"].filter(Boolean),
    launcherDelaySeconds: config.engagement.triggers.launcher.delaySeconds,
    autoOpenDelaySeconds: config.engagement.triggers.autoOpen.enabled ? config.engagement.triggers.autoOpen.delaySeconds : null,
    routeQueue: null,
    customerLabel: config.components.messages.customerLabel,
    traces: [],
  };
  if (!config.decisions?.enabled) return result;

  const rules = [...(config.decisions.rules || [])]
    .filter((rule) => rule.enabled)
    .sort((left, right) => left.priority - right.priority);
  for (const rule of rules) {
    const conditions = rule.conditions.map((condition) => ({
      condition,
      matched: matchesDecisionCondition(condition, context),
      actual: contextValue(context, condition.field),
    }));
    const matched = rule.match === "any"
      ? conditions.some((condition) => condition.matched)
      : conditions.every((condition) => condition.matched);
    result.traces.push({ rule, matched, conditions });
    if (!matched) continue;
    result.matched = true;
    result.matchedRule = rule;
    for (const action of rule.actions) applyDecisionAction(result, action, context, baseConfig);
    break;
  }
  return result;
}

export function previewDecisionContext(config, deviceType = "desktop") {
  return {
    ...(config.preview?.decisionContext || {}),
    "device.type": deviceType,
    "visitor.locale": config.preview?.decisionContext?.["visitor.locale"] || config.locale,
  };
}
