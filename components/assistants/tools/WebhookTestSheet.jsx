"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  IconX,
  IconFlask,
  IconLoader2,
  IconCheck,
  IconAlertCircle,
  IconCode,
  IconCopy,
  IconExternalLink,
  IconWorld,
  IconSettings,
  IconVariable,
  IconEye,
  IconChevronRight,
  IconInfoCircle,
} from "@tabler/icons-react";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

/**
 * Webhook Test Sheet
 * A sheet that slides in from the right to test webhook requests with parameter substitution
 */
export default function WebhookTestSheet({
  open,
  onOpenChange,
  webhookConfig,
  assistantId,
  toolId,
  standaloneToolId,
  availableVariables = [],
}) {
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testError, setTestError] = useState(null);
  const [expandedResponse, setExpandedResponse] = useState(true);
  const [expandedRequest, setExpandedRequest] = useState(false);

  // Parameter values for testing
  const [testArguments, setTestArguments] = useState({});
  const [testVariables, setTestVariables] = useState({});

  // Helper function to get parameter type from webhook config
  const getParameterType = (key) => {
    const param =
      webhookConfig?.path_parameters?.properties?.[key] ||
      webhookConfig?.query_parameters?.properties?.[key] ||
      webhookConfig?.body_parameters?.properties?.[key];
    return param?.type || "string";
  };

  // Helper function to get default value based on type
  const getDefaultValue = (type) => {
    switch (type) {
      case "boolean":
        return false;
      case "number":
      case "integer":
        return "";
      case "array":
        return [];
      default:
        return "";
    }
  };

  // Reset state when webhook config changes
  useEffect(() => {
    if (webhookConfig) {
      // Initialize test arguments from webhook parameters
      const newTestArguments = {};

      // Helper to get param type inline
      const getParamType = (key) => {
        const param =
          webhookConfig?.path_parameters?.properties?.[key] ||
          webhookConfig?.query_parameters?.properties?.[key] ||
          webhookConfig?.body_parameters?.properties?.[key];
        return param?.type || "string";
      };

      // Initialize path parameters
      if (webhookConfig.path_parameters?.properties) {
        Object.keys(webhookConfig.path_parameters.properties).forEach((key) => {
          const type = getParamType(key);
          newTestArguments[key] = getDefaultValue(type);
        });
      }

      // Initialize query parameters
      if (webhookConfig.query_parameters?.properties) {
        Object.keys(webhookConfig.query_parameters.properties).forEach(
          (key) => {
            const type = getParamType(key);
            newTestArguments[key] = getDefaultValue(type);
          }
        );
      }

      // Initialize body parameters
      if (webhookConfig.body_parameters?.properties) {
        Object.keys(webhookConfig.body_parameters.properties).forEach((key) => {
          const type = getParamType(key);
          newTestArguments[key] = getDefaultValue(type);
        });
      }

      setTestArguments(newTestArguments);
    }
  }, [webhookConfig]);

  const handleArgumentChange = (key, value) => {
    setTestArguments((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  const handleVariableChange = (key, value) => {
    setTestVariables((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  // Convert test arguments to proper types based on webhook schema
  const convertArgumentsToTypes = (args) => {
    const converted = {};
    Object.keys(args).forEach((key) => {
      const type = getParameterType(key);
      const value = args[key];

      if (value === "" || value === null || value === undefined) {
        // Skip empty values
        return;
      }

      switch (type) {
        case "boolean":
          // Convert string "true"/"false" to boolean, or use boolean directly
          if (typeof value === "string") {
            converted[key] = value.toLowerCase() === "true";
          } else {
            converted[key] = Boolean(value);
          }
          break;
        case "number":
        case "integer":
          const num = Number(value);
          if (!isNaN(num)) {
            converted[key] = type === "integer" ? Math.floor(num) : num;
          }
          break;
        case "array":
          // If it's already an array, use it; otherwise try to parse JSON
          if (Array.isArray(value)) {
            converted[key] = value;
          } else if (typeof value === "string") {
            try {
              converted[key] = JSON.parse(value);
            } catch {
              // If parsing fails, treat as single-item array
              converted[key] = [value];
            }
          }
          break;
        default:
          converted[key] = value;
      }
    });
    return converted;
  };

  const handleTestRequest = async () => {
    if ((!assistantId || !toolId) && !standaloneToolId) {
      setTestError("Missing assistant/tool ID or standalone tool ID");
      return;
    }

    setIsTesting(true);
    setTestError(null);
    setTestResult(null);

    try {
      // Convert arguments to proper types
      const convertedArguments = convertArgumentsToTypes(testArguments);
      const isStandaloneToolTest = Boolean(standaloneToolId);
      const endpoint = isStandaloneToolTest
        ? "/api/ai/tools/test"
        : "/api/assistants/test-webhook-telnyx";
      const body = isStandaloneToolTest
        ? {
            toolId: standaloneToolId,
            arguments: convertedArguments,
          }
        : {
            assistantId,
            toolId,
            arguments: convertedArguments,
            dynamicVariables: testVariables,
          };

      console.log("Testing webhook with:", {
        assistantId,
        toolId,
        standaloneToolId,
        testArguments,
        convertedArguments,
        testVariables,
      });

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const result = await response.json();

      if (!response.ok) {
        setTestError(result.error || "Test request failed");
        return;
      }

      if (result.success) {
        setTestResult(result.response);
        setExpandedResponse(true);
      } else {
        setTestError(result.error || "Request failed");
      }
    } catch (error) {
      console.error("Test request error:", error);
      setTestError(error.message || "Failed to test request");
    } finally {
      setIsTesting(false);
    }
  };

  const getStatusBadge = (success, statusCode) => {
    if (success) {
      return (
        <Badge
          variant="secondary"
          className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
        >
          <IconCheck className="h-3 w-3 mr-1" />
          {statusCode} OK
        </Badge>
      );
    } else {
      return (
        <Badge
          variant="secondary"
          className="bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
        >
          <IconAlertCircle className="h-3 w-3 mr-1" />
          {statusCode} Error
        </Badge>
      );
    }
  };

  if (!webhookConfig) {
    return null;
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[600px] sm:w-[700px] overflow-y-auto mb-4">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <IconFlask className="h-5 w-5 text-blue-500" />
            Test Webhook
          </SheetTitle>
          <SheetDescription>
            {webhookConfig?.description ||
              "Test your webhook configuration with sample data"}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 mt-0 mx-4">
          {/* Request Configuration */}
          <Card>
            <CardHeader className="pb-0">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm flex items-center gap-2">
                  <IconSettings className="h-4 w-4" />
                  Request Configuration
                </CardTitle>
                <Button
                  onClick={handleTestRequest}
                  disabled={isTesting}
                  size="sm"
                  className="ml-auto"
                >
                  {isTesting ? (
                    <>
                      <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                      Testing...
                    </>
                  ) : (
                    <>
                      <IconFlask className="h-4 w-4 mr-2" />
                      Test
                    </>
                  )}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label className="text-xs">Tool Configuration</Label>
                <div className="mt-1 px-3 py-2 bg-muted rounded-md text-sm">
                  <div className="font-mono">
                    {webhookConfig.name || "Unnamed Tool"}
                  </div>
                  <div className="text-muted-foreground">
                    {webhookConfig.description || "No description"}
                  </div>
                </div>
              </div>

              {/* Tool Parameters */}
              {Object.keys(testArguments).length > 0 && (
                <div>
                  <Label className="text-xs">Tool Parameters</Label>
                  <div className="space-y-2 mt-2">
                    {Object.keys(testArguments).map((key) => {
                      // Get parameter description and type from webhook config
                      const paramDescription =
                        webhookConfig?.query_parameters?.properties?.[key]
                          ?.description ||
                        webhookConfig?.body_parameters?.properties?.[key]
                          ?.description ||
                        webhookConfig?.path_parameters?.properties?.[key]
                          ?.description;
                      const paramType = getParameterType(key);
                      const isBoolean = paramType === "boolean";
                      const currentValue = testArguments[key];

                      return (
                        <div key={key}>
                          <Label className="text-xs text-muted-foreground">
                            {key}
                          </Label>
                          {isBoolean ? (
                            <div className="flex items-center gap-4 mt-2">
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                  type="radio"
                                  name={key}
                                  checked={currentValue === true}
                                  onChange={() =>
                                    handleArgumentChange(key, true)
                                  }
                                  className="w-4 h-4"
                                />
                                <span className="text-sm">True</span>
                              </label>
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                  type="radio"
                                  name={key}
                                  checked={currentValue === false}
                                  onChange={() =>
                                    handleArgumentChange(key, false)
                                  }
                                  className="w-4 h-4"
                                />
                                <span className="text-sm">False</span>
                              </label>
                            </div>
                          ) : (
                            <Input
                              type={
                                paramType === "number" ||
                                paramType === "integer"
                                  ? "number"
                                  : "text"
                              }
                              value={
                                typeof currentValue === "object"
                                  ? JSON.stringify(currentValue)
                                  : currentValue || ""
                              }
                              onChange={(e) =>
                                handleArgumentChange(key, e.target.value)
                              }
                              placeholder={`Enter ${key}`}
                              className="mt-1"
                            />
                          )}
                          {paramDescription && (
                            <div className="flex items-start gap-1 mt-1 mb-2 p-2 bg-blue-50 dark:bg-blue-950/20 rounded-md border border-blue-200 dark:border-blue-800">
                              <IconInfoCircle className="h-3 w-3 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
                              <p className="text-xs text-blue-700 dark:text-blue-300 leading-relaxed">
                                {paramDescription}
                              </p>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Request Preview */}
          <Card className="border border-border bg-card">
            <Collapsible
              open={expandedRequest}
              onOpenChange={setExpandedRequest}
            >
              <CollapsibleTrigger asChild>
                <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors p-3">
                  <div className="flex items-center gap-2">
                    <IconEye className="h-3 w-3 text-green-600" />
                    <CardTitle className="text-sm font-semibold">
                      Request Preview
                    </CardTitle>
                    <IconChevronRight
                      className={`h-3 w-3 transition-transform ${
                        expandedRequest ? "rotate-90" : ""
                      }`}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    How your request will be sent to the webhook
                  </p>
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="px-3 pb-3 space-y-4">
                  {/* URL */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <IconWorld className="h-3 w-3 text-blue-600" />
                      <Label className="text-xs font-medium">URL</Label>
                    </div>
                    <div className="p-3 bg-muted/50 rounded border">
                      <code className="text-xs font-mono break-all text-foreground">
                        {webhookConfig.url || ""}
                      </code>
                    </div>
                  </div>

                  {/* Method */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <IconSettings className="h-3 w-3 text-purple-600" />
                      <Label className="text-xs font-medium">Method</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs px-2 py-1">
                        {webhookConfig.method || "POST"}
                      </Badge>
                    </div>
                  </div>

                  {/* Parameters */}
                  {Object.keys(testArguments).length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <IconVariable className="h-3 w-3 text-orange-600" />
                        <Label className="text-xs font-medium">
                          {webhookConfig.method === "GET"
                            ? "Query Parameters"
                            : "Parameters"}
                        </Label>
                        <Badge variant="secondary" className="text-xs">
                          {Object.keys(testArguments).length}
                        </Badge>
                      </div>
                      {webhookConfig.method === "GET" ? (
                        <div className="space-y-2">
                          {Object.entries(testArguments).map(([key, value]) => (
                            <div
                              key={key}
                              className="p-2 bg-muted/50 rounded border"
                            >
                              <div className="flex items-start gap-2">
                                <span className="font-semibold text-indigo-600 min-w-0 flex-shrink-0 text-xs">
                                  {key}:
                                </span>
                                <code className="text-xs text-muted-foreground break-all">
                                  {value}
                                </code>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="mt-2 border rounded-md h-[200px] overflow-y-auto">
                          <CodeBlock
                            className="h-[200px]"
                            language="json"
                            code={JSON.stringify(
                              convertArgumentsToTypes(testArguments),
                              null,
                              2
                            )}
                          >
                            <CodeBlockCopyButton />
                          </CodeBlock>
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </CollapsibleContent>
            </Collapsible>
          </Card>

          {/* Test Results */}
          {testError && (
            <Card className="border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950">
              <CardContent className="pt-4">
                <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
                  <IconAlertCircle className="h-4 w-4" />
                  <span className="font-medium">Test Failed</span>
                </div>
                <p className="text-sm text-red-600 dark:text-red-400 mt-2">
                  {testError}
                </p>
              </CardContent>
            </Card>
          )}

          {testResult && (
            <Card className="mb-4">
              <CardHeader className="pb-0">
                <CardTitle className="text-sm flex items-center gap-2">
                  <IconCheck className="h-4 w-4 text-green-500" />
                  Response
                  {getStatusBadge(testResult.success, testResult.status_code)}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="space-y-4">
                  <div>
                    <Label className="text-xs text-muted-foreground">
                      Content Type
                    </Label>
                    <div className="mt-1 px-3 py-2 bg-muted rounded-md text-sm font-mono">
                      {testResult.content_type || "application/json"}
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">
                      Response Body
                    </Label>
                    <div className="mt-2 border rounded-md h-[200px] overflow-auto">
                      <CodeBlock
                        language="json"
                        className="h-[200px] overflow-y-auto"
                        code={
                          typeof testResult.response === "string"
                            ? (() => {
                                try {
                                  return JSON.stringify(
                                    JSON.parse(testResult.response),
                                    null,
                                    2
                                  );
                                } catch {
                                  return testResult.response;
                                }
                              })()
                            : JSON.stringify(testResult.response || {}, null, 2)
                        }
                      >
                        <CodeBlockCopyButton />
                      </CodeBlock>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
