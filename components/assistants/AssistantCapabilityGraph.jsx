"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ReactFlow, {
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  Panel,
  Position,
} from "reactflow";
import "reactflow/dist/style.css";
import { Badge } from "@/components/ui/badge";
import {
  IconArrowRight,
  IconEdit,
  IconGitBranch,
  IconInfoCircle,
  IconRobot,
  IconTool,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import AssistantToolEditSheet, {
  descriptionForAssistantToolType,
  getAssistantToolDisplay,
  renderAssistantToolIcon,
} from "@/components/assistants/AssistantToolEditSheet";

/**
 * AssistantCapabilityGraph — read-only "capability graph" view.
 *
 * This is the original Assistant Workflow tab renderer (pre-conversation-flow
 * editor, last version at commit 61c9d145). It auto-generates a ReactFlow graph
 * from the assistant's inline `tools` array: the assistant sits at the centre
 * and each tool branches out radially with curved bezier edges, with handoff
 * tools expanding recursively into linked assistants.
 *
 * The graph is read-only with respect to the assistant's tool configuration —
 * tool nodes are selectable to open the AssistantToolEditSheet for editing
 * (depth-0 tools only), but the graph structure cannot be modified. This view
 * is kept alongside the newer conversation-flow editor for assistants that
 * still rely on the legacy handoff tool flow.
 */

const TYPE_COLORS = {
  webhook: {
    border: "border-cyan-500/80",
    glow: "shadow-cyan-500/15",
    edge: "#0891b2",
    badge: "border-cyan-500/40 text-cyan-300",
  },
  retrieval: {
    border: "border-amber-500/80",
    glow: "shadow-amber-500/15",
    edge: "#d97706",
    badge: "border-amber-500/40 text-amber-300",
  },
  handoff: {
    border: "border-emerald-500/80",
    glow: "shadow-emerald-500/15",
    edge: "#059669",
    badge: "border-emerald-500/40 text-emerald-300",
  },
  transfer: {
    border: "border-violet-500/80",
    glow: "shadow-violet-500/15",
    edge: "#7c3aed",
    badge: "border-violet-500/40 text-violet-300",
  },
  refer: {
    border: "border-sky-500/80",
    glow: "shadow-sky-500/15",
    edge: "#0284c7",
    badge: "border-sky-500/40 text-sky-300",
  },
  send_dtmf: {
    border: "border-teal-500/80",
    glow: "shadow-teal-500/15",
    edge: "#0d9488",
    badge: "border-teal-500/40 text-teal-300",
  },
  hangup: {
    border: "border-red-500/80",
    glow: "shadow-red-500/15",
    edge: "#dc2626",
    badge: "border-red-500/40 text-red-300",
  },
  send_message: {
    border: "border-green-500/80",
    glow: "shadow-green-500/15",
    edge: "#16a34a",
    badge: "border-green-500/40 text-green-300",
  },
  invite: {
    border: "border-indigo-500/80",
    glow: "shadow-indigo-500/15",
    edge: "#4f46e5",
    badge: "border-indigo-500/40 text-indigo-300",
  },
  skip_turn: {
    border: "border-slate-500/80",
    glow: "shadow-slate-500/15",
    edge: "#64748b",
    badge: "border-slate-500/40 text-slate-300",
  },
  default: {
    border: "border-border",
    glow: "shadow-black/10",
    edge: "#64748b",
    badge: "border-border text-muted-foreground",
  },
};

function toolStyle(type) {
  return TYPE_COLORS[type] || TYPE_COLORS.default;
}

const LEVEL_EDGE_COLORS = [
  "#14b8a6",
  "#38bdf8",
  "#a78bfa",
  "#f59e0b",
];

function levelEdgeColor(depth) {
  return LEVEL_EDGE_COLORS[depth % LEVEL_EDGE_COLORS.length];
}

function directEdgeHandlePair(fromPosition, toPosition) {
  return {
    sourceHandle: `source-${fromPosition}`,
    targetHandle: `target-${toPosition}`,
  };
}

const NODE_SIZE = {
  assistant: { width: 330, height: 108 },
  tool: { width: 288, height: 112 },
};

function radialToolLayout({ x, y, count, depth }) {
  if (count <= 0) return [];

  const radiusX = depth === 0 ? 740 : 520;
  const radiusY = depth === 0 ? 430 : 320;
  const centerX = x + NODE_SIZE.assistant.width / 2;
  const centerY = y + NODE_SIZE.assistant.height / 2;
  const useFullCircle = count >= 5;
  const startAngle = useFullCircle ? 0 : 205;
  const endAngle = useFullCircle ? 360 : 335;
  const angleStep = count === 1
    ? 0
    : useFullCircle
      ? endAngle / count
      : (endAngle - startAngle) / (count - 1);

  return Array.from({ length: count }, (_, index) => {
    const angle = count === 1 ? 270 : startAngle + index * angleStep;
    const radians = (angle * Math.PI) / 180;
    return {
      x: Math.round(
        centerX + Math.cos(radians) * radiusX - NODE_SIZE.tool.width / 2
      ),
      y: Math.round(
        centerY - Math.sin(radians) * radiusY - NODE_SIZE.tool.height / 2
      ),
      angle,
    };
  });
}

function edgeHandlesForPositions(source, target) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;

  if (Math.abs(dx) > Math.abs(dy)) {
    return dx >= 0
      ? directEdgeHandlePair("right", "left")
      : directEdgeHandlePair("left", "right");
  }

  return dy >= 0
    ? directEdgeHandlePair("bottom", "top")
    : directEdgeHandlePair("top", "bottom");
}

function targetLayoutForTool({ toolPosition, assistantPosition, targetIndex }) {
  const isAboveAssistant = toolPosition.y < assistantPosition.y;
  const verticalDirection = isAboveAssistant ? -1 : 1;
  const verticalGap = 120;
  const stackGap = 92;

  return {
    position: {
      x: toolPosition.x,
      y:
        toolPosition.y +
        verticalDirection * (verticalGap + targetIndex * stackGap),
    },
    sourceHandle: isAboveAssistant ? "source-top" : "source-bottom",
    targetHandle: isAboveAssistant ? "target-bottom" : "target-top",
  };
}

function NodeHandles() {
  return (
    <>
      <Handle id="target-top" type="target" position={Position.Top} className="!bg-muted-foreground" />
      <Handle id="target-right" type="target" position={Position.Right} className="!bg-muted-foreground" />
      <Handle id="target-bottom" type="target" position={Position.Bottom} className="!bg-muted-foreground" />
      <Handle id="target-left" type="target" position={Position.Left} className="!bg-muted-foreground" />
      <Handle id="source-top" type="source" position={Position.Top} className="!bg-telnyx-green" />
      <Handle id="source-right" type="source" position={Position.Right} className="!bg-telnyx-green" />
      <Handle id="source-bottom" type="source" position={Position.Bottom} className="!bg-telnyx-green" />
      <Handle id="source-left" type="source" position={Position.Left} className="!bg-telnyx-green" />
    </>
  );
}

function AssistantStartNode({ data }) {
  return (
    <div
      className={cn(
        "min-w-56 rounded-md border bg-background shadow-lg",
        data.depth > 0
          ? "border-emerald-500/70 shadow-emerald-500/10"
          : "border-telnyx-green/70 shadow-telnyx-green/10"
      )}
    >
      <NodeHandles />
      <div className="border-b px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <IconRobot className="size-4 shrink-0 text-telnyx-green" />
              <span className="truncate">{data.name || "Assistant"}</span>
            </div>
            {data.model && (
              <div className="mt-1 text-xs text-muted-foreground line-clamp-1">
                {data.model}
              </div>
            )}
          </div>
          {data.depth > 0 && data.onOpenAssistant && (
            <button
              type="button"
              aria-label="Edit linked assistant"
              title="Edit linked assistant"
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-telnyx-green transition hover:border-telnyx-green hover:bg-telnyx-green/10"
              onClick={(event) => {
                event.stopPropagation();
                data.onOpenAssistant();
              }}
            >
              <IconEdit className="size-4" />
            </button>
          )}
        </div>
      </div>
      <div className="px-4 py-2 text-xs text-muted-foreground">
        {data.depth > 0
          ? "Handoff target assistant. Its tools expand from here."
          : "Runtime decides when to invoke tools from conversation context."}
      </div>
    </div>
  );
}

function ToolNode({ data }) {
  const style = toolStyle(data.type);
  return (
    <button
      type="button"
      onClick={data.onEdit || undefined}
      aria-disabled={!data.editable}
      className={cn(
        "group relative block w-72 rounded-md border bg-background text-left shadow-lg transition",
        data.editable
          ? "hover:-translate-y-0.5 hover:shadow-xl"
          : "cursor-default",
        style.border,
        style.glow
      )}
    >
      <NodeHandles />
      <div className="flex items-start gap-3 px-4 py-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/40">
          {renderAssistantToolIcon(data.type)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <Badge variant="outline" className={cn("h-5 rounded px-1.5 text-[10px]", style.badge)}>
              {data.label}
            </Badge>
            {data.editable && (
              <IconEdit className="size-3.5 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
            )}
          </div>
          <div className="mt-2 truncate text-sm font-medium">
            {data.name || data.label}
          </div>
          {data.subtitle && (
            <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
              {data.subtitle}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

function TargetNode({ data }) {
  return (
    <div className="w-64 rounded-md border border-dashed border-border bg-muted/20 px-4 py-3 text-sm shadow-sm">
      <NodeHandles />
      <div className="flex items-center gap-2 font-medium">
        <IconArrowRight className="size-4 text-muted-foreground" />
        <span className="truncate">{data.title}</span>
      </div>
      {data.subtitle && (
        <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
          {data.subtitle}
        </div>
      )}
    </div>
  );
}

const nodeTypes = {
  assistantStart: AssistantStartNode,
  assistantTool: ToolNode,
  assistantTarget: TargetNode,
};

const MAX_HANDOFF_DEPTH = 3;

function getToolSubtitle(tool) {
  const type = tool?.type;
  if (type === "webhook") {
    const method = tool?.webhook?.method || "POST";
    const url = tool?.webhook?.url || "No URL configured";
    return `${method} ${url}`;
  }
  if (type === "handoff") {
    const targets = Array.isArray(tool?.handoff?.ai_assistants)
      ? tool.handoff.ai_assistants
      : [];
    return targets.length
      ? `${targets.length} target assistant${targets.length > 1 ? "s" : ""}`
      : "No target assistant configured";
  }
  const targets =
    tool?.transfer?.targets ||
    tool?.refer?.targets ||
    tool?.invite?.targets ||
    [];
  if (Array.isArray(targets) && targets.length) {
    return `${targets.length} target${targets.length > 1 ? "s" : ""}`;
  }
  return descriptionForAssistantToolType(type);
}

function getToolTargets(tool) {
  const targetList =
    tool?.transfer?.targets ||
    tool?.refer?.targets ||
    tool?.invite?.targets ||
    [];
  if (!Array.isArray(targetList)) return [];
  return targetList.map((target, index) => ({
    id: target?.to || target?.destination || `target-${index + 1}`,
    title: target?.name || `Target ${index + 1}`,
    subtitle: target?.to || target?.destination || "",
  }));
}

function getHandoffTargets(tool) {
  if (tool?.type !== "handoff") return [];
  return (Array.isArray(tool?.handoff?.ai_assistants)
    ? tool.handoff.ai_assistants
    : []
  ).filter((target) => target?.id || target?.name);
}

function getAssistantTools(assistant) {
  return Array.isArray(assistant?.tools) ? assistant.tools : [];
}

function buildWorkflowGraph({
  values,
  assistantId,
  handoffAssistantsById,
  onEditTool,
  onOpenAssistant,
}) {
  const nodes = [];
  const edges = [];

  function addAssistantNode({ nodeId, assistant, x, y, depth }) {
    nodes.push({
      id: nodeId,
      type: "assistantStart",
      position: { x, y },
      data: {
        name: assistant?.name,
        model: assistant?.model || assistant?.llm_model,
        depth,
        onOpenAssistant:
          depth > 0 && assistant?.id
            ? () => onOpenAssistant(assistant.id)
            : null,
      },
    });
  }

  function addToolNode({
    assistantNodeId,
    assistantPosition,
    tool,
    toolIndex,
    nodeId,
    x,
    y,
    editable,
    depth,
  }) {
    const display = getAssistantToolDisplay(tool);
    const style = toolStyle(tool?.type);
    const directColor = levelEdgeColor(depth);
    const handles = edgeHandlesForPositions(assistantPosition, { x, y });

    nodes.push({
      id: nodeId,
      type: "assistantTool",
      position: { x, y },
      data: {
        type: tool?.type,
        label: display.label,
        name: display.name,
        subtitle: getToolSubtitle(tool),
        editable,
        onEdit: editable ? () => onEditTool(toolIndex) : null,
      },
    });

    edges.push({
      id: `${assistantNodeId}-${nodeId}`,
      source: assistantNodeId,
      target: nodeId,
      type: "bezier",
      ...handles,
      animated: tool?.type === "handoff",
      zIndex: 20,
      style: {
        stroke: directColor,
        strokeWidth: tool?.type === "handoff" ? 2.5 : 2,
      },
    });

    const targets = getToolTargets(tool);
    targets.slice(0, 2).forEach((target, targetIndex) => {
      const targetId = `${nodeId}-target-${targetIndex}`;
      const targetLayout = targetLayoutForTool({
        toolPosition: { x, y },
        assistantPosition,
        targetIndex,
      });
      nodes.push({
        id: targetId,
        type: "assistantTarget",
        position: targetLayout.position,
        data: {
          title: target.title,
          subtitle: target.subtitle,
        },
      });
      edges.push({
        id: `${nodeId}-${targetId}`,
        source: nodeId,
        target: targetId,
        type: "smoothstep",
        sourceHandle: targetLayout.sourceHandle,
        targetHandle: targetLayout.targetHandle,
        style: { stroke: style.edge, strokeWidth: 1.5 },
      });
    });
  }

  function addAssistantSubgraph({
    assistant,
    nodeId,
    x,
    y,
    depth,
    prefix,
    editable,
  }) {
    addAssistantNode({ nodeId, assistant, x, y, depth });

    const tools = getAssistantTools(assistant);
    const toolEntries = tools.map((tool, index) => [tool, index]);
    const directToolEntries = [
      ...toolEntries.filter(([tool]) => tool?.type === "handoff"),
      ...toolEntries.filter(([tool]) => tool?.type !== "handoff"),
    ];

    const assistantPosition = { x, y };
    const radialPositions = radialToolLayout({
      x,
      y,
      count: directToolEntries.length,
      depth,
    });

    directToolEntries.forEach(([tool, toolIndex], orderIndex) => {
      const position = radialPositions[orderIndex];
      const nodeIdSuffix =
        tool?.type === "handoff" ? `handoff-${toolIndex}` : `tool-${toolIndex}`;
      const toolNodeId = `${prefix}-${nodeIdSuffix}`;

      addToolNode({
        assistantNodeId: nodeId,
        assistantPosition,
        tool,
        toolIndex,
        nodeId: toolNodeId,
        x: position.x,
        y: position.y,
        editable: editable && depth === 0,
        depth,
      });

      if (tool?.type !== "handoff") return;

      if (depth >= MAX_HANDOFF_DEPTH) return;

      getHandoffTargets(tool).forEach((target, targetIndex) => {
        const targetAssistant =
          (target?.id && handoffAssistantsById[target.id]) ||
          null;
        const targetNodeId = `${toolNodeId}-assistant-${targetIndex}`;
        const targetAssistantData =
          targetAssistant || {
            id: target?.id,
            name: target?.name || target?.id || `Assistant ${targetIndex + 1}`,
            model: target?.id ? "Loading assistant tools..." : "",
            tools: [],
          };
        const targetX = Math.max(position.x + 480, x + (depth === 0 ? 980 : 720));
        const targetY = position.y + targetIndex * 460;

        addAssistantSubgraph({
          assistant: targetAssistantData,
          nodeId: targetNodeId,
          x: targetX,
          y: targetY,
          depth: depth + 1,
          prefix: `${toolNodeId}-target-${targetIndex}`,
          editable: false,
        });

        edges.push({
          id: `${toolNodeId}-${targetNodeId}`,
          source: toolNodeId,
          target: targetNodeId,
          type: "smoothstep",
          sourceHandle: "source-right",
          targetHandle: "target-left",
          animated: true,
          style: { stroke: toolStyle("handoff").edge, strokeWidth: 2.5 },
        });
      });
    });
  }

  addAssistantSubgraph({
    assistant: {
      id: assistantId,
      name: values?.name || "Assistant",
      model: values?.model,
      tools: getAssistantTools(values),
    },
    nodeId: "assistant-root",
    x: 980,
    y: 430,
    depth: 0,
    prefix: "root",
    editable: true,
  });

  return { nodes, edges };
}

export default function AssistantCapabilityGraph({ values, setValues, assistantId }) {
  const router = useRouter();
  const [editingToolIndex, setEditingToolIndex] = useState(null);
  const [handoffAssistantsById, setHandoffAssistantsById] = useState({});
  const requestedAssistantIdsRef = useRef(new Set());
  const tools = Array.isArray(values?.tools) ? values.tools : [];
  const editingTool =
    editingToolIndex !== null && tools[editingToolIndex]
      ? tools[editingToolIndex]
      : null;

  const assistantVariableNames = useMemo(() => {
    const systemVariables = [
      "telnyx_current_time",
      "telnyx_conversation_channel",
      "telnyx_agent_target",
      "telnyx_end_user_target",
      "telnyx_shaken_stir_attestation",
      "call_control_id",
    ];
    const customVariables = Object.keys(values?.dynamic_variables || {}).filter(Boolean);
    return Array.from(new Set([...systemVariables, ...customVariables]));
  }, [values?.dynamic_variables]);

  useEffect(() => {
    const ids = new Set();

    function collectFromTools(toolList, depth = 0) {
      if (!Array.isArray(toolList) || depth >= MAX_HANDOFF_DEPTH) return;
      for (const tool of toolList) {
        for (const target of getHandoffTargets(tool)) {
          if (!target?.id) continue;
          ids.add(target.id);
          const loadedAssistant = handoffAssistantsById[target.id];
          if (loadedAssistant) {
            collectFromTools(loadedAssistant.tools, depth + 1);
          }
        }
      }
    }

    collectFromTools(tools);

    const missingIds = Array.from(ids).filter(
      (id) =>
        !handoffAssistantsById[id] &&
        !requestedAssistantIdsRef.current.has(id)
    );
    if (!missingIds.length) return;

    for (const id of missingIds) {
      requestedAssistantIdsRef.current.add(id);
    }

    let cancelled = false;
    Promise.all(
      missingIds.map(async (id) => {
        try {
          const response = await fetch(
            `/api/ai/assistants/${encodeURIComponent(id)}`,
            { cache: "no-store" }
          );
          const data = await response.json();
          if (!response.ok || data?.ok === false) {
            throw new Error(data?.error || `Failed to load assistant ${id}`);
          }
          return [id, data.assistant];
        } catch (error) {
          console.error("[AssistantCapabilityGraph] Failed to load handoff assistant", id, error);
          requestedAssistantIdsRef.current.delete(id);
          return [id, null];
        }
      })
    ).then((items) => {
      if (cancelled) return;
      setHandoffAssistantsById((current) => {
        const next = { ...current };
        for (const [id, assistant] of items) {
          if (assistant) next[id] = assistant;
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [tools, handoffAssistantsById]);

  const { nodes, edges } = useMemo(
    () =>
      buildWorkflowGraph({
        values,
        assistantId,
        handoffAssistantsById,
        onEditTool: setEditingToolIndex,
        onOpenAssistant: (id) =>
          router.push(`/ai/assistants/${encodeURIComponent(id)}?tab=workflow`),
      }),
    [values, assistantId, handoffAssistantsById, router]
  );
  const [viewNodes, setViewNodes] = useState(nodes);

  useEffect(() => {
    setViewNodes(nodes);
  }, [nodes]);

  const handleNodesChange = useCallback((changes) => {
    const moveOnlyChanges = changes.filter(
      (change) => change.type !== "remove" && change.type !== "add"
    );
    setViewNodes((currentNodes) =>
      applyNodeChanges(moveOnlyChanges, currentNodes)
    );
  }, []);

  function saveTool(nextTool) {
    if (editingToolIndex === null) return;
    setValues((current) => {
      const nextTools = Array.isArray(current.tools) ? [...current.tools] : [];
      nextTools[editingToolIndex] = nextTool;
      return { ...current, tools: nextTools };
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium">
            <IconGitBranch className="size-4 text-telnyx-green" />
            Assistant Workflow
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Visual map of the tools available to this assistant. Select any tool node to edit its configuration.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="rounded">
            {tools.length} tool{tools.length === 1 ? "" : "s"}
          </Badge>
        </div>
      </div>

      <div className="assistant-workflow-canvas relative h-[70vh] min-h-[560px] overflow-hidden rounded-md border bg-[#17181d]">
        <ReactFlow
          nodes={viewNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          nodesDraggable
          nodesConnectable={false}
          onNodesChange={handleNodesChange}
          elementsSelectable
          deleteKeyCode={null}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#39404a" gap={18} size={1} />
          <Controls position="top-right" />
          <Panel position="top-left" className="rounded-md border bg-background/95 p-3 shadow-sm">
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <IconInfoCircle className="mt-0.5 size-4 shrink-0 text-telnyx-green" />
              <span>
                This is a capability graph: the assistant chooses tools dynamically during the conversation.
              </span>
            </div>
          </Panel>
          {tools.length === 0 && (
            <Panel position="center" className="rounded-md border bg-background/95 p-5 shadow-lg">
              <div className="flex max-w-sm flex-col items-center text-center">
                <div className="mb-3 flex size-10 items-center justify-center rounded-md border bg-muted">
                  <IconTool className="size-5 text-muted-foreground" />
                </div>
                <div className="text-sm font-medium">No tools configured</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Add tools in the Integrations tab and they will appear in this workflow view.
                </p>
              </div>
            </Panel>
          )}
        </ReactFlow>
        <style jsx global>{`
          .assistant-workflow-canvas .react-flow__controls {
            border: 1px solid hsl(var(--border));
            border-radius: 6px;
            box-shadow: 0 8px 24px rgb(0 0 0 / 0.28);
            overflow: hidden;
          }

          .assistant-workflow-canvas .react-flow__controls-button {
            width: 30px;
            height: 30px;
            border-bottom: 1px solid hsl(var(--border));
            background: hsl(var(--background));
            color: hsl(var(--foreground));
            fill: currentColor;
          }

          .assistant-workflow-canvas .react-flow__controls-button:hover {
            background: hsl(var(--muted));
          }

          .assistant-workflow-canvas .react-flow__controls-button svg {
            fill: currentColor;
          }

          .assistant-workflow-canvas .react-flow__handle {
            opacity: 0;
            pointer-events: none;
          }

          .assistant-workflow-canvas .react-flow__attribution {
            display: none;
          }
        `}</style>
      </div>

      {editingTool && (
        <AssistantToolEditSheet
          open={editingToolIndex !== null}
          onOpenChange={(open) => {
            if (!open) setEditingToolIndex(null);
          }}
          tool={editingTool}
          onSave={saveTool}
          assistantId={assistantId}
          availableVariables={assistantVariableNames}
        />
      )}
    </div>
  );
}
