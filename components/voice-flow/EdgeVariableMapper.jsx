"use client";

import { useEffect, useMemo, useState } from "react";
import { VOICE_FLOW_NODES } from "@/config/voice-flow-nodes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { CodeBlock, CodeBlockCopyButton } from "@/components/ai-elements/code-block";
import {
  IconAlertCircle,
  IconChevronRight,
  IconCode,
  IconEdit,
  IconList,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { VariableTextarea } from "./VariableTextarea";
import {
  extractPathsFromObject,
  getSchemaPath,
  getWebhookSchema,
} from "@/config/webhook-schemas";
import {
  checkDuplicateVariableName,
  generateUniqueVariableName,
  suggestVariableName,
  validateVariableName,
} from "@/lib/variable-utils";
import { getEntitySchema } from "@/lib/data-sources-schema.js";
import { getMcpResponseVariablePayload } from "@/lib/mcp/mcp-argument-builder";

/**
 * Edge Variable Mapper Modal
 * Configure variable mappings for an edge based on webhook payload
 */
export function EdgeVariableMapper({
  open,
  onClose,
  edge,
  sourceNode,
  onSave,
  existingVariableNames = [],
  nodes = [],
  edges = [],
  globalVariables = {},
}) {
  const [variableMappings, setVariableMappings] = useState([]);
  const [expandedSchema, setExpandedSchema] = useState(false);
  const [schemaViewMode, setSchemaViewMode] = useState("list");
  const [samplePayload, setSamplePayload] = useState("");
  const [payloadError, setPayloadError] = useState("");
  const [samplePayloadExpanded, setSamplePayloadExpanded] = useState(false);
  const [selectedSourcePaths, setSelectedSourcePaths] = useState(new Set());

  const nodeType = sourceNode?.data?.nodeType;
  const isHttpRequestActionNode = nodeType === "http_request_action";
  const isHttpRequestInitiatorNode = nodeType === "http_request";
  const isHttpRequestNode =
    isHttpRequestActionNode || isHttpRequestInitiatorNode;
  const isDataActionNode = nodeType === "data_action";
  const isMcpToolNode = nodeType === "mcp_tool";
  const outputEvent = getOutputEvent(sourceNode, edge);

  const mappingContext = useMemo(() => {
    if (!sourceNode) {
      return {
        webhookSchema: null,
        schemaPaths: [],
        examplePayload: null,
        sourceLabel: "Expected Payload Structure",
      };
    }

    if (isHttpRequestActionNode) {
      const testResponse = sourceNode?.data?.config?.testResponse;
      const responseVariable =
        sourceNode?.data?.config?.responseVariable || "http_response";

      if (testResponse?.body) {
        return {
          webhookSchema: null,
          schemaPaths: extractPathsFromObject(testResponse.body, responseVariable),
          examplePayload: testResponse.body,
          sourceLabel: "HTTP Response Structure",
        };
      }

      return {
        webhookSchema: null,
        schemaPaths: [],
        examplePayload: null,
        sourceLabel: "HTTP Response Structure",
      };
    }

    if (isHttpRequestInitiatorNode) {
      const edgeSamplePayload = samplePayload || edge?.data?.samplePayload || "";
      const httpMethod = sourceNode?.data?.config?.http_method || "POST";

      if (edgeSamplePayload) {
        try {
          const parsed = JSON.parse(edgeSamplePayload);
          const rootPath = httpMethod === "GET" ? "query" : "payload";
          return {
            webhookSchema: null,
            schemaPaths: extractPathsFromObject(parsed, rootPath, 10),
            examplePayload: parsed,
            sourceLabel: "Request Payload Structure",
          };
        } catch {
          return {
            webhookSchema: null,
            schemaPaths: [],
            examplePayload: null,
            sourceLabel: "Request Payload Structure",
          };
        }
      }

      return {
        webhookSchema: null,
        schemaPaths: [],
        examplePayload: null,
        sourceLabel: "Request Payload Structure",
      };
    }

    if (isDataActionNode) {
      const dataSource = sourceNode?.data?.config?.dataSource;
      const action = sourceNode?.data?.config?.action || "list";
      const responseVariable =
        sourceNode?.data?.config?.responseVariable || "data_response";
      const dataActionContext = getDataActionResponseSchemaPaths(
        dataSource,
        action,
        responseVariable,
      );

      return {
        webhookSchema: null,
        schemaPaths: dataActionContext.schemaPaths,
        examplePayload: dataActionContext.examplePayload,
        sourceLabel: "Data Action Response Structure",
      };
    }

    if (isMcpToolNode) {
      const testResponse = sourceNode?.data?.config?.testResponse;
      const responseVariable =
        sourceNode?.data?.config?.responseVariable || "mcp_response";
      const responsePayload = testResponse?.body !== undefined
        ? testResponse.body
        : getMcpResponseVariablePayload(testResponse);

      if (responsePayload && typeof responsePayload === "object") {
        return {
          webhookSchema: null,
          schemaPaths: extractPathsFromObject(responsePayload, responseVariable, 10),
          examplePayload: responsePayload,
          sourceLabel: "MCP Tool Response Structure",
        };
      }

      return {
        webhookSchema: null,
        schemaPaths: [],
        examplePayload: null,
        sourceLabel: "MCP Tool Response Structure",
      };
    }

    const webhookSchema = outputEvent ? getWebhookSchema(outputEvent) : null;
    return {
      webhookSchema,
      schemaPaths: webhookSchema ? getSchemaPath(webhookSchema) : [],
      examplePayload: null,
      sourceLabel: "Expected Payload Structure",
    };
  }, [
    edge?.data?.samplePayload,
    isDataActionNode,
    isHttpRequestActionNode,
    isHttpRequestInitiatorNode,
    isMcpToolNode,
    outputEvent,
    samplePayload,
    sourceNode,
  ]);

  const { webhookSchema, schemaPaths, examplePayload, sourceLabel } =
    mappingContext;
  const mappedSourcePaths = useMemo(
    () => new Set(variableMappings.map((mapping) => mapping.sourcePath).filter(Boolean)),
    [variableMappings],
  );

  useEffect(() => {
    if (open && edge) {
      const existingMappings = edge.data?.variableMappings || [];
      const mappingsWithIds = existingMappings.map((m, i) => ({
        ...m,
        id: m.id || `mapping_${Date.now()}_${i}`,
      }));
      setVariableMappings(mappingsWithIds.length > 0 ? mappingsWithIds : []);
      setSelectedSourcePaths(new Set());

      if (isHttpRequestInitiatorNode) {
        setSamplePayload(edge.data?.samplePayload || "");
      }
    }
  }, [open, edge, isHttpRequestInitiatorNode]);

  useEffect(() => {
    if (!isHttpRequestInitiatorNode || !samplePayload) {
      setPayloadError("");
      return;
    }

    try {
      JSON.parse(samplePayload);
      setPayloadError("");
    } catch {
      setPayloadError("Invalid JSON. Please check your payload format.");
    }
  }, [samplePayload, isHttpRequestInitiatorNode]);

  const buildExampleJson = () => {
    if ((isHttpRequestNode || isDataActionNode || isMcpToolNode) && examplePayload) {
      return examplePayload;
    }

    if (!webhookSchema) return null;

    const payload = {};
    Object.entries(webhookSchema).forEach(([fieldName, fieldDef]) => {
      payload[fieldName] = buildExampleValue(fieldDef);
    });

    return {
      event_type: outputEvent,
      id: "0ccc7b54-4df3-4bca-a65a-3da1ecc777f0",
      occurred_at: new Date().toISOString(),
      payload,
    };
  };

  const getKnownVariableNames = () => [
    ...existingVariableNames,
    ...variableMappings.map((m) => m.variableName).filter(Boolean),
  ];

  const createMappingFromField = (field, knownNames = getKnownVariableNames()) => {
    const suggested = suggestVariableName(field.path);
    const uniqueName = generateUniqueVariableName(suggested, knownNames);
    knownNames.push(uniqueName);

    return {
      id: `mapping_${Date.now()}_${Math.random()}`,
      variableName: uniqueName,
      sourcePath: field.path,
      description: field.description || "",
    };
  };

  const addSelectedMappings = () => {
    if (selectedSourcePaths.size === 0) return;

    const existingPaths = new Set(
      variableMappings.map((mapping) => mapping.sourcePath).filter(Boolean),
    );
    const knownNames = getKnownVariableNames();
    const selectedFields = schemaPaths.filter(
      (field) => selectedSourcePaths.has(field.path) && !existingPaths.has(field.path),
    );

    if (selectedFields.length === 0) {
      setSelectedSourcePaths(new Set());
      return;
    }

    setVariableMappings([
      ...variableMappings,
      ...selectedFields.map((field) => createMappingFromField(field, knownNames)),
    ]);
    setSelectedSourcePaths(new Set());
  };

  const removeMapping = (index) => {
    setVariableMappings(variableMappings.filter((_, i) => i !== index));
  };

  const updateMapping = (index, field, value) => {
    const newMappings = [...variableMappings];
    newMappings[index] = {
      ...newMappings[index],
      [field]: value,
    };
    setVariableMappings(newMappings);
  };

  const toggleSourcePath = (path) => {
    if (mappedSourcePaths.has(path)) return;

    setSelectedSourcePaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const handleSave = () => {
    if (isHttpRequestInitiatorNode && samplePayload) {
      try {
        JSON.parse(samplePayload);
      } catch {
        alert("Invalid JSON in sample payload. Please fix the format.");
        return;
      }
    }

    const errors = [];
    const seenNames = new Set();

    variableMappings.forEach((mapping, index) => {
      const mappingLabel = mapping.sourcePath || `Mapping ${index + 1}`;
      if (!mapping.variableName) {
        errors.push(`${mappingLabel}: Variable name is required`);
      }
      if (!mapping.sourcePath) {
        errors.push(`${mappingLabel}: Source path is required`);
      }
      if (seenNames.has(mapping.variableName)) {
        errors.push(`${mappingLabel}: Duplicate variable name "${mapping.variableName}"`);
      }
      seenNames.add(mapping.variableName);

      const validation = validateVariableName(mapping.variableName);
      if (!validation.valid) {
        errors.push(`${mappingLabel}: ${validation.error}`);
      }

      if (mapping.variableName) {
        const duplicateCheck = checkDuplicateVariableName(
          mapping.variableName,
          { nodes, edges, globalVariables },
          { type: "edge", edgeId: edge?.id },
        );
        if (duplicateCheck.isDuplicate) {
          errors.push(`${mappingLabel}: ${duplicateCheck.message}`);
        }
      }
    });

    if (errors.length > 0) {
      alert("Validation errors:\n\n" + errors.join("\n"));
      return;
    }

    const mappingsToSave = variableMappings.map(({ id, ...mapping }) => mapping);
    onSave(
      mappingsToSave,
      isHttpRequestInitiatorNode ? { samplePayload } : undefined,
    );
    onClose();
  };

  const hasDuplicates = variableMappings.some((mapping) => {
    if (!mapping.variableName) return false;
    const duplicateCheck = checkDuplicateVariableName(
      mapping.variableName,
      { nodes, edges, globalVariables },
      { type: "edge", edgeId: edge?.id },
    );
    return duplicateCheck.isDuplicate;
  });

  const hasValidationErrors = variableMappings.some((mapping) => {
    if (!mapping.variableName || !mapping.sourcePath) return true;
    const validation = validateVariableName(mapping.variableName);
    return !validation.valid;
  });

  const canSave = !hasDuplicates && !hasValidationErrors;
  const supportsMapping = Boolean(outputEvent || isHttpRequestNode || isDataActionNode);

  const handleOpenChange = (nextOpen) => {
    if (!nextOpen) {
      onClose?.();
    }
  };

  if (!open) return null;

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl overflow-hidden flex flex-col p-0"
      >
        <SheetHeader className="px-6 py-4 border-b">
          <SheetTitle className="text-xl font-bold text-telnyx-green flex items-center gap-2">
            <IconEdit className="size-5" />
            Configure Edge Variables
          </SheetTitle>
          <SheetDescription className="text-sm">
            Extract variables from webhook, HTTP, or Data Action payloads as data flows through this edge.
          </SheetDescription>
        </SheetHeader>

      {!sourceNode && (
        <Card className="mx-5 my-4 border-destructive/40 bg-destructive/5">
          <CardContent className="p-4">
            <p className="text-sm text-destructive font-medium">Error: Source node not found</p>
            <p className="text-xs text-muted-foreground mt-1">
              The source node for this edge could not be found. Please try closing and reopening the flow.
            </p>
          </CardContent>
        </Card>
      )}

      {sourceNode && (
        <>
          <div className="flex-1 overflow-y-auto">
            <Card className="mx-5 my-4">
              <CardContent className="p-6 space-y-5">
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold text-muted-foreground flex items-center gap-1">
                    <IconChevronRight className="size-3.5 text-telnyx-green" />
                    Source Node
                  </h3>
                  <div className="rounded-lg border bg-muted/30 p-3 text-sm space-y-2">
                    <div className="font-medium">{sourceNode.data?.label || sourceNode.id}</div>
                    <div className="text-muted-foreground font-mono text-xs">{sourceNode.data?.nodeType}</div>
                    {outputEvent && !isHttpRequestNode && !isDataActionNode && (
                      <Badge variant="secondary" className="text-xs">{outputEvent}</Badge>
                    )}
                    {isHttpRequestActionNode && <Badge variant="secondary" className="text-xs">HTTP Response</Badge>}
                    {isHttpRequestInitiatorNode && (
                      <Badge variant="secondary" className="text-xs">
                        HTTP Request Trigger ({sourceNode?.data?.config?.http_method || "POST"})
                      </Badge>
                    )}
                    {isDataActionNode && (
                      <Badge variant="secondary" className="text-xs">
                        Data Action: {sourceNode?.data?.config?.dataSource || "select data source"}
                      </Badge>
                    )}
                  </div>
                </section>

                {isHttpRequestInitiatorNode && (
                  <section className="rounded-lg border overflow-hidden">
                    <button
                      type="button"
                      className="w-full p-3 bg-muted/40 flex items-center justify-between text-left"
                      onClick={() => setSamplePayloadExpanded(!samplePayloadExpanded)}
                    >
                      <span className="text-sm font-semibold flex items-center gap-2">
                        <IconCode className="h-4 w-4" />
                        Sample Payload
                      </span>
                      <IconChevronRight className={`h-4 w-4 transition-transform ${samplePayloadExpanded ? "rotate-90" : ""}`} />
                    </button>
                    {samplePayloadExpanded && (
                      <div className="p-3 border-t space-y-3">
                        <p className="text-xs text-muted-foreground">
                          Provide a sample {sourceNode?.data?.config?.http_method || "POST"} request payload to detect fields for mapping.
                          {sourceNode?.data?.config?.http_method === "GET" && " For GET requests, provide query parameters as JSON."}
                        </p>
                        <VariableTextarea
                          value={samplePayload}
                          onChange={(value) => {
                            setSamplePayload(value);
                            setPayloadError("");
                          }}
                          placeholder={JSON.stringify(
                            sourceNode?.data?.config?.http_method === "GET"
                              ? { phone_number: "+1234567890", message: "Hello" }
                              : { to: "+1234567890", from: "+0987654321", message: "Hello" },
                            null,
                            2,
                          )}
                          rows={8}
                          className="font-mono text-xs"
                        />
                        {payloadError && (
                          <p className="text-xs text-destructive flex items-center gap-1">
                            <IconAlertCircle className="h-3 w-3" />
                            {payloadError}
                          </p>
                        )}
                      </div>
                    )}
                  </section>
                )}

                {!supportsMapping && (
                  <div className="p-3 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-md">
                    <p className="text-xs font-medium text-blue-800 dark:text-blue-200">No Variable Mapping Available</p>
                    <p className="text-xs text-blue-700 dark:text-blue-300 mt-1">
                      This node type does not generate output data that can be mapped to variables.
                      {sourceNode.data?.nodeType === "set_variable" && " Variables set by this node are automatically available in subsequent nodes."}
                    </p>
                  </div>
                )}

                {isHttpRequestActionNode && schemaPaths.length === 0 && (
                  <div className="p-3 bg-yellow-50 dark:bg-yellow-950/20 border border-yellow-200 dark:border-yellow-800 rounded-md">
                    <p className="text-xs font-medium text-yellow-800 dark:text-yellow-200">Test Required</p>
                    <p className="text-xs text-yellow-700 dark:text-yellow-300 mt-1">
                      Please run a test request in the HTTP Request node editor to see available response fields for variable mapping.
                    </p>
                  </div>
                )}

                {isHttpRequestInitiatorNode && schemaPaths.length === 0 && !samplePayload && (
                  <div className="p-3 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-md">
                    <p className="text-xs font-medium text-blue-800 dark:text-blue-200">Sample Payload Recommended</p>
                    <p className="text-xs text-blue-700 dark:text-blue-300 mt-1">
                      Provide a sample payload above to automatically detect available fields for mapping.
                    </p>
                  </div>
                )}

                {schemaPaths.length > 0 && (
                  <section className="rounded-lg border overflow-hidden">
                    <div className="p-3 bg-muted/40 flex items-center justify-between gap-3">
                      <button
                        type="button"
                        className="flex items-center gap-2 text-left flex-1"
                        onClick={() => setExpandedSchema(!expandedSchema)}
                      >
                        <span className="text-sm font-semibold">{sourceLabel}</span>
                        <Badge variant="outline" className="text-[10px]">{schemaPaths.length} fields</Badge>
                        <IconChevronRight className={`h-4 w-4 transition-transform ${expandedSchema ? "rotate-90" : ""}`} />
                      </button>
                      <div className="flex items-center gap-1 border rounded-md bg-background">
                        <Button
                          type="button"
                          size="sm"
                          variant={schemaViewMode === "list" ? "secondary" : "ghost"}
                          className="h-7 px-2"
                          onClick={() => setSchemaViewMode("list")}
                        >
                          <IconList className="h-3 w-3" />
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant={schemaViewMode === "json" ? "secondary" : "ghost"}
                          className="h-7 px-2"
                          onClick={() => setSchemaViewMode("json")}
                        >
                          <IconCode className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>

                    {expandedSchema && (
                      <div className="border-t">
                        {schemaViewMode === "list" ? (
                          <div className="max-h-64 overflow-y-auto p-3 space-y-1">
                            {schemaPaths.map((field) => renderSelectableFieldRow(field, selectedSourcePaths, mappedSourcePaths, toggleSourcePath))}
                          </div>
                        ) : (
                          <div className="p-3">
                            {renderJsonPayloadView(mappedSourcePaths, buildExampleJson())}
                          </div>
                        )}
                      </div>
                    )}
                  </section>
                )}

                {supportsMapping && (
                  <section className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <Label className="font-semibold">Variable Mappings</Label>
                        <p className="text-xs text-muted-foreground mt-1">
                          Select one or more payload keys above, then add them as mappings in one click.
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={addSelectedMappings}
                        className="h-8"
                        disabled={selectedSourcePaths.size === 0 || (isHttpRequestActionNode && schemaPaths.length === 0)}
                      >
                        <IconPlus className="h-3 w-3 mr-1" />
                        Add {selectedSourcePaths.size || ""} Mapping{selectedSourcePaths.size === 1 ? "" : "s"}
                      </Button>
                    </div>

                    <div className="space-y-3">
                      {variableMappings.map((mapping, index) => (
                        <div key={mapping.id} className="rounded-xl border bg-card p-4 space-y-4 shadow-sm">
                          <div className="flex items-start justify-between gap-3">
                            <Badge variant="outline" className={getSourcePathBadgeClass(mapping.sourcePath)}>
                              {mapping.sourcePath || "No source selected"}
                            </Badge>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => removeMapping(index)}
                              className="h-7 w-7 p-0 text-destructive hover:bg-destructive/10"
                              aria-label={`Remove mapping ${mapping.sourcePath || index + 1}`}
                            >
                              <IconTrash className="h-3.5 w-3.5" />
                            </Button>
                          </div>

                          <div className="space-y-3">
                            <div>
                              <Label className="text-xs">Source Path</Label>
                              <Input
                                value={mapping.sourcePath || ""}
                                onChange={(e) => updateMapping(index, "sourcePath", e.target.value)}
                                placeholder="payload.custom_headers[0].name"
                                className="mt-1 font-mono text-xs"
                              />
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                              <Label className="text-xs">Variable Name</Label>
                              <Input
                                value={mapping.variableName}
                                onChange={(e) => updateMapping(index, "variableName", e.target.value)}
                                placeholder="call_control_id"
                                className={`mt-1 ${
                                  mapping.variableName &&
                                  checkDuplicateVariableName(
                                    mapping.variableName,
                                    { nodes, edges, globalVariables },
                                    { type: "edge", edgeId: edge?.id },
                                  ).isDuplicate
                                    ? "border-yellow-500"
                                    : ""
                                }`}
                              />
                              {mapping.variableName &&
                                checkDuplicateVariableName(
                                  mapping.variableName,
                                  { nodes, edges, globalVariables },
                                  { type: "edge", edgeId: edge?.id },
                                ).isDuplicate && (
                                  <p className="text-xs text-yellow-600 dark:text-yellow-500 mt-1 flex items-center gap-1">
                                    <IconAlertCircle className="h-3 w-3" />
                                    {
                                      checkDuplicateVariableName(
                                        mapping.variableName,
                                        { nodes, edges, globalVariables },
                                        { type: "edge", edgeId: edge?.id },
                                      ).message
                                    }
                                  </p>
                                )}
                            </div>

                            <div>
                              <Label className="text-xs">Description (Optional)</Label>
                              <Input
                                value={mapping.description || ""}
                                onChange={(e) => updateMapping(index, "description", e.target.value)}
                                placeholder="Brief description..."
                                className="mt-1"
                              />
                            </div>
                          </div>
                        </div>
                        </div>
                        ))}

                      {variableMappings.length === 0 && (
                        <div className="text-center py-8 text-sm text-muted-foreground border rounded-xl bg-muted/30">
                          No variable mappings defined.
                          <br />
                          Select payload fields above and click "Add Mapping" to capture data from this edge.
                        </div>
                      )}
                    </div>
                  </section>
                )}
              </CardContent>
            </Card>
          </div>

          <SheetFooter className="px-6 py-4 border-t flex flex-row justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              {supportsMapping ? "Cancel" : "Close"}
            </Button>
            {supportsMapping && (
              <Button
                onClick={handleSave}
                disabled={!canSave || Boolean(isHttpRequestInitiatorNode && samplePayload && payloadError)}
              >
                Save Mappings
              </Button>
            )}
          </SheetFooter>
        </>
      )}
      </SheetContent>
    </Sheet>
  );
}

function renderSelectableFieldRow(field, selectedSourcePaths, mappedSourcePaths, toggleSourcePath) {
  const isAlreadyMapped = mappedSourcePaths.has(field.path);

  return (
    <label
      key={field.path}
      aria-disabled={isAlreadyMapped}
      className={`flex items-start gap-3 rounded-md border bg-background/70 p-2 ${
        isAlreadyMapped
          ? "cursor-not-allowed opacity-70 bg-muted/50"
          : "hover:bg-muted/60 cursor-pointer"
      }`}
    >
      <Checkbox
        checked={isAlreadyMapped || selectedSourcePaths.has(field.path)}
        disabled={isAlreadyMapped}
        onCheckedChange={() => toggleSourcePath(field.path)}
        className="mt-0.5 data-[state=checked]:bg-telnyx-green data-[state=checked]:border-telnyx-green"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-mono text-telnyx-green font-semibold break-all">{field.path}</span>
          <Badge variant="secondary" className="text-[10px] font-mono">{field.type}</Badge>
          {isAlreadyMapped && (
            <Badge variant="outline" className="text-[10px] text-telnyx-green border-telnyx-green/40 bg-telnyx-green/10">
              mapped
            </Badge>
          )}
        </div>
        {field.description && (
          <p className="text-[11px] text-muted-foreground mt-1">{field.description}</p>
        )}
      </div>
    </label>
  );
}

function renderJsonPayloadView(mappedSourcePaths, exampleJson) {
  const code = exampleJson ? JSON.stringify(exampleJson, null, 2) : "{}";
  const mappedPaths = Array.from(mappedSourcePaths);

  return (
    <div className="space-y-3">
      {mappedPaths.length > 0 && (
        <div className="rounded-md border border-telnyx-green/30 bg-telnyx-green/5 p-3">
          <div className="text-[11px] uppercase tracking-wide text-telnyx-green font-semibold mb-2">
            Mapped in this edge
          </div>
          <div className="flex flex-wrap gap-1.5">
            {mappedPaths.map((path) => (
              <Badge key={path} variant="outline" className={getSourcePathBadgeClass(path)}>
                {path}
              </Badge>
            ))}
          </div>
        </div>
      )}
      <CodeBlock code={code} language="json" showLineNumbers maxHeight={384}>
        <CodeBlockCopyButton type="button" />
      </CodeBlock>
    </div>
  );
}

function getSourcePathBadgeClass() {
  return "text-telnyx-green border-telnyx-green/40 bg-telnyx-green/10 dark:bg-telnyx-green/15 font-mono text-[11px] break-all";
}

function getDataActionResponseSchemaPaths(dataSource, action, responseVariable = "data_response") {
  // Default list payload path: data_response.rows.0
  if (!dataSource) {
    return { schemaPaths: [], examplePayload: null };
  }

  const schema = getEntitySchema(dataSource);
  const rowExample = {};
  const schemaPaths = [];

  Object.entries(schema).forEach(([fieldName, fieldDef]) => {
    rowExample[fieldName] = buildExampleValue(fieldDef);
  });

  const addFieldPaths = (prefix) => {
    Object.entries(schema).forEach(([fieldName, fieldDef]) => {
      schemaPaths.push({
        path: `${prefix}.${fieldName}`,
        type: fieldDef.type || "string",
        description: fieldDef.description || "",
      });
    });
  };

  schemaPaths.push({
    path: `${responseVariable}.success`,
    type: "boolean",
    description: "Whether the Data Action request succeeded",
  });
  schemaPaths.push({
    path: `${responseVariable}.status`,
    type: "number",
    description: "HTTP status returned by the Data Action API",
  });

  if (action === "list") {
    schemaPaths.push({
      path: `${responseVariable}.rows`,
      type: "array",
      description: `List of ${dataSource} records returned by the Data Action`,
    });
    addFieldPaths(`${responseVariable}.rows.0`);

    return {
      schemaPaths,
      examplePayload: {
        [responseVariable]: {
          success: true,
          status: 200,
          rows: [rowExample],
          total: 1,
          page: 1,
          pageSize: 25,
        },
      },
    };
  }

  schemaPaths.push({
    path: `${responseVariable}.data`,
    type: "object",
    description: `${dataSource} record returned by the Data Action`,
  });
  addFieldPaths(`${responseVariable}.data`);

  return {
    schemaPaths,
    examplePayload: {
      [responseVariable]: {
        success: true,
        status: action === "delete" ? 204 : 200,
        data: action === "delete" ? { deleted: true } : rowExample,
      },
    },
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

/**
 * Get the output event type for an edge based on source node and handle
 */
function getOutputEvent(sourceNode, edge) {
  if (!sourceNode || !edge) return null;

  const nodeType = sourceNode.data?.nodeType;
  const nodeDef = VOICE_FLOW_NODES[nodeType];

  if (!nodeDef || !nodeDef.outputEvents) return null;

  const sourceHandle = edge.sourceHandle || "output-0";
  const outputIndex = parseInt(sourceHandle.replace("output-", ""), 10);

  return nodeDef.outputEvents[outputIndex] || null;
}
