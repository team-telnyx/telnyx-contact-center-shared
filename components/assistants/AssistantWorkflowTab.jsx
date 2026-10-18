"use client";
import { sourceText } from "@/lib/i18n/source-text.mjs";
import { useUiText } from "@/components/i18n/use-ui-text";


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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger, tabsTriggerCompactClass } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Combobox } from "@/components/ui/combobox";
import WorkflowExpressionEditor from "./WorkflowExpressionEditor";
import AssistantModelConfiguration from "./AssistantModelConfiguration";
import AssistantTranscriptionSettings from "./AssistantTranscriptionSettings";
import { Skeleton } from "@/components/ui/skeleton";
import TtsVoicePicker from "./VoicePicker";
import AssistantToolAudioSettings from "./AssistantToolAudioSettings";
import { assistantForEditor, assistantVoiceSettings } from "@/lib/ai/assistant-draft.mjs";
import { compatibleVoiceAudio } from "@/lib/ai/assistant-audio-ui.mjs";
import AssistantCapabilityGraph from "@/components/assistants/AssistantCapabilityGraph";
import { VariableTextarea } from "@/components/voice-flow/VariableTextarea";
import { hydrateWorkflowCanvasNodes, addAssistantHandoff, updateAssistantHandoff, defaultConnectionCondition, defaultWorkflowNodePosition, normalizeWorkflowNode, toReactFlowNodes, toReactFlowEdges, reactFlowToConversationFlow, virtualAssistantNodeId } from "@/lib/ai/assistant-workflow-canvas.mjs";
import { cn } from "@/lib/utils";
import {
  ASSISTANT_TOOL_LIBRARY_SOURCE_KEY,
  ASSISTANT_TOOL_LIBRARY_SOURCE_VALUE,
} from "@/lib/ai/tool-library";
import { cloneAssistantTranscriptionOverride } from "@/lib/ai/assistant-transcription.mjs";
import { cloneAssistantOverride } from "@/lib/ai/assistant-overrides.mjs";
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
  tool: {label:"Tool node", color:"#F59E0B", icon:IconRobot, inputs:1, outputs:1, inputLabel:"Execute", outputLabels:["Next"], category:"AI ASSISTANT"},
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
  const tUi = useUiText();
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
      style={{ width: "280px" }}
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
          <Badge className="bg-telnyx-green/15 text-telnyx-green border-telnyx-green/30 text-[10px] font-semibold uppercase tracking-wide">{tUi("Start")}</Badge>
        </div>
      )}

      <div className="flex items-center justify-between px-2 py-2 border-y">
        <div className="flex min-w-0 items-center gap-2">
          <div
            className="flex items-center justify-center w-8 h-8 rounded-md flex-shrink-0"
            style={{ backgroundColor: `${nodeDef.color}20`, color: nodeDef.color }}
          >
            <IconComponent className="h-5 w-5" />
          </div>
          <div className="truncate font-semibold text-base" title={data.label}>{data.label}</div>
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
                <TooltipContent side="bottom" className="max-w-xs [overflow-wrap:anywhere]">
                  <div className="space-y-1">
                    <div className="font-semibold text-xs">{tUi("Missing required configuration:")}</div>
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
  const tUi = useUiText();
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const condition = data?.edge?.condition || {};
  const label = edgeLabel(condition, tUi);
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
                    <TooltipContent side="bottom" className="max-w-xs [overflow-wrap:anywhere]">
                      <div className="space-y-1">
                        <div className="font-semibold text-xs">{tUi("Missing required configuration:")}</div>
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

function workflowLayoutSignature(flow) {
  return JSON.stringify((flow?.nodes || []).map((node) => ({
    id: String(node.id || ""),
    x: Number(node.position?.x ?? 0),
    y: Number(node.position?.y ?? 0),
  })));
}

function edgeLabel(condition = {}, tUi = sourceText) {
  if (condition.type === "default") return tUi("Default");
  if (condition.type === "expression") return expressionLabel(condition.expression, tUi) || tUi("Variable Comparison");
  return tUi("LLM Prompt");
}

function expressionLabel(expression, tUi = sourceText) {
  if (expression?.type === "bool_op") return tUi(expression.op === "and" ? "All conditions" : expression.op === "or" ? "Any condition" : "Condition is not met");
  if (!expression || expression.type !== "comparison") return "";
  const left = expression.left?.name || expression.left?.value || "variable";
  const op = expression.op || "==";
  const right = expression.right;
  const value = right?.type === "string_literal" ? `\"${right.value ?? ""}\"` : String(right?.value ?? "");
  return `${left} ${op} ${value}`;
}

function WorkflowNodePalette({ onAddNode, onDragStart }) {
  const tUi = useUiText();
  const nodesByCategory = {
    "AI ASSISTANT": [
      { id: "prompt", ...WORKFLOW_NODE_DEFS.prompt },
      { id: "speak", ...WORKFLOW_NODE_DEFS.speak },
      { id: "tool", ...WORKFLOW_NODE_DEFS.tool },
      { id: "assistant", ...WORKFLOW_NODE_DEFS.assistant },
    ],
  };

  return (
    <div className="w-64 border-r bg-card flex flex-col h-full">
      <Tabs value="nodes" className="flex-1 flex flex-col h-full">
        <TabsList className="px-4">
          <TabsTrigger value="nodes">{tUi("Nodes")}</TabsTrigger>
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
  const tUi = useUiText();
  const errors = useMemo(() => validateConversationFlow(flow, {allowInheritedInstructions: true}, tUi), [flow, tUi]);

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
        sourceType={flow.nodes.find(node => node.id === selectedEdge.data?.edge?.start_node_id)?.type}
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
            <IconGitBranch className="size-4 text-telnyx-green" />{tUi("Workflow")}</div>
          <p className="mt-1 text-xs text-muted-foreground">
            {(flow.nodes?.length || 0) + (flow.edges || []).filter(edge => edge.target?.type === "assistant").length + (flow._assistantDrafts?.length || 0)}{tUi(" nodes, ")}{flow.edges?.length || 0}{tUi(" edges")}</p>
        </div>
        <p className="text-sm text-muted-foreground">{tUi("Select a step or connection to edit it. Add an Assistant node to hand the conversation to another assistant.")}</p>
        <Button variant="outline" className="w-full" onClick={onDisable}>{tUi("Disable Workflow")}</Button>
      </div>
    );
  }

  return (
    <div data-workflow-properties className="flex h-full min-w-0 [overflow-wrap:anywhere] w-[380px] max-w-[48%] shrink-0 flex-col border-l bg-card xl:w-[440px]">
      <div className="flex-1 min-h-0 min-w-0 overflow-x-hidden overflow-y-auto">
        {errors.length > 0 && (
          <div role="status" aria-live="polite" className="m-4 mb-0 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
            <div className="mb-1 font-medium">{tUi("Validation")}</div>
            <ul className="list-disc space-y-1 pl-4">
              {errors.map((error, index) => <li key={index}>{error}</li>)}
            </ul>
          </div>
        )}
        {configContent}
      </div>
    </div>
  );
}

function AssistantNodeProperties({ flow, node, edgeId, variableNames, onUpdateEdge, onDeleteNode }) {
  const tUi = useUiText();
  const [catalog, setCatalog] = useState({status: "loading", options: []});
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/ai/assistants?all=true", {cache: "no-store", signal: controller.signal});
        const data = await res.json();
        if (!res.ok || !data?.ok) throw new Error("assistants");
        if (!controller.signal.aborted) setCatalog({status: "ready", options: (data.items || []).map(a => ({value: a.id, label: a.name || tUi("Unnamed assistant"), Icon: IconRobot}))});
      } catch (_) {
        if (!controller.signal.aborted) setCatalog({status: "error", options: []});
      }
    })();
    return () => controller.abort();
  }, [retry, tUi]);
  const assistantOptions = catalog.options;
  const edge = flow.edges.find(candidate => String(candidate.id) === String(edgeId));

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
      <PanelHeader title={tUi("Assistant handoff")} />
      {assistantMissing && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
            <IconAlertTriangle className="size-3.5" />{tUi(" Missing required configuration")}</div>
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-amber-600 dark:text-amber-400">
            <li>{tUi("A target assistant is required.")}</li>
          </ul>
        </div>
      )}
      <Field label={tUi("From step")}>
        <Select value={edge?.start_node_id || "__disconnected"} onValueChange={sourceId => onUpdateEdge(edgeId, {start_node_id: sourceId === "__disconnected" ? "" : sourceId})}>
          <SelectTrigger className="w-full" aria-label={tUi("From step")}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="__disconnected">{tUi("Not connected")}</SelectItem>{flow.nodes.map((step, index) => <SelectItem key={step.id} value={step.id}>{step.name || tUi("Step {number}", {number: index + 1})}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      <Field label={tUi("Target Assistant")} required>
        {catalog.status === "loading" ? <Skeleton className="h-10 w-full" aria-label={tUi("Loading assistants")} /> : catalog.status === "error" ? (
          <div role="alert" className="space-y-2 text-xs text-muted-foreground">
            <p>{tUi("Assistants could not be loaded. Your current selection is preserved.")}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => {setCatalog({status: "loading", options: []}); setRetry(value => value + 1);}}>{tUi("Retry")}</Button>
          </div>
        ) : assistantOptions.length === 0 ? <p className="text-xs text-muted-foreground">{tUi("Create another assistant before configuring this handoff.")}</p> : <>
          <Combobox
            value={assistantId}
            onChange={(val) => updateTarget({ assistant_id: val })}
            options={assistantOptions}
            placeholder={assistantId ? tUi("Saved assistant is unavailable — choose another") : tUi("Select assistant…")}
            triggerClassName="w-full min-w-0"
            searchable
          />
          {selectedOption && <p className="mt-1 text-xs text-muted-foreground">{tUi("Routes the conversation to another assistant when this node is reached.")}</p>}
        </>}
      </Field>
      <Field label={tUi("Voice Mode")}>
        <Select
          value={voiceMode}
          onValueChange={(value) => updateTarget({ voice_mode: value })}
        >
          <SelectTrigger className="w-full text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="unified">{tUi("Unified (keep current voice)")}</SelectItem>
            <SelectItem value="distinct">{tUi("Distinct (target assistant's voice)")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {edge && <EdgeProperties edge={edge} sourceType={flow.nodes.find(step => step.id === edge.start_node_id)?.type} customVariableNames={variableNames} onUpdateEdge={onUpdateEdge} embedded />}
      {edgeId && (
        <Button variant="destructive" className="w-full" onClick={() => onDeleteNode(node.id)}>
          <IconTrash className="mr-2 size-4" />{tUi(" Delete assistant node")}</Button>
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
  const tUi = useUiText();
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
        variableNames={variableNames}
        onUpdateEdge={onUpdateEdge}
        onDeleteNode={onDeleteNode}
      />
    );
  }

  if (node.type === "tool") return <div className="space-y-5 p-4">
    <PanelHeader title={tUi("Tool step")} />
    <Field label={tUi("Name")}><Input aria-label={tUi("Step name")} value={node.name || ""} onChange={event => onUpdateNode(node.id, { name: event.target.value })} /></Field>
    <Field label={tUi("Shared tool")} required>
      {libraryToolsLoading ? <Skeleton className="h-10 w-full" /> : <Combobox value={node.shared_tool_id || ""} onChange={shared_tool_id => onUpdateNode(node.id, { shared_tool_id })} options={Array.from(new Map([...(values.tools || []), ...(libraryTools || [])].map(tool => [getSharedToolId(tool) || tool.id, tool])).entries()).filter(([id]) => id).map(([id, tool]) => ({ value: id, label: getToolDisplayName(tool) || tUi("Shared tool") }))} placeholder={tUi("Select a shared tool")} emptyLabel={tUi("No shared tools available")} triggerClassName="w-full" />}
      <p className="text-xs text-muted-foreground">{tUi("Runs this tool when the conversation reaches the step. Arguments use matching dynamic variables.")}</p>
    </Field>
    <Field label={tUi("Announcement before running")}><VariableTextarea rows={4} value={node.message || ""} onChange={message => onUpdateNode(node.id, { message: message || undefined })} availableVariables={variableNames} includeSecrets={false} placeholder={tUi("One moment while I look that up.")} /></Field>
    <NodeActions isStart={flow.start_node_id === node.id} onSetStart={() => onSetStart(node.id)} onDelete={() => onDeleteNode(node.id)} />
  </div>;

  if (isSpeak) {
    return (
      <div className="p-4 space-y-4">
        <PanelHeader title={tUi("Speak node · {value0}", { value0: node.name || tUi("Speak node") })} />
        <Field label={tUi("Name")}>
          <Input value={node.name || ""} onChange={(event) => onUpdateNode(node.id, { name: event.target.value })} />
        </Field>
        <Field label={tUi("Message")} required error={!String(node.message || "").trim() ? tUi("Speak node requires a message.") : null}>
          <VariableTextarea
            value={node.message || ""}
            onChange={(next) => onUpdateNode(node.id, { message: next })}
            availableVariables={variableNames}
            includeSecrets={false}
            highlightVariables
            rows={8}
            placeholder={tUi("Thanks for calling {{company_name}}.")}
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
      <PanelHeader title={tUi("Prompt node · {value0}", { value0: node.name || tUi("Prompt node") })} />
      <Tabs defaultValue="agent" className="mt-4">
        <TabsList>
          <TabsTrigger value="agent">{tUi("Agent")}</TabsTrigger>
          <TabsTrigger value="voice">{tUi("TTS")}</TabsTrigger>
          <TabsTrigger value="transcription">{tUi("STT")}</TabsTrigger>
          <TabsTrigger value="tools">{tUi("Tools")}</TabsTrigger>
        </TabsList>
        <TabsContent value="agent" className="space-y-4 pt-4">
          <Field label={tUi("Name")}>
            <Input value={node.name || ""} onChange={(event) => onUpdateNode(node.id, { name: event.target.value })} />
          </Field>
          <Field label={tUi("Instructions")} required error={!String(node.instructions || "").trim() ? tUi("Prompt node requires instructions.") : null}>
            <VariableTextarea
              value={node.instructions || ""}
              onChange={(next) => onUpdateNode(node.id, { instructions: next })}
              availableVariables={variableNames}
              includeSecrets={false}
              highlightVariables
              rows={8}
              placeholder={tUi("Tell the assistant how to handle this step.")}
            />
          </Field>
          <Field label={tUi("Instructions Mode")}>
            <Select
              value={node.instructions_mode || "append"}
              onValueChange={(value) => onUpdateNode(node.id, { instructions_mode: value })}
            >
              <SelectTrigger className="w-full text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="append">{tUi("Append to assistant instructions")}</SelectItem>
                <SelectItem value="replace">{tUi("Replace assistant instructions")}</SelectItem>
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
          <NodeTtsOverride node={node} values={values} onUpdateNode={onUpdateNode} />
        </TabsContent>
        <TabsContent value="transcription" className="space-y-4 pt-4">
          <NodeSttOverride
            node={node}
            values={values}
            variableNames={variableNames}
            onUpdateNode={onUpdateNode}
          />
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
  const tUi = useUiText();
  const configuredTools = values?.tools;
  const assistantTools = useMemo(
    () => (Array.isArray(configuredTools) ? configuredTools.filter((tool) => getSharedToolId(tool)) : []),
    [configuredTools]
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
          <div className="text-sm font-medium">{tUi("Override assistant defaults")}</div>
          <Switch checked={override} onCheckedChange={toggleOverride} />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {override
            ? tUi("Toggle which assistant tools are active for this step. Assistant tools can be disabled but not removed.")
            : tUi("This node inherits all of the assistant's tools. Turn on override to disable specific ones for this step.")}
        </p>
      </div>

      <div>
        <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">{tUi("Assistant tools")}</div>
        <div className="space-y-2">
          {assistantTools.length === 0 ? (
            <p className="rounded-md border p-3 text-xs text-muted-foreground">{tUi("No shared assistant tools attached.")}</p>
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
        <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">{tUi("Node tools")}</div>
        <div className="space-y-2">
          {nodeAddedIds.length === 0 ? (
            <p className="rounded-md border p-3 text-xs text-muted-foreground">{tUi("No node-specific tools added. Add one from the library below.")}</p>
          ) : nodeAddedIds.map((id) => {
            const tool = toolById.get(id);
            return (
              <ToolSelectedRow
                key={id}
                name={tool ? getToolDisplayName(tool, tUi) : id}
                type={tool?.type || tUi("Tool")}
                onRemove={() => removeNodeTool(id)}
              />
            );
          })}
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-xs font-medium uppercase text-muted-foreground">{tUi("Tools Library")}</div>
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
            <SelectValue placeholder={libraryToolsLoading ? tUi("Loading library tools…") : tUi("Select a tool to add")} />
          </SelectTrigger>
          <SelectContent>
            {addableLibraryTools.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                {libraryToolsLoading ? tUi("Loading…") : tUi("No more tools available")}
              </div>
            ) : addableLibraryTools.map((tool) => {
              const id = getSharedToolId(tool);
              return (
                <SelectItem key={id} value={id}>
                  {getToolDisplayName(tool, tUi)} ({tool.type || tUi("tool")})
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
  const tUi = useUiText();
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border p-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{getToolDisplayName(tool, tUi)}</div>
        <div className="text-xs text-muted-foreground">{tool.type || tUi("Tool")}</div>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </div>
  );
}

function ToolSelectedRow({ name, type, onRemove }) {
  const tUi = useUiText();
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
        aria-label={tUi("Remove tool")}
      >
        <IconTrash className="size-4" />
      </Button>
    </div>
  );
}

function EdgeProperties({ edge, sourceType, systemVariableNames = [], customVariableNames = [], onUpdateEdge, onDeleteEdge, embedded = false }) {
  const tUi = useUiText();
  const condition = edge.condition || { type: "llm", prompt: "" };
  const edgeIssues = useMemo(() => validateWorkflowEdge(edge, undefined, tUi), [edge, tUi]);
  const llmPromptMissing = condition.type === "llm" && !String(condition.prompt || "").trim();

  function updateCondition(next) {
    onUpdateEdge(edge.id, { condition: next });
  }

  return (
    <div className={embedded ? "space-y-4 border-t pt-4" : "p-4 space-y-4"}>
      <PanelHeader title={tUi(embedded ? "When to hand off" : "Connection")} />
      {!embedded && edgeIssues.length > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
            <IconAlertTriangle className="size-3.5" />{tUi(" Missing required configuration")}</div>
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-amber-600 dark:text-amber-400">
            {edgeIssues.map((issue) => <li key={issue}>{issue}</li>)}
          </ul>
        </div>
      )}
      <Field label={tUi("Condition Type")}>
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
            <SelectItem value="llm">{tUi("LLM Prompt")}</SelectItem>
            <SelectItem value="expression">{tUi("Variable Comparison")}</SelectItem>
            <SelectItem value="default" disabled={!["speak", "tool"].includes(sourceType)}>{tUi("Default route")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {condition.type === "llm" && (
        <Field label={tUi("LLM Prompt")} required error={llmPromptMissing ? tUi("LLM prompt is required.") : null}>
          <Textarea
            value={condition.prompt || ""}
            aria-label={tUi("Handoff condition")}
            rows={5}
            onChange={(event) => updateCondition({ type: "llm", prompt: event.target.value })}
            placeholder={tUi("The caller wants to speak with a human.")}
          />
        </Field>
      )}
      {condition.type === "expression" && <WorkflowExpressionEditor value={condition.expression} onChange={expression => updateCondition({ type: "expression", expression })} variables={[...new Set([...systemVariableNames, ...customVariableNames])]} />}
      {!embedded && <Button variant="destructive" className="w-full" onClick={() => onDeleteEdge(edge.id)}>
        <IconTrash className="mr-2 size-4" />{tUi(" Delete connection")}</Button>}
    </div>
  );
}

function NodeActions({ isStart, onSetStart, onDelete }) {
  const tUi = useUiText();
  if (isStart) {
    // The start node cannot be deleted; only show its (disabled) start control.
    return (
      <Button variant="outline" className="w-full" disabled>{tUi("Start node")}</Button>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      <Button variant="outline" onClick={onSetStart}>{tUi("Set as Start")}</Button>
      <Button variant="destructive" onClick={onDelete}><IconTrash className="mr-2 size-4" />{tUi("Delete Node")}</Button>
    </div>
  );
}

function OverrideAssistantDefaultsToggle({ checked, onCheckedChange, description }) {
  const tUi = useUiText();
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium">{tUi("Override assistant defaults")}</div>
        <Switch checked={checked} onCheckedChange={onCheckedChange} aria-label={tUi("Override assistant defaults")} />
      </div>
      {description && <p className="mt-2 text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}

function NodeTtsOverride({ node, values, onUpdateNode }) {
  const tUi = useUiText();
  const isOverride = Boolean(
    node.voice_settings &&
    typeof node.voice_settings === "object" &&
    Object.keys(node.voice_settings).length > 0
  );

  return (
    <div className="space-y-4">
      <OverrideAssistantDefaultsToggle
        checked={isOverride}
        onCheckedChange={(checked) => {
          if (!checked) {
            onUpdateNode(node.id, { voice_settings: undefined });
          } else if (!isOverride) {
            onUpdateNode(node.id, {
              voice_settings: compatibleVoiceAudio(cloneAssistantOverride(assistantVoiceSettings(values), "VoiceSettings")),
            });
          }
        }}
        description={
          isOverride
            ? tUi("This node uses its own text-to-speech voice settings.")
            : tUi("This node inherits the assistant text-to-speech voice settings.")
        }
      />
      {!isOverride ? (
        <p className="text-xs text-muted-foreground">{tUi("Uses the assistant voice")}{values?.voice ? tUi(" ({value0})", { value0: values.voice }) : ""}.
        </p>
      ) : (
        <div className="[&_.grid]:grid-cols-1"><TtsVoicePicker compact hideNoiseSuppression section="voice"
          value={assistantForEditor({ voice_settings: node.voice_settings })}
          onChange={patch => {
            const draft = assistantForEditor({ voice_settings: node.voice_settings });
            onUpdateNode(node.id, { voice_settings: compatibleVoiceAudio(assistantVoiceSettings({ ...draft, ...patch })) });
          }}
          callAudioExtras={<AssistantToolAudioSettings value={node.voice_settings?.tool_call_audio} backgroundAudio={node.voice_settings?.background_audio} onChange={tool_call_audio => onUpdateNode(node.id, { voice_settings: compatibleVoiceAudio({ ...node.voice_settings, tool_call_audio }) })} />}
        /></div>
      )}
    </div>
  );
}

function NodeSttOverride({ node, values, variableNames, onUpdateNode }) {
  const tUi = useUiText();
  const isOverride = Boolean(
    node.transcription &&
    typeof node.transcription === "object" &&
    Object.keys(node.transcription).length > 0
  );

  return (
    <div className="space-y-4">
      <OverrideAssistantDefaultsToggle
        checked={isOverride}
        onCheckedChange={(checked) => {
          if (!checked) {
            onUpdateNode(node.id, { transcription: undefined });
          } else if (!isOverride) {
            onUpdateNode(node.id, {
              transcription: cloneAssistantTranscriptionOverride(values?.transcription),
            });
          }
        }}
        description={
          isOverride
            ? tUi("This node uses its own speech-to-text transcription settings.")
            : tUi("This node inherits the assistant speech-to-text transcription settings.")
        }
      />
      {!isOverride ? (
        <p className="text-xs text-muted-foreground">{tUi("Uses the assistant transcription")}{values?.transcription?.model ? tUi(" ({value0})", { value0: values.transcription.model }) : ""}.
        </p>
      ) : (
        <div className="space-y-4 [&_.grid]:grid-cols-1">
          <p className="text-xs text-muted-foreground">{tUi("Changing the model resets provider-specific settings to Telnyx defaults.")}</p>
          <AssistantTranscriptionSettings
            compact
            value={node.transcription}
            availableVariables={variableNames}
            onChange={(transcription) => onUpdateNode(node.id, { transcription })}
          />
        </div>
      )}
    </div>
  );
}

function NodeLlmOverride({ node, values, onUpdateNode }) {
  const tUi = useUiText();
  const isOverride = Boolean(node.model || node.external_llm || node._llmOverride);
  return <Field label={tUi("LLM")}><div className="space-y-4">
    <OverrideAssistantDefaultsToggle checked={isOverride} onCheckedChange={enabled => onUpdateNode(node.id, enabled ? {_llmOverride:true, ...(values.external_llm ? {external_llm:{...values.external_llm}} : {model:values.model || '', llm_api_key_ref:values.llm_api_key_ref || undefined})} : {_llmOverride:undefined,model:undefined,external_llm:undefined,llm_api_key_ref:undefined})} description={isOverride?tUi("This node uses its own LLM model settings."):tUi("This node inherits the assistant LLM model settings.")}/>
    {isOverride?<AssistantModelConfiguration label="Node model" value={node} ui={node._modelUi} onUiChange={next=>onUpdateNode(node.id,{_modelUi:next})} onChange={cfg=>onUpdateNode(node.id,{model:cfg.external_llm?undefined:cfg.model,llm_api_key_ref:cfg.llm_api_key_ref||undefined,external_llm:cfg.external_llm||undefined})}/>:null}
  </div></Field>;
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

function WorkflowEditor({ values, setValues, assistantId }) {
  const tUi = useUiText();
  const reactFlowWrapper = useRef(null);
  const flow = values?.conversation_flow;
  const workflowIdentity = assistantId || values?.id || values?.assistant_id || "";
  const [nodes, setNodes] = useNodesState(toReactFlowNodes(flow));
  const [edges, setEdges] = useEdgesState(toReactFlowEdges(flow));
  const [reactFlowInstance, setReactFlowInstance] = useState(null);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [libraryTools, setLibraryTools] = useState([]);
  const [libraryError, setLibraryError] = useState(false);
  const [libraryToolsLoading, setLibraryToolsLoading] = useState(true);
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
    // Hydration must never mutate the saved graph. Layout is an explicit action.
    setNodes(current => hydrateWorkflowCanvasNodes(current, flow));
    setEdges(toReactFlowEdges(flow));
  }, [flow?.start_node_id, flow?.nodes, flow?.edges, flow?._assistantDrafts, setValues, setNodes, setEdges]);

  const canvasReady = nodes.length > 0 && nodes.every(node => node.width && node.height);

  // Wait for measurement before framing newly added or loaded nodes.
  // When the canvas mounts inside an inactive tab its container can measure 0px,
  // so re-fit once the instance is ready and whenever the node count or the
  // active workflow identity changes (load existing flow or add a node).
  useEffect(() => {
    if (!reactFlowInstance || !canvasReady) return;
    const frame = window.requestAnimationFrame(() => {
      reactFlowInstance.fitView({ padding: 0.2, maxZoom: 1, includeHiddenNodes: false, duration: 0 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [reactFlowInstance, canvasReady, nodes.length, workflowIdentity]);

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
    setLibraryError(false);
    try {
      const res = await fetch("/api/ai/tools?all=true", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || data?.ok === false) throw new Error("tools");
      const tools = Array.isArray(data?.items) ? data.items : Array.isArray(data?.tools) ? data.tools : Array.isArray(data?.data) ? data.data : [];
      setLibraryTools(tools);
    } catch (_) {
      setLibraryError(true);
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
      const nodeIssues = validateWorkflowNode(node.data?.node, flow, tUi);
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
    [nodes, selectedNodeId, flow, tUi]
  );
  const decoratedEdges = useMemo(
    () => edges.map((edge) => {
      const edgeIssues = validateWorkflowEdge(edge.data?.edge, flow, tUi);
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
    [edges, selectedEdgeId, flow, tUi]
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
    if (!flow.nodes.some(node => String(node.id) === String(params.source))) return;
    const condition = defaultConnectionCondition(flow, params.source);
    const handoff = nodes.find(node => node.id === params.target)?.data?.edgeId;
    if (handoff) {
      const nextFlow = updateAssistantHandoff(flow, handoff, {start_node_id: params.source});
      setValues(current => ({...current, conversation_flow: nextFlow}));
      return;
    }
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
  }, [flow, nodes, persist, setEdges, setValues]);

  const onDragStart = useCallback((event, nodeType) => {
    event.dataTransfer.setData(NODE_TRANSFER_TYPE, nodeType);
    event.dataTransfer.effectAllowed = "move";
  }, []);

  const handleAddNode = useCallback((nodeType, position = null) => {
    if (nodeType === "assistant") {
      const nextFlow = addAssistantHandoff(flow, {position});
      if (nextFlow === flow) return;
      const edgeId = nextFlow._assistantDrafts.at(-1).id;
      setValues(current => ({...current, conversation_flow: nextFlow}));
      setNodes(current => hydrateWorkflowCanvasNodes(current, nextFlow));
      setEdges(toReactFlowEdges(nextFlow));
      setSelectedNodeId(virtualAssistantNodeId(edgeId));
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
  }, [edges, nodes, persist, flow, setValues, setNodes, setEdges]);

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
    const nextNodes = nodes.filter(node => String(node.id) !== String(nodeId));
    const nextEdges = edges.filter(edge => edge.source !== nodeId && edge.target !== nodeId);
    persist(nextNodes, nextEdges);
    setNodes(nextNodes);
    setEdges(nextEdges);
    setSelectedNodeId(null);
  }, [nodes, edges, persist, setNodes, setEdges]);

  const updateEdge = useCallback((edgeId, patch) => {
    const handoff = flow.edges.find(edge => edge.id === edgeId)?.target?.type === "assistant" || flow._assistantDrafts?.some(draft => draft.id === edgeId);
    const nextFlow = handoff ? updateAssistantHandoff(flow, edgeId, patch) : {
      ...flow, edges: flow.edges.map(edge => edge.id === edgeId ? {...edge, ...patch} : edge),
    };
    internalUpdateRef.current = true;
    setNodes(current => hydrateWorkflowCanvasNodes(current, nextFlow));
    setEdges(toReactFlowEdges(nextFlow));
    setValues(current => ({...current, conversation_flow: nextFlow}));
  }, [flow, setValues, setEdges, setNodes]);

  const deleteEdge = useCallback((edgeId) => {
    const nextEdges = edges.filter(edge => edge.id !== edgeId);
    // Removing a connection leaves its assistant card available for reconnection.
    persist(nodes, nextEdges);
    setEdges(nextEdges);
    setSelectedEdgeId(null);
  }, [nodes, edges, persist, setEdges]);

  return (
    <div className="flex h-full min-h-0 overflow-hidden rounded-md border">
      <WorkflowNodePalette onAddNode={handleAddNode} onDragStart={onDragStart} />
      <div className="min-h-0 min-w-0 flex-1 flex flex-col">
        {libraryError ? <div role="alert" className="flex items-center justify-between gap-3 border-b p-3 text-xs">{tUi("The shared tool library could not be loaded. Saved tool choices are preserved.")}<Button type="button" variant="outline" size="sm" onClick={loadLibraryTools}>{tUi("Retry")}</Button></div> : null}
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
            fitViewOptions={{padding: 0.2, maxZoom: 1}}
            minZoom={0.2}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls className="call-flow-controls" position="bottom-left" />
            <Panel position="bottom-right" className="bg-card border rounded p-2 text-xs">
              <div className="text-muted-foreground">
                {nodes.length}{tUi(" nodes • ")}{edges.length}{tUi(" connections")}</div>
              <div className="text-xs text-muted-foreground mt-0">{tUi("Drag nodes from sidebar or right-click to add")}</div>
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
  const tUi = useUiText();
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-5">
      <div className="flex items-start gap-3">
        <IconAlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600" />
        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold">{tUi("Make your tools shared to use Workflows")}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{tUi("Conversation workflows can only use tools from your shared library. This assistant has ")}{blockers.length}{tUi(" tools that aren't shared yet. Save them to your library, then enable the workflow.")}</p>
          </div>
          <div>
            <div className="text-xs font-medium uppercase text-muted-foreground">{tUi("Tools to make shared:")}</div>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              {blockers.map((tool) => <li key={tool.name}>{tool.name}</li>)}
            </ul>
          </div>
          <p className="text-xs text-muted-foreground">{tUi("To make a tool shared, open Integrations → Tools, find the tool, and use the “Save to Library” action.")}</p>
        </div>
      </div>
    </div>
  );
}

function WorkflowEmptyState({ setValues }) {
  const tUi = useUiText();
  return (
    <div className="rounded-md border bg-muted/20 p-8 text-center">
      <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-md border bg-background">
        <IconGitBranch className="size-6 text-telnyx-green" />
      </div>
      <h3 className="text-base font-semibold">{tUi("Workflow is disabled")}</h3>
      <p className="mx-auto mt-1 max-w-xl text-sm text-muted-foreground">{tUi("Enable conversation workflows to design prompt and speak nodes with call-flows-style drag and drop.")}</p>
      <Button className="mt-4" onClick={() => setValues((current) => ({ ...current, conversation_flow: createDefaultConversationFlow() }))}>
        <IconPlus className="mr-2 size-4" />{tUi(" Enable Workflow")}</Button>
    </div>
  );
}

export default function AssistantWorkflowTab({ values, setValues, assistantId }) {
  const tUi = useUiText();
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
    <div className="flex h-full min-h-0 flex-col space-y-3 overflow-hidden" data-setting-path="conversation_flow">
      <div className="flex flex-wrap items-center justify-between gap-3 flex-shrink-0">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium">
            <IconGitBranch className="size-4 text-telnyx-green" />
            {effectiveMode === "capability" ? tUi("Assistant Workflow") : tUi("Conversation Workflow")}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* View toggle — disabled when a handoff tool is present */}
          <Tabs value={effectiveMode} onValueChange={(mode) => { if (!hasHandoffTool) setViewMode(mode); }} className="gap-0">
            <TabsList className="w-auto">
              <TabsTrigger
                value="workflow"
                disabled={hasHandoffTool}
                className={tabsTriggerCompactClass}
                title={hasHandoffTool ? tUi("Remove the handoff tool to use the conversation workflow editor") : tUi("Conversation workflow editor")}
              >{tUi("Conversation Workflow")}</TabsTrigger>
              <TabsTrigger
                value="capability"
                disabled={hasHandoffTool}
                className={tabsTriggerCompactClass}
                title={hasHandoffTool ? tUi("Capability graph is required when a handoff tool is configured") : tUi("Read-only capability graph")}
              >{tUi("Capability Graph")}</TabsTrigger>
            </TabsList>
          </Tabs>
          {effectiveMode === "workflow" && flow && (
            <><Select value={flow.start_node_id || ""} onValueChange={start_node_id => setValues(current => ({ ...current, conversation_flow: { ...current.conversation_flow, start_node_id } }))}><SelectTrigger aria-label={tUi("Starting step")} className="w-52"><SelectValue placeholder={tUi("Starting step")} /></SelectTrigger><SelectContent>{(flow.nodes || []).map((node, index) => <SelectItem key={node.id} value={node.id}>{node.name || tUi("Step {value0}", { value0: index + 1 })}</SelectItem>)}</SelectContent></Select><Button type="button" size="sm" variant="outline" onClick={() => setValues(current => ({ ...current, conversation_flow: normalizeWorkflowCanvasLayout(current.conversation_flow) }))}>{tUi("Arrange steps")}</Button></>
          )}
          {effectiveMode === "capability" && (
            <Badge variant="outline" className="rounded">{tUi("Tools: {value0}", {value0: tools.length})}</Badge>
          )}
        </div>
      </div>

      {/* Disclaimer banner when handoff tool blocks the workflow editor */}
      {hasHandoffTool && (
        <div className="flex flex-shrink-0 items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-4">
          <IconInfoCircle className="mt-0.5 size-5 shrink-0 text-amber-600" />
          <div className="space-y-1 text-sm">
            <div className="font-semibold">{tUi("Workflows unavailable")}</div>
            <p className="text-muted-foreground">{tUi("Workflows cannot be used while this assistant has a handoff tool configured. Remove the handoff tool to use Workflows.")}</p>
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
