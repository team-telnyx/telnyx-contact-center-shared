"use client";

import React, {
  useEffect,
  useState,
  useCallback,
  useRef,
  useMemo,
} from "react";
import { useRouter, useParams } from "next/navigation";
import ReactFlow, {
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  Panel,
  Handle,
  Position,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
} from "reactflow";
import "reactflow/dist/style.css";
import { AdminPageContent, AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  IconArrowLeft,
  IconDeviceFloppy,
  IconAlertTriangle,
  IconAlertCircle,
  IconInfoCircle,
  IconTrash,
  IconCopy,
  IconCheck,
  IconPhoneOutgoing,
  IconPhoneCall,
  IconPhoneIncoming,
  IconWorld,
  IconPlayerPlay,
  IconVolume,
  IconVolumeOff,
  IconKeyboard,
  IconMicrophone,
  IconRobot,
  IconCircleCheck,
  IconRecordMail,
  IconFileText,
  IconLink,
  IconX,
  IconSearch,
  IconActivity,
  IconChevronDown,
  IconPhoneOff,
  IconCurrencyDollar,
  IconUser,
  IconPlus,
  IconVariable,
  IconApi,
  IconDatabase,
  IconGitBranch,
  IconGitFork,
  IconCircuitGround,
  IconCircleCheckFilled,
  IconBroadcast,
  IconBroadcastOff,
  IconWebhook,
  IconRobotOff,
  IconCircleFilled,
  IconSquare,
  IconPlayerPause,
  IconFileOff,
  IconGitMerge,
  IconCircuitSwitchOpen,
  IconFlag,
  IconLoader2,
  IconSettings,
  IconList,
} from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import {
  VOICE_FLOW_NODES,
  NODE_CATEGORIES,
  getNodesByCategory,
  getCategoryDisplayName,
} from "@/config/voice-flow-nodes";
import SpeakNodeEditor from "@/components/voice-flow/SpeakNodeEditor";
import GatherSpeakNodeEditor from "@/components/voice-flow/GatherSpeakNodeEditor";
import PlayAudioNodeEditor from "@/components/voice-flow/PlayAudioNodeEditor";
import TranscriptionNodeEditor from "@/components/voice-flow/TranscriptionNodeEditor";
import StreamingStartNodeEditor from "@/components/voice-flow/StreamingStartNodeEditor";
import ConditionNodeEditor from "@/components/voice-flow/ConditionNodeEditor";
import SwitchNodeEditor from "@/components/voice-flow/SwitchNodeEditor";
import SetVariableNodeEditor, {
  SetVariableNodeEditorSaveButton,
} from "@/components/voice-flow/SetVariableNodeEditor";
import LogicGateNodeEditor from "@/components/voice-flow/LogicGateNodeEditor";
import HttpRequestNodeEditor from "@/components/voice-flow/HttpRequestNodeEditor";
import DataActionsNodeEditor from "@/components/voice-flow/DataActionsNodeEditor";
import ReferNodeEditor from "@/components/voice-flow/ReferNodeEditor";
import DialNodeEditor from "@/components/voice-flow/DialNodeEditor";
import BridgeNodeEditor from "@/components/voice-flow/BridgeNodeEditor";
import AnswerNodeEditor from "@/components/voice-flow/AnswerNodeEditor";
import EnqueueNodeEditor from "@/components/voice-flow/EnqueueNodeEditor";
import SetQueueOptionsNodeEditor from "@/components/voice-flow/SetQueueOptionsNodeEditor";
import AgentAssistNodeEditor from "@/components/voice-flow/AgentAssistNodeEditor";
import { EdgeVariableMapper } from "@/components/voice-flow/EdgeVariableMapper";
import { VariableInput } from "@/components/voice-flow/VariableInput";
import { validateFlow } from "@/lib/voice-flow-validator";
import {
  getAllVariableNames,
  checkDuplicateVariableName,
} from "@/lib/variable-utils";
import { cn } from "@/lib/utils";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tool, ToolContent, ToolHeader } from "@/components/ai-elements/tool";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import useCallFlowMonitorStore, {
  useFlowEvents,
  useFlowCurrentCallControlId,
} from "@/lib/stores/call-flow-monitor-store";

// Icon mapping for node types
const iconMap = {
  IconPhoneOutgoing,
  IconPhoneCall,
  IconPhoneIncoming,
  IconPhoneOff,
  IconWorld,
  IconPlayerPlay,
  IconVolume,
  IconVolumeOff,
  IconKeyboard,
  IconMicrophone,
  IconRobot,
  IconRobotOff,
  IconCircleCheck,
  IconRecordMail,
  IconFileText,
  IconFileOff,
  IconLink,
  IconTrash,
  IconBroadcast,
  IconBroadcastOff,
  IconWebhook,
  IconCircleFilled,
  IconSquare,
  IconPlayerPause,
  IconGitBranch,
  IconGitMerge,
  IconVariable,
  IconCircuitSwitchOpen,
  IconFlag,
  IconApi,
  IconX,
  IconSettings,
};

// Icon mapping for webhook event types
const getWebhookIcon = (eventType) => {
  if (!eventType)
    return <IconActivity className="size-4 text-muted-foreground" />;

  const type = eventType.toLowerCase();

  if (type.includes("call.initiated") || type.includes("call.received")) {
    return <IconPhoneIncoming className="size-4 text-blue-500" />;
  }
  if (type.includes("call.answered")) {
    return <IconPhoneCall className="size-4 text-green-500" />;
  }
  if (type.includes("call.hangup") || type.includes("call.ended")) {
    return <IconPhoneOff className="size-4 text-red-500" />;
  }
  if (type.includes("call.cost")) {
    return <IconCurrencyDollar className="size-4 text-emerald-500" />;
  }
  if (type.includes("answer") && !type.includes("answered")) {
    return <IconUser className="size-4 text-blue-500" />;
  }
  if (type.includes("speak") || type.includes("playback")) {
    return <IconVolume className="size-4 text-purple-500" />;
  }
  if (type.includes("gather") || type.includes("dtmf")) {
    return <IconKeyboard className="size-4 text-orange-500" />;
  }
  if (type.includes("recording")) {
    return <IconRecordMail className="size-4 text-pink-500" />;
  }
  if (type.includes("transcription")) {
    return <IconFileText className="size-4 text-cyan-500" />;
  }
  if (type.includes("streaming")) {
    return <IconBroadcast className="size-4 text-cyan-500" />;
  }
  if (type.includes("bridge") || type.includes("transfer")) {
    return <IconLink className="size-4 text-indigo-500" />;
  }
  if (type.includes("conversation") || type.includes("assistant")) {
    return <IconRobot className="size-4 text-violet-500" />;
  }

  return <IconActivity className="size-4 text-muted-foreground" />;
};

// Get icon for node execution events
const getNodeExecutionIcon = (nodeType) => {
  if (!nodeType)
    return <IconActivity className="size-4 text-muted-foreground" />;

  const type = nodeType.toLowerCase();

  if (type === "set_variable") {
    return <IconVariable className="size-4 text-blue-500" />;
  }
  if (type === "http_request_action") {
    return <IconApi className="size-4 text-indigo-500" />;
  }
  if (type === "data_action") {
    return <IconDatabase className="size-4 text-teal-500" />;
  }
  if (type === "condition") {
    return <IconGitBranch className="size-4 text-yellow-500" />;
  }
  if (type === "switch") {
    return <IconGitFork className="size-4 text-orange-500" />;
  }
  if (type === "logic_gate") {
    return <IconCircuitGround className="size-4 text-purple-500" />;
  }
  if (type === "flow_end") {
    return <IconCircleCheckFilled className="size-4 text-green-500" />;
  }

  return <IconActivity className="size-4 text-muted-foreground" />;
};

// Custom ToolHeader for webhooks with icons
function WebhookToolHeader({ eventType, direction, timestamp, className }) {
  const Icon = getWebhookIcon(eventType);
  const isSent = direction === "sent";

  // Format timestamp with milliseconds
  const formatTimestamp = (ts) => {
    if (!ts) return "";
    try {
      const d = new Date(ts);
      if (isNaN(d.getTime())) return String(ts);
      const pad2 = (n) => String(n).padStart(2, "0");
      const pad3 = (n) => String(n).padStart(3, "0");
      const yyyy = d.getFullYear();
      const MM = pad2(d.getMonth() + 1);
      const DD = pad2(d.getDate());
      const HH = pad2(d.getHours());
      const mm = pad2(d.getMinutes());
      const ss = pad2(d.getSeconds());
      const SSS = pad3(d.getMilliseconds());
      return `${yyyy}-${MM}-${DD} ${HH}:${mm}:${ss}.${SSS}`;
    } catch {
      return String(ts);
    }
  };

  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full flex-col items-start p-3 hover:bg-muted/50 transition-colors",
        className,
      )}
    >
      <div className="flex items-center justify-between w-full gap-4">
        <div className="flex items-center gap-2">
          {Icon}
          <span className="font-medium text-sm">{eventType}</span>
          <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
            {isSent ? (
              <>
                <IconCircleCheck className="size-4 text-orange-600" />
                Sent
              </>
            ) : (
              <>
                <IconCircleCheck className="size-4 text-green-600" />
                Received
              </>
            )}
          </Badge>
        </div>
        <IconChevronDown className="size-4 text-muted-foreground transition-transform data-[state=open]:rotate-180 flex-shrink-0" />
      </div>
      {timestamp && (
        <div className="text-[10px] text-muted-foreground mt-1 ml-6">
          {formatTimestamp(timestamp)}
        </div>
      )}
    </CollapsibleTrigger>
  );
}

// Custom ToolHeader for node execution events
function NodeExecutionToolHeader({
  nodeType,
  nodeLabel,
  success,
  timestamp,
  className,
}) {
  const Icon = getNodeExecutionIcon(nodeType);

  // Format timestamp with milliseconds
  const formatTimestamp = (ts) => {
    if (!ts) return "";
    try {
      const d = new Date(ts);
      if (isNaN(d.getTime())) return String(ts);
      const pad2 = (n) => String(n).padStart(2, "0");
      const pad3 = (n) => String(n).padStart(3, "0");
      const yyyy = d.getFullYear();
      const MM = pad2(d.getMonth() + 1);
      const DD = pad2(d.getDate());
      const HH = pad2(d.getHours());
      const mm = pad2(d.getMinutes());
      const ss = pad2(d.getSeconds());
      const SSS = pad3(d.getMilliseconds());
      return `${yyyy}-${MM}-${DD} ${HH}:${mm}:${ss}.${SSS}`;
    } catch {
      return String(ts);
    }
  };

  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full flex-col items-start p-3 hover:bg-muted/50 transition-colors",
        className,
      )}
    >
      <div className="flex items-center justify-between w-full gap-4">
        <div className="flex items-center gap-2">
          {Icon}
          <span className="font-medium text-sm">{nodeLabel || nodeType}</span>
          <Badge
            className="gap-1.5 rounded-full text-xs"
            variant={success ? "default" : "destructive"}
          >
            {success ? (
              <>
                <IconCircleCheckFilled className="size-4" />
                Success
              </>
            ) : (
              <>
                <IconAlertCircle className="size-4" />
                Failed
              </>
            )}
          </Badge>
        </div>
        <IconChevronDown className="size-4 text-muted-foreground transition-transform data-[state=open]:rotate-180 flex-shrink-0" />
      </div>
      {timestamp && (
        <div className="text-[10px] text-muted-foreground mt-1 ml-6">
          {formatTimestamp(timestamp)}
        </div>
      )}
    </CollapsibleTrigger>
  );
}

function getJsonObjectPreview(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return JSON.stringify(value, null, 2);
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify(parsed, null, 2);
    }
  } catch {
    return null;
  }

  return null;
}

function formatInlineValue(value) {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}

// Render node execution details based on node type
function renderNodeExecutionDetails(nodeType, details, success) {
  if (!details) {
    return (
      <div className="p-3 text-sm text-muted-foreground">
        No details available
      </div>
    );
  }

  // Set Variable Node
  if (nodeType === "set_variable") {
    const resultJsonPreview = success
      ? getJsonObjectPreview(details.result)
      : null;

    return (
      <div className="p-3 space-y-3 text-sm">
        <div className="space-y-1">
          <span className="font-semibold">Variable Name:</span>
          <code className="ml-2 bg-muted px-2 py-0.5 rounded text-xs break-all">
            {details.variable_name}
          </code>
        </div>
        <div className="space-y-1">
          <span className="font-semibold">Expression:</span>
          <code className="ml-2 bg-muted px-2 py-0.5 rounded text-xs break-all">
            {details.expression}
          </code>
        </div>
        {success ? (
          <div className="space-y-1 border-t pt-3">
            <span className="font-semibold">Result:</span>
            {resultJsonPreview ? (
              <CodeBlock
                code={resultJsonPreview}
                language="json"
                className="mt-1"
                showLineNumbers
              >
                <CodeBlockCopyButton />
              </CodeBlock>
            ) : (
              <code className="ml-2 bg-muted px-2 py-0.5 rounded text-xs break-all">
                {formatInlineValue(details.result)}
              </code>
            )}
          </div>
        ) : (
          <div className="text-destructive border-t pt-3">
            <span className="font-semibold">Error:</span>
            <span className="ml-2">{details.error}</span>
          </div>
        )}
      </div>
    );
  }

  // HTTP Request Node
  if (nodeType === "http_request_action") {
    return (
      <div className="p-3 space-y-3 text-sm">
        <div className="space-y-1">
          <div className="font-semibold text-xs uppercase text-muted-foreground">
            Request
          </div>
          <div>
            <span className="font-semibold">Method:</span>
            <Badge className="ml-2" variant="outline">
              {details.request?.method}
            </Badge>
          </div>
          <div>
            <span className="font-semibold">URL:</span>
            <code className="ml-2 bg-muted px-2 py-0.5 rounded text-xs break-all">
              {details.request?.url}
            </code>
          </div>
          {details.request?.body && (
            <div>
              <span className="font-semibold">Body:</span>
              <CodeBlock
                code={details.request.body}
                language="json"
                className="mt-1"
              >
                <CodeBlockCopyButton />
              </CodeBlock>
            </div>
          )}
        </div>

        {details.response ? (
          <div className="space-y-1 border-t pt-3">
            <div className="font-semibold text-xs uppercase text-muted-foreground">
              Response
            </div>
            <div>
              <span className="font-semibold">Status:</span>
              <span
                className={`ml-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${
                  details.response.status >= 200 &&
                  details.response.status < 300
                    ? "bg-green-50 text-green-700 border-green-200"
                    : details.response.status >= 300 &&
                        details.response.status < 400
                      ? "bg-blue-50 text-blue-700 border-blue-200"
                      : details.response.status >= 400 &&
                          details.response.status < 500
                        ? "bg-red-50 text-red-700 border-red-200"
                        : details.response.status >= 500
                          ? "bg-orange-50 text-orange-700 border-orange-200"
                          : "bg-gray-50 text-gray-700 border-gray-200"
                }`}
              >
                {details.response.status} {details.response.status_text}
              </span>
            </div>
            {details.response?.body && (
              <div>
                <span className="font-semibold">Body:</span>
                <CodeBlock
                  code={
                    typeof details.response.body === "string"
                      ? details.response.body
                      : JSON.stringify(details.response.body, null, 2)
                  }
                  language="json"
                  className="mt-1"
                >
                  <CodeBlockCopyButton />
                </CodeBlock>
              </div>
            )}
          </div>
        ) : (
          details.error && (
            <div className="text-destructive border-t pt-3">
              <span className="font-semibold">Error:</span>
              <span className="ml-2">{details.error}</span>
            </div>
          )
        )}
      </div>
    );
  }

  // Condition Node
  if (nodeType === "condition") {
    return (
      <div className="p-3 space-y-2 text-sm">
        <div>
          <span className="font-semibold">Left Operand:</span>
          <code className="ml-2 bg-muted px-2 py-0.5 rounded text-xs">
            {details.left_operand}
          </code>
        </div>
        <div>
          <span className="font-semibold">Operator:</span>
          <Badge className="ml-2" variant="outline">
            {details.operator}
          </Badge>
        </div>
        <div>
          <span className="font-semibold">Right Operand:</span>
          <code className="ml-2 bg-muted px-2 py-0.5 rounded text-xs">
            {details.right_operand}
          </code>
        </div>
        <div>
          <span className="font-semibold">Data Type:</span>
          <Badge className="ml-2" variant="secondary">
            {details.data_type}
          </Badge>
        </div>
        {success ? (
          <div className="pt-2 border-t">
            <span className="font-semibold">Result:</span>
            <Badge
              className="ml-2"
              variant={details.result ? "default" : "secondary"}
            >
              {details.result ? "TRUE" : "FALSE"}
            </Badge>
            <span className="ml-2 text-muted-foreground">
              → {details.output_path}
            </span>
          </div>
        ) : (
          <div className="text-destructive">
            <span className="font-semibold">Error:</span>
            <span className="ml-2">{details.error}</span>
          </div>
        )}
      </div>
    );
  }

  // Switch Node
  if (nodeType === "switch") {
    return (
      <div className="p-3 space-y-2 text-sm">
        <div>
          <span className="font-semibold">Variable:</span>
          <code className="ml-2 bg-muted px-2 py-0.5 rounded text-xs">
            {details.variable}
          </code>
        </div>
        <div>
          <span className="font-semibold">Value:</span>
          <code className="ml-2 bg-muted px-2 py-0.5 rounded text-xs">
            {JSON.stringify(details.variable_value)}
          </code>
        </div>
        {details.cases && details.cases.length > 0 && (
          <div>
            <span className="font-semibold">Cases:</span>
            <div className="ml-2 mt-1 space-y-1">
              {details.cases.map((c, idx) => (
                <div key={idx} className="text-xs">
                  <Badge
                    variant={
                      details.matched_case?.value === c.value
                        ? "default"
                        : "secondary"
                    }
                  >
                    {c.label || c.value}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="pt-2 border-t">
          <span className="font-semibold">Matched:</span>
          <Badge className="ml-2" variant="default">
            {details.output_path}
          </Badge>
        </div>
      </div>
    );
  }

  // Logic Gate Node
  if (nodeType === "logic_gate") {
    return (
      <div className="p-3 space-y-2 text-sm">
        <div>
          <span className="font-semibold">Operator:</span>
          <Badge className="ml-2" variant="outline">
            {details.operator}
          </Badge>
        </div>
        {details.conditions && details.conditions.length > 0 && (
          <div>
            <span className="font-semibold">Conditions:</span>
            <div className="ml-2 mt-2 space-y-2">
              {details.conditions.map((cond, idx) => (
                <div key={idx} className="text-xs bg-muted p-2 rounded">
                  <div className="flex items-center gap-2">
                    <code>{cond.condition?.leftOperand}</code>
                    <Badge variant="secondary">
                      {cond.condition?.operator}
                    </Badge>
                    <code>{cond.condition?.rightOperand}</code>
                    <span>→</span>
                    <Badge variant={cond.result ? "default" : "secondary"}>
                      {cond.result ? "TRUE" : "FALSE"}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {success ? (
          <div className="pt-2 border-t">
            <span className="font-semibold">Final Result:</span>
            <Badge
              className="ml-2"
              variant={details.final_result ? "default" : "secondary"}
            >
              {details.final_result ? "TRUE" : "FALSE"}
            </Badge>
            <span className="ml-2 text-muted-foreground">
              → {details.output_path}
            </span>
          </div>
        ) : (
          <div className="text-destructive">
            <span className="font-semibold">Error:</span>
            <span className="ml-2">{details.error}</span>
          </div>
        )}
      </div>
    );
  }

  // Flow End Node
  if (nodeType === "flow_end") {
    return (
      <div className="p-3 text-sm">
        <div className="flex items-center gap-2 text-green-600">
          <IconCircleCheckFilled className="size-4" />
          <span className="font-semibold">{details.message}</span>
        </div>
      </div>
    );
  }

  // Default fallback - show raw JSON
  return (
    <div className="p-3">
      <CodeBlock code={JSON.stringify(details, null, 2)} language="json">
        <CodeBlockCopyButton />
      </CodeBlock>
    </div>
  );
}

// Custom node component with connection handles
function CustomNode({ data, selected }) {
  const nodeDef = VOICE_FLOW_NODES[data.nodeType];
  if (!nodeDef) return null;

  const hasInput = nodeDef.inputs > 0;
  // For switch nodes, use dynamic outputs/outputLabels from node.data if available
  const outputs =
    data.dynamicOutputs !== undefined
      ? data.dynamicOutputs
      : nodeDef.outputs || 0;
  const outputLabels = data.dynamicOutputLabels || nodeDef.outputLabels || [];
  const isActive = data.isActive || false;

  // Get icon component
  const IconComponent = iconMap[nodeDef.icon] || IconCircleCheck;

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <div
          className={`shadow-lg rounded-lg border-2 bg-card text-card-foreground transition-all ${
            isActive
              ? "border-[#00C081] shadow-[0_0_15px_rgba(0,192,129,0.5)]"
              : selected
                ? "border-primary"
                : "border-border"
          }`}
          style={{
            minWidth: "280px",
            animation: isActive
              ? "nodeBorderBlink 0.8s ease-in-out infinite"
              : undefined,
          }}
        >
          {isActive && (
            <style>{`
              @keyframes nodeBorderBlink {
                0%, 100% { 
                  border-color: #00C081;
                  box-shadow: 0 0 15px rgba(0,192,129,0.8);
                }
                50% { 
                  border-color: #00C081;
                  box-shadow: 0 0 5px rgba(0,192,129,0.3);
                }
              }
            `}</style>
          )}
          {/* Header: Icon, Node Name, and Node Number */}
          <div className="flex items-center justify-between px-2 py-1 border-b">
            <div className="flex items-center gap-0">
              <div
                className="flex items-center justify-center w-8 h-8 rounded-md flex-shrink-0"
                style={{
                  backgroundColor: `${nodeDef.color}20`,
                  color: nodeDef.color,
                }}
              >
                <IconComponent className="h-5 w-5" />
              </div>
              <div className="font-semibold text-base">{data.label}</div>
            </div>
            {data.nodeNumber && (
              <Badge variant="outline" className="text-xs font-semibold">
                #{data.nodeNumber}
              </Badge>
            )}
          </div>

          {/* Input Handle - positioned at the edge */}
          {hasInput && (
            <Handle
              type="target"
              position={Position.Left}
              id="input-execute"
              style={{
                background: nodeDef.color,
                width: "12px",
                height: "12px",
                border: "2px solid white",
                borderRadius: "2px",
                left: "5px",
                top: "63px",
              }}
            />
          )}

          {/* Output Handles - positioned at the edge */}
          {outputs > 0 &&
            [...Array(outputs)].map((_, index) => {
              const handleTopPosition = 63 + index * 37;
              return (
                <Handle
                  key={`handle-${index}`}
                  type="source"
                  position={Position.Right}
                  id={`output-${index}`}
                  style={{
                    background: nodeDef.color,
                    width: "12px",
                    height: "12px",
                    border: "2px solid white",
                    borderRadius: "2px",
                    right: "5px",
                    top: `${handleTopPosition}px`,
                  }}
                />
              );
            })}

          {/* Main Content Area */}
          <div className="flex min-h-[40px]">
            {/* Left Side - Inputs */}
            <div
              className={`flex-1 pl-2 pr-3 py-3 ${
                hasInput && outputs > 0 ? "border-r" : ""
              }`}
            >
              {hasInput && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="text-xs font-medium whitespace-nowrap ml-3">
                      Execute
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Right Side - Outputs */}
            <div className="flex-1 pl-3 pr-2 py-3 space-y-3">
              {outputs > 0 &&
                [...Array(outputs)].map((_, index) => {
                  // Use dynamic outputDescriptions/Events/Labels if available (for dial/switch nodes), otherwise use nodeDef
                  const outputDescription =
                    data.dynamicOutputDescriptions?.[index] ||
                    nodeDef.outputDescriptions?.[index];
                  const outputEvent =
                    data.dynamicOutputEvents?.[index] ||
                    nodeDef.outputEvents?.[index];
                  const outputLabel =
                    outputLabels[index] || nodeDef.outputLabels?.[index];
                  // Prioritize outputLabels over outputEvents, fallback to output-{index}
                  const displayLabel =
                    outputLabel || outputEvent || `output-${index}`;

                  return (
                    <div key={index} title={outputDescription}>
                      {/* Output Label */}
                      <div className="flex items-center justify-end mr-3">
                        <div className="text-[11px] text-muted-foreground font-mono flex items-center gap-1.5 whitespace-nowrap">
                          <IconCircleCheck className="h-3 w-3 flex-shrink-0" />
                          {displayLabel}
                        </div>
                      </div>
                      {index < outputs - 1 && <div className="border-b my-2" />}
                    </div>
                  );
                })}
            </div>
          </div>

          {data.hasErrors && (
            <div className="px-4 py-2 border-t">
              <Badge
                variant="destructive"
                className="text-xs w-full justify-center"
              >
                Missing required fields
              </Badge>
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onClick={() => data.onDelete && data.onDelete(data.nodeId)}
        >
          <IconTrash className="h-4 w-4 mr-2" />
          Delete Node
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// Custom edge component with delete button and variable mapping badge
function CustomEdge({
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
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const isActive = data?.isActive || false;

  const onEdgeClick = (evt) => {
    evt.stopPropagation();
    if (data?.onDelete) {
      data.onDelete(id);
    }
  };

  const onConfigureVariables = (evt) => {
    evt.stopPropagation();
    if (data?.onConfigureVariables) {
      data.onConfigureVariables(id);
    }
  };

  const hasVariableMappings =
    data?.variableMappings && data.variableMappings.length > 0;
  const varCount = data?.variableMappings?.length || 0;

  // Active edge style with blinking animation
  const edgeStyle = isActive
    ? {
        ...style,
        stroke: "#00C081",
        strokeWidth: 3,
        animation: "edgeBlink 0.5s ease-in-out infinite",
      }
    : style;

  return (
    <>
      <style>{`
        @keyframes edgeBlink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
      <BaseEdge path={edgePath} markerEnd={markerEnd} style={edgeStyle} />

      {/* Show variable badge when mappings exist */}
      {hasVariableMappings && !selected && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              fontSize: 10,
              pointerEvents: "all",
            }}
            className="nodrag nopan"
            title={`${varCount} variable${varCount > 1 ? "s" : ""} mapped`}
          >
            <button
              className="flex items-center gap-1 px-2 py-0.5 bg-telnyx-green text-white rounded-full border border-background shadow-md hover:scale-105 transition-transform text-xs"
              onClick={onConfigureVariables}
            >
              {varCount} var{varCount > 1 ? "s" : ""}
            </button>
          </div>
        </EdgeLabelRenderer>
      )}

      {/* Show buttons when selected */}
      {selected && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              fontSize: 12,
              pointerEvents: "all",
            }}
            className="nodrag nopan flex items-center gap-1"
          >
            <button
              className="flex items-center justify-center w-6 h-6 bg-telnyx-green text-white rounded-full border-2 border-background shadow-lg hover:scale-110 transition-transform"
              onClick={onConfigureVariables}
              title="Configure variables"
            >
              <IconCurrencyDollar className="h-3 w-3" />
            </button>
            <button
              className="flex items-center justify-center w-6 h-6 bg-destructive text-destructive-foreground rounded-full border-2 border-background shadow-lg hover:scale-110 transition-transform"
              onClick={onEdgeClick}
              title="Delete connection"
            >
              <IconX className="h-3 w-3" />
            </button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = {
  customNode: CustomNode,
};

const edgeTypes = {
  default: CustomEdge,
};

// Variable Card Component (extracted to avoid hooks in loops)
function VariableCard({
  varName,
  varDef,
  globalVariables,
  setGlobalVariables,
  nodes,
  edges,
}) {
  const [editingName, setEditingName] = useState(varName);

  // Sync editingName when varName changes (after successful rename)
  useEffect(() => {
    setEditingName(varName);
  }, [varName]);

  // Check for duplicate variable name
  const duplicateCheck = useMemo(() => {
    return checkDuplicateVariableName(
      editingName,
      { nodes, edges, globalVariables },
      { type: "global", oldName: varName },
    );
  }, [editingName, nodes, edges, globalVariables, varName]);

  const handleNameBlur = () => {
    const newVarName = editingName.trim();
    // Only update if name changed and is valid
    if (newVarName && newVarName !== varName) {
      // Check for duplicates
      const check = checkDuplicateVariableName(
        newVarName,
        { nodes, edges, globalVariables },
        { type: "global", oldName: varName },
      );

      if (check.isDuplicate) {
        notify({
          title: "Error",
          description: check.message,
          variant: "error",
        });
        setEditingName(varName); // Reset to original
        return;
      }

      // Rename the variable
      const newVars = { ...globalVariables };
      delete newVars[varName];
      newVars[newVarName] = varDef;
      setGlobalVariables(newVars);
    } else if (!newVarName) {
      // Reset if empty
      setEditingName(varName);
    }
  };

  return (
    <div className="p-3 border rounded-md bg-card space-y-2 relative">
      {/* Delete button in top right corner */}
      <Button
        variant="ghost"
        size="sm"
        className="absolute top-2 right-2 h-6 w-6 p-0 text-destructive hover:bg-destructive/10"
        onClick={() => {
          const newVars = { ...globalVariables };
          delete newVars[varName];
          setGlobalVariables(newVars);
        }}
      >
        <IconTrash className="h-3 w-3" />
      </Button>

      {/* Variable Name - Full width */}
      <div>
        <Label className="text-xs mb-1">Variable Name</Label>
        <Input
          value={editingName}
          onChange={(e) => setEditingName(e.target.value)}
          onBlur={handleNameBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            }
          }}
          placeholder="variable_name"
          className={`text-xs font-mono ${
            duplicateCheck.isDuplicate ? "border-yellow-500" : ""
          }`}
        />
        {duplicateCheck.isDuplicate && (
          <p className="text-xs text-yellow-600 dark:text-yellow-500 mt-1 flex items-center gap-1">
            <IconAlertCircle className="h-3 w-3" />
            {duplicateCheck.message}
          </p>
        )}
      </div>

      {/* Type - Full width */}
      <div>
        <Label className="text-xs mb-1">Type</Label>
        <Select
          value={varDef.type || "string"}
          onValueChange={(value) => {
            setGlobalVariables({
              ...globalVariables,
              [varName]: {
                ...varDef,
                type: value,
              },
            });
          }}
        >
          <SelectTrigger className="text-xs w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="string">String</SelectItem>
            <SelectItem value="number">Number</SelectItem>
            <SelectItem value="boolean">Boolean</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Value - Full width */}
      <div>
        <Label className="text-xs mb-1">Value</Label>
        <Input
          value={varDef.value || ""}
          onChange={(e) => {
            setGlobalVariables({
              ...globalVariables,
              [varName]: {
                ...varDef,
                value: e.target.value,
              },
            });
          }}
          placeholder="Enter value"
          className="text-xs"
        />
      </div>
    </div>
  );
}

function normalizeAiAssistants(payload) {
  const rows = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload?.data) ? payload.data : [];
  return rows
    .map((assistant) => ({
      id: String(assistant?.id || assistant?.assistant_id || "").trim(),
      name: assistant?.name || assistant?.display_name || assistant?.id || "Untitled assistant",
      status: assistant?.status || "active",
    }))
    .filter((assistant) => assistant.id);
}

export default function FlowBuilderPage() {
  const params = useParams();
  const router = useRouter();
  const flowId = params.id;

  const [flowName, setFlowName] = useState("");
  const [flowDescription, setFlowDescription] = useState("");
  const [isFlowDefault, setIsFlowDefault] = useState(false);
  const [userVoiceAppId, setUserVoiceAppId] = useState(null);
  const [userVoiceAppName, setUserVoiceAppName] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);

  // Check if user is admin/owner
  useEffect(() => {
    async function checkAuth() {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store" });
        const data = await res.json();

        if (!data?.isAuth || !data?.user) {
          router.push("/signin");
          return;
        }

        // Check if user has admin or owner role
        const userRoles =
          data.user.roles &&
          Array.isArray(data.user.roles) &&
          data.user.roles.length > 0
            ? data.user.roles.map((r) => String(r).toLowerCase())
            : ["agent"];

        const hasAdminAccess = userRoles.some(
          (role) => role === "admin" || role === "owner",
        );

        if (!hasAdminAccess) {
          notify({
            title: "Access Denied",
            description: "You do not have permission to access this page.",
            variant: "error",
          });
          router.push("/");
          return;
        }

        setIsAuthorized(true);
      } catch (error) {
        console.error("Error checking authorization:", error);
        router.push("/signin");
      } finally {
        setCheckingAuth(false);
      }
    }

    checkAuth();
  }, [router]);
  const [saving, setSaving] = useState(false);
  const [selectedNode, setSelectedNode] = useState(null);
  const [nodeConfig, setNodeConfig] = useState({});
  const [setVariableValidation, setSetVariableValidation] = useState({
    isValid: false,
    hasUnsavedChanges: false,
    expressionValid: false,
    hasExpression: false,
  });
  const setVariableEditorRef = useRef(null);
  const shouldAutoSaveRef = useRef(false);
  const [validation, setValidation] = useState({
    valid: true,
    errors: [],
    warnings: [],
  });
  const [contextMenuPosition, setContextMenuPosition] = useState(null);
  const [contextMenuSearchQuery, setContextMenuSearchQuery] = useState("");
  const [showMonitor, setShowMonitor] = useState(false);
  const prevShowMonitorRef = useRef(false);
  const lastCallControlIdRef = useRef(null);

  // Use Zustand store for monitoring data
  // Use the exported hooks which handle SSR properly
  const monitorData = useFlowEvents(flowId);
  const currentCallControlId = useFlowCurrentCallControlId(flowId);
  const setFlowEvents = useCallFlowMonitorStore((state) => state.setFlowEvents);
  const setCurrentCallControlId = useCallFlowMonitorStore(
    (state) => state.setCurrentCallControlId,
  );
  const clearFlowEvents = useCallFlowMonitorStore(
    (state) => state.clearFlowEvents,
  );
  const [aiAssistants, setAiAssistants] = useState([]);
  const [assistantSearchQuery, setAssistantSearchQuery] = useState("");
  const [queues, setQueues] = useState([]);
  const [copiedField, setCopiedField] = useState(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [showExitDialog, setShowExitDialog] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState(null);
  const [showWebhookDialog, setShowWebhookDialog] = useState(false);
  const [webhookUpdateInfo, setWebhookUpdateInfo] = useState(null);
  const [showDescriptionDialog, setShowDescriptionDialog] = useState(false);
  const [tempDescription, setTempDescription] = useState("");
  const [globalVariables, setGlobalVariables] = useState({});
  const [showEdgeVariableMapper, setShowEdgeVariableMapper] = useState(false);
  const [selectedEdge, setSelectedEdge] = useState(null);
  const [leftPanelTab, setLeftPanelTab] = useState("nodes");
  const [rightPanelTab, setRightPanelTab] = useState("config");
  const [showGlobalVariablesPanel, setShowGlobalVariablesPanel] =
    useState(false);

  // Real-time monitoring state
  const [activeNodes, setActiveNodes] = useState(new Set());
  const [activeEdges, setActiveEdges] = useState(new Set());
  const eventSourceRef = useRef(null);
  const activeNodesByCallRef = useRef(new Map()); // Track active node per call

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  const reactFlowWrapper = useRef(null);
  const contextMenuRef = useRef(null);
  const [reactFlowInstance, setReactFlowInstance] = useState(null);

  // Store initial state for comparison
  const initialStateRef = useRef({
    name: "",
    description: "",
    nodes: [],
    edges: [],
  });

  const handleDeleteEdge = useCallback(
    (edgeId) => {
      setEdges((eds) => eds.filter((e) => e.id !== edgeId));
    },
    [setEdges],
  );

  // Refs to store latest edges and nodes for callbacks
  const edgesRef = useRef(edges);
  const nodesRef = useRef(nodes);

  // Update refs when edges or nodes change
  useEffect(() => {
    console.log("📝 Updating edgesRef, count:", edges.length);
    edgesRef.current = edges;
  }, [edges]);

  useEffect(() => {
    console.log("📝 Updating nodesRef, count:", nodes.length);
    nodesRef.current = nodes;
  }, [nodes]);

  const handleConfigureEdgeVariables = useCallback((edgeId) => {
    console.log("🔍 Configure edge variables called for:", edgeId);

    // Use refs to get latest edges and nodes
    const currentEdges = edgesRef.current;
    const currentNodes = nodesRef.current;

    console.log("🔍 Ref has", currentEdges.length, "edges");
    console.log(
      "🔍 Available edges:",
      currentEdges.map((e) => e.id),
    );

    const edge = currentEdges.find((e) => e.id === edgeId);
    console.log("🔍 Found edge:", edge);

    if (edge) {
      const sourceNode = currentNodes.find((n) => n.id === edge.source);
      console.log("🔍 Source node:", sourceNode);

      setSelectedEdge(edge);
      setShowEdgeVariableMapper(true);
      console.log("🔍 Modal should open now");
    } else {
      console.error("❌ Edge not found:", edgeId);
      console.error(
        "❌ Available edge IDs:",
        currentEdges.map((e) => e.id),
      );
    }
  }, []);

  const onConnect = useCallback(
    (params) => {
      const newEdge = {
        ...params,
        data: {
          onDelete: handleDeleteEdge,
          onConfigureVariables: handleConfigureEdgeVariables,
          variableMappings: [],
        },
      };
      setEdges((eds) => addEdge(newEdge, eds));
    },
    [setEdges, handleDeleteEdge, handleConfigureEdgeVariables],
  );

  // Load flow data
  useEffect(() => {
    async function loadFlow() {
      try {
        const res = await fetch(`/api/voice/flows/${flowId}`);
        const data = await res.json();

        if (!res.ok || !data.ok) {
          throw new Error(data.error || "Failed to load flow");
        }

        const flow = data.flow;
        setFlowName(flow.name);
        setFlowDescription(flow.description || "");
        // Note: is_default is no longer used - multiple flows can be active
        setIsFlowDefault(false);
        setGlobalVariables(flow.globalVariables || {});

        // Set flow's voice application info for incoming_call nodes
        if (flow.telnyx_voice_app_id) {
          setUserVoiceAppId(flow.telnyx_voice_app_id);
          setUserVoiceAppName(flow.name || flow.telnyx_voice_app_id);
        }

        // Add onDelete callback and node numbers to all nodes
        // Also apply default values from node definitions for any missing config values
        const nodesWithCallbacks = (flow.nodes || []).map((node, index) => {
          const nodeType = node.data?.nodeType;
          const nodeDef = VOICE_FLOW_NODES[nodeType];
          const existingConfig = node.data?.config || {};

          // Apply default values for any missing parameters
          const configWithDefaults = { ...existingConfig };
          if (nodeDef?.config) {
            Object.entries(nodeDef.config).forEach(([paramKey, paramDef]) => {
              if (
                paramDef.default !== undefined &&
                (configWithDefaults[paramKey] === undefined ||
                  configWithDefaults[paramKey] === null ||
                  configWithDefaults[paramKey] === "")
              ) {
                configWithDefaults[paramKey] = paramDef.default;
              }
            });
          }

          // Initialize dynamic outputs/outputLabels for Switch nodes
          let dynamicOutputs = undefined;
          let dynamicOutputLabels = undefined;
          let dynamicOutputEvents = undefined;
          let dynamicOutputDescriptions = undefined;

          if (nodeType === "switch") {
            const cases = configWithDefaults.cases || [];
            const defaultLabel = configWithDefaults.defaultLabel || "Default";
            dynamicOutputLabels = cases.map(
              (c) => c.label || `Case ${c.value}`,
            );
            dynamicOutputLabels.push(defaultLabel);
            dynamicOutputs = dynamicOutputLabels.length;
          } else if (nodeType === "dial") {
            // Calculate dynamic outputs for Dial node based on AMD and streaming settings
            const baseOutputs = [
              "Call Initiated",
              "Call Answered",
              "Call Hangup",
            ];
            const baseEvents = [
              "call.initiated",
              "call.answered",
              "call.hangup",
            ];
            const baseDescriptions = [
              "Triggered when call is initiated (call.initiated event)",
              "Triggered when call is answered (call.answered event)",
              "Triggered when call hangs up (call.hangup event)",
            ];

            const amdType =
              configWithDefaults.answering_machine_detection || "disabled";
            const streamUrl = configWithDefaults.stream_url || "";

            // AMD exits - show all AMD exits if AMD is enabled (any option except "disabled")
            const amdOutputs = [];
            const amdEvents = [];
            const amdDescriptions = [];

            if (amdType !== "disabled") {
              // Show all AMD exits when any AMD option is selected
              amdOutputs.push(
                "AMD Detection Ended",
                "AMD Premium Detection Ended",
                "AMD Greeting Ended",
                "AMD Premium Greeting Ended",
              );
              amdEvents.push(
                "call.machine.detection.ended",
                "call.machine.premium.detection.ended",
                "call.machine.greeting.ended",
                "call.machine.premium.greeting.ended",
              );
              amdDescriptions.push(
                "Triggered when standard AMD detection ends (call.machine.detection.ended event)",
                "Triggered when premium AMD detection ends (call.machine.premium.detection.ended event)",
                "Triggered when machine greeting ends (call.machine.greeting.ended event)",
                "Triggered when premium machine greeting ends (call.machine.premium.greeting.ended event)",
              );
            }

            // Streaming exits (only if streaming is enabled)
            const streamingOutputs = [];
            const streamingEvents = [];
            const streamingDescriptions = [];

            if (streamUrl) {
              streamingOutputs.push(
                "Streaming Started",
                "Streaming Stopped",
                "Streaming Failed",
              );
              streamingEvents.push(
                "streaming.started",
                "streaming.stopped",
                "streaming.failed",
              );
              streamingDescriptions.push(
                "Triggered when streaming starts (streaming.started event)",
                "Triggered when streaming stops (streaming.stopped event)",
                "Triggered when streaming fails (streaming.failed event)",
              );
            }

            dynamicOutputLabels = [
              ...baseOutputs,
              ...amdOutputs,
              ...streamingOutputs,
            ];
            dynamicOutputEvents = [
              ...baseEvents,
              ...amdEvents,
              ...streamingEvents,
            ];
            dynamicOutputDescriptions = [
              ...baseDescriptions,
              ...amdDescriptions,
              ...streamingDescriptions,
            ];
            dynamicOutputs = dynamicOutputLabels.length;
          }

          return {
            ...node,
            data: {
              ...node.data,
              config: configWithDefaults,
              nodeId: node.id,
              nodeNumber: index + 1,
              onDelete: handleDeleteNodeById,
              ...(dynamicOutputs !== undefined && { dynamicOutputs }),
              ...(dynamicOutputLabels !== undefined && { dynamicOutputLabels }),
              ...(dynamicOutputEvents !== undefined && { dynamicOutputEvents }),
              ...(dynamicOutputDescriptions !== undefined && {
                dynamicOutputDescriptions,
              }),
            },
          };
        });

        // Add onDelete and onConfigureVariables callbacks to all edges
        const edgesWithCallbacks = (flow.edges || []).map((edge) => ({
          ...edge,
          data: {
            ...edge.data,
            onDelete: handleDeleteEdge,
            onConfigureVariables: handleConfigureEdgeVariables,
            variableMappings: edge.data?.variableMappings || [],
          },
        }));

        setNodes(nodesWithCallbacks);
        setEdges(edgesWithCallbacks);

        // Store initial state
        initialStateRef.current = {
          name: flow.name,
          description: flow.description || "",
          nodes: JSON.parse(JSON.stringify(flow.nodes || [])),
          edges: JSON.parse(JSON.stringify(flow.edges || [])),
        };
      } catch (error) {
        console.error("Error loading flow:", error);
        notify({
          title: "Error",
          description: "Failed to load flow",
          variant: "error",
        });
      } finally {
        setLoading(false);
      }
    }

    loadFlow();
  }, [flowId]);

  // Load user profile for queue name extraction
  useEffect(() => {
    async function loadUserProfile() {
      try {
        const res = await fetch("/api/user/profile");
        const data = await res.json();
        if (res.ok && data?.ok && data.data) {
          // Store user email for queue name extraction
          if (data.data.email || data.data.username) {
            setUserEmail(data.data.email || data.data.username);
          }
        }
      } catch (error) {
        console.error("Error loading user profile:", error);
      }
    }

    loadUserProfile();
  }, []);

  // Load enabled and active queues for enqueue node
  useEffect(() => {
    async function loadQueues() {
      try {
        const res = await fetch("/api/contact-center/queues/list");
        const data = await res.json();
        if (res.ok && data?.queues) {
          setQueues(data.queues);
        }
      } catch (error) {
        console.error("Error loading queues:", error);
      }
    }

    loadQueues();
  }, []);

  // Load AI assistants for Start AI Assistant node
  useEffect(() => {
    async function loadAiAssistants() {
      try {
        const res = await fetch("/api/ai/assistants?pageSize=1000");
        const data = await res.json();
        if (res.ok) {
          setAiAssistants(normalizeAiAssistants(data));
        }
      } catch (error) {
        console.error("Error loading AI assistants:", error);
      }
    }

    loadAiAssistants();
  }, []);

  // Validate flow whenever nodes/edges or queues change
  useEffect(() => {
    const result = validateFlow({ nodes, edges }, queues);
    setValidation(result);
  }, [nodes, edges, queues]);

  // Check if flow has an initiator (incoming_call/http_request/form_submit/outbound_campaign)
  const hasInitiator = useMemo(() => {
    return nodes.some(
      (node) =>
        node.data?.nodeType === "incoming_call" ||
        node.data?.nodeType === "http_request" ||
        node.data?.nodeType === "form_submit" ||
        node.data?.nodeType === "outbound_campaign",
    );
  }, [nodes]);

  // SSE connection for real-time monitoring (works for all flows with initiators)
  useEffect(() => {
    // In contact center, all flows with initiators can be monitored
    if (!hasInitiator || !showMonitor) {
      // Close existing connection if monitor is hidden or flow has no initiator
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
        setActiveNodes(new Set());
        setActiveEdges(new Set());
      }
      return;
    }

    const eventSource = new EventSource(
      `/api/voice/flows/${flowId}/monitor-stream`,
    );
    eventSourceRef.current = eventSource;

    eventSource.addEventListener("connected", (event) => {
      console.log("[Monitor] Connected to flow execution stream");
    });

    eventSource.addEventListener("execution", (event) => {
      const data = JSON.parse(event.data);
      const { events } = data;

      events.forEach((evt) => {
        if (evt.type === "node") {
          const callId = evt.callControlId;

          // Deactivate previous node for this call
          const previousNode = activeNodesByCallRef.current.get(callId);
          if (previousNode) {
            setActiveNodes((prev) => {
              const next = new Set(prev);
              next.delete(previousNode);
              return next;
            });
          }

          // Activate new node
          setActiveNodes((prev) => new Set(prev).add(evt.id));
          activeNodesByCallRef.current.set(callId, evt.id);
        } else if (evt.type === "edge") {
          // Activate edge
          const edgeKey = `${evt.sourceId}-${evt.targetId}`;
          setActiveEdges((prev) => new Set(prev).add(edgeKey));

          // Deactivate after 1 second (shorter for edges to create flow effect)
          setTimeout(() => {
            setActiveEdges((prev) => {
              const next = new Set(prev);
              next.delete(edgeKey);
              return next;
            });
          }, 1000);
        }
      });
    });

    eventSource.addEventListener("heartbeat", (event) => {
      // Keep connection alive
      console.log("[Monitor] Heartbeat received");
    });

    eventSource.onerror = (error) => {
      console.warn(
        "[Monitor] SSE connection lost (this may be normal during network issues):",
        error,
      );
      eventSource.close();
      eventSourceRef.current = null;
    };

    // Cleanup on unmount or when dependencies change
    return () => {
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [flowId, showMonitor, hasInitiator, nodes]);

  // Update nodes with active state
  useEffect(() => {
    setNodes((nds) =>
      nds.map((node) => ({
        ...node,
        data: {
          ...node.data,
          isActive: activeNodes.has(node.id),
        },
      })),
    );
  }, [activeNodes, setNodes]);

  // Update edges with active state
  useEffect(() => {
    setEdges((eds) =>
      eds.map((edge) => {
        const edgeKey = `${edge.source}-${edge.target}`;
        return {
          ...edge,
          data: {
            ...edge.data,
            isActive: activeEdges.has(edgeKey),
          },
        };
      }),
    );
  }, [activeEdges, setEdges]);

  // Track unsaved changes
  useEffect(() => {
    if (!initialStateRef.current.name) return; // Skip if not loaded yet

    const hasChanges =
      flowName !== initialStateRef.current.name ||
      flowDescription !== initialStateRef.current.description ||
      JSON.stringify(nodes) !== JSON.stringify(initialStateRef.current.nodes) ||
      JSON.stringify(edges) !== JSON.stringify(initialStateRef.current.edges);

    setHasUnsavedChanges(hasChanges);
  }, [flowName, flowDescription, nodes, edges]);

  // Auto-save when Set Variable expression is saved
  useEffect(() => {
    if (shouldAutoSaveRef.current && !saving) {
      shouldAutoSaveRef.current = false;
      handleSave();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, saving]); // Trigger when nodes change

  // Warn before closing browser tab/window
  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = "";
        return "";
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedChanges]);

  // Load existing monitoring data from server on mount (if any)
  useEffect(() => {
    const loadInitialData = async () => {
      try {
        const res = await fetch(`/api/voice/flows/${flowId}/monitor/webhooks`);
        if (res.ok) {
          const data = await res.json();
          if (data && data.ok && data.webhooks && data.webhooks.length > 0) {
            const webhooks = data.webhooks;
            const latestWebhook = webhooks[webhooks.length - 1];
            const newCallControlId = latestWebhook?.call_control_id || null;
            // Restore from server if we have data but Zustand store is empty
            const storeState = useCallFlowMonitorStore.getState();
            const existingData = storeState.flowData[flowId];
            if (!existingData || existingData.events.length === 0) {
              storeState.setFlowEvents(flowId, webhooks, newCallControlId);
            }
          }
        }
      } catch (error) {
        // Silently fail - this is just for restoring state
      }
    };

    loadInitialData();
  }, [flowId]);

  // Fetch monitoring data when monitor panel is opened
  useEffect(() => {
    if (!showMonitor) {
      // Reset tracking when monitor is closed
      lastCallControlIdRef.current = null;
      return;
    }

    // Initialize ref with current call control ID if available
    if (currentCallControlId && !lastCallControlIdRef.current) {
      lastCallControlIdRef.current = currentCallControlId;
    }

    const fetchMonitorData = async () => {
      try {
        const res = await fetch(`/api/voice/flows/${flowId}/monitor/webhooks`);
        if (!res.ok) {
          console.warn(
            "Monitor API returned non-OK status:",
            res.status,
            res.statusText,
          );
          return;
        }

        const data = await res.json();
        if (data && data.ok) {
          const webhooks = data.webhooks || [];

          // Find the latest run-start event to detect new phone-call or form-submit runs.
          // Phone calls start with call.initiated; Form Submit data actions use a
          // synthetic monitor id (form:<submission_id>) and start with form.submit.
          const latestRunStart = webhooks
            .filter(
              (w) =>
                w.event_type === "call.initiated" ||
                w.event_type === "form.submit",
            )
            .pop();

          const newCallControlId =
            latestRunStart?.call_control_id ||
            latestRunStart?.payload?.data?.payload?.call_control_id ||
            latestRunStart?.payload?.data?.payload?.monitor_run_id ||
            webhooks[webhooks.length - 1]?.call_control_id ||
            null;

          // Detect if this is a new call (different call_control_id)
          let webhooksToStore = webhooks;
          if (
            newCallControlId &&
            lastCallControlIdRef.current &&
            newCallControlId !== lastCallControlIdRef.current
          ) {
            // New call detected - filter to only include events from the new call
            console.log(
              "[Monitor] New call detected, clearing previous events",
            );
            clearFlowEvents(flowId);
            // Filter webhooks to only include events from the new call
            webhooksToStore = webhooks.filter(
              (w) => w.call_control_id === newCallControlId,
            );
            // Also clear server-side data for the previous call
            await fetch(`/api/voice/flows/${flowId}/monitor/clear`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                callControlId: lastCallControlIdRef.current,
              }),
            }).catch((err) =>
              console.error("Error clearing previous call data:", err),
            );
          }

          // Update the ref with the new call control ID
          if (newCallControlId) {
            lastCallControlIdRef.current = newCallControlId;
          }

          // Update Zustand store - this will persist across navigation
          setFlowEvents(flowId, webhooksToStore, newCallControlId);
        }
      } catch (error) {
        // Only log as warning to avoid console spam during network issues
        console.warn(
          "Monitor data fetch failed (this may be normal during network issues):",
          error.message,
        );
      }
    };

    fetchMonitorData();
    // Poll every 2 seconds
    const interval = setInterval(fetchMonitorData, 2000);

    return () => {
      clearInterval(interval);
    };
  }, [
    showMonitor,
    flowId,
    setFlowEvents,
    clearFlowEvents,
    currentCallControlId,
  ]);

  // Handle monitor panel state changes (track for other purposes if needed)
  useEffect(() => {
    // Update ref to current value
    prevShowMonitorRef.current = showMonitor;
  }, [showMonitor]);

  // Handler to clear monitor data (called by clear button)
  const handleClearMonitor = useCallback(async () => {
    // Clear server-side data
    try {
      await fetch(`/api/voice/flows/${flowId}/monitor/clear`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clearAll: true }),
      });
    } catch (err) {
      console.error("Error clearing monitor data:", err);
    }

    // Clear Zustand store for this flow
    clearFlowEvents(flowId);

    // Reset call control ID tracking
    lastCallControlIdRef.current = null;
  }, [flowId, clearFlowEvents]);

  async function handleSave() {
    // Check if flow has an initiator node before saving
    const hasInitiator = nodes.some(
      (node) =>
        node.data?.nodeType === "incoming_call" ||
        node.data?.nodeType === "http_request" ||
        node.data?.nodeType === "form_submit" ||
        node.data?.nodeType === "outbound_campaign",
    );

    if (!hasInitiator) {
      notify({
        title: "Error",
        description:
          "Cannot save flow: An initiator node (Incoming Call, HTTP Request, Form Submit, or Outbound Campaign) is required. Please add an initiator node first.",
        variant: "error",
      });
      return;
    }

    const currentValidation = validateFlow({ nodes, edges }, queues);
    setValidation(currentValidation);
    if (!currentValidation.valid) {
      notify({
        title: "Validation error",
        description:
          currentValidation.errors[0] ||
          "Cannot save flow until validation errors are fixed.",
        variant: "error",
      });
      return;
    }

    // Check for enqueue nodes with skill-based queues that have no skills
    const enqueueNodes = nodes.filter(
      (node) => node.data?.nodeType === "enqueue",
    );
    for (const node of enqueueNodes) {
      const config = node.data?.config || {};
      const queueName = config.queue_name;

      if (queueName) {
        // Find the queue to check its routing strategy
        const queue = queues.find((q) => q.name === queueName);
        if (queue && queue.routing_strategy === "Skill-based") {
          // Check if skills are defined
          const routingSkills = config.routing_skills || [];
          const hasSkills =
            Array.isArray(routingSkills) &&
            routingSkills.length > 0 &&
            routingSkills.some((skill) => skill.name && skill.proficiency);

          // Also check client_state for required_skills
          let hasSkillsInClientState = false;
          if (!hasSkills && config.client_state) {
            try {
              const decoded = atob(config.client_state);
              const clientStateObj = JSON.parse(decoded);
              if (
                clientStateObj.required_skills &&
                typeof clientStateObj.required_skills === "object" &&
                Object.keys(clientStateObj.required_skills).length > 0
              ) {
                hasSkillsInClientState = true;
              }
            } catch {
              // Ignore decode errors
            }
          }

          if (!hasSkills && !hasSkillsInClientState) {
            notify({
              title: "Error",
              description: `Cannot save flow: The "Enqueue Call" node "${
                node.data?.label || node.id
              }" uses a skill-based queue ("${
                queue.display_name || queueName
              }") but no required skills are defined. Please add at least one skill with a proficiency level.`,
              variant: "error",
            });
            return;
          }
        }
      }
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/voice/flows/${flowId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: flowName,
          description: flowDescription,
          nodes,
          edges,
          globalVariables,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Failed to save flow");
      }

      // Update initial state after successful save
      initialStateRef.current = {
        name: flowName,
        description: flowDescription,
        nodes: JSON.parse(JSON.stringify(nodes)),
        edges: JSON.parse(JSON.stringify(edges)),
      };
      setHasUnsavedChanges(false);

      // Update voice app name display in incoming_call nodes
      setUserVoiceAppName(flowName);

      notify({
        title: "Success",
        description: "Flow saved",
        variant: "success",
      });
    } catch (error) {
      console.error("Error saving flow:", error);
      notify({
        title: "Error",
        description: "Failed to save flow",
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  const handleBackClick = useCallback(() => {
    if (hasUnsavedChanges) {
      setShowExitDialog(true);
      setPendingNavigation("/admin/call-flows");
    } else {
      router.push("/admin/call-flows");
    }
  }, [hasUnsavedChanges, router]);

  const handleConfirmExit = useCallback(() => {
    setShowExitDialog(false);
    setHasUnsavedChanges(false);
    if (pendingNavigation) {
      router.push(pendingNavigation);
    }
  }, [pendingNavigation, router]);

  const handleCancelExit = useCallback(() => {
    setShowExitDialog(false);
    setPendingNavigation(null);
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenuPosition(null);
    setContextMenuSearchQuery("");
  }, []);

  const handleCopyToClipboard = useCallback((text, fieldKey) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedField(fieldKey);
      notify({
        title: "Success",
        description: "Copied to clipboard",
        variant: "success",
      });
      setTimeout(() => setCopiedField(null), 2000);
    });
  }, []);

  // Voice application selection is handled automatically - each flow uses its own voice app
  // No need for manual selection in contact center

  const handleUpdateWebhook = useCallback(async () => {
    if (!webhookUpdateInfo) return;

    try {
      const res = await fetch(
        `/api/voice/call-control-applications/${webhookUpdateInfo.appId}/webhook`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            webhook_url: webhookUpdateInfo.newUrl,
          }),
        },
      );

      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Failed to update webhook");
      }

      notify({
        title: "Success",
        description: "Webhook URL updated successfully",
        variant: "success",
      });
      setShowWebhookDialog(false);
      setWebhookUpdateInfo(null);
    } catch (error) {
      console.error("Error updating webhook:", error);
      notify({
        title: "Error",
        description: error.message || "Failed to update webhook URL",
        variant: "error",
      });
    }
  }, [webhookUpdateInfo]);

  const handleCancelWebhookUpdate = useCallback(() => {
    setShowWebhookDialog(false);
    setWebhookUpdateInfo(null);
  }, []);

  const handleOpenDescriptionDialog = useCallback(() => {
    setTempDescription(flowDescription);
    setShowDescriptionDialog(true);
  }, [flowDescription]);

  const handleSaveDescription = useCallback(() => {
    setFlowDescription(tempDescription);
    setShowDescriptionDialog(false);
  }, [tempDescription]);

  const handleCancelDescription = useCallback(() => {
    setShowDescriptionDialog(false);
    setTempDescription("");
  }, []);

  // Clear server data when monitor is closed
  useEffect(() => {
    // Detect when monitor changes from open (true) to closed (false)
    if (prevShowMonitorRef.current && !showMonitor) {
      fetch("/api/voice/monitor/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clearAll: true }),
      }).catch((err) => console.error("Error clearing monitor data:", err));
    }
    // Update ref to current value
    prevShowMonitorRef.current = showMonitor;
  }, [showMonitor]);

  const onNodeClick = useCallback((event, node) => {
    setSelectedNode(node);
    const config = node.data?.config || {};

    // Auto-detect variable mode for assistant_id
    if (config.assistant_id && config.assistant_id.startsWith("{{")) {
      config.assistant_id_use_variable = true;
    } else if (config.assistant_id && !config.assistant_id_use_variable) {
      config.assistant_id_use_variable = false;
    }

    setNodeConfig(config);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
    closeContextMenu();
  }, [closeContextMenu]);

  // Helper function to check if flow has an initiator node
  const hasInitiatorNode = useCallback(() => {
    return nodes.some(
      (node) =>
        node.data?.nodeType === "incoming_call" ||
        node.data?.nodeType === "http_request" ||
        node.data?.nodeType === "form_submit" ||
        node.data?.nodeType === "outbound_campaign",
    );
  }, [nodes]);

  function handleAddNode(nodeType, position = null) {
    const nodeDef = VOICE_FLOW_NODES[nodeType];
    if (!nodeDef) return;

    // Check if flow has an initiator node
    const hasInitiator = nodes.some(
      (node) =>
        node.data?.nodeType === "incoming_call" ||
        node.data?.nodeType === "http_request" ||
        node.data?.nodeType === "form_submit" ||
        node.data?.nodeType === "outbound_campaign",
    );

    // Check if trying to add an initiator node when one already exists
    if (nodeDef.category === NODE_CATEGORIES.INITIATOR) {
      if (hasInitiator) {
        notify({
          title: "Error",
          description:
            "Only one initiator node is allowed per flow. Please remove the existing initiator before adding a new one.",
          variant: "error",
        });
        return;
      }
    }

    // Check if trying to add a non-initiator node when no initiator exists
    if (nodeDef.category !== NODE_CATEGORIES.INITIATOR) {
      if (!hasInitiator) {
        notify({
          title: "Error",
          description:
            "Please add an initiator node (Incoming Call, HTTP Request, Form Submit, or Outbound Campaign) first before adding other nodes to the flow.",
          variant: "error",
        });
        return;
      }
    }

    const newNodeId = `${nodeType}_${Date.now()}`;

    // Initialize config with default values from node definition
    const defaultConfig = {};

    // Apply default values from node definition
    if (nodeDef.config) {
      Object.entries(nodeDef.config).forEach(([paramKey, paramDef]) => {
        if (paramDef.default !== undefined) {
          defaultConfig[paramKey] = paramDef.default;
        }
      });
    }

    // Auto-populate webhook URLs for initiator nodes (override defaults)
    const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

    if (nodeType === "incoming_call") {
      defaultConfig.webhook_url = `${baseUrl}/api/voice/webhook/incoming/${flowId}`;
      // Auto-populate voice application ID with user's voice app
      if (userVoiceAppId) {
        defaultConfig.voice_application_id = userVoiceAppId;
      }
    } else if (nodeType === "http_request") {
      defaultConfig.endpoint_path = `${baseUrl}/api/voice/flows/trigger/${flowId}`;
    } else if (nodeType === "form_submit") {
      defaultConfig.description =
        defaultConfig.description || "Run from an Agent Desktop form button";
    } else if (nodeType === "dial") {
      // Auto-populate webhook URL for Dial node to continue flow execution
      defaultConfig.webhook_url = `${baseUrl}/api/voice/webhook/flows/${flowId}`;
    }

    // Initialize dynamic outputs/outputLabels for Switch nodes
    let dynamicOutputs = undefined;
    let dynamicOutputLabels = undefined;
    if (nodeType === "switch") {
      const cases = defaultConfig.cases || [];
      const defaultLabel = defaultConfig.defaultLabel || "Default";
      dynamicOutputLabels = cases.map((c) => c.label || `Case ${c.value}`);
      dynamicOutputLabels.push(defaultLabel);
      dynamicOutputs = dynamicOutputLabels.length;
    }

    const newNode = {
      id: newNodeId,
      type: "customNode",
      position: position || { x: 250, y: 100 + nodes.length * 100 },
      data: {
        label: nodeDef.label,
        nodeType: nodeType,
        config: defaultConfig,
        nodeId: newNodeId,
        nodeNumber: nodes.length + 1,
        ...(dynamicOutputs !== undefined && { dynamicOutputs }),
        ...(dynamicOutputLabels !== undefined && { dynamicOutputLabels }),
        onDelete: handleDeleteNodeById,
      },
    };

    setNodes((nds) => {
      const updatedNodes = [...nds, newNode];
      // Recalculate node numbers
      return updatedNodes.map((node, index) => ({
        ...node,
        data: { ...node.data, nodeNumber: index + 1 },
      }));
    });
    setContextMenuPosition(null);
  }

  const onDragStart = (event, nodeType) => {
    event.dataTransfer.setData("application/reactflow", nodeType);
    event.dataTransfer.effectAllowed = "move";
  };

  const onDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (event) => {
      event.preventDefault();

      const nodeType = event.dataTransfer.getData("application/reactflow");
      if (!nodeType || !reactFlowInstance) return;

      const bounds = reactFlowWrapper.current.getBoundingClientRect();
      const position = reactFlowInstance.project({
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      });

      handleAddNode(nodeType, position);
    },
    [reactFlowInstance, nodes],
  );

  function handleUpdateNodeConfig(key, value) {
    setNodeConfig((prev) => ({ ...prev, [key]: value }));

    if (selectedNode) {
      const updatedConfig = { ...selectedNode.data.config, [key]: value };

      // Don't auto-detect variable mode during typing - only respect explicit mode setting
      // Auto-detection only happens when loading the node (in onNodeClick)

      setNodes((nds) =>
        nds.map((node) =>
          node.id === selectedNode.id
            ? {
                ...node,
                data: {
                  ...node.data,
                  config: updatedConfig,
                },
              }
            : node,
        ),
      );
    }
  }

  function handleDeleteNodeById(nodeId) {
    setNodes((nds) => {
      const filtered = nds.filter((n) => n.id !== nodeId);
      // Recalculate node numbers after deletion
      return filtered.map((node, index) => ({
        ...node,
        data: { ...node.data, nodeNumber: index + 1 },
      }));
    });
    setEdges((eds) =>
      eds.filter((e) => e.source !== nodeId && e.target !== nodeId),
    );
    if (selectedNode?.id === nodeId) {
      setSelectedNode(null);
    }
  }

  function handleDeleteNode() {
    if (!selectedNode) return;
    handleDeleteNodeById(selectedNode.id);
  }

  // Handle right-click on canvas
  const onPaneContextMenu = useCallback(
    (event) => {
      event.preventDefault();

      if (!reactFlowInstance) return;

      const bounds = reactFlowWrapper.current.getBoundingClientRect();
      const position = reactFlowInstance.project({
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      });

      setContextMenuPosition({
        x: event.clientX,
        y: event.clientY,
        flowPosition: position,
      });
    },
    [reactFlowInstance],
  );

  // Close context menu on scroll or click outside
  useEffect(() => {
    const handleClickOutside = () => closeContextMenu();
    const handleScroll = (e) => {
      // Don't close if scrolling inside the context menu
      if (contextMenuRef.current && contextMenuRef.current.contains(e.target)) {
        return;
      }
      closeContextMenu();
    };

    if (contextMenuPosition) {
      document.addEventListener("click", handleClickOutside);
      document.addEventListener("wheel", handleScroll);
      return () => {
        document.removeEventListener("click", handleClickOutside);
        document.removeEventListener("wheel", handleScroll);
      };
    }
  }, [contextMenuPosition, closeContextMenu]);

  const nodesByCategory = getNodesByCategory();

  // Show loading state while checking authorization
  if (checkingAuth || !isAuthorized) {
    return (
      <AdminPageShell>
        <AdminPageHeader title="Call Flow Editor" badges={<Badge variant="secondary">Authorizing</Badge>} />
        <AdminPageContent>
          <Card className="w-full">
            <CardContent className="space-y-4 pt-6">
              <div className="space-y-2">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-96 w-full" />
              </div>
            </CardContent>
          </Card>
        </AdminPageContent>
      </AdminPageShell>
    );
  }

  if (loading) {
    return (
      <AdminPageShell>
        <AdminPageHeader title="Call Flow Editor" badges={<Badge variant="secondary">Loading</Badge>} />
        <AdminPageContent>
          <div className="flex h-full items-center justify-center">
            <div className="flex items-center gap-2 text-muted-foreground">
              <IconLoader2 className="h-4 w-4 text-green-500 animate-spin" />
              <span>Loading flow...</span>
            </div>
          </div>
        </AdminPageContent>
      </AdminPageShell>
    );
  }

  const selectedNodeDef = selectedNode
    ? VOICE_FLOW_NODES[selectedNode.data?.nodeType]
    : null;

  return (
    <AdminPageShell>
      <AdminPageHeader
        title={flowName || "Call Flow Editor"}
        badges={hasUnsavedChanges ? (
          <Badge variant="outline" className="border-orange-500 text-orange-700 dark:text-orange-300">Unsaved</Badge>
        ) : (
          <Badge variant="outline" className="border-emerald-500 text-emerald-700 dark:text-emerald-300">Saved</Badge>
        )}
      />
      <AdminPageContent>
        <Card className="w-full" style={{ height: "calc(100vh - 220px)" }}>
        <CardContent className="p-0 h-full">
          <div className="flex h-full">
            {/* Left Sidebar - Node Palette & Variables */}
            <div className="w-64 border-r bg-card flex flex-col h-full">
              <Tabs
                value={leftPanelTab}
                onValueChange={setLeftPanelTab}
                className="flex-1 flex flex-col h-full"
              >
                <TabsList className="w-full rounded-none border-b flex-shrink-0">
                  <TabsTrigger value="nodes" className="flex-1">
                    Nodes
                  </TabsTrigger>
                </TabsList>

                <TabsContent
                  value="nodes"
                  className="flex-1 overflow-y-auto mt-0 h-0"
                >
                  {/* Nodes Tab */}
                  <div className="p-4 border-b">
                    <p className="text-xs text-muted-foreground">
                      Drag nodes to canvas, click to add, or right-click canvas
                    </p>
                  </div>

                  <div className="p-4 space-y-4">
                    {Object.keys(nodesByCategory).map((category) => (
                      <div key={category}>
                        <h4 className="text-xs font-semibold mb-2 text-muted-foreground uppercase">
                          {getCategoryDisplayName(category)}
                        </h4>
                        <div className="space-y-1">
                          {nodesByCategory[category].map((node) => (
                            <Button
                              key={node.id}
                              variant="outline"
                              size="sm"
                              className="w-full justify-start text-xs cursor-move"
                              style={{
                                borderLeftWidth: "3px",
                                borderLeftColor: node.color,
                              }}
                              draggable
                              onDragStart={(e) => onDragStart(e, node.id)}
                              onClick={() => handleAddNode(node.id)}
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

            {/* Main Canvas */}
            <div className="flex-1 flex flex-col">
              {/* Top Toolbar */}
              <div className="border-b bg-card p-4 flex items-center justify-between">
                <div className="flex items-center gap-4 flex-1">
                  <Button variant="ghost" size="icon" onClick={handleBackClick}>
                    <IconArrowLeft className="h-4 w-4" />
                  </Button>
                  <div className="flex items-center gap-2 flex-1 max-w-md">
                    <Input
                      value={flowName}
                      onChange={(e) => setFlowName(e.target.value)}
                      placeholder="Flow name"
                      className="font-semibold"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={handleOpenDescriptionDialog}
                      title="Edit flow description"
                    >
                      <IconInfoCircle className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  {/* Validation Badges */}
                  <div className="flex items-center gap-2">
                    {validation.errors.length > 0 && (
                      <Popover>
                        <PopoverTrigger asChild>
                          <Badge
                            variant="destructive"
                            className="cursor-pointer hover:bg-destructive/90 transition-colors"
                          >
                            <IconAlertTriangle className="h-3 w-3 mr-1" />
                            {validation.errors.length}
                          </Badge>
                        </PopoverTrigger>
                        <PopoverContent className="w-80" align="end">
                          <div className="space-y-2">
                            <h4 className="font-semibold text-sm text-destructive flex items-center gap-2">
                              <IconAlertTriangle className="h-4 w-4" />
                              Validation Errors
                            </h4>
                            <Separator />
                            <ul className="text-xs space-y-2 max-h-60 overflow-y-auto">
                              {validation.errors.map((error, i) => (
                                <li
                                  key={i}
                                  className="text-destructive flex items-start gap-2"
                                >
                                  <span className="text-destructive/70 flex-shrink-0">
                                    •
                                  </span>
                                  <span>{error}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        </PopoverContent>
                      </Popover>
                    )}

                    {validation.warnings.length > 0 && (
                      <Popover>
                        <PopoverTrigger asChild>
                          <Badge className="cursor-pointer bg-yellow-500 hover:bg-yellow-600 text-white transition-colors">
                            <IconAlertTriangle className="h-3 w-3 mr-1" />
                            {validation.warnings.length}
                          </Badge>
                        </PopoverTrigger>
                        <PopoverContent className="w-80" align="end">
                          <div className="space-y-2">
                            <h4 className="font-semibold text-sm text-yellow-600 dark:text-yellow-500 flex items-center gap-2">
                              <IconAlertTriangle className="h-4 w-4" />
                              Warnings
                            </h4>
                            <Separator />
                            <ul className="text-xs space-y-2 max-h-60 overflow-y-auto">
                              {validation.warnings.map((warning, i) => (
                                <li
                                  key={i}
                                  className="text-yellow-600 dark:text-yellow-500 flex items-start gap-2"
                                >
                                  <span className="text-yellow-600/70 dark:text-yellow-500/70 flex-shrink-0">
                                    •
                                  </span>
                                  <span>{warning}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        </PopoverContent>
                      </Popover>
                    )}
                  </div>

                  {(() => {
                    // Show Monitor button for all flows with an initiator
                    // In contact center, all flows are active and can be monitored
                    const hasInitiator = nodes.some(
                      (node) =>
                        node.data?.nodeType === "incoming_call" ||
                        node.data?.nodeType === "http_request" ||
                        node.data?.nodeType === "form_submit" ||
                        node.data?.nodeType === "outbound_campaign",
                    );

                    if (!hasInitiator) {
                      return null;
                    }

                    return (
                      <Button
                        variant="outline"
                        onClick={() => setShowMonitor(!showMonitor)}
                      >
                        <IconActivity className="h-4 w-4 mr-2" />
                        Monitor
                      </Button>
                    );
                  })()}
                  <Button
                    onClick={handleSave}
                    disabled={saving}
                    variant="default"
                    className={
                      hasUnsavedChanges
                        ? "border-2 border-red-500 hover:border-red-600"
                        : ""
                    }
                  >
                    <IconDeviceFloppy className="h-4 w-4 mr-2" />
                    {saving ? "Saving..." : "Save"}
                  </Button>
                </div>
              </div>

              {/* ReactFlow Canvas */}
              <div ref={reactFlowWrapper} className="flex-1 relative">
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={onConnect}
                  onNodeClick={onNodeClick}
                  onEdgeClick={(event, edge) => {
                    // Edge is now selected by ReactFlow automatically
                    // The CustomEdge component will show the configure button
                  }}
                  onPaneClick={onPaneClick}
                  onPaneContextMenu={onPaneContextMenu}
                  onInit={setReactFlowInstance}
                  onDrop={onDrop}
                  onDragOver={onDragOver}
                  nodeTypes={nodeTypes}
                  edgeTypes={edgeTypes}
                  fitView
                >
                  <Background />
                  <Controls />
                  <Panel
                    position="bottom-right"
                    className="bg-card border rounded p-2 text-xs"
                  >
                    <div className="text-muted-foreground">
                      {nodes.length} nodes • {edges.length} connections
                    </div>
                    <div className="text-xs text-muted-foreground mt-0">
                      Drag nodes from sidebar or right-click to add
                    </div>
                  </Panel>
                </ReactFlow>

                {/* Custom Context Menu */}
                {contextMenuPosition && (
                  <div
                    ref={contextMenuRef}
                    className="fixed z-50 min-w-[14rem] max-w-[18rem] rounded-md border bg-popover text-popover-foreground shadow-md flex flex-col"
                    style={{
                      left: `${contextMenuPosition.x}px`,
                      top: `${contextMenuPosition.y}px`,
                      maxHeight: "min(32rem, 80vh)",
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* Search Input */}
                    <div className="p-2 border-b sticky top-0 bg-popover z-10">
                      <div className="flex items-center gap-2 px-2 py-1.5 border rounded-md bg-background">
                        <IconSearch className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                        <Input
                          placeholder="Search nodes..."
                          value={contextMenuSearchQuery}
                          onChange={(e) =>
                            setContextMenuSearchQuery(e.target.value)
                          }
                          className="h-6 border-0 focus-visible:ring-0 focus-visible:ring-offset-0 bg-transparent p-0 text-sm"
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                          autoFocus
                        />
                      </div>
                    </div>

                    {/* Scrollable Node List */}
                    <div className="overflow-y-auto p-1">
                      {(() => {
                        let visibleCategoryCount = 0;
                        const categoryElements = Object.keys(nodesByCategory)
                          .map((category) => {
                            const filteredNodes = nodesByCategory[
                              category
                            ].filter((node) =>
                              node.label
                                .toLowerCase()
                                .includes(contextMenuSearchQuery.toLowerCase()),
                            );

                            if (filteredNodes.length === 0) return null;

                            const categoryIdx = visibleCategoryCount;
                            visibleCategoryCount++;

                            return (
                              <div key={category}>
                                {categoryIdx > 0 && (
                                  <div className="my-1 h-px bg-border" />
                                )}
                                <div className="px-2 py-1.5">
                                  <div className="text-xs font-semibold text-muted-foreground uppercase mb-1">
                                    {getCategoryDisplayName(category)}
                                  </div>
                                  {filteredNodes.map((node) => (
                                    <button
                                      key={node.id}
                                      className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground transition-colors"
                                      onClick={() => {
                                        handleAddNode(
                                          node.id,
                                          contextMenuPosition.flowPosition,
                                        );
                                        closeContextMenu();
                                      }}
                                    >
                                      <div
                                        className="w-2 h-2 rounded-full mr-2 flex-shrink-0"
                                        style={{ backgroundColor: node.color }}
                                      />
                                      <span className="truncate">
                                        {node.label}
                                      </span>
                                    </button>
                                  ))}
                                </div>
                              </div>
                            );
                          })
                          .filter(Boolean);

                        if (categoryElements.length === 0) {
                          return (
                            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                              {contextMenuSearchQuery
                                ? `No nodes found matching "${contextMenuSearchQuery}"`
                                : "No nodes available"}
                            </div>
                          );
                        }

                        return categoryElements;
                      })()}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Right Sidebar - Node Configuration & Variables */}
            <div className="w-96 border-l bg-card flex flex-col h-full">
              <Tabs
                value={rightPanelTab}
                onValueChange={setRightPanelTab}
                className="flex-1 flex flex-col h-full"
              >
                <TabsList className="w-full rounded-none border-b flex-shrink-0">
                  <TabsTrigger value="config" className="flex-1">
                    Config
                  </TabsTrigger>
                  <TabsTrigger value="variables" className="flex-1">
                    Variables
                  </TabsTrigger>
                </TabsList>

                <TabsContent
                  value="config"
                  className="flex-1 flex flex-col mt-0 h-0"
                >
                  {selectedNode && selectedNodeDef ? (
                    <>
                      {/* Static Header Section */}
                      <div className="p-4 pb-0 space-y-4 flex-shrink-0">
                        <div>
                          <h3 className="font-semibold">
                            {selectedNodeDef.label}
                          </h3>
                          <p className="text-xs text-muted-foreground mt-1">
                            {selectedNodeDef.description}
                          </p>
                        </div>

                        <Separator />

                        <div>
                          <Label>Node Label</Label>
                          <Input
                            value={selectedNode.data?.label || ""}
                            onChange={(e) => {
                              const newLabel = e.target.value;
                              setNodes((nds) =>
                                nds.map((node) =>
                                  node.id === selectedNode.id
                                    ? {
                                        ...node,
                                        data: {
                                          ...node.data,
                                          label: newLabel,
                                        },
                                      }
                                    : node,
                                ),
                              );
                              // Also update selectedNode so the input reflects the change
                              setSelectedNode((prev) =>
                                prev
                                  ? {
                                      ...prev,
                                      data: {
                                        ...prev.data,
                                        label: newLabel,
                                      },
                                    }
                                  : prev,
                              );
                            }}
                            className="mt-1"
                          />
                        </div>

                        <Separator />
                      </div>

                      {/* Scrollable Content Section */}
                      <div className="flex-1 overflow-y-auto p-4 pt-0">
                        <div className="space-y-3">
                          {selectedNodeDef.customEditor !==
                            "EnqueueNodeEditor" && (
                            <h4 className="text-sm font-semibold">
                              Configuration
                            </h4>
                          )}

                          {/* Use custom editor if defined */}
                          {selectedNodeDef.customEditor ===
                          "SpeakNodeEditor" ? (
                            <SpeakNodeEditor
                              config={nodeConfig}
                              onChange={(newConfig) => {
                                setNodeConfig(newConfig);
                                if (selectedNode) {
                                  setNodes((nds) =>
                                    nds.map((node) =>
                                      node.id === selectedNode.id
                                        ? {
                                            ...node,
                                            data: {
                                              ...node.data,
                                              config: newConfig,
                                            },
                                          }
                                        : node,
                                    ),
                                  );
                                }
                              }}
                              availableVariables={getAllVariableNames({
                                nodes,
                                edges,
                                globalVariables,
                              })}
                            />
                          ) : selectedNodeDef.customEditor ===
                            "GatherSpeakNodeEditor" ? (
                            <GatherSpeakNodeEditor
                              config={nodeConfig}
                              onChange={(newConfig) => {
                                setNodeConfig(newConfig);
                                if (selectedNode) {
                                  setNodes((nds) =>
                                    nds.map((node) =>
                                      node.id === selectedNode.id
                                        ? {
                                            ...node,
                                            data: {
                                              ...node.data,
                                              config: newConfig,
                                            },
                                          }
                                        : node,
                                    ),
                                  );
                                }
                              }}
                              availableVariables={getAllVariableNames({
                                nodes,
                                edges,
                                globalVariables,
                              })}
                            />
                          ) : selectedNodeDef.customEditor ===
                            "PlayAudioNodeEditor" ? (
                            <PlayAudioNodeEditor
                              config={nodeConfig}
                              onChange={(newConfig) => {
                                setNodeConfig(newConfig);
                                if (selectedNode) {
                                  setNodes((nds) =>
                                    nds.map((node) =>
                                      node.id === selectedNode.id
                                        ? {
                                            ...node,
                                            data: {
                                              ...node.data,
                                              config: newConfig,
                                            },
                                          }
                                        : node,
                                    ),
                                  );
                                }
                              }}
                            />
                          ) : selectedNodeDef.customEditor ===
                            "TranscriptionNodeEditor" ? (
                            <TranscriptionNodeEditor
                              config={nodeConfig}
                              onChange={(newConfig) => {
                                setNodeConfig(newConfig);
                                if (selectedNode) {
                                  setNodes((nds) =>
                                    nds.map((node) =>
                                      node.id === selectedNode.id
                                        ? {
                                            ...node,
                                            data: {
                                              ...node.data,
                                              config: newConfig,
                                            },
                                          }
                                        : node,
                                    ),
                                  );
                                }
                              }}
                            />
                          ) : selectedNodeDef.customEditor ===
                            "StreamingStartNodeEditor" ? (
                            <StreamingStartNodeEditor
                              config={nodeConfig}
                              currentUserEmail={userEmail}
                              onChange={(newConfig) => {
                                setNodeConfig(newConfig);
                                if (selectedNode) {
                                  setNodes((nds) =>
                                    nds.map((node) =>
                                      node.id === selectedNode.id
                                        ? {
                                            ...node,
                                            data: {
                                              ...node.data,
                                              config: newConfig,
                                            },
                                          }
                                        : node,
                                    ),
                                  );
                                }
                              }}
                            />
                          ) : selectedNodeDef.customEditor ===
                            "ConditionNodeEditor" ? (
                            <ConditionNodeEditor
                              config={nodeConfig}
                              onChange={(newConfig) => {
                                setNodeConfig(newConfig);
                                if (selectedNode) {
                                  setNodes((nds) =>
                                    nds.map((node) =>
                                      node.id === selectedNode.id
                                        ? {
                                            ...node,
                                            data: {
                                              ...node.data,
                                              config: newConfig,
                                            },
                                          }
                                        : node,
                                    ),
                                  );
                                }
                              }}
                              availableVariables={getAllVariableNames({
                                nodes,
                                edges,
                                globalVariables,
                              })}
                            />
                          ) : selectedNodeDef.customEditor ===
                            "SwitchNodeEditor" ? (
                            <SwitchNodeEditor
                              config={nodeConfig}
                              onChange={(newConfig) => {
                                setNodeConfig(newConfig);
                                if (selectedNode) {
                                  setNodes((nds) =>
                                    nds.map((node) =>
                                      node.id === selectedNode.id
                                        ? {
                                            ...node,
                                            data: {
                                              ...node.data,
                                              config: newConfig,
                                            },
                                          }
                                        : node,
                                    ),
                                  );
                                }
                              }}
                              onOutputsChange={(outputLabels) => {
                                if (selectedNode) {
                                  setNodes((nds) =>
                                    nds.map((node) =>
                                      node.id === selectedNode.id
                                        ? {
                                            ...node,
                                            data: {
                                              ...node.data,
                                              dynamicOutputs:
                                                outputLabels.length,
                                              dynamicOutputLabels: outputLabels,
                                            },
                                          }
                                        : node,
                                    ),
                                  );
                                }
                              }}
                              availableVariables={getAllVariableNames({
                                nodes,
                                edges,
                                globalVariables,
                              })}
                            />
                          ) : selectedNodeDef.customEditor ===
                            "SetVariableNodeEditor" ? (
                            <SetVariableNodeEditor
                              ref={setVariableEditorRef}
                              config={nodeConfig}
                              onChange={(newConfig) => {
                                setNodeConfig(newConfig);
                                if (selectedNode) {
                                  // Update nodes and get the new state
                                  setNodes((nds) => {
                                    const updatedNodes = nds.map((node) =>
                                      node.id === selectedNode.id
                                        ? {
                                            ...node,
                                            data: {
                                              ...node.data,
                                              config: newConfig,
                                            },
                                          }
                                        : node,
                                    );
                                    return updatedNodes;
                                  });
                                }
                              }}
                              onSave={() => {
                                // This is called AFTER onChange has been called
                                // Set flag to trigger auto-save on next render when nodes state updates
                                shouldAutoSaveRef.current = true;
                              }}
                              availableVariables={getAllVariableNames({
                                nodes,
                                edges,
                                globalVariables,
                              })}
                              nodes={nodes}
                              edges={edges}
                              globalVariables={globalVariables}
                              selectedNodeId={selectedNode?.id}
                              hideSaveButton={true}
                              onValidationChange={setSetVariableValidation}
                            />
                          ) : selectedNodeDef.customEditor ===
                            "LogicGateNodeEditor" ? (
                            <LogicGateNodeEditor
                              config={nodeConfig}
                              onChange={(newConfig) => {
                                setNodeConfig(newConfig);
                                if (selectedNode) {
                                  setNodes((nds) =>
                                    nds.map((node) =>
                                      node.id === selectedNode.id
                                        ? {
                                            ...node,
                                            data: {
                                              ...node.data,
                                              config: newConfig,
                                            },
                                          }
                                        : node,
                                    ),
                                  );
                                }
                              }}
                              availableVariables={getAllVariableNames({
                                nodes,
                                edges,
                                globalVariables,
                              })}
                            />
                          ) : selectedNodeDef.customEditor ===
                            "HttpRequestNodeEditor" ? (
                            <HttpRequestNodeEditor
                              config={nodeConfig}
                              onChange={(newConfig) => {
                                setNodeConfig(newConfig);
                                if (selectedNode) {
                                  setNodes((nds) =>
                                    nds.map((node) =>
                                      node.id === selectedNode.id
                                        ? {
                                            ...node,
                                            data: {
                                              ...node.data,
                                              config: newConfig,
                                            },
                                          }
                                        : node,
                                    ),
                                  );
                                }
                              }}
                              availableVariables={getAllVariableNames({
                                nodes,
                                edges,
                                globalVariables,
                              })}
                              nodes={nodes}
                              edges={edges}
                              globalVariables={globalVariables}
                              selectedNodeId={selectedNode?.id}
                            />
                          ) : selectedNodeDef.customEditor ===
                            "DataActionsNodeEditor" ? (
                            <DataActionsNodeEditor
                              config={nodeConfig}
                              onChange={(newConfig) => {
                                setNodeConfig(newConfig);
                                if (selectedNode) {
                                  setNodes((nds) =>
                                    nds.map((node) =>
                                      node.id === selectedNode.id
                                        ? {
                                            ...node,
                                            data: {
                                              ...node.data,
                                              config: newConfig,
                                            },
                                          }
                                        : node,
                                    ),
                                  );
                                }
                              }}
                              availableVariables={getAllVariableNames({
                                nodes,
                                edges,
                                globalVariables,
                              })}
                              nodes={nodes}
                              edges={edges}
                              globalVariables={globalVariables}
                              selectedNodeId={selectedNode?.id}
                            />
                          ) : selectedNodeDef.customEditor ===
                            "ReferNodeEditor" ? (
                            <ReferNodeEditor
                              config={nodeConfig}
                              onChange={(newConfig) => {
                                setNodeConfig(newConfig);
                                if (selectedNode) {
                                  setNodes((nds) =>
                                    nds.map((node) =>
                                      node.id === selectedNode.id
                                        ? {
                                            ...node,
                                            data: {
                                              ...node.data,
                                              config: newConfig,
                                            },
                                          }
                                        : node,
                                    ),
                                  );
                                }
                              }}
                            />
                          ) : selectedNodeDef.customEditor ===
                            "DialNodeEditor" ? (
                            <DialNodeEditor
                              config={nodeConfig}
                              onChange={(newConfig) => {
                                setNodeConfig(newConfig);
                                if (selectedNode) {
                                  setNodes((nds) =>
                                    nds.map((node) =>
                                      node.id === selectedNode.id
                                        ? {
                                            ...node,
                                            data: {
                                              ...node.data,
                                              config: newConfig,
                                            },
                                          }
                                        : node,
                                    ),
                                  );
                                }
                              }}
                              onOutputsChange={(
                                outputLabels,
                                outputEvents,
                                outputDescriptions,
                              ) => {
                                if (selectedNode) {
                                  setNodes((nds) =>
                                    nds.map((node) =>
                                      node.id === selectedNode.id
                                        ? {
                                            ...node,
                                            data: {
                                              ...node.data,
                                              dynamicOutputs:
                                                outputLabels.length,
                                              dynamicOutputLabels: outputLabels,
                                              dynamicOutputEvents: outputEvents,
                                              dynamicOutputDescriptions:
                                                outputDescriptions,
                                            },
                                          }
                                        : node,
                                    ),
                                  );
                                }
                              }}
                              availableVariables={getAllVariableNames({
                                nodes,
                                edges,
                                globalVariables,
                              })}
                            />
                          ) : selectedNodeDef.customEditor ===
                            "BridgeNodeEditor" ? (
                            <BridgeNodeEditor
                              config={nodeConfig}
                              onChange={(newConfig) => {
                                setNodeConfig(newConfig);
                                if (selectedNode) {
                                  setNodes((nds) =>
                                    nds.map((node) =>
                                      node.id === selectedNode.id
                                        ? {
                                            ...node,
                                            data: {
                                              ...node.data,
                                              config: newConfig,
                                            },
                                          }
                                        : node,
                                    ),
                                  );
                                }
                              }}
                            />
                          ) : selectedNodeDef.customEditor ===
                            "AnswerNodeEditor" ? (
                            <AnswerNodeEditor
                              config={nodeConfig}
                              onChange={(newConfig) => {
                                setNodeConfig(newConfig);
                                if (selectedNode) {
                                  setNodes((nds) =>
                                    nds.map((node) =>
                                      node.id === selectedNode.id
                                        ? {
                                            ...node,
                                            data: {
                                              ...node.data,
                                              config: newConfig,
                                            },
                                          }
                                        : node,
                                    ),
                                  );
                                }
                              }}
                              onOutputsChange={(
                                outputLabels,
                                outputEvents,
                                outputDescriptions,
                              ) => {
                                if (selectedNode) {
                                  setNodes((nds) =>
                                    nds.map((node) =>
                                      node.id === selectedNode.id
                                        ? {
                                            ...node,
                                            data: {
                                              ...node.data,
                                              dynamicOutputs:
                                                outputLabels.length,
                                              dynamicOutputLabels: outputLabels,
                                              dynamicOutputEvents: outputEvents,
                                              dynamicOutputDescriptions:
                                                outputDescriptions,
                                            },
                                          }
                                        : node,
                                    ),
                                  );
                                }
                              }}
                              availableVariables={getAllVariableNames({
                                nodes,
                                edges,
                                globalVariables,
                              })}
                            />
                          ) : selectedNodeDef.customEditor ===
                            "EnqueueNodeEditor" ? (
                            <EnqueueNodeEditor
                              config={nodeConfig}
                              onChange={(newConfig) => {
                                setNodeConfig(newConfig);
                                if (selectedNode) {
                                  setNodes((nds) =>
                                    nds.map((node) =>
                                      node.id === selectedNode.id
                                        ? {
                                            ...node,
                                            data: {
                                              ...node.data,
                                              config: newConfig,
                                            },
                                          }
                                        : node,
                                    ),
                                  );
                                }
                              }}
                              queues={queues}
                              nodes={nodes}
                              edges={edges}
                              currentNodeId={selectedNode?.id}
                            />
                          ) : selectedNodeDef.customEditor ===
                            "SetQueueOptionsNodeEditor" ? (
                            <SetQueueOptionsNodeEditor
                              config={nodeConfig}
                              onChange={(newConfig) => {
                                setNodeConfig(newConfig);
                                if (selectedNode) {
                                  setNodes((nds) =>
                                    nds.map((node) =>
                                      node.id === selectedNode.id
                                        ? {
                                            ...node,
                                            data: {
                                              ...node.data,
                                              config: newConfig,
                                            },
                                          }
                                        : node,
                                    ),
                                  );
                                }
                              }}
                              queues={queues}
                              availableVariables={getAllVariableNames({
                                nodes,
                                edges,
                                globalVariables,
                              })}
                            />
                          ) : selectedNodeDef.customEditor ===
                            "AgentAssistNodeEditor" ? (
                            <AgentAssistNodeEditor
                              config={nodeConfig}
                              currentUserEmail={userEmail}
                              availableVariables={getAllVariableNames({
                                nodes,
                                edges,
                                globalVariables,
                              })}
                              onChange={(newConfig) => {
                                setNodeConfig(newConfig);
                                if (selectedNode) {
                                  setNodes((nds) =>
                                    nds.map((node) =>
                                      node.id === selectedNode.id
                                        ? {
                                            ...node,
                                            data: {
                                              ...node.data,
                                              config: newConfig,
                                            },
                                          }
                                        : node,
                                    ),
                                  );
                                }
                              }}
                            />
                          ) : (
                            Object.entries(selectedNodeDef.config || {}).map(
                              ([key, paramDef]) => (
                                <div key={key}>
                                  <Label className="text-xs">
                                    {paramDef.label}
                                    {paramDef.required && (
                                      <span className="text-destructive ml-1">
                                        *
                                      </span>
                                    )}
                                  </Label>
                                  {paramDef.readOnly ? (
                                    <div className="relative mt-1">
                                      <div className="flex items-center gap-2">
                                        <Input
                                          value={
                                            nodeConfig[key] ||
                                            paramDef.placeholder ||
                                            ""
                                          }
                                          readOnly
                                          className="bg-muted pr-10 font-mono text-xs"
                                        />
                                        <Button
                                          type="button"
                                          variant="outline"
                                          size="icon"
                                          className="h-9 w-9 flex-shrink-0"
                                          onClick={() =>
                                            handleCopyToClipboard(
                                              nodeConfig[key] ||
                                                paramDef.placeholder ||
                                                "",
                                              key,
                                            )
                                          }
                                        >
                                          {copiedField === key ? (
                                            <IconCheck className="h-4 w-4 text-green-500" />
                                          ) : (
                                            <IconCopy className="h-4 w-4" />
                                          )}
                                        </Button>
                                      </div>
                                    </div>
                                  ) : paramDef.type === "textarea" ? (
                                    <Textarea
                                      value={nodeConfig[key] || ""}
                                      onChange={(e) =>
                                        handleUpdateNodeConfig(
                                          key,
                                          e.target.value,
                                        )
                                      }
                                      placeholder={paramDef.placeholder}
                                      className="mt-1"
                                      rows={3}
                                    />
                                  ) : paramDef.type === "voice_app_select" ? (
                                    <Input
                                      value={
                                        userVoiceAppName ||
                                        "Voice application not configured"
                                      }
                                      readOnly
                                      className="bg-muted mt-1"
                                    />
                                  ) : paramDef.type ===
                                    "ai_assistant_select" ? (
                                    <div className="space-y-2">
                                      {/* Mode Toggle - Full Width Tabs */}
                                      <Tabs
                                        value={
                                          nodeConfig[`${key}_use_variable`]
                                            ? "variable"
                                            : "static"
                                        }
                                        onValueChange={(value) => {
                                          const isVariable =
                                            value === "variable";
                                          handleUpdateNodeConfig(
                                            `${key}_use_variable`,
                                            isVariable,
                                          );
                                          // Clear value when switching modes
                                          if (isVariable) {
                                            // Switching to variable - clear static value
                                            const currentValue =
                                              nodeConfig[key] || "";
                                            if (
                                              currentValue &&
                                              !currentValue.startsWith("{{")
                                            ) {
                                              handleUpdateNodeConfig(key, "");
                                            }
                                          } else {
                                            // Switching to static - clear variable value
                                            if (
                                              nodeConfig[key]?.startsWith("{{")
                                            ) {
                                              handleUpdateNodeConfig(key, "");
                                            }
                                          }
                                        }}
                                        className="w-full"
                                      >
                                        <TabsList className="w-full grid grid-cols-2">
                                          <TabsTrigger
                                            value="static"
                                            className="text-xs"
                                          >
                                            Static
                                          </TabsTrigger>
                                          <TabsTrigger
                                            value="variable"
                                            className="text-xs"
                                          >
                                            <IconVariable className="h-3 w-3 mr-1" />
                                            Variable
                                          </TabsTrigger>
                                        </TabsList>
                                      </Tabs>

                                      {/* Static Dropdown */}
                                      {!nodeConfig[`${key}_use_variable`] && (
                                        <Select
                                          value={nodeConfig[key] || ""}
                                          onValueChange={(value) => {
                                            handleUpdateNodeConfig(key, value);
                                            setAssistantSearchQuery(""); // Reset search on selection
                                          }}
                                        >
                                          <SelectTrigger className="mt-1 w-full">
                                            <SelectValue
                                              placeholder={
                                                paramDef.placeholder ||
                                                "Select..."
                                              }
                                            />
                                          </SelectTrigger>
                                          <SelectContent className="max-w-[300px] p-0">
                                            <div className="flex items-center gap-2 px-2 py-2 border-b bg-background sticky top-0 z-10">
                                              <IconSearch className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                                              <Input
                                                placeholder="Search assistants..."
                                                value={assistantSearchQuery}
                                                onChange={(e) =>
                                                  setAssistantSearchQuery(
                                                    e.target.value,
                                                  )
                                                }
                                                className="h-8 border-0 focus-visible:ring-0 focus-visible:ring-offset-0 bg-transparent"
                                                onClick={(e) =>
                                                  e.stopPropagation()
                                                }
                                                onKeyDown={(e) =>
                                                  e.stopPropagation()
                                                }
                                              />
                                            </div>
                                            <div className="max-h-[200px] overflow-y-auto p-1">
                                              {aiAssistants
                                                .filter((assistant) => {
                                                  const name =
                                                    assistant.name ||
                                                    assistant.id;
                                                  return name
                                                    .toLowerCase()
                                                    .includes(
                                                      assistantSearchQuery.toLowerCase(),
                                                    );
                                                })
                                                .map((assistant) => (
                                                  <SelectItem
                                                    key={assistant.id}
                                                    value={assistant.id}
                                                    className="cursor-pointer"
                                                  >
                                                    <div className="truncate max-w-[260px]">
                                                      {assistant.name ||
                                                        assistant.id}
                                                    </div>
                                                  </SelectItem>
                                                ))}
                                              {aiAssistants.filter(
                                                (assistant) => {
                                                  const name =
                                                    assistant.name ||
                                                    assistant.id;
                                                  return name
                                                    .toLowerCase()
                                                    .includes(
                                                      assistantSearchQuery.toLowerCase(),
                                                    );
                                                },
                                              ).length === 0 && (
                                                <div className="px-2 py-6 text-center text-sm text-muted-foreground">
                                                  {assistantSearchQuery
                                                    ? "No assistants found"
                                                    : "No AI assistants available"}
                                                </div>
                                              )}
                                            </div>
                                          </SelectContent>
                                        </Select>
                                      )}

                                      {/* Variable Input */}
                                      {nodeConfig[`${key}_use_variable`] && (
                                        <VariableInput
                                          value={nodeConfig[key] || ""}
                                          onChange={(value) => {
                                            handleUpdateNodeConfig(key, value);
                                          }}
                                          availableVariables={getAllVariableNames(
                                            {
                                              nodes,
                                              edges,
                                              globalVariables,
                                            },
                                          )}
                                          placeholder="{{assistant_id}}"
                                          className="mt-1"
                                        />
                                      )}

                                      <p className="text-xs text-muted-foreground">
                                        {!nodeConfig[`${key}_use_variable`]
                                          ? "Select an AI assistant from the list"
                                          : "Enter a variable name (e.g., {{assistant_id}}) to dynamically select the assistant"}
                                      </p>
                                    </div>
                                  ) : paramDef.type === "select" ? (
                                    (() => {
                                      // Special handling for enqueue node's queue_name field
                                      // Use queues fetched from database instead of hardcoded options
                                      const isQueueNameField =
                                        selectedNodeDef.id === "enqueue" &&
                                        key === "queue_name";

                                      // For enqueue queue_name, use fetched queues; otherwise use paramDef options
                                      let processedOptions = [];
                                      if (isQueueNameField) {
                                        // Convert fetched queues to options format
                                        // Only show queues from cc_queues table (enabled and active)
                                        processedOptions = queues.map(
                                          (queue) => ({
                                            value: queue.name,
                                            label:
                                              queue.display_name || queue.name,
                                          }),
                                        );
                                      } else {
                                        // For other select fields, use paramDef options
                                        processedOptions =
                                          paramDef.options || [];
                                      }

                                      // Get current value
                                      const currentValue =
                                        nodeConfig[key] ||
                                        paramDef.default ||
                                        "";

                                      return (
                                        <Select
                                          value={currentValue}
                                          onValueChange={(value) => {
                                            handleUpdateNodeConfig(key, value);
                                          }}
                                        >
                                          <SelectTrigger className="mt-1">
                                            <SelectValue>
                                              {(() => {
                                                const selectedOption =
                                                  processedOptions.find(
                                                    (opt) =>
                                                      opt.value ===
                                                      currentValue,
                                                  );
                                                return (
                                                  selectedOption?.label ||
                                                  currentValue
                                                );
                                              })()}
                                            </SelectValue>
                                          </SelectTrigger>
                                          <SelectContent>
                                            {processedOptions.length > 0 ? (
                                              processedOptions.map((opt) => (
                                                <SelectItem
                                                  key={opt.value}
                                                  value={opt.value}
                                                >
                                                  {opt.label}
                                                </SelectItem>
                                              ))
                                            ) : (
                                              <SelectItem value="" disabled>
                                                {isQueueNameField
                                                  ? "No enabled queues available"
                                                  : "No options available"}
                                              </SelectItem>
                                            )}
                                          </SelectContent>
                                        </Select>
                                      );
                                    })()
                                  ) : paramDef.type === "number" ? (
                                    <Input
                                      type="number"
                                      value={
                                        nodeConfig[key] ||
                                        paramDef.default ||
                                        ""
                                      }
                                      onChange={(e) =>
                                        handleUpdateNodeConfig(
                                          key,
                                          parseInt(e.target.value, 10) || 0,
                                        )
                                      }
                                      placeholder={paramDef.placeholder}
                                      min={paramDef.min}
                                      max={paramDef.max}
                                      className="mt-1"
                                    />
                                  ) : paramDef.type === "boolean" ? (
                                    <Select
                                      value={String(nodeConfig[key] || false)}
                                      onValueChange={(value) =>
                                        handleUpdateNodeConfig(
                                          key,
                                          value === "true",
                                        )
                                      }
                                    >
                                      <SelectTrigger className="mt-1">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="true">
                                          Yes
                                        </SelectItem>
                                        <SelectItem value="false">
                                          No
                                        </SelectItem>
                                      </SelectContent>
                                    </Select>
                                  ) : (
                                    <Input
                                      value={nodeConfig[key] || ""}
                                      onChange={(e) =>
                                        handleUpdateNodeConfig(
                                          key,
                                          e.target.value,
                                        )
                                      }
                                      placeholder={paramDef.placeholder}
                                      className="mt-1"
                                    />
                                  )}
                                  {paramDef.description && (
                                    <p className="text-xs text-muted-foreground mt-1">
                                      {paramDef.description}
                                    </p>
                                  )}
                                </div>
                              ),
                            )
                          )}
                        </div>
                      </div>

                      {/* Static Footer Section with SAVE and DELETE NODE buttons */}
                      <div className="p-4 pt-2 flex-shrink-0 border-t bg-card space-y-2">
                        {/* Show Save Expression button for Set Variable nodes */}
                        {selectedNodeDef.customEditor ===
                          "SetVariableNodeEditor" && (
                          <SetVariableNodeEditorSaveButton
                            isValid={setVariableValidation.isValid}
                            hasUnsavedChanges={
                              setVariableValidation.hasUnsavedChanges
                            }
                            onSave={() => {
                              // Call the save function exposed by the child component via ref
                              // The child's onSave callback will trigger handleSave() automatically
                              if (setVariableEditorRef.current) {
                                setVariableEditorRef.current.save();
                              }
                            }}
                            expressionValid={
                              setVariableValidation.expressionValid
                            }
                            hasExpression={setVariableValidation.hasExpression}
                          />
                        )}

                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={handleDeleteNode}
                          className="w-full"
                        >
                          <IconTrash className="h-4 w-4 mr-2" />
                          Delete Node
                        </Button>
                      </div>
                    </>
                  ) : (
                    <div className="text-center py-12">
                      <p className="text-sm text-muted-foreground">
                        Select a node to configure it
                      </p>
                      <p className="text-xs text-muted-foreground mt-2">
                        Right-click on canvas to add nodes
                      </p>
                    </div>
                  )}
                </TabsContent>

                <TabsContent
                  value="variables"
                  className="flex-1 overflow-y-auto mt-0 p-4 h-0"
                >
                  <div className="space-y-4">
                    {/* Manage Global Variables Button - First Row */}
                    <div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => setShowGlobalVariablesPanel(true)}
                      >
                        <IconVariable className="h-3 w-3 mr-1" />
                        Manage Global Variables
                      </Button>
                    </div>

                    <div>
                      <h4 className="font-semibold text-sm mb-2">
                        Flow Variables
                      </h4>
                      <p className="text-xs text-muted-foreground">
                        All available variables in this flow
                      </p>
                    </div>

                    <Separator />

                    {/* Global Variables Section */}
                    <div>
                      <h5 className="text-xs font-semibold text-muted-foreground uppercase mb-2">
                        Global Variables
                      </h5>
                      {Object.keys(globalVariables).length === 0 ? (
                        <div className="text-xs text-muted-foreground">
                          No global variables defined
                        </div>
                      ) : (
                        <div className="space-y-1">
                          {Object.entries(globalVariables).map(
                            ([varName, varDef]) => (
                              <div
                                key={varName}
                                className="p-2 border rounded text-xs font-mono bg-background hover:bg-muted cursor-pointer"
                                onClick={() => {
                                  navigator.clipboard.writeText(
                                    `{{global.${varName}}}`,
                                  );
                                  notify({
                                    title: "Success",
                                    description:
                                      "Variable copied to clipboard!",
                                    variant: "success",
                                  });
                                }}
                                title="Click to copy variable reference"
                              >
                                <div className="font-semibold">{`{{global.${varName}}}`}</div>
                                <div className="text-muted-foreground mt-1">
                                  {varDef.value || "(empty)"}
                                </div>
                              </div>
                            ),
                          )}
                        </div>
                      )}
                    </div>

                    <Separator />

                    {/* Edge Variables Section */}
                    <div>
                      <h5 className="text-xs font-semibold text-muted-foreground uppercase mb-2">
                        Edge Variables
                      </h5>
                      {(() => {
                        const edgeVars = [];
                        edges.forEach((edge) => {
                          if (edge.data?.variableMappings) {
                            edge.data.variableMappings.forEach((mapping) => {
                              edgeVars.push({
                                name: mapping.variableName,
                                source: mapping.sourcePath,
                                edgeId: edge.id,
                              });
                            });
                          }
                        });

                        return edgeVars.length === 0 ? (
                          <div className="text-xs text-muted-foreground">
                            No edge variables defined
                          </div>
                        ) : (
                          <div className="space-y-1">
                            {edgeVars.map((edgeVar, idx) => (
                              <div
                                key={`${edgeVar.edgeId}-${idx}`}
                                className="p-2 border rounded text-xs font-mono bg-background hover:bg-muted cursor-pointer"
                                onClick={() => {
                                  navigator.clipboard.writeText(
                                    `{{${edgeVar.name}}}`,
                                  );
                                  notify({
                                    title: "Success",
                                    description:
                                      "Variable copied to clipboard!",
                                    variant: "success",
                                  });
                                }}
                                title="Click to copy variable reference"
                              >
                                <div className="font-semibold">{`{{${edgeVar.name}}}`}</div>
                                <div className="text-muted-foreground mt-1">
                                  from: {edgeVar.source}
                                </div>
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                    </div>

                    <Separator />

                    {/* Usage Tips */}
                    <div className="text-xs text-muted-foreground space-y-2 p-3 bg-muted/50 rounded">
                      <p className="font-semibold">Usage Tips:</p>
                      <ul className="list-disc list-inside space-y-1">
                        <li>Click any variable to copy its reference</li>
                        <li>Use {`{{global.varName}}`} for global variables</li>
                        <li>Use {`{{varName}}`} for edge variables</li>
                        <li>Use {`{{payload.field}}`} for webhook data</li>
                      </ul>
                    </div>
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Exit Confirmation Dialog */}
      <AlertDialog open={showExitDialog} onOpenChange={setShowExitDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes. Are you sure you want to leave? All
              unsaved changes will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleCancelExit}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmExit}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Leave without saving
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Webhook Update Confirmation Dialog */}
      <AlertDialog open={showWebhookDialog} onOpenChange={setShowWebhookDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Update Voice Application Webhook
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  The webhook URL for{" "}
                  <strong>{webhookUpdateInfo?.appName}</strong> needs to be
                  updated to work with this flow.
                </p>

                <div className="rounded-lg border bg-muted p-3 space-y-2">
                  <div>
                    <div className="text-xs font-semibold text-muted-foreground mb-1">
                      Current Webhook URL:
                    </div>
                    <code className="text-xs break-all block bg-background p-2 rounded">
                      {webhookUpdateInfo?.currentUrl}
                    </code>
                  </div>

                  <div>
                    <div className="text-xs font-semibold text-muted-foreground mb-1">
                      New Webhook URL:
                    </div>
                    <code className="text-xs break-all block bg-background p-2 rounded text-green-600 dark:text-green-400">
                      {webhookUpdateInfo?.newUrl}
                    </code>
                  </div>
                </div>

                <p className="text-sm">
                  Would you like to update the voice application's webhook URL
                  now?
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleCancelWebhookUpdate}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleUpdateWebhook}>
              Update Webhook URL
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Flow Description Dialog */}
      <Dialog
        open={showDescriptionDialog}
        onOpenChange={setShowDescriptionDialog}
      >
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>Edit Flow Description</DialogTitle>
            <DialogDescription>
              Add a description for this call flow to help others understand its
              purpose.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Textarea
              value={tempDescription}
              onChange={(e) => setTempDescription(e.target.value)}
              placeholder="Enter flow description..."
              className="min-h-[150px]"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleCancelDescription}>
              Cancel
            </Button>
            <Button onClick={handleSaveDescription}>Save Description</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Monitor Panel */}
      {showMonitor && (
        <div className="fixed inset-y-0 right-0 w-[32rem] bg-background dark:bg-zinc-900 border-l shadow-2xl z-50 flex flex-col animate-in slide-in-from-right">
          {/* Panel Header */}
          <div className="border-b p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <IconActivity className="h-5 w-5" />
                <h2 className="font-semibold text-lg">Call Monitor</h2>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setShowMonitor(false)}
              >
                <IconX className="h-4 w-4" />
              </Button>
            </div>
            {currentCallControlId && (
              <div className="flex items-center gap-2">
                <code className="text-xs bg-muted px-2 py-1 rounded font-mono flex-1 truncate">
                  {currentCallControlId}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 flex-shrink-0"
                  onClick={() => {
                    navigator.clipboard.writeText(currentCallControlId);
                    notify({
                      title: "Success",
                      description: currentCallControlId.startsWith("form:")
                        ? "Monitor Run ID copied to clipboard"
                        : "Call Control ID copied to clipboard",
                      variant: "success",
                    });
                  }}
                >
                  {copiedField === "call_control_id" ? (
                    <IconCheck className="h-3.5 w-3.5" />
                  ) : (
                    <IconCopy className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            )}
          </div>

          {/* Panel Content */}
          <div className="flex-1 overflow-y-auto p-4">
            {monitorData.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground">
                <IconActivity className="h-12 w-12 mb-4 opacity-50" />
                <p className="text-sm">No webhook events yet</p>
                <p className="text-xs mt-1">
                  Events will appear here when calls or form submits run
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {monitorData.map((item) => {
                  // Check if this is a node execution event
                  const isNodeExecution =
                    item.event_type?.startsWith("node_execution:");

                  if (isNodeExecution) {
                    const nodeType = item.payload?.node_type;
                    const nodeLabel = item.payload?.node_label;
                    const success = item.payload?.success;
                    const details = item.payload?.details;

                    return (
                      <Tool key={item.id} defaultOpen={false}>
                        <NodeExecutionToolHeader
                          nodeType={nodeType}
                          nodeLabel={nodeLabel}
                          success={success}
                          timestamp={item.timestamp}
                        />
                        <ToolContent>
                          {/* Render specific details based on node type */}
                          {renderNodeExecutionDetails(
                            nodeType,
                            details,
                            success,
                          )}
                        </ToolContent>
                      </Tool>
                    );
                  }

                  // Regular webhook event
                  return (
                    <Tool key={item.id} defaultOpen={false}>
                      <WebhookToolHeader
                        eventType={item.event_type}
                        direction={item.direction}
                        timestamp={item.timestamp}
                      />
                      <ToolContent>
                        <CodeBlock
                          code={JSON.stringify(item.payload, null, 2)}
                          language="json"
                        >
                          <CodeBlockCopyButton />
                        </CodeBlock>
                      </ToolContent>
                    </Tool>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Edge Variable Mapper Modal */}
      <EdgeVariableMapper
        open={showEdgeVariableMapper}
        onClose={() => {
          setShowEdgeVariableMapper(false);
          setSelectedEdge(null);
        }}
        edge={selectedEdge}
        sourceNode={
          selectedEdge ? nodes.find((n) => n.id === selectedEdge.source) : null
        }
        onSave={(variableMappings, edgeData) => {
          if (selectedEdge) {
            setEdges((eds) =>
              eds.map((e) =>
                e.id === selectedEdge.id
                  ? {
                      ...e,
                      data: {
                        ...e.data,
                        variableMappings,
                        ...(edgeData || {}),
                      },
                    }
                  : e,
              ),
            );
            setShowEdgeVariableMapper(false);
            setSelectedEdge(null);
            setHasUnsavedChanges(true);
          }
        }}
        existingVariableNames={getAllVariableNames({
          nodes,
          edges,
          globalVariables,
        })}
        nodes={nodes}
        edges={edges}
        globalVariables={globalVariables}
      />

      {/* Global Variables Management Panel */}
      <Sheet
        open={showGlobalVariablesPanel}
        onOpenChange={setShowGlobalVariablesPanel}
      >
        <SheetContent className="w-full sm:max-w-md overflow-y-auto">
          <SheetHeader className="pb-4">
            <SheetTitle className="flex items-center gap-2 text-lg">
              <IconVariable className="h-4 w-4 text-telnyx-green" />
              Manage Global Variables
            </SheetTitle>
            <SheetDescription className="text-sm">
              Define variables accessible throughout the flow
            </SheetDescription>
          </SheetHeader>

          <div className="px-4 space-y-4">
            {/* Add Variable Button */}
            <div>
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => {
                  const newVarName = `variable_${
                    Object.keys(globalVariables).length + 1
                  }`;
                  setGlobalVariables({
                    ...globalVariables,
                    [newVarName]: {
                      value: "",
                      type: "string",
                      description: "",
                    },
                  });
                  setHasUnsavedChanges(true);
                }}
              >
                <IconPlus className="h-3 w-3 mr-1" />
                Add Variable
              </Button>
            </div>

            {/* Variable List */}
            {Object.keys(globalVariables).length === 0 ? (
              <div className="text-center py-8 text-sm text-muted-foreground">
                No global variables defined yet
                <br />
                <span className="text-xs mt-2 block">
                  Click "Add Variable" above to create your first variable
                </span>
              </div>
            ) : (
              <div className="space-y-2">
                {Object.entries(globalVariables).map(([varName, varDef]) => (
                  <VariableCard
                    key={varName}
                    varName={varName}
                    varDef={varDef}
                    globalVariables={globalVariables}
                    setGlobalVariables={(vars) => {
                      setGlobalVariables(vars);
                      setHasUnsavedChanges(true);
                    }}
                    nodes={nodes}
                    edges={edges}
                  />
                ))}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Monitor Panel */}
      {showMonitor && (
        <div className="fixed inset-y-0 right-0 w-[32rem] bg-background dark:bg-zinc-900 border-l shadow-2xl z-50 flex flex-col animate-in slide-in-from-right">
          {/* Panel Header */}
          <div className="border-b p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <IconActivity className="h-5 w-5" />
                <h2 className="font-semibold text-lg">Call Monitor</h2>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleClearMonitor}
                  title="Clear monitor data"
                >
                  <IconTrash className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setShowMonitor(false)}
                >
                  <IconX className="h-4 w-4" />
                </Button>
              </div>
            </div>
            {currentCallControlId && (
              <div className="flex items-center gap-2">
                <code className="text-xs bg-muted px-2 py-1 rounded font-mono flex-1 truncate">
                  {currentCallControlId}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 flex-shrink-0"
                  onClick={() => {
                    if (currentCallControlId) {
                      navigator.clipboard.writeText(currentCallControlId);
                      setCopiedField("call_control_id");
                      notify({
                        title: "Copied",
                        description: currentCallControlId.startsWith("form:")
                          ? "Monitor Run ID copied to clipboard"
                          : "Call Control ID copied to clipboard",
                        variant: "success",
                      });
                      setTimeout(() => setCopiedField(null), 2000);
                    }
                  }}
                >
                  {copiedField === "call_control_id" ? (
                    <IconCheck className="h-3.5 w-3.5" />
                  ) : (
                    <IconCopy className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            )}
          </div>

          {/* Panel Content */}
          <div className="flex-1 overflow-y-auto p-4">
            {monitorData.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground">
                <IconActivity className="h-12 w-12 mb-4 opacity-50" />
                <p className="text-sm">No webhook events yet</p>
                <p className="text-xs mt-1">
                  Events will appear here when calls or form submits run for
                  this flow
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {monitorData.map((item) => {
                  // Check if this is a node execution event
                  const isNodeExecution =
                    item.event_type?.startsWith("node_execution:");

                  if (isNodeExecution) {
                    const nodeType = item.payload?.node_type;
                    const nodeLabel = item.payload?.node_label;
                    const success = item.payload?.success;
                    const details = item.payload?.details;

                    return (
                      <Tool key={item.id} defaultOpen={false}>
                        <NodeExecutionToolHeader
                          nodeType={nodeType}
                          nodeLabel={nodeLabel}
                          success={success}
                          timestamp={item.timestamp}
                        />
                        <ToolContent>
                          {/* Render specific details based on node type */}
                          {renderNodeExecutionDetails(
                            nodeType,
                            details,
                            success,
                          )}
                        </ToolContent>
                      </Tool>
                    );
                  }

                  // Regular webhook event
                  return (
                    <Tool key={item.id} defaultOpen={false}>
                      <WebhookToolHeader
                        eventType={item.event_type}
                        direction={item.direction}
                        timestamp={item.timestamp}
                      />
                      <ToolContent>
                        <CodeBlock
                          code={JSON.stringify(item.payload, null, 2)}
                          language="json"
                        >
                          <CodeBlockCopyButton />
                        </CodeBlock>
                      </ToolContent>
                    </Tool>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
      </AdminPageContent>
    </AdminPageShell>
  );
}
