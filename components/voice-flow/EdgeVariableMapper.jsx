"use client";

import { useState, useEffect } from "react";
import { VOICE_FLOW_NODES } from "@/config/voice-flow-nodes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  IconPlus,
  IconTrash,
  IconChevronRight,
  IconX,
  IconList,
  IconCode,
  IconAlertCircle,
  IconWand,
} from "@tabler/icons-react";
import { VariableTextarea } from "./VariableTextarea";
import {
  getWebhookSchema,
  getSchemaPath,
  extractPathsFromObject,
} from "@/config/webhook-schemas";
import { checkDuplicateVariableName } from "@/lib/variable-utils";
import {
  suggestVariableName,
  generateUniqueVariableName,
  validateVariableName,
} from "@/lib/variable-utils";
import { Badge } from "@/components/ui/badge";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";

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
  const [schemaViewMode, setSchemaViewMode] = useState("list"); // 'list' or 'json'
  const [samplePayload, setSamplePayload] = useState("");
  const [payloadError, setPayloadError] = useState("");
  const [samplePayloadExpanded, setSamplePayloadExpanded] = useState(false);

  // Check if source node is HTTP request action or HTTP request initiator
  const nodeType = sourceNode?.data?.nodeType;
  const isHttpRequestActionNode = nodeType === "http_request_action";
  const isHttpRequestInitiatorNode = nodeType === "http_request";
  const isHttpRequestNode =
    isHttpRequestActionNode || isHttpRequestInitiatorNode;

  // Get webhook schema based on source node output event OR HTTP response
  const outputEvent = getOutputEvent(sourceNode, edge);
  let webhookSchema = null;
  let schemaPaths = [];
  let examplePayload = null;

  if (isHttpRequestActionNode) {
    // For HTTP request action nodes, use the test response if available
    const testResponse = sourceNode?.data?.config?.testResponse;
    const responseVariable =
      sourceNode?.data?.config?.responseVariable || "http_response";

    if (testResponse && testResponse.body) {
      // Extract paths from body only
      schemaPaths = extractPathsFromObject(testResponse.body, responseVariable);

      examplePayload = testResponse.body;
    }
  } else if (isHttpRequestInitiatorNode) {
    // For HTTP Request initiator nodes, use sample payload from edge data or state
    const edgeSamplePayload = samplePayload || edge?.data?.samplePayload || "";
    const httpMethod = sourceNode?.data?.config?.http_method || "POST";

    if (edgeSamplePayload) {
      try {
        const parsed = JSON.parse(edgeSamplePayload);
        // For GET requests, treat as query parameters
        // For POST requests, treat as body
        if (httpMethod === "GET") {
          // Extract paths with "query." prefix
          schemaPaths = extractPathsFromObject(parsed, "query", 10);
          examplePayload = parsed;
        } else {
          // Extract paths with "payload." prefix
          schemaPaths = extractPathsFromObject(parsed, "payload", 10);
          examplePayload = parsed;
        }
      } catch (error) {
        // Error will be shown in the UI
        schemaPaths = [];
      }
    }
  } else {
    // For other nodes, use webhook schemas
    webhookSchema = outputEvent ? getWebhookSchema(outputEvent) : null;
    schemaPaths = webhookSchema ? getSchemaPath(webhookSchema) : [];
  }

  // Build example JSON from schema
  const buildExampleJson = () => {
    // If HTTP request node and we have a test response, use it
    if (isHttpRequestNode && examplePayload) {
      return examplePayload;
    }

    // Otherwise build from webhook schema
    if (!webhookSchema) return null;

    const payload = {};
    Object.entries(webhookSchema).forEach(([fieldName, fieldDef]) => {
      // Always use example if it exists, regardless of type
      if (fieldDef.example !== undefined) {
        payload[fieldName] = fieldDef.example;
      } else {
        // Provide default examples based on type only if no example exists
        switch (fieldDef.type) {
          case "string":
            payload[fieldName] = "example_value";
            break;
          case "number":
            payload[fieldName] = 0;
            break;
          case "boolean":
            payload[fieldName] = true;
            break;
          case "array":
            payload[fieldName] = [];
            break;
          case "object":
            payload[fieldName] = {};
            break;
          default:
            payload[fieldName] = null;
        }
      }
    });

    return {
      event_type: outputEvent,
      id: "0ccc7b54-4df3-4bca-a65a-3da1ecc777f0",
      occurred_at: new Date().toISOString(),
      payload,
    };
  };

  useEffect(() => {
    if (open && edge) {
      // Load existing mappings or initialize empty
      const existingMappings = edge.data?.variableMappings || [];
      // Ensure each mapping has a unique ID for React keys
      const mappingsWithIds = existingMappings.map((m, i) => ({
        ...m,
        id: m.id || `mapping_${Date.now()}_${i}`, // Add ID if missing
      }));
      setVariableMappings(mappingsWithIds.length > 0 ? mappingsWithIds : []);

      // Load sample payload for HTTP Request initiator nodes
      if (isHttpRequestInitiatorNode) {
        setSamplePayload(edge.data?.samplePayload || "");
      }
    }
  }, [open, edge, isHttpRequestInitiatorNode]);

  // Validate sample payload for HTTP Request initiator
  useEffect(() => {
    if (!isHttpRequestInitiatorNode || !samplePayload) {
      setPayloadError("");
      return;
    }

    try {
      JSON.parse(samplePayload);
      setPayloadError("");
    } catch (error) {
      setPayloadError("Invalid JSON. Please check your payload format.");
    }
  }, [samplePayload, isHttpRequestInitiatorNode]);

  const addMapping = () => {
    setVariableMappings([
      ...variableMappings,
      {
        id: `mapping_${Date.now()}_${Math.random()}`, // Unique ID for React key
        variableName: "",
        sourcePath: "",
        description: "",
      },
    ]);
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

    // Auto-suggest variable name when source path is selected
    if (field === "sourcePath" && value && !newMappings[index].variableName) {
      const suggested = suggestVariableName(value);
      const allVarNames = [
        ...existingVariableNames,
        ...variableMappings.map((m) => m.variableName).filter(Boolean),
      ];
      const uniqueName = generateUniqueVariableName(suggested, allVarNames);
      newMappings[index].variableName = uniqueName;
    }

    setVariableMappings(newMappings);
  };

  // Auto-suggest mappings from sample payload
  const autoSuggestMappings = () => {
    if (!isHttpRequestInitiatorNode || schemaPaths.length === 0) {
      return;
    }

    const suggestedMappings = schemaPaths
      .filter((path) => {
        // Only suggest leaf nodes (non-object types)
        return (
          path.type !== "object" &&
          (!path.path.includes(".") || path.path.split(".").length <= 3)
        );
      })
      .slice(0, 10) // Limit to 10 suggestions
      .map((path) => {
        // Generate variable name from path
        const pathParts = path.path
          .replace(/^(payload|query)\./, "")
          .split(".");
        const varName = pathParts
          .map((part, i) => {
            if (i === 0) return part;
            return part.charAt(0).toUpperCase() + part.slice(1);
          })
          .join("");

        return {
          id: `mapping_${Date.now()}_${Math.random()}`,
          variableName: varName,
          sourcePath: path.path,
          description: "",
        };
      });

    // Merge with existing mappings (don't overwrite)
    const existingPaths = new Set(
      variableMappings.map((m) => m.sourcePath).filter(Boolean)
    );
    const newMappings = [
      ...variableMappings,
      ...suggestedMappings.filter((m) => !existingPaths.has(m.sourcePath)),
    ];

    setVariableMappings(newMappings);
  };

  const handleSave = () => {
    // Validate sample payload for HTTP Request initiator
    if (isHttpRequestInitiatorNode && samplePayload) {
      try {
        JSON.parse(samplePayload);
      } catch (error) {
        alert("Invalid JSON in sample payload. Please fix the format.");
        return;
      }
    }

    // Validate mappings
    const errors = [];
    const seenNames = new Set();

    variableMappings.forEach((mapping, index) => {
      if (!mapping.variableName) {
        errors.push(`Mapping ${index + 1}: Variable name is required`);
      }
      if (!mapping.sourcePath) {
        errors.push(`Mapping ${index + 1}: Source path is required`);
      }

      // Check for duplicates within this edge
      if (seenNames.has(mapping.variableName)) {
        errors.push(
          `Mapping ${index + 1}: Duplicate variable name "${
            mapping.variableName
          }"`
        );
      }
      seenNames.add(mapping.variableName);

      // Validate variable name format
      const validation = validateVariableName(mapping.variableName);
      if (!validation.valid) {
        errors.push(`Mapping ${index + 1}: ${validation.error}`);
      }

      // Check for duplicates across the flow
      if (mapping.variableName) {
        const duplicateCheck = checkDuplicateVariableName(
          mapping.variableName,
          { nodes, edges, globalVariables },
          { type: "edge", edgeId: edge?.id }
        );
        if (duplicateCheck.isDuplicate) {
          errors.push(`Mapping ${index + 1}: ${duplicateCheck.message}`);
        }
      }
    });

    if (errors.length > 0) {
      alert("Validation errors:\n\n" + errors.join("\n"));
      return;
    }

    // Strip the 'id' field before saving (it's only for React keys)
    const mappingsToSave = variableMappings.map(
      ({ id, ...mapping }) => mapping
    );

    onSave(
      mappingsToSave,
      isHttpRequestInitiatorNode ? { samplePayload } : undefined
    );
    onClose();
  };

  // Check if save should be disabled
  const hasDuplicates = variableMappings.some((mapping) => {
    if (!mapping.variableName) return false;
    const duplicateCheck = checkDuplicateVariableName(
      mapping.variableName,
      { nodes, edges, globalVariables },
      { type: "edge", edgeId: edge?.id }
    );
    return duplicateCheck.isDuplicate;
  });

  const hasValidationErrors = variableMappings.some((mapping) => {
    if (!mapping.variableName || !mapping.sourcePath) return true;
    const validation = validateVariableName(mapping.variableName);
    return !validation.valid;
  });

  // Allow saving with 0 mappings (to clear all variables from edge)
  const canSave = !hasDuplicates && !hasValidationErrors;

  if (!open) return null;

  return (
    <div className="fixed inset-y-0 right-0 w-[40rem] bg-background border-l shadow-2xl z-50 flex flex-col animate-in slide-in-from-right">
      {/* Panel Header */}
      <div className="border-b p-4 flex-shrink-0">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <IconChevronRight className="h-5 w-5 text-telnyx-green" />
            <h2 className="font-semibold text-lg">Configure Edge Variables</h2>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <IconX className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Extract variables from webhook payload as data flows through this edge
        </p>
      </div>

      {/* Show error if source node not found */}
      {!sourceNode && (
        <div className="p-4 m-4 bg-destructive/10 border border-destructive rounded-md">
          <p className="text-sm text-destructive font-medium">
            Error: Source node not found
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            The source node for this edge could not be found. Please try closing
            and reopening the flow.
          </p>
        </div>
      )}

      {/* Panel Content */}
      {sourceNode && (
        <>
          {/* Static Content Section */}
          <div className="flex-shrink-0 p-4 space-y-4">
            {/* Source Info */}
            <div className="p-3 bg-muted rounded-md text-sm">
              <div className="font-medium mb-1">Source Node:</div>
              <div className="text-muted-foreground">
                {sourceNode.data?.label || sourceNode.id} (
                {sourceNode.data?.nodeType})
              </div>
              {outputEvent && !isHttpRequestNode && (
                <div className="mt-2">
                  <Badge variant="secondary" className="text-xs">
                    {outputEvent}
                  </Badge>
                </div>
              )}
              {isHttpRequestActionNode && (
                <div className="mt-2">
                  <Badge variant="secondary" className="text-xs">
                    HTTP Response
                  </Badge>
                </div>
              )}
              {isHttpRequestInitiatorNode && (
                <div className="mt-2">
                  <Badge variant="secondary" className="text-xs">
                    HTTP Request Trigger (
                    {sourceNode?.data?.config?.http_method || "POST"})
                  </Badge>
                </div>
              )}
            </div>

            {/* Sample Payload Section for HTTP Request Initiator */}
            {isHttpRequestInitiatorNode && (
              <div className="border rounded-md">
                <div className="p-3 bg-muted/50 flex items-center justify-between">
                  <div
                    className="flex items-center gap-2 cursor-pointer flex-1"
                    onClick={() =>
                      setSamplePayloadExpanded(!samplePayloadExpanded)
                    }
                  >
                    <IconCode className="h-4 w-4" />
                    <span className="text-sm font-medium">Sample Payload</span>
                    <IconChevronRight
                      className={`h-4 w-4 transition-transform ${
                        samplePayloadExpanded ? "rotate-90" : ""
                      }`}
                    />
                  </div>
                </div>
                {samplePayloadExpanded && (
                  <div className="p-3 border-t space-y-2">
                    <p className="text-xs text-muted-foreground">
                      Provide a sample{" "}
                      {sourceNode?.data?.config?.http_method || "POST"} request
                      payload to automatically detect available fields for
                      mapping.
                      {sourceNode?.data?.config?.http_method === "GET" &&
                        " For GET requests, provide query parameters as JSON."}
                    </p>
                    <VariableTextarea
                      value={samplePayload}
                      onChange={(value) => {
                        setSamplePayload(value);
                        setPayloadError("");
                      }}
                      placeholder={
                        sourceNode?.data?.config?.http_method === "GET"
                          ? JSON.stringify(
                              { phone_number: "+1234567890", message: "Hello" },
                              null,
                              2
                            )
                          : JSON.stringify(
                              {
                                to: "+1234567890",
                                from: "+0987654321",
                                message: "Hello",
                              },
                              null,
                              2
                            )
                      }
                      rows={8}
                      className="font-mono text-xs"
                    />
                    {payloadError && (
                      <p className="text-xs text-destructive flex items-center gap-1">
                        <IconAlertCircle className="h-3 w-3" />
                        {payloadError}
                      </p>
                    )}
                    {schemaPaths.length > 0 && (
                      <div className="mt-2 p-2 bg-muted rounded text-xs">
                        <p className="font-semibold mb-1">
                          Detected {schemaPaths.length} field(s):
                        </p>
                        <div className="flex flex-wrap gap-1">
                          {schemaPaths.slice(0, 10).map((path, idx) => (
                            <span
                              key={idx}
                              className="px-2 py-1 bg-background rounded border text-xs font-mono"
                              title={`Type: ${path.type}`}
                            >
                              {path.path}
                            </span>
                          ))}
                          {schemaPaths.length > 10 && (
                            <span className="px-2 py-1 text-muted-foreground">
                              +{schemaPaths.length - 10} more
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                    {schemaPaths.length > 0 && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={autoSuggestMappings}
                        className="w-full"
                      >
                        <IconWand className="h-4 w-4 mr-2" />
                        Auto-suggest Variable Mappings
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* No Output Event Notice (for nodes like Set Variable) */}
            {!outputEvent && !isHttpRequestNode && (
              <div className="p-3 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-md">
                <p className="text-xs font-medium text-blue-800 dark:text-blue-200">
                  No Variable Mapping Available
                </p>
                <p className="text-xs text-blue-700 dark:text-blue-300 mt-1">
                  This node type does not generate output data that can be
                  mapped to variables.
                  {sourceNode.data?.nodeType === "set_variable" && (
                    <>
                      {" "}
                      Variables set by this node are automatically available in
                      subsequent nodes.
                    </>
                  )}
                </p>
              </div>
            )}

            {/* HTTP Request Action Test Notice */}
            {isHttpRequestActionNode && schemaPaths.length === 0 && (
              <div className="p-3 bg-yellow-50 dark:bg-yellow-950/20 border border-yellow-200 dark:border-yellow-800 rounded-md">
                <p className="text-xs font-medium text-yellow-800 dark:text-yellow-200">
                  Test Required
                </p>
                <p className="text-xs text-yellow-700 dark:text-yellow-300 mt-1">
                  Please run a test request in the HTTP Request node editor to
                  see available response fields for variable mapping.
                </p>
              </div>
            )}
            {/* HTTP Request Initiator Sample Payload Notice */}
            {isHttpRequestInitiatorNode &&
              schemaPaths.length === 0 &&
              !samplePayload && (
                <div className="p-3 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-md">
                  <p className="text-xs font-medium text-blue-800 dark:text-blue-200">
                    Sample Payload Recommended
                  </p>
                  <p className="text-xs text-blue-700 dark:text-blue-300 mt-1">
                    Provide a sample payload above to automatically detect
                    available fields for mapping.
                  </p>
                </div>
              )}

            {/* Schema Explorer */}
            {schemaPaths.length > 0 && (
              <div className="border rounded-md">
                <div className="p-3 bg-muted/50 flex items-center justify-between">
                  <div
                    className="flex items-center gap-2 cursor-pointer flex-1"
                    onClick={() => setExpandedSchema(!expandedSchema)}
                  >
                    <span className="text-sm font-medium">
                      {isHttpRequestActionNode
                        ? "HTTP Response Structure"
                        : isHttpRequestInitiatorNode
                        ? "Request Payload Structure"
                        : "Expected Payload Structure"}
                    </span>
                    <IconChevronRight
                      className={`h-4 w-4 transition-transform ${
                        expandedSchema ? "rotate-90" : ""
                      }`}
                    />
                  </div>

                  {/* View Mode Toggle */}
                  {expandedSchema && (
                    <div className="flex items-center gap-1 border rounded-md bg-background">
                      <Button
                        type="button"
                        size="sm"
                        variant={
                          schemaViewMode === "list" ? "secondary" : "ghost"
                        }
                        className="h-7 px-2"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSchemaViewMode("list");
                        }}
                      >
                        <IconList className="h-3 w-3" />
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={
                          schemaViewMode === "json" ? "secondary" : "ghost"
                        }
                        className="h-7 px-2"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSchemaViewMode("json");
                        }}
                      >
                        <IconCode className="h-3 w-3" />
                      </Button>
                    </div>
                  )}
                </div>

                {expandedSchema && (
                  <>
                    {/* List View */}
                    {schemaViewMode === "list" && (
                      <div className="max-h-48 overflow-y-auto p-3 border-t">
                        <div className="space-y-1">
                          {schemaPaths.map((field, index) => (
                            <div
                              key={index}
                              className="text-xs font-mono flex items-start gap-2"
                            >
                              <span className="text-blue-600 font-semibold">
                                {field.path}
                              </span>
                              <span className="text-muted-foreground">
                                ({field.type})
                              </span>
                              {field.description && (
                                <span className="text-muted-foreground text-[10px]">
                                  - {field.description}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* JSON View */}
                    {schemaViewMode === "json" && (
                      <div className="max-h-96 overflow-y-auto border-t">
                        <CodeBlock
                          code={JSON.stringify(buildExampleJson(), null, 2)}
                          language="json"
                        >
                          <CodeBlockCopyButton />
                        </CodeBlock>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Variable Mappings Header - Only show if node supports variable mapping */}
            {(outputEvent || isHttpRequestNode) && (
              <div className="flex items-center justify-between">
                <Label className="font-semibold">Variable Mappings</Label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={addMapping}
                  className="h-8"
                  disabled={isHttpRequestActionNode && schemaPaths.length === 0}
                >
                  <IconPlus className="h-3 w-3 mr-1" />
                  Add Mapping
                </Button>
              </div>
            )}
          </div>

          {/* Scrollable Mappings List - Only show if node supports variable mapping */}
          {(outputEvent || isHttpRequestNode) && (
            <div className="flex-1 overflow-y-auto px-4">
              <div className="space-y-3 pb-4">
                {variableMappings.map((mapping, index) => (
                  <div
                    key={mapping.id}
                    className="p-3 border rounded-md bg-card space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">
                        Mapping {index + 1}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => removeMapping(index)}
                        className="h-6 w-6 p-0 text-destructive hover:bg-destructive/10"
                      >
                        <IconTrash className="h-3 w-3" />
                      </Button>
                    </div>

                    <div>
                      <Label className="text-xs">Source Path</Label>
                      {schemaPaths.length > 0 ? (
                        <Select
                          value={mapping.sourcePath}
                          onValueChange={(value) =>
                            updateMapping(index, "sourcePath", value)
                          }
                        >
                          <SelectTrigger className="mt-1">
                            <SelectValue placeholder="Select field..." />
                          </SelectTrigger>
                          <SelectContent>
                            {schemaPaths.map((field) => (
                              <SelectItem key={field.path} value={field.path}>
                                <div className="flex items-center gap-2">
                                  <span className="font-mono text-xs">
                                    {field.path}
                                  </span>
                                  <span className="text-xs text-muted-foreground">
                                    ({field.type})
                                  </span>
                                </div>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input
                          value={mapping.sourcePath}
                          onChange={(e) =>
                            updateMapping(index, "sourcePath", e.target.value)
                          }
                          placeholder="payload.call_control_id"
                          className="mt-1"
                        />
                      )}
                      <p className="text-xs text-muted-foreground mt-1">
                        Path to the data in the webhook payload
                      </p>
                    </div>

                    <div>
                      <Label className="text-xs">Variable Name</Label>
                      <Input
                        value={mapping.variableName}
                        onChange={(e) =>
                          updateMapping(index, "variableName", e.target.value)
                        }
                        placeholder="call_control_id"
                        className={`mt-1 ${
                          mapping.variableName &&
                          checkDuplicateVariableName(
                            mapping.variableName,
                            { nodes, edges, globalVariables },
                            { type: "edge", edgeId: edge?.id }
                          ).isDuplicate
                            ? "border-yellow-500"
                            : ""
                        }`}
                      />
                      {mapping.variableName &&
                        checkDuplicateVariableName(
                          mapping.variableName,
                          { nodes, edges, globalVariables },
                          { type: "edge", edgeId: edge?.id }
                        ).isDuplicate && (
                          <p className="text-xs text-yellow-600 dark:text-yellow-500 mt-1 flex items-center gap-1">
                            <IconAlertCircle className="h-3 w-3" />
                            {
                              checkDuplicateVariableName(
                                mapping.variableName,
                                { nodes, edges, globalVariables },
                                { type: "edge", edgeId: edge?.id }
                              ).message
                            }
                          </p>
                        )}
                      {!checkDuplicateVariableName(
                        mapping.variableName,
                        { nodes, edges, globalVariables },
                        { type: "edge", edgeId: edge?.id }
                      ).isDuplicate && (
                        <p className="text-xs text-muted-foreground mt-1">
                          Name to store this value (auto-suggested from path)
                        </p>
                      )}
                    </div>

                    <div>
                      <Label className="text-xs">Description (Optional)</Label>
                      <Input
                        value={mapping.description || ""}
                        onChange={(e) =>
                          updateMapping(index, "description", e.target.value)
                        }
                        placeholder="Brief description..."
                        className="mt-1"
                      />
                    </div>
                  </div>
                ))}

                {variableMappings.length === 0 && (
                  <div className="text-center py-8 text-sm text-muted-foreground border rounded-md bg-muted/30">
                    No variable mappings defined.
                    <br />
                    Click "Add Mapping" to capture data from this edge.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Fixed Footer - Only show Save button if node supports variable mapping */}
          <div className="border-t p-4 flex-shrink-0 flex items-center justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              {outputEvent || isHttpRequestNode ? "Cancel" : "Close"}
            </Button>
            {(outputEvent || isHttpRequestNode) && (
              <Button
                onClick={handleSave}
                disabled={
                  !canSave ||
                  (isHttpRequestInitiatorNode && samplePayload && payloadError)
                }
              >
                Save Mappings
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Get the output event type for an edge based on source node and handle
 */
function getOutputEvent(sourceNode, edge) {
  if (!sourceNode || !edge) return null;

  const nodeType = sourceNode.data?.nodeType;
  const nodeDef = VOICE_FLOW_NODES[nodeType];

  if (!nodeDef || !nodeDef.outputEvents) return null;

  // Extract output index from sourceHandle (e.g., "output-0" -> 0)
  const sourceHandle = edge.sourceHandle || "output-0";
  const outputIndex = parseInt(sourceHandle.replace("output-", ""), 10);

  return nodeDef.outputEvents[outputIndex] || null;
}
