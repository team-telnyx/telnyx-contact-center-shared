"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getSmoothStepPath,
  Handle,
  Panel,
  Position,
  useEdgesState,
  useNodesState,
} from "reactflow";
import "reactflow/dist/style.css";
import {
  IconAlertTriangle,
  IconArrowsRight,
  IconGitBranch,
  IconInfoCircle,
  IconMessageCircle,
  IconMicrophone,
  IconPlus,
  IconRefresh,
  IconRobot,
  IconTool,
  IconTrash,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Combobox } from "@/components/ui/combobox";
import AIModels from "@/components/assistants/AIModels";
import WorkflowVoicePicker from "@/components/assistants/WorkflowVoicePicker";
import AssistantCapabilityGraph from "@/components/assistants/AssistantCapabilityGraph";
import { VariableTextarea } from "@/components/voice-flow/VariableTextarea";
import { cn } from "@/lib/utils";
import {
  ASSISTANT_TOOL_LIBRARY_SOURCE_KEY,
  ASSISTANT_TOOL_LIBRARY_SOURCE_VALUE,
} from "@/lib/ai/tool-library";
import {
  buildComparisonExpression,
  createDefaultConversationFlow,
  createWorkflowNode,
  getInlineToolsBlockingWorkflow,
  getSharedToolId,
  getToolDisplayName,
  normalizeWorkflowCanvasLayout,
  validateConversationFlow,
  validateWorkflowEdge,
  validateWorkflowNode,
} from "@/lib/ai/assistant-conversation-workflow.mjs";

// Canonical Telnyx AI Assistant system variables. Defined locally (not imported
// from the .mjs lib) because the Webpack named-import boundary for this constant
// resolved to a runtime ReferenceError in the dev bundle. These are the same
// variables the assistant editor (AgentTab) exposes — system vars + the
// assistant-level dynamic_variables drive the {{ }} autocomplete and the edge
// Variable Comparison dropdown.
const OPENCLAW_SYSTEM_VARIABLES = [
  { name: "telnyx_current_time", description: "The current date and time in UTC", example: "Monday, February 24 2025 04:04:15 PM UTC" },
  { name: "telnyx_conversation_channel", description: "This can be phone_call, web_call, or sms_chat", example: "phone_call" },
  { name: "telnyx_agent_target", description: "The phone number, SIP URI, or other identifier associated with the agent.", example: "+13128675309" },
  { name: "telnyx_end_user_target", description: "The phone number, SIP URI, or other identifier associated with the end user", example: "+15551234567" },
  { name: "telnyx_shaken_stir_attestation", description: "The SHAKEN/STIR attestation level for inbound phone calls, if available. This can be a, b, or c.", example: "a" },
  { name: "call_control_id", description: "The call control ID for the call, if applicable", example: "v3:u5OAKGEPT3Dx8SZSSDRWEMdNH2OripQhO" },
];

const NODE_TRANSFER_TYPE = "application/assistant-workflow-node";
const nodeTypes = {
  customNode: WorkflowCanvasNode,
};
const edgeTypes = {
  workflowEdge: WorkflowEdge,
};

const WORKFLOW_NODE_DEFS = {
  prompt: {
    label: "Prompt node",
    color: "#00E3AA",
    icon: IconRobot,
    inputs: 1,
    outputs: 1,
    inputLabel: "Execute",
    outputLabels: ["Next"],
    category: "AI ASSISTANT",
  },
  speak: {
    label: "Speak node",
    color: "#A78BFA",
    icon: IconMicrophone,
    inputs: 1,
    outputs: 1,
    inputLabel: "Execute",
    outputLabels: ["Next"],
    category: "AI ASSISTANT",
  },
  assistant: {
    label: "Assistant node",
    color: "#3B82F6",
    icon: IconArrowsRight,
    inputs: 1,
    outputs: 0,
    inputLabel: "Execute",
    outputLabels: [],
    category: "AI ASSISTANT",
  },
};

function workflowNodeLabel(type) {
  return WORKFLOW_NODE_DEFS[type]?.label || "Prompt node";
}

function WorkflowCanvasNode({ data, selected }) {
  const nodeDef = WORKFLOW_NODE_DEFS[data.nodeType || data.node?.type || "prompt"] || WORKFLOW_NODE_DEFS.prompt;
  const IconComponent = nodeDef.icon;
  const hasInput = nodeDef.inputs > 0;
  const outputs = nodeDef.outputs || 0;
  const handleStyle = {
    background: nodeDef.color,
    width: "12px",
    height: "12px",
    border: "2px solid white",
    borderRadius: "2px",
  };

  return (
    <div
      className={`shadow-lg rounded-lg border-2 bg-card text-card-foreground transition-all ${
        selected ? "border-primary ring-2 ring-primary/30" : "border-border"
      }`}
      style={{ minWidth: "260px" }}
    >
      {/* Top-down layout: input handle on top, output handle(s) on bottom */}
      {hasInput && (
        <Handle
          type="target"
          position={Position.Top}
          id="input-execute"
          style={{ ...handleStyle, top: "-7px", left: "50%" }}
        />
      )}

      {data.isStart && (
        <div className="flex items-center justify-center pt-1.5 pb-0.5">
          <Badge className="bg-telnyx-green/15 text-telnyx-green border-telnyx-green/30 text-[10px] font-semibold uppercase tracking-wide">
            Start
          </Badge>
        </div>
      )}

      <div className="flex items-center justify-between px-2 py-2 border-y">
        <div className="flex items-center gap-2">
          <div
            className="flex items-center justify-center w-8 h-8 rounded-md flex-shrink-0"
            style={{ backgroundColor: `${nodeDef.color}20`, color: nodeDef.color }}
          >
            <IconComponent className="h-5 w-5" />
          </div>
          <div className="font-semibold text-base">{data.label}</div>
        </div>
        <div className="flex items-center gap-1">
          {data.nodeIssues && data.nodeIssues.length > 0 && (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center justify-center w-6 h-6 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 cursor-help">
                    <IconAlertTriangle className="h-4 w-4" />
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs">
                  <div className="space-y-1">
                    <div className="font-semibold text-xs">Missing required configuration:</div>
                    <ul className="list-disc space-y-0.5 pl-3 text-xs">
                      {data.nodeIssues.map((issue) => <li key={issue}>{issue}</li>)}
                    </ul>
                  </div>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {data.nodeNumber && (
            <Badge variant="outline" className="text-xs font-semibold">
              #{data.nodeNumber}
            </Badge>
          )}
        </div>
      </div>

      {outputs > 0 && (
        <div className="flex items-stretch justify-around px-2 py-2">
          {[...Array(outputs)].map((_, index) => {
            const total = Math.max(outputs, 1);
            const leftPct = ((index + 1) / (total + 1)) * 100;
            return (
              <div key={`out-${index}`} className="flex-1 text-center">
                <Handle
                  type="source"
                  position={Position.Bottom}
                  id={`output-${index}`}
                  style={{ ...handleStyle, bottom: "-7px", left: `${leftPct}%` }}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function WorkflowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  selected,
  data,
}) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const condition = data?.edge?.condition || {};
  const label = edgeLabel(condition);
  const isDefault = condition.type === "default";
  const edgeIssues = data?.edgeIssues || [];

  // Emphasize the selected edge like the Telnyx UI: recolor + thicken the stroke.
  const edgeStyle = selected
    ? { ...style, stroke: "var(--primary)", strokeWidth: 3 }
    : style;

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={edgeStyle} />
      {(label || edgeIssues.length > 0) && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: "all",
            }}
            className="nodrag nopan"
          >
            <span
              className={`inline-flex max-w-[180px] items-center gap-1 truncate rounded-full border px-2 py-0.5 text-[11px] font-medium shadow-sm ${
                selected
                  ? "border-primary bg-primary text-primary-foreground"
                  : isDefault
                  ? "border-border bg-muted text-muted-foreground"
                  : "border-telnyx-green/40 bg-background text-foreground"
              }`}
              title={label}
            >
              {label}
              {edgeIssues.length > 0 && (
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex items-center justify-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 cursor-help">
                        <IconAlertTriangle className="h-3 w-3" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-xs">
                      <div className="space-y-1">
                        <div className="font-semibold text-xs">Missing required configuration:</div>
                        <ul className="list-disc space-y-0.5 pl-3 text-xs">
                          {edgeIssues.map((issue) => <li key={issue}>{issue}</li>)}
                        </ul>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

function defaultWorkflowNodePosition(index) {
  return { x: 40 + index * 320, y: 40 };
}

function normalizeWorkflowNode(node, index = 0) {
  const type = node?.type === "speak" ? "speak" : "prompt";
  const id = String(node.id || `n_${type}_${index + 1}`);
  return {
    ...node,
    id,
    type,
    name: node?.name || workflowNodeLabel(type),
    position: node.position || defaultWorkflowNodePosition(index),
  };
}

// Deterministic canvas id for the virtual node synthesized from an edge
// whose target.type === "assistant". The id is stable across renders so
// ReactFlow keeps the node mounted and the user's drag is preserved.
function virtualAssistantNodeId(assistantId) {
  return `assistant:${String(assistantId)}`;
}

function toReactFlowNodes(flow, options = {}) {
  const displayFlow = options.normalize === false ? flow : normalizeWorkflowCanvasLayout(flow);
  const realNodes = (displayFlow?.nodes || []).map((node, index) => {
    const normalized = normalizeWorkflowNode(node, index);
    return {
      id: String(node.id || normalized.id),
      type: "customNode",
      position: node.position || defaultWorkflowNodePosition(index),
      data: {
        node: normalized,
        nodeType: normalized.type,
        label: normalized.name || workflowNodeLabel(normalized.type),
        nodeId: normalized.id,
        nodeNumber: index + 1,
        isStart: String(displayFlow.start_node_id || "") === normalized.id,
      },
    };
  });

  // Synthesize a virtual read-only Assistant node on the canvas for every
  // edge whose target.type === "assistant". The node is NOT persisted to
  // flow.nodes — it is derived from the edge target (assistant_id +
  // voice_mode + position) purely for visualization. Edges connect to it
  // via the stable id `assistant:<assistant_id>`.
  const edges = Array.isArray(displayFlow?.edges) ? displayFlow.edges : [];
  const seenAssistantIds = new Set();
  const virtualNodes = [];
  let virtualIndex = realNodes.length + 1;
  for (const edge of edges) {
    const target = edge.target;
    if (!target || target.type !== "assistant" || !target.assistant_id) continue;
    const aid = String(target.assistant_id);
    if (seenAssistantIds.has(aid)) continue; // one node per target assistant
    seenAssistantIds.add(aid);
    const position = target.position || { x: 320, y: 320 + virtualIndex * 80 };
    virtualNodes.push({
      id: virtualAssistantNodeId(aid),
      type: "customNode",
      position: { x: Number(position.x || 0), y: Number(position.y || 0) },
      // Virtual nodes are not draggable from ReactFlow's perspective because
      // their position lives on the edge target; we allow drag but persist it
      // back via onNodesChange → reactFlowToConversationFlow.
      draggable: true,
      data: {
        node: {
          id: virtualAssistantNodeId(aid),
          type: "assistant",
          name: "Assistant node",
          assistant_id: aid,
          voice_mode: target.voice_mode || "distinct",
          position: { x: Number(position.x || 0), y: Number(position.y || 0) },
        },
        nodeType: "assistant",
        label: "Assistant node",
        nodeId: virtualAssistantNodeId(aid),
        isVirtualAssistant: true,
        edgeId: String(edge.id),
        assistantId: aid,
        voiceMode: target.voice_mode || "distinct",
      },
    });
    virtualIndex += 1;
  }

  return [...realNodes, ...virtualNodes];
}

function toReactFlowEdges(flow) {
  return (flow?.edges || [])
    .filter((edge) => edge.target?.type === "node" || edge.target?.type === "assistant")
    .map((edge) => {
      const targetNodeId =
        edge.target?.type === "assistant"
          ? virtualAssistantNodeId(edge.target.assistant_id)
          : String(edge.target?.node_id || "");
      return {
        id: String(edge.id || `e_${edge.start_node_id}_${targetNodeId}`),
        source: String(edge.start_node_id),
        target: targetNodeId,
        sourceHandle: "output-0",
        targetHandle: "input-execute",
        animated: edge.condition?.type === "llm",
        type: "workflowEdge",
        data: { edge },
        style: { stroke: edge.condition?.type === "default" ? "#64748b" : "#00E3AA", strokeWidth: 2 },
      };
    });
}

function workflowLayoutSignature(flow) {
  return JSON.stringify((flow?.nodes || []).map((node) => ({
    id: String(node.id || ""),
    x: Number(node.position?.x ?? 0),
    y: Number(node.position?.y ?? 0),
  })));
}

function edgeLabel(condition = {}) {
  if (condition.type === "default") return "Default";
  if (condition.type === "expression") return expressionLabel(condition.expression) || "Variable Comparison";
  return "LLM Prompt";
}

function expressionLabel(expression) {
  if (!expression || expression.type !== "comparison") return "";
  const left = expression.left?.name || expression.left?.value || "variable";
  const op = expression.op || "==";
  const right = expression.right;
  const value = right?.type === "string_literal" ? `\"${right.value ?? ""}\"` : String(right?.value ?? "");
  return `${left} ${op} ${value}`;
}

function reactFlowToConversationFlow({ flow, nodes, edges }) {
  const byId = new Map((flow?.nodes || []).map((node) => [String(node.id), node]));

  // Separate real workflow nodes (prompt/speak) from virtual assistant nodes
  // synthesized from edge targets. Only real nodes are persisted to flow.nodes.
  const realRfNodes = [];
  // Map canvas node id → { position, assistant_id, voice_mode } for virtual
  // assistant nodes, so edges can read back assistant_id + voice_mode + the
  // dragged canvas position when persisting.
  const virtualAssistantByNodeId = new Map();
  for (const rfNode of nodes) {
    const n = rfNode.data?.node || {};
    if (n.type === "assistant") {
      virtualAssistantByNodeId.set(String(rfNode.id), {
        assistantId: n.assistant_id,
        voiceMode: n.voice_mode || "distinct",
        position: rfNode.position || { x: 0, y: 0 },
      });
    } else {
      realRfNodes.push(rfNode);
    }
  }

  const nextNodes = realRfNodes.map((node, index) => {
    const position = node.position || defaultWorkflowNodePosition(index);
    return {
      ...(byId.get(String(node.id)) || node.data.node),
      id: String(node.id),
      type: node.data?.nodeType || node.data?.node?.type || "prompt",
      name: node.data?.label || node.data?.node?.name || workflowNodeLabel(node.data?.nodeType),
      position: {
        x: Number(position.x || 0),
        y: Number(position.y || 0),
      },
    };
  });

  const edgeById = new Map((flow?.edges || []).map((edge) => [String(edge.id), edge]));
  const nextEdges = edges.map((edge) => {
    const existing = edgeById.get(String(edge.id));
    const targetNodeId = String(edge.target);
    const virtual = virtualAssistantByNodeId.get(targetNodeId);
    if (virtual) {
      // Edge targets a virtual assistant node — persist as
      // target.type="assistant" with the canvas position so Telnyx remembers
      // where the handoff node was placed.
      return {
        ...(existing || edge.data?.edge || {}),
        id: String(edge.id),
        start_node_id: String(edge.source),
        target: {
          type: "assistant",
          assistant_id: virtual.assistantId,
          voice_mode: virtual.voiceMode,
          position: {
            x: Number(virtual.position.x || 0),
            y: Number(virtual.position.y || 0),
          },
        },
      };
    }
    // Otherwise keep the original target if it existed (preserves
    // target.type="assistant" on edges that haven't been reconnected), else
    // default to a plain node target.
    return {
      ...(existing || edge.data?.edge || {}),
      id: String(edge.id),
      start_node_id: String(edge.source),
      target: existing?.target || { type: "node", node_id: targetNodeId },
    };
  });
  return {
    start_node_id: String(flow?.start_node_id || nextNodes[0]?.id || ""),
    nodes: nextNodes,
    edges: nextEdges,
  };
}

function WorkflowNodePalette({ onAddNode, onDragStart }) {
  const nodesByCategory = {
    "AI ASSISTANT": [
      { id: "prompt", ...WORKFLOW_NODE_DEFS.prompt },
      { id: "speak", ...WORKFLOW_NODE_DEFS.speak },
      { id: "assistant", ...WORKFLOW_NODE_DEFS.assistant },
    ],
  };

  return (
    <div className="w-64 border-r bg-card flex flex-col h-full">
      <Tabs value="nodes" className="flex-1 flex flex-col h-full">
        <TabsList className="w-full rounded-none border-b flex-shrink-0">
          <TabsTrigger value="nodes" className="flex-1">
            Nodes
          </TabsTrigger>
        </TabsList>
        <TabsContent value="nodes" className="flex-1 overflow-y-auto mt-0 h-0">
          <div className="p-4 space-y-4">
            {Object.entries(nodesByCategory).map(([category, nodes]) => (
              <div key={category}>
                <div className="space-y-1">
                  {nodes.map((node) => (
                    <Button
                      key={node.id}
                      variant="outline"
                      size="sm"
                      className="w-full justify-start text-xs cursor-move"
                      style={{ borderLeftWidth: "3px", borderLeftColor: node.color }}
                      draggable
                      onDragStart={(event) => onDragStart(event, node.id)}
                      onClick={() => onAddNode(node.id)}
                    >
                      {node.label}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function WorkflowPropertiesPanel({
  flow,
  selectedNode,
  selectedEdge,
  values,
  models,
  libraryTools,
  libraryToolsLoading,
  onRefreshLibraryTools,
  onDisable,
  onUpdateNode,
  onDeleteNode,
  onSetStart,
  onUpdateEdge,
  onDeleteEdge,
}) {
  const errors = useMemo(() => validateConversationFlow(flow), [flow]);

  const systemVariableNames = useMemo(() => OPENCLAW_SYSTEM_VARIABLES.map((variable) => variable.name), []);
  const customVariableNames = useMemo(() => Object.keys(values?.dynamic_variables || {}), [values?.dynamic_variables]);

  let configContent;

  if (selectedNode) {
    configContent = (
      <NodeProperties
        flow={flow}
        node={selectedNode.data.node}
        values={values}
        models={models}
        libraryTools={libraryTools}
        libraryToolsLoading={libraryToolsLoading}
        onRefreshLibraryTools={onRefreshLibraryTools}
        onUpdateNode={onUpdateNode}
        onDeleteNode={onDeleteNode}
        onSetStart={onSetStart}
        edgeId={selectedNode.data?.edgeId}
        onUpdateEdge={onUpdateEdge}
        onDeleteEdge={onDeleteEdge}
      />
    );
  } else if (selectedEdge) {
    configContent = (
      <EdgeProperties
        edge={selectedEdge.data?.edge || { id: selectedEdge.id }}
        systemVariableNames={systemVariableNames}
        customVariableNames={customVariableNames}
        onUpdateEdge={onUpdateEdge}
        onDeleteEdge={onDeleteEdge}
      />
    );
  } else {
    configContent = (
      <div className="p-4 space-y-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <IconGitBranch className="size-4 text-telnyx-green" />
            Workflow
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {flow.nodes?.length || 0} nodes, {flow.edges?.length || 0} edges
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          Select a node or edge on the canvas to edit it. Drag Prompt node or Speak node from the left panel to add steps.
        </p>
        {errors.length > 0 && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
            <div className="mb-1 font-medium">Validation</div>
            <ul className="list-disc space-y-1 pl-4">
              {errors.map((error) => <li key={error}>{error}</li>)}
            </ul>
          </div>
        )}
        <Button variant="outline" className="w-full" onClick={onDisable}>
          Disable Workflow
        </Button>
      </div>
    );
  }

  return (
    <div className="w-80 border-l bg-card flex flex-col h-full">
      <div className="flex-1 min-h-0 overflow-y-auto">
        {configContent}
      </div>
    </div>
  );
}

function AssistantNodeProperties({ flow, node, edgeId, onUpdateEdge, onDeleteEdge }) {
  const [assistantOptions, setAssistantOptions] = useState([]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch("/api/ai/assistants?all=true", { cache: "no-store" });
        const data = await res.json();
        if (mounted && res.ok && data?.ok) {
          const items = Array.isArray(data.items) ? data.items : [];
          setAssistantOptions(items.map((a) => ({ value: a.id, label: a.name || a.id, Icon: IconRobot })));
        }
      } catch (_) {
        if (mounted) setAssistantOptions([]);
      }
    })();
    return () => { mounted = false; };
  }, []);

  // The virtual assistant node carries assistant_id + voice_mode in node.data.
  // Updates go to the edge that synthesizes this node (edgeId) — NOT to
  // flow.nodes, because the assistant handoff is persisted on the edge target.
  const assistantId = String(node.assistant_id || "");
  const voiceMode = node.voice_mode || "distinct";
  const assistantMissing = !assistantId.trim();
  const selectedOption = assistantOptions.find((o) => o.value === assistantId);

  function updateTarget(patch) {
    const existing = flow?.edges?.find((e) => String(e.id) === String(edgeId));
    const currentTarget = existing?.target || { type: "assistant", assistant_id: assistantId, voice_mode: voiceMode };
    onUpdateEdge(edgeId, { target: { ...currentTarget, type: "assistant", ...patch } });
  }

  return (
    <div className="p-4 space-y-4">
      <PanelHeader title={`Assistant node · ${node.name || "Assistant node"}`} />
      {assistantMissing && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
            <IconAlertTriangle className="size-3.5" /> Missing required configuration
          </div>
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-amber-600 dark:text-amber-400">
            <li>A target assistant is required.</li>
          </ul>
        </div>
      )}
      <Field label="Target Assistant" required error={assistantMissing ? "A target assistant is required." : null}>
        <Combobox
          value={assistantId}
          onChange={(val) => updateTarget({ assistant_id: val })}
          options={assistantOptions}
          placeholder="Select assistant…"
          triggerClassName="w-full"
          searchable
        />
        {selectedOption && (
          <p className="mt-1 text-xs text-muted-foreground">
            Routes the conversation to another assistant when this node is reached.
          </p>
        )}
      </Field>
      <Field label="Voice Mode">
        <Select
          value={voiceMode}
          onValueChange={(value) => updateTarget({ voice_mode: value })}
        >
          <SelectTrigger className="w-full text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="unified">Unified (keep current voice)</SelectItem>
            <SelectItem value="distinct">Distinct (target assistant&apos;s voice)</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {edgeId && (
        <Button variant="destructive" className="w-full" onClick={() => onDeleteEdge(edgeId)}>
          <IconTrash className="mr-2 size-4" /> Delete Edge
        </Button>
      )}
    </div>
  );
}

function NodeProperties({
  flow,
  node,
  values,
  models,
  libraryTools,
  libraryToolsLoading,
  onRefreshLibraryTools,
  onUpdateNode,
  onDeleteNode,
  onSetStart,
  edgeId,
  onUpdateEdge,
  onDeleteEdge,
}) {
  const variableNames = useMemo(
    () => Array.from(new Set([...OPENCLAW_SYSTEM_VARIABLES.map((variable) => variable.name), ...Object.keys(values?.dynamic_variables || {})])),
    [values?.dynamic_variables]
  );
  const isSpeak = node.type === "speak";
  const isAssistant = node.type === "assistant";

  if (isAssistant) {
    return (
      <AssistantNodeProperties
        flow={flow}
        node={node}
        edgeId={edgeId}
        onUpdateEdge={onUpdateEdge}
        onDeleteEdge={onDeleteEdge}
      />
    );
  }

  if (isSpeak) {
    return (
      <div className="p-4 space-y-4">
        <PanelHeader title={`Speak node · ${node.name || "Speak node"}`} />
        <Field label="Name">
          <Input value={node.name || ""} onChange={(event) => onUpdateNode(node.id, { name: event.target.value })} />
        </Field>
        <Field label="Message" required error={!String(node.message || "").trim() ? "Speak node requires a message." : null}>
          <VariableTextarea
            value={node.message || ""}
            onChange={(next) => onUpdateNode(node.id, { message: next })}
            availableVariables={variableNames}
            includeSecrets={false}
            highlightVariables
            rows={8}
            placeholder="Thanks for calling {{company_name}}."
          />
        </Field>
        <NodeActions
          isStart={flow.start_node_id === node.id}
          onSetStart={() => onSetStart(node.id)}
          onDelete={() => onDeleteNode(node.id)}
        />
      </div>
    );
  }

  return (
    <div className="p-4">
      <PanelHeader title={`Prompt node · ${node.name || "Prompt node"}`} />
      <Tabs defaultValue="agent" className="mt-4">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="agent">Agent</TabsTrigger>
          <TabsTrigger value="voice">Voice</TabsTrigger>
          <TabsTrigger value="tools">Tools</TabsTrigger>
        </TabsList>
        <TabsContent value="agent" className="space-y-4 pt-4">
          <Field label="Name">
            <Input value={node.name || ""} onChange={(event) => onUpdateNode(node.id, { name: event.target.value })} />
          </Field>
          <Field label="Instructions" required error={!String(node.instructions || "").trim() ? "Prompt node requires instructions." : null}>
            <VariableTextarea
              value={node.instructions || ""}
              onChange={(next) => onUpdateNode(node.id, { instructions: next })}
              availableVariables={variableNames}
              includeSecrets={false}
              highlightVariables
              rows={8}
              placeholder="Tell the assistant how to handle this step."
            />
          </Field>
          <Field label="Instructions Mode">
            <Select
              value={node.instructions_mode || "append"}
              onValueChange={(value) => onUpdateNode(node.id, { instructions_mode: value })}
            >
              <SelectTrigger className="w-full text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="append">Append to assistant instructions</SelectItem>
                <SelectItem value="replace">Replace assistant instructions</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <NodeLlmOverride node={node} values={values} models={models} onUpdateNode={onUpdateNode} />
          <NodeActions
            isStart={flow.start_node_id === node.id}
            onSetStart={() => onSetStart(node.id)}
            onDelete={() => onDeleteNode(node.id)}
          />
        </TabsContent>
        <TabsContent value="voice" className="space-y-4 pt-4">
          <p className="text-xs text-muted-foreground">
            Override the assistant voice for this step. Leave blank to use the assistant default
            {values?.voice ? ` (${values.voice})` : ""}.
          </p>
          <WorkflowVoicePicker
            value={{
              voice: node.voice_settings?.voice || "",
              voice_speed: node.voice_settings?.voice_speed ?? 1,
              expressive_mode: node.voice_settings?.expressive_mode,
            }}
            onChange={(next) =>
              onUpdateNode(node.id, {
                voice_settings: cleanObject({ ...(node.voice_settings || {}), ...next }),
              })
            }
          />
          <Button variant="outline" className="w-full" onClick={() => onUpdateNode(node.id, { voice_settings: undefined })}>
            Use Assistant Default
          </Button>
        </TabsContent>
        <TabsContent value="tools" className="space-y-4 pt-4">
          <ToolsPanel
            node={node}
            values={values}
            libraryTools={libraryTools}
            libraryToolsLoading={libraryToolsLoading}
            onRefreshLibraryTools={onRefreshLibraryTools}
            onUpdateNode={onUpdateNode}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ToolsPanel({ node, values, libraryTools, libraryToolsLoading, onRefreshLibraryTools, onUpdateNode }) {
  const assistantTools = useMemo(
    () => (Array.isArray(values?.tools) ? values.tools.filter((tool) => getSharedToolId(tool)) : []),
    [values]
  );

  // Two independent concepts:
  //  - `override`: whether the node may DISABLE individual assistant tools.
  //    Assistant-level tools are NEVER removable here — at most they can be
  //    toggled off when override is on. With override off they're locked on.
  //  - node-added tools: extra tools attached at the node level from the Tools
  //    Library. These live in their own section and are the ONLY removable ones.
  //
  // `shared_tool_ids` is the effective replace-set sent to Telnyx (undefined =>
  // inherit the assistant's tools verbatim). We derive the two sections from it
  // by membership against the assistant's tool ids. `tools_override` is a
  // UI-only flag (stripped before the flow is sent to Telnyx).
  const override = node.tools_override === true;

  const inheritedIds = useMemo(
    () => assistantTools.map((tool) => getSharedToolId(tool)).filter(Boolean),
    [assistantTools]
  );
  const inheritedSet = useMemo(() => new Set(inheritedIds), [inheritedIds]);

  // Resolve a tool object (for display name/type) from any id, across both the
  // assistant's own tools and the shared Tools Library.
  const toolById = useMemo(() => {
    const map = new Map();
    for (const tool of assistantTools) {
      const id = getSharedToolId(tool);
      if (id) map.set(id, tool);
    }
    for (const tool of libraryTools || []) {
      const id = getSharedToolId(tool);
      if (id && !map.has(id)) map.set(id, tool);
    }
    return map;
  }, [assistantTools, libraryTools]);

  // The node's explicit effective set (undefined => inherit all assistant tools).
  const effective = node.shared_tool_ids;
  const effectiveSet = useMemo(
    () => new Set(Array.isArray(effective) ? effective : []),
    [effective]
  );

  // Node-added tools = effective entries that are NOT assistant-level tools.
  const nodeAddedIds = useMemo(
    () => (Array.isArray(effective) ? effective.filter((id) => !inheritedSet.has(id)) : []),
    [effective, inheritedSet]
  );
  const nodeAddedSet = useMemo(() => new Set(nodeAddedIds), [nodeAddedIds]);

  // Whether an assistant tool is currently enabled for this node.
  //  - override off => always enabled (locked on)
  //  - override on  => enabled iff present in the effective set (or no explicit
  //    set yet, meaning it still inherits everything)
  function isInheritedEnabled(id) {
    if (!override) return true;
    if (!Array.isArray(effective)) return true;
    return effectiveSet.has(id);
  }

  // Compose and persist the effective set from the current intent.
  // enabledInheritedIds: which assistant tools stay on; addedIds: node tools.
  function commit({ nextOverride, enabledInheritedIds, addedIds }) {
    const ov = nextOverride;
    const added = addedIds;
    // Inherited tools that remain active. With override off, all stay on.
    const inheritedActive = ov ? enabledInheritedIds : inheritedIds;
    // If nothing is overridden and no node tools were added, fall back to
    // inheriting verbatim (undefined) so we don't pin a redundant replace-set.
    const allInheritedOn =
      inheritedActive.length === inheritedIds.length &&
      inheritedActive.every((id) => inheritedSet.has(id));
    if (!ov && added.length === 0 && allInheritedOn) {
      onUpdateNode(node.id, { shared_tool_ids: undefined, tools_override: undefined });
      return;
    }
    const next = [...inheritedActive, ...added];
    onUpdateNode(node.id, { shared_tool_ids: next, tools_override: ov || undefined });
  }

  function toggleOverride(checked) {
    if (checked) {
      // Turning override on: keep current enablement (all inherited on by
      // default) plus existing node tools.
      commit({ nextOverride: true, enabledInheritedIds: inheritedIds, addedIds: nodeAddedIds });
    } else {
      // Turning override off: all inherited tools become locked-on again; node
      // tools are preserved.
      commit({ nextOverride: false, enabledInheritedIds: inheritedIds, addedIds: nodeAddedIds });
    }
  }

  function toggleInheritedTool(id, enabled) {
    if (!override) return;
    const enabledInherited = inheritedIds.filter((tid) =>
      tid === id ? enabled : isInheritedEnabled(tid)
    );
    commit({ nextOverride: true, enabledInheritedIds: enabledInherited, addedIds: nodeAddedIds });
  }

  function addLibraryTool(toolId) {
    if (!toolId || nodeAddedSet.has(toolId) || inheritedSet.has(toolId)) return;
    const enabledInherited = inheritedIds.filter((tid) => isInheritedEnabled(tid));
    commit({
      nextOverride: override,
      enabledInheritedIds: enabledInherited,
      addedIds: [...nodeAddedIds, toolId],
    });
  }

  function removeNodeTool(toolId) {
    const enabledInherited = inheritedIds.filter((tid) => isInheritedEnabled(tid));
    commit({
      nextOverride: override,
      enabledInheritedIds: enabledInherited,
      addedIds: nodeAddedIds.filter((id) => id !== toolId),
    });
  }

  // Library tools not yet attached (and not assistant-level) — the picker pool.
  const addableLibraryTools = (libraryTools || []).filter((tool) => {
    const id = getSharedToolId(tool);
    return id && !nodeAddedSet.has(id) && !inheritedSet.has(id);
  });

  return (
    <div className="space-y-4">
      <div className="rounded-md border p-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">Override assistant tools</div>
          <Switch checked={override} onCheckedChange={toggleOverride} />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {override
            ? "Toggle which assistant tools are active for this step. Assistant tools can be disabled but not removed."
            : "This node inherits all of the assistant's tools. Turn on override to disable specific ones for this step."}
        </p>
      </div>

      <div>
        <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">Assistant tools</div>
        <div className="space-y-2">
          {assistantTools.length === 0 ? (
            <p className="rounded-md border p-3 text-xs text-muted-foreground">No shared assistant tools attached.</p>
          ) : assistantTools.map((tool) => {
            const id = getSharedToolId(tool);
            return (
              <ToolToggleRow
                key={id}
                tool={tool}
                disabled={!override}
                checked={isInheritedEnabled(id)}
                onCheckedChange={(checked) => toggleInheritedTool(id, checked)}
              />
            );
          })}
        </div>
      </div>

      <div>
        <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">Node tools</div>
        <div className="space-y-2">
          {nodeAddedIds.length === 0 ? (
            <p className="rounded-md border p-3 text-xs text-muted-foreground">No node-specific tools added. Add one from the library below.</p>
          ) : nodeAddedIds.map((id) => {
            const tool = toolById.get(id);
            return (
              <ToolSelectedRow
                key={id}
                name={tool ? getToolDisplayName(tool) : id}
                type={tool?.type || "Tool"}
                onRemove={() => removeNodeTool(id)}
              />
            );
          })}
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-xs font-medium uppercase text-muted-foreground">Tools Library</div>
          <Button type="button" size="icon" variant="ghost" className="size-7" onClick={onRefreshLibraryTools}>
            <IconRefresh className="size-4" />
          </Button>
        </div>
        <Select
          value=""
          disabled={libraryToolsLoading}
          onValueChange={addLibraryTool}
        >
          <SelectTrigger className="w-full text-sm">
            <SelectValue placeholder={libraryToolsLoading ? "Loading library tools…" : "Select a tool to add"} />
          </SelectTrigger>
          <SelectContent>
            {addableLibraryTools.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                {libraryToolsLoading ? "Loading…" : "No more tools available"}
              </div>
            ) : addableLibraryTools.map((tool) => {
              const id = getSharedToolId(tool);
              return (
                <SelectItem key={id} value={id}>
                  {getToolDisplayName(tool)} ({tool.type || "tool"})
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function ToolToggleRow({ tool, checked, disabled, onCheckedChange }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border p-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{getToolDisplayName(tool)}</div>
        <div className="text-xs text-muted-foreground">{tool.type || "Tool"}</div>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </div>
  );
}

function ToolSelectedRow({ name, type, onRemove }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border p-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{name}</div>
        <div className="text-xs text-muted-foreground">{type}</div>
      </div>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-7 text-muted-foreground hover:text-destructive"
        onClick={onRemove}
        aria-label="Remove tool"
      >
        <IconTrash className="size-4" />
      </Button>
    </div>
  );
}

function EdgeProperties({ edge, systemVariableNames = [], customVariableNames = [], onUpdateEdge, onDeleteEdge }) {
  const condition = edge.condition || { type: "llm", prompt: "" };
  const expression = condition.expression || {};
  const variable = expression.left?.name || "";
  const op = expression.op || "==";
  const right = expression.right || { type: "string_literal", value: "" };
  const valueType = right.type === "number_literal" ? "number" : right.type === "bool_literal" ? "boolean" : "string";

  const hasKnownVariable = systemVariableNames.includes(variable) || customVariableNames.includes(variable);
  const edgeIssues = useMemo(() => validateWorkflowEdge(edge), [edge]);
  const llmPromptMissing = condition.type === "llm" && !String(condition.prompt || "").trim();
  const variableMissing = condition.type === "expression" && !String(variable).trim();

  function updateCondition(next) {
    onUpdateEdge(edge.id, { condition: next });
  }

  return (
    <div className="p-4 space-y-4">
      <PanelHeader title="Edge" />
      {edgeIssues.length > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
            <IconAlertTriangle className="size-3.5" /> Missing required configuration
          </div>
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-amber-600 dark:text-amber-400">
            {edgeIssues.map((issue) => <li key={issue}>{issue}</li>)}
          </ul>
        </div>
      )}
      <Field label="Condition Type">
        <Select
          value={condition.type || "llm"}
          onValueChange={(type) => {
            if (type === "default") updateCondition({ type: "default" });
            else if (type === "expression") updateCondition({ type: "expression", expression: buildComparisonExpression({ variable: "", op: "==", value: "", valueType: "string" }) });
            else updateCondition({ type: "llm", prompt: "" });
          }}
        >
          <SelectTrigger className="w-full text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="llm">LLM Prompt</SelectItem>
            <SelectItem value="expression">Variable Comparison</SelectItem>
            <SelectItem value="default">Default</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {condition.type === "llm" && (
        <Field label="LLM Prompt" required error={llmPromptMissing ? "LLM prompt is required." : null}>
          <Textarea
            value={condition.prompt || ""}
            rows={5}
            onChange={(event) => updateCondition({ type: "llm", prompt: event.target.value })}
            placeholder="The caller wants to speak with a human."
          />
        </Field>
      )}
      {condition.type === "expression" && (
        <div className="space-y-3 rounded-md border p-3">
          <div className="text-sm font-medium">Variable Comparison</div>
          <Field label="Variable" required error={variableMissing ? "A variable is required." : null}>
            <Select
              value={variable || undefined}
              onValueChange={(value) => updateCondition({ type: "expression", expression: buildComparisonExpression({ variable: value, op, value: right.value, valueType }) })}
            >
              <SelectTrigger className="w-full font-mono text-xs">
                <SelectValue placeholder="Select a variable" />
              </SelectTrigger>
              <SelectContent>
                {systemVariableNames.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>System variables</SelectLabel>
                    {systemVariableNames.map((name) => (
                      <SelectItem key={`sys_${name}`} value={name} className="font-mono text-xs">{name}</SelectItem>
                    ))}
                  </SelectGroup>
                )}
                {customVariableNames.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Custom variables</SelectLabel>
                    {customVariableNames.map((name) => (
                      <SelectItem key={`custom_${name}`} value={name} className="font-mono text-xs">{name}</SelectItem>
                    ))}
                  </SelectGroup>
                )}
                {variable && !hasKnownVariable && (
                  <SelectGroup>
                    <SelectLabel>Current</SelectLabel>
                    <SelectItem value={variable} className="font-mono text-xs">{variable}</SelectItem>
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Operator">
            <Select
              value={op}
              onValueChange={(value) => updateCondition({ type: "expression", expression: buildComparisonExpression({ variable, op: value, value: right.value, valueType }) })}
            >
              <SelectTrigger className="w-full text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["==", "!=", "<", "<=", ">", ">=", "contains", "not_contains"].map((operator) => (
                  <SelectItem key={operator} value={operator}>{operator}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Value Type">
            <Select
              value={valueType}
              onValueChange={(value) => updateCondition({ type: "expression", expression: buildComparisonExpression({ variable, op, value: right.value, valueType: value }) })}
            >
              <SelectTrigger className="w-full text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="string">String</SelectItem>
                <SelectItem value="number">Number</SelectItem>
                <SelectItem value="boolean">Boolean</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Value">
            <Input
              value={String(right.value ?? "")}
              onChange={(event) => updateCondition({ type: "expression", expression: buildComparisonExpression({ variable, op, value: event.target.value, valueType }) })}
              placeholder="enterprise"
            />
          </Field>
        </div>
      )}
      <Button variant="destructive" className="w-full" onClick={() => onDeleteEdge(edge.id)}>
        <IconTrash className="mr-2 size-4" /> Delete Edge
      </Button>
    </div>
  );
}

function NodeActions({ isStart, onSetStart, onDelete }) {
  if (isStart) {
    // The start node cannot be deleted; only show its (disabled) start control.
    return (
      <Button variant="outline" className="w-full" disabled>
        Start node
      </Button>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      <Button variant="outline" onClick={onSetStart}>Set as Start</Button>
      <Button variant="destructive" onClick={onDelete}><IconTrash className="mr-2 size-4" />Delete Node</Button>
    </div>
  );
}

function SecretsCombobox({ value, onChange, className }) {
  const [options, setOptions] = useState([]);
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch("/api/integration-secrets", { cache: "no-store" });
        const data = await res.json();
        if (mounted && res.ok && data?.ok) {
          setOptions((data.secrets || []).map((s) => ({ value: s.identifier, label: s.identifier })));
        }
      } catch (_) {
        if (mounted) setOptions([]);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);
  return (
    <Combobox
      value={value || ""}
      onChange={onChange}
      options={options}
      placeholder="Select integration secret…"
      emptyLabel="No secrets found"
      triggerClassName={className || "w-full"}
      searchable
    />
  );
}

function NodeLlmOverride({ node, values, models, onUpdateNode }) {
  const isOverride = Boolean(node.model);
  const recommendedModels = useMemo(
    () => (Array.isArray(models) ? models : []).filter((model) => model.recommended_for_assistants),
    [models]
  );
  const selectedModel = useMemo(
    () => (Array.isArray(models) ? models : []).find((model) => String(model.id) === String(node.model)) || null,
    [models, node.model]
  );
  const ownedBy = selectedModel?.raw?.owned_by;
  const requiresSecret = ownedBy ? String(ownedBy).toLowerCase() !== "telnyx" : false;

  return (
    <Field label="LLM">
      <Tabs
        value={isOverride ? "override" : "default"}
        onValueChange={(value) => {
          if (value === "default") {
            onUpdateNode(node.id, { model: undefined, llm_api_key_ref: undefined });
          } else if (!node.model) {
            const fallback = recommendedModels[0]?.id || (Array.isArray(models) ? models[0]?.id : "") || "";
            onUpdateNode(node.id, { model: fallback || undefined });
          }
        }}
      >
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="default">Assistant default</TabsTrigger>
          <TabsTrigger value="override">Override</TabsTrigger>
        </TabsList>
        <TabsContent value="default" className="pt-2">
          <p className="text-xs text-muted-foreground">
            Uses the assistant model{values?.model ? ` (${values.model})` : ""}.
          </p>
        </TabsContent>
        <TabsContent value="override" className="space-y-3 pt-2">
          <AIModels
            value={node.model || ""}
            onValueChange={(value) => onUpdateNode(node.id, { model: value || undefined })}
            models={recommendedModels}
            triggerClassName="w-full max-w-full"
            contentClassName="w-[var(--radix-select-trigger-width)] max-w-[var(--radix-select-trigger-width)]"
          />
          {requiresSecret && (
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">LLM API Key Reference</Label>
              <SecretsCombobox
                value={node.llm_api_key_ref || ""}
                onChange={(value) => onUpdateNode(node.id, { llm_api_key_ref: value || undefined })}
              />
            </div>
          )}
        </TabsContent>
      </Tabs>
    </Field>
  );
}

function PanelHeader({ title }) {
  return <div className="text-sm font-semibold">{title}</div>;
}

function Field({ label, children, required = false, error = null }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-muted-foreground">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </Label>
      {children}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}

function cleanObject(value) {
  if (!value || typeof value !== "object") return undefined;
  const next = Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== ""));
  return Object.keys(next).length ? next : undefined;
}

function WorkflowEditor({ values, setValues, assistantId }) {
  const reactFlowWrapper = useRef(null);
  const flow = values?.conversation_flow;
  const workflowIdentity = assistantId || values?.id || values?.assistant_id || "";
  const [nodes, setNodes] = useNodesState(toReactFlowNodes(flow));
  const [edges, setEdges] = useEdgesState(toReactFlowEdges(flow));
  const [reactFlowInstance, setReactFlowInstance] = useState(null);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [libraryTools, setLibraryTools] = useState([]);
  const [libraryToolsLoading, setLibraryToolsLoading] = useState(false);
  const [models, setModels] = useState([]);
  const localLayoutSignatureRef = useRef("");
  // Guard the flow→nodes/edges sync effect: when updateNode/updateEdge fire
  // they update both values.conversation_flow AND the ReactFlow nodes/edges
  // state in the same batch. Without this guard the effect would fire on the
  // next tick (because flow.nodes/edges got a new reference) and recreate all
  // nodes/edges from flow — producing a stale render between the two updates
  // that resets controlled-input cursor position to end-of-field.
  const internalUpdateRef = useRef(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/ai/models", { cache: "no-store" });
        const data = await res.json();
        if (active && res.ok && data?.ok) setModels(data.models || []);
      } catch (_) {
        if (active) setModels([]);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Sync from external flow changes (prop update / load existing workflow /
  // normalize-layout pass) into ReactFlow state. When the change originated
  // from updateNode/updateEdge below we already updated nodes/edges state in
  // the same batch, so we skip the recreation here to avoid a stale interim
  // render that would reset controlled-input cursor position.
  useEffect(() => {
    if (!flow) return;
    if (internalUpdateRef.current) {
      internalUpdateRef.current = false;
      return;
    }
    const currentLayoutSignature = workflowLayoutSignature(flow);
    if (localLayoutSignatureRef.current === currentLayoutSignature) {
      setNodes(toReactFlowNodes(flow, { normalize: false }));
      setEdges(toReactFlowEdges(flow));
      return;
    }
    const normalizedFlow = normalizeWorkflowCanvasLayout(flow);
    if (workflowLayoutSignature(normalizedFlow) !== workflowLayoutSignature(flow)) {
      setValues((current) => ({ ...current, conversation_flow: normalizedFlow }));
      return;
    }
    setNodes(toReactFlowNodes(normalizedFlow));
    setEdges(toReactFlowEdges(normalizedFlow));
  }, [flow?.start_node_id, flow?.nodes, flow?.edges, setValues, setNodes, setEdges]);

  // Mirror Call Flows: let ReactFlow frame the nodes via the fitView prop.
  // When the canvas mounts inside an inactive tab its container can measure 0px,
  // so re-fit once the instance is ready and whenever the node count or the
  // active workflow identity changes (load existing flow or add a node).
  useEffect(() => {
    if (!reactFlowInstance || !nodes.length) return;
    const frame = window.requestAnimationFrame(() => {
      reactFlowInstance.fitView({ padding: 0.2, includeHiddenNodes: false, duration: 0 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [reactFlowInstance, nodes.length, workflowIdentity]);

  const persist = useCallback((nextNodes, nextEdges, baseFlow = flow) => {
    const nextFlow = reactFlowToConversationFlow({
      flow: baseFlow,
      nodes: nextNodes,
      edges: nextEdges,
    });
    localLayoutSignatureRef.current = workflowLayoutSignature(nextFlow);
    setValues((current) => ({ ...current, conversation_flow: nextFlow }));
  }, [flow, setValues]);

  const loadLibraryTools = useCallback(async () => {
    setLibraryToolsLoading(true);
    try {
      const res = await fetch("/api/ai/tools?all=true", { cache: "no-store" });
      const data = await res.json();
      const tools = Array.isArray(data?.items) ? data.items : Array.isArray(data?.tools) ? data.tools : Array.isArray(data?.data) ? data.data : [];
      setLibraryTools(tools);
    } catch (_) {
      setLibraryTools([]);
    } finally {
      setLibraryToolsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadLibraryTools();
  }, [loadLibraryTools]);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) || null;
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId) || null;

  // Drive the `selected` flag from OUR selection state, not ReactFlow's internal
  // selection. ReactFlow's built-in selection flickers on mousedown and clears on
  // mouseup (we manage selection via onNodeClick/onEdgeClick + selectedNodeId), so
  // the node/edge `selected` prop would never stick. Inject it here so the green
  // border/ring persists for the actively selected element.
  // Also inject per-node validation issues so the canvas warning icon stays in
  // sync with the current flow state (instructions/message/outgoing-edge checks).
  const decoratedNodes = useMemo(
    () => nodes.map((node) => {
      const nodeIssues = validateWorkflowNode(node.data?.node, flow);
      const basePatch = { selected: node.id === selectedNodeId };
      const prevIssues = node.data?.nodeIssues || [];
      const issuesChanged = prevIssues.length !== nodeIssues.length ||
        prevIssues.some((issue, index) => issue !== nodeIssues[index]);
      if (!issuesChanged && node.selected === basePatch.selected) return node;
      return {
        ...node,
        data: { ...node.data, nodeIssues },
        selected: basePatch.selected,
      };
    }),
    [nodes, selectedNodeId, flow]
  );
  const decoratedEdges = useMemo(
    () => edges.map((edge) => {
      const edgeIssues = validateWorkflowEdge(edge.data?.edge, flow);
      const prevIssues = edge.data?.edgeIssues || [];
      const issuesChanged = prevIssues.length !== edgeIssues.length ||
        prevIssues.some((issue, index) => issue !== edgeIssues[index]);
      const wantSelected = edge.id === selectedEdgeId;
      if (!issuesChanged && edge.selected === wantSelected) return edge;
      return {
        ...edge,
        data: { ...edge.data, edgeIssues },
        selected: wantSelected,
      };
    }),
    [edges, selectedEdgeId, flow]
  );

  const onNodesChange = useCallback((changes) => {
    const next = applyNodeChanges(changes, nodes);
    setNodes(next);
    const shouldPersistNodeChanges = changes.some(
      (change) => change.type !== "dimensions" && change.type !== "select"
    );
    if (shouldPersistNodeChanges) {
      persist(next, edges);
    }
  }, [edges, nodes, persist, setNodes]);

  const onEdgesChange = useCallback((changes) => {
    const next = applyEdgeChanges(changes, edges);
    setEdges(next);
    const shouldPersistEdgeChanges = changes.some((change) => change.type !== "select");
    if (shouldPersistEdgeChanges) {
      persist(nodes, next);
    }
  }, [edges, nodes, persist, setEdges]);

  const onConnect = useCallback((params) => {
    const sourceNode = flow.nodes.find((node) => String(node.id) === String(params.source));
    const condition = sourceNode?.type === "speak"
      ? { type: "default" }
      : { type: "llm", prompt: "" };
    const workflowEdge = {
      id: `e_${params.source}_${params.target}_${Date.now()}`,
      start_node_id: String(params.source),
      target: { type: "node", node_id: String(params.target) },
      condition,
    };
    const reactEdge = {
      id: workflowEdge.id,
      ...params,
      sourceHandle: params.sourceHandle || "output-0",
      targetHandle: params.targetHandle || "input-execute",
      type: "workflowEdge",
      data: { edge: workflowEdge },
    };
    setEdges((current) => {
      const next = addEdge(reactEdge, current);
      persist(nodes, next);
      return next;
    });
  }, [flow?.nodes, nodes, persist]);

  const onDragStart = useCallback((event, nodeType) => {
    event.dataTransfer.setData(NODE_TRANSFER_TYPE, nodeType);
    event.dataTransfer.effectAllowed = "move";
  }, []);

  const handleAddNode = useCallback((nodeType, position = null) => {
    if (nodeType === "assistant") {
      // Adding an Assistant Handoff from the palette creates a virtual
      // assistant node (not persisted to flow.nodes) plus an edge from the
      // most recently added real node so the user can immediately configure
      // the target assistant. The virtual node is completed once the user
      // picks an assistant_id in its properties panel.
      const pos = position || defaultWorkflowNodePosition(nodes.length);
      const sourceNode = nodes[nodes.length - 1];
      if (!sourceNode) return; // need at least one real node to connect from
      const placeholderId = `assistant:pending_${Date.now()}`;
      const virtualNode = {
        id: placeholderId,
        type: "customNode",
        position: pos,
        data: {
          node: { type: "assistant", assistant_id: "", voice_mode: "unified" },
          nodeType: "assistant",
          label: "Assistant node",
          edgeId: null,
        },
      };
      const newEdge = {
        id: `e_${sourceNode.id}_${placeholderId}_${Date.now()}`,
        source: String(sourceNode.id),
        target: placeholderId,
        sourceHandle: "output-0",
        targetHandle: "input-execute",
        type: "workflowEdge",
        data: {
          edge: {
            id: `e_${sourceNode.id}_${placeholderId}_${Date.now()}`,
            start_node_id: String(sourceNode.id),
            target: { type: "assistant", assistant_id: "", voice_mode: "unified", position: { x: pos.x, y: pos.y } },
            condition: { type: "llm", prompt: "" },
          },
        },
      };
      const nextNodes = [...nodes, virtualNode];
      const nextEdges = [...edges, newEdge];
      persist(nextNodes, nextEdges);
      setNodes(nextNodes);
      setEdges(nextEdges);
      setSelectedNodeId(placeholderId);
      setSelectedEdgeId(null);
      return;
    }
    const workflowNode = createWorkflowNode(
      nodeType,
      position || defaultWorkflowNodePosition(nodes.length)
    );
    const normalized = normalizeWorkflowNode(workflowNode, nodes.length);
    const reactNode = {
      id: String(normalized.id),
      type: "customNode",
      position: normalized.position,
      data: {
        node: normalized,
        nodeType: normalized.type,
        label: normalized.name || workflowNodeLabel(normalized.type),
        nodeId: normalized.id,
        nodeNumber: nodes.length + 1,
        isStart: false,
      },
    };
    const nextNodes = [...nodes, reactNode];
    persist(nextNodes, edges);
    setNodes(nextNodes);
    setSelectedNodeId(normalized.id);
    setSelectedEdgeId(null);
  }, [edges, nodes, persist]);

  const onDrop = useCallback((event) => {
    event.preventDefault();
    const nodeType = event.dataTransfer.getData(NODE_TRANSFER_TYPE);
    if (!nodeType || !reactFlowInstance || !reactFlowWrapper.current) return;
    const bounds = reactFlowWrapper.current.getBoundingClientRect();
    const position = reactFlowInstance.project({
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    });
    handleAddNode(nodeType, position);
  }, [handleAddNode, reactFlowInstance]);

  const updateNode = useCallback((nodeId, patch) => {
    // Update both values.conversation_flow (source of truth) and the ReactFlow
    // nodes state in the same React batch so the properties panel re-renders
    // with the new value immediately — without this, the panel reads from the
    // stale `nodes` state until the flow→nodes effect fires on the next tick,
    // and that interim render resets controlled-input cursor position.
    internalUpdateRef.current = true;
    setNodes((currentNodes) => currentNodes.map((rfNode) => {
      if (String(rfNode.id) !== String(nodeId)) return rfNode;
      const nextNodeData = cleanObjectPreserve({ ...rfNode.data?.node, ...patch });
      return { ...rfNode, data: { ...rfNode.data, node: nextNodeData } };
    }));
    const nextFlow = {
      ...flow,
      nodes: flow.nodes.map((node) => String(node.id) === String(nodeId) ? cleanObjectPreserve({ ...node, ...patch }) : node),
    };
    setValues((current) => ({ ...current, conversation_flow: nextFlow }));
  }, [flow, setValues, setNodes]);

  const deleteNode = useCallback((nodeId) => {
    const remainingNodes = flow.nodes.filter((node) => String(node.id) !== String(nodeId));
    const nextFlow = {
      ...flow,
      start_node_id: String(flow.start_node_id) === String(nodeId) ? remainingNodes[0]?.id || "" : flow.start_node_id,
      nodes: remainingNodes,
      edges: flow.edges.filter((edge) => String(edge.start_node_id) !== String(nodeId) && String(edge.target?.node_id) !== String(nodeId)),
    };
    setValues((current) => ({ ...current, conversation_flow: nextFlow }));
    setSelectedNodeId(null);
  }, [flow, setValues]);

  const updateEdge = useCallback((edgeId, patch) => {
    // Same dual-update as updateNode: keep ReactFlow edges state in sync with
    // values.conversation_flow within one batch to avoid stale renders that
    // reset controlled-input cursor position in the edge properties panel.
    internalUpdateRef.current = true;
    setEdges((currentEdges) => currentEdges.map((rfEdge) => {
      if (String(rfEdge.id) !== String(edgeId)) return rfEdge;
      const nextEdgeData = { ...rfEdge.data?.edge, ...patch };
      return { ...rfEdge, data: { ...rfEdge.data, edge: nextEdgeData } };
    }));
    // If the patch updates an assistant target (assistant_id / voice_mode),
    // also sync the virtual node on the canvas so reactFlowToConversationFlow
    // reads the up-to-date values on the next persist — otherwise the stale
    // virtual node overwrites the new edge target on save.
    if (patch?.target?.type === "assistant") {
      const assistantId = patch.target.assistant_id || "";
      const virtualId = assistantId ? `assistant:${assistantId}` : null;
      setNodes((currentNodes) => currentNodes.map((rfNode) => {
        const n = rfNode.data?.node;
        if (!n || n.type !== "assistant") return rfNode;
        if (virtualId && String(rfNode.id) !== virtualId) return rfNode;
        return {
          ...rfNode,
          data: {
            ...rfNode.data,
            node: {
              ...n,
              assistant_id: patch.target.assistant_id ?? n.assistant_id,
              voice_mode: patch.target.voice_mode ?? n.voice_mode,
            },
          },
        };
      }));
    }
    const nextFlow = {
      ...flow,
      edges: flow.edges.map((edge) => edge.id === edgeId ? { ...edge, ...patch } : edge),
    };
    setValues((current) => ({ ...current, conversation_flow: nextFlow }));
  }, [flow, setValues, setEdges, setNodes]);

  const deleteEdge = useCallback((edgeId) => {
    const nextFlow = { ...flow, edges: flow.edges.filter((edge) => edge.id !== edgeId) };
    setValues((current) => ({ ...current, conversation_flow: nextFlow }));
    setSelectedEdgeId(null);
  }, [flow, setValues]);

  return (
    <div className="flex h-full min-h-0 overflow-hidden rounded-md border">
      <WorkflowNodePalette onAddNode={handleAddNode} onDragStart={onDragStart} />
      <div className="min-h-0 flex-1 flex flex-col">
        <div ref={reactFlowWrapper} className="call-flow-canvas min-h-0 flex-1 relative" onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={onDrop}>
          <ReactFlow
            nodes={decoratedNodes}
            edges={decoratedEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(event, node) => {
              setSelectedNodeId(node.id);
              setSelectedEdgeId(null);
            }}
            onEdgeClick={(event, edge) => {
              setSelectedEdgeId(edge.id);
              setSelectedNodeId(null);
            }}
            onPaneClick={() => {
              setSelectedNodeId(null);
              setSelectedEdgeId(null);
            }}
            onInit={setReactFlowInstance}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls className="call-flow-controls" position="bottom-left" />
            <Panel position="bottom-right" className="bg-card border rounded p-2 text-xs">
              <div className="text-muted-foreground">
                {nodes.length} nodes • {edges.length} connections
              </div>
              <div className="text-xs text-muted-foreground mt-0">
                Drag nodes from sidebar or right-click to add
              </div>
            </Panel>
          </ReactFlow>
        </div>
      </div>
      <WorkflowPropertiesPanel
        flow={flow}
        selectedNode={selectedNode}
        selectedEdge={selectedEdge}
        values={values}
        models={models}
        libraryTools={libraryTools}
        libraryToolsLoading={libraryToolsLoading}
        onRefreshLibraryTools={loadLibraryTools}
        onDisable={() => setValues((current) => ({ ...current, conversation_flow: null }))}
        onUpdateNode={updateNode}
        onDeleteNode={deleteNode}
        onSetStart={(nodeId) => setValues((current) => ({ ...current, conversation_flow: { ...current.conversation_flow, start_node_id: nodeId } }))}
        onUpdateEdge={updateEdge}
        onDeleteEdge={deleteEdge}
      />
    </div>
  );
}

function cleanObjectPreserve(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function WorkflowBlockedByInlineTools({ blockers }) {
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-5">
      <div className="flex items-start gap-3">
        <IconAlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600" />
        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold">Make your tools shared to use Workflows</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Conversation workflows can only use tools from your shared library. This assistant has {blockers.length} tools that aren&apos;t shared yet. Save them to your library, then enable the workflow.
            </p>
          </div>
          <div>
            <div className="text-xs font-medium uppercase text-muted-foreground">Tools to make shared:</div>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              {blockers.map((tool) => <li key={tool.name}>{tool.name}</li>)}
            </ul>
          </div>
          <p className="text-xs text-muted-foreground">
            To make a tool shared, open the Tools section in the Agent tab, find the tool, and use the “Save to Library” action.
          </p>
        </div>
      </div>
    </div>
  );
}

function WorkflowEmptyState({ setValues }) {
  return (
    <div className="rounded-md border bg-muted/20 p-8 text-center">
      <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-md border bg-background">
        <IconGitBranch className="size-6 text-telnyx-green" />
      </div>
      <h3 className="text-base font-semibold">Workflow is disabled</h3>
      <p className="mx-auto mt-1 max-w-xl text-sm text-muted-foreground">
        Enable conversation workflows to design prompt and speak nodes with call-flows-style drag and drop.
      </p>
      <Button className="mt-4" onClick={() => setValues((current) => ({ ...current, conversation_flow: createDefaultConversationFlow() }))}>
        <IconPlus className="mr-2 size-4" /> Enable Workflow
      </Button>
    </div>
  );
}

export default function AssistantWorkflowTab({ values, setValues, assistantId }) {
  const blockers = getInlineToolsBlockingWorkflow(values);
  const flow = values?.conversation_flow;
  const tools = Array.isArray(values?.tools) ? values.tools : [];

  // A handoff tool forces the legacy capability graph view and disables the
  // toggle — mirroring the Telnyx Portal behaviour where an assistant with a
  // handoff tool cannot use the new conversation workflow editor until the
  // handoff tool is removed.
  const hasHandoffTool = tools.some((tool) => tool?.type === "handoff");

  // User-selected view: "workflow" (conversation workflow editor) or
  // "capability" (read-only auto-generated tool graph). The handoff tool
  // overrides any user choice and forces "capability".
  const [viewMode, setViewMode] = useState("workflow");
  const effectiveMode = hasHandoffTool ? "capability" : viewMode;

  return (
    <div className="flex h-full min-h-0 flex-col space-y-3 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 flex-shrink-0">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium">
            <IconGitBranch className="size-4 text-telnyx-green" />
            {effectiveMode === "capability" ? "Assistant Workflow" : "Conversation Workflow"}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* View toggle — disabled when a handoff tool is present */}
          <div className="inline-flex rounded-md border bg-muted/40 p-0.5">
            <button
              type="button"
              disabled={hasHandoffTool}
              onClick={() => setViewMode("workflow")}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium transition",
                effectiveMode === "workflow"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
                hasHandoffTool && "cursor-not-allowed opacity-50"
              )}
              title={hasHandoffTool ? "Remove the handoff tool to use the conversation workflow editor" : "Conversation workflow editor"}
            >
              Conversation Workflow
            </button>
            <button
              type="button"
              disabled={hasHandoffTool}
              onClick={() => setViewMode("capability")}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium transition",
                effectiveMode === "capability"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
                hasHandoffTool && "cursor-not-allowed opacity-50"
              )}
              title={hasHandoffTool ? "Capability graph is required when a handoff tool is configured" : "Read-only capability graph"}
            >
              Capability Graph
            </button>
          </div>
          {effectiveMode === "workflow" && flow && (
            <Badge variant="outline" className="rounded">{flow.nodes?.length || 0} nodes</Badge>
          )}
          {effectiveMode === "capability" && (
            <Badge variant="outline" className="rounded">{tools.length} tool{tools.length === 1 ? "" : "s"}</Badge>
          )}
        </div>
      </div>

      {/* Disclaimer banner when handoff tool blocks the workflow editor */}
      {hasHandoffTool && (
        <div className="flex flex-shrink-0 items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-4">
          <IconInfoCircle className="mt-0.5 size-5 shrink-0 text-amber-600" />
          <div className="space-y-1 text-sm">
            <div className="font-semibold">Workflows unavailable</div>
            <p className="text-muted-foreground">
              Workflows cannot be used while this assistant has a handoff tool configured. Remove the handoff tool to use Workflows.
            </p>
          </div>
        </div>
      )}

      {effectiveMode === "capability" ? (
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <AssistantCapabilityGraph values={values} setValues={setValues} assistantId={assistantId} />
        </div>
      ) : blockers.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <WorkflowBlockedByInlineTools blockers={blockers} />
        </div>
      ) : flow ? (
        <div className="min-h-0 flex-1">
          <WorkflowEditor values={values} setValues={setValues} assistantId={assistantId} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <WorkflowEmptyState setValues={setValues} />
        </div>
      )}

      <style jsx global>{`
        .call-flow-canvas .react-flow__controls {
          border: 1px solid hsl(var(--border));
          border-radius: 6px;
          box-shadow: 0 8px 24px rgb(0 0 0 / 0.28);
          overflow: hidden;
        }
        .call-flow-canvas .react-flow__controls-button {
          width: 30px;
          height: 30px;
          border-bottom: 1px solid hsl(var(--border));
          background: hsl(var(--background));
          color: hsl(var(--foreground));
          fill: currentColor;
        }
        .call-flow-canvas .react-flow__controls-button:hover {
          background: hsl(var(--muted));
        }
        .call-flow-canvas .react-flow__attribution {
          display: none;
        }
        .call-flow-canvas .react-flow__node {
          visibility: visible !important;
        }
      `}</style>
    </div>
  );
}
