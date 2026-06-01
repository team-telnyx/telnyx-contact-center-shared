const NODE_DATA_RUNTIME_KEYS = new Set([
  "onDelete",
  "isActive",
  "nodeId",
  "nodeNumber",
  "dynamicOutputs",
  "dynamicOutputLabels",
  "dynamicOutputEvents",
  "dynamicOutputDescriptions",
]);

const EDGE_DATA_RUNTIME_KEYS = new Set([
  "onDelete",
  "onConfigureVariables",
  "isActive",
]);

const REACT_FLOW_RUNTIME_KEYS = new Set([
  "dragging",
  "selected",
  "resizing",
  "width",
  "height",
  "measured",
  "positionAbsolute",
]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;

  return Object.keys(value)
    .filter((key) => typeof value[key] !== "function" && value[key] !== undefined)
    .sort()
    .reduce((acc, key) => {
      acc[key] = stableValue(value[key]);
      return acc;
    }, {});
}

function normalizeData(data = {}, runtimeKeys = new Set()) {
  return Object.keys(data || {})
    .filter((key) => !runtimeKeys.has(key))
    .filter((key) => typeof data[key] !== "function" && data[key] !== undefined)
    .sort()
    .reduce((acc, key) => {
      acc[key] = stableValue(data[key]);
      return acc;
    }, {});
}

function normalizeReactFlowItem(item = {}, dataRuntimeKeys = new Set()) {
  return Object.keys(item || {})
    .filter((key) => !REACT_FLOW_RUNTIME_KEYS.has(key))
    .filter((key) => typeof item[key] !== "function" && item[key] !== undefined)
    .sort()
    .reduce((acc, key) => {
      if (key === "data") {
        acc.data = normalizeData(item.data || {}, dataRuntimeKeys);
      } else {
        acc[key] = stableValue(item[key]);
      }
      return acc;
    }, {});
}

export function createCallFlowDirtySnapshot({
  name = "",
  description = "",
  nodes = [],
  edges = [],
  globalVariables = {},
} = {}) {
  return {
    name: name || "",
    description: description || "",
    nodes: (nodes || []).map((node) => normalizeReactFlowItem(node, NODE_DATA_RUNTIME_KEYS)),
    edges: (edges || []).map((edge) => normalizeReactFlowItem(edge, EDGE_DATA_RUNTIME_KEYS)),
    globalVariables: stableValue(globalVariables || {}),
  };
}

export function hasCallFlowDirtyState(currentState, initialSnapshot) {
  const currentSnapshot = createCallFlowDirtySnapshot(currentState);
  return JSON.stringify(currentSnapshot) !== JSON.stringify(initialSnapshot);
}
