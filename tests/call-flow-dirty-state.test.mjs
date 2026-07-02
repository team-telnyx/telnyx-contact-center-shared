import assert from "node:assert/strict";
import test from "node:test";

import {
  createCallFlowDirtySnapshot,
  hasCallFlowDirtyState,
} from "../lib/voice-flow-dirty-state.js";

const noop = () => {};

const persistedNodes = [
  {
    id: "node-1",
    type: "customNode",
    position: { x: 100, y: 200 },
    data: {
      nodeType: "dial",
      label: "Dial",
      config: { to: "+15551234567" },
    },
  },
];

const editorNodes = [
  {
    ...persistedNodes[0],
    selected: false,
    dragging: false,
    width: 240,
    height: 90,
    positionAbsolute: { x: 100, y: 200 },
    data: {
      ...persistedNodes[0].data,
      isActive: true,
      nodeId: "node-1",
      nodeNumber: 1,
      onDelete: noop,
      dynamicOutputs: 3,
      dynamicOutputLabels: ["Call Initiated", "Call Answered", "Call Hangup"],
      dynamicOutputEvents: ["call.initiated", "call.answered", "call.hangup"],
      dynamicOutputDescriptions: ["a", "b", "c"],
    },
  },
];

const persistedEdges = [
  {
    id: "edge-1",
    source: "node-1",
    target: "node-2",
    data: { variableMappings: [] },
  },
];

const editorEdges = [
  {
    ...persistedEdges[0],
    selected: false,
    data: {
      ...persistedEdges[0].data,
      isActive: true,
      onDelete: noop,
      onConfigureVariables: noop,
    },
  },
];

test("call flow dirty comparison ignores runtime-only ReactFlow/editor fields", () => {
  const initial = createCallFlowDirtySnapshot({
    name: "Support flow",
    description: "",
    nodes: persistedNodes,
    edges: persistedEdges,
    globalVariables: {},
  });

  assert.equal(
    hasCallFlowDirtyState(
      {
        name: "Support flow",
        description: "",
        nodes: editorNodes,
        edges: editorEdges,
        globalVariables: {},
      },
      initial,
    ),
    false,
  );
});

test("call flow dirty comparison detects real config changes", () => {
  const initial = createCallFlowDirtySnapshot({
    name: "Support flow",
    description: "",
    nodes: persistedNodes,
    edges: persistedEdges,
    globalVariables: {},
  });

  assert.equal(
    hasCallFlowDirtyState(
      {
        name: "Support flow",
        description: "",
        nodes: [
          {
            ...editorNodes[0],
            data: {
              ...editorNodes[0].data,
              config: { to: "+15557654321" },
            },
          },
        ],
        edges: editorEdges,
        globalVariables: {},
      },
      initial,
    ),
    true,
  );
});
