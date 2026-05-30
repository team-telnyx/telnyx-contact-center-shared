"use client";

import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { VariableInput } from "./VariableInput";
import { VariableTextarea } from "./VariableTextarea";
import {
  IconPlus,
  IconTrash,
  IconFlask,
  IconLoader2,
  IconChevronRight,
  IconChevronDown,
  IconList,
  IconCode,
  IconAlertCircle,
  IconExternalLink,
} from "@tabler/icons-react";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import { extractPathsFromObject } from "@/config/webhook-schemas";
import { checkDuplicateVariableName } from "@/lib/variable-utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import HttpRequestTestModal from "./HttpRequestTestModal";

/**
 * HTTP Request Node Editor
 * Editor for making HTTP requests to external APIs
 */
export default function HttpRequestNodeEditor({
  config,
  onChange,
  availableVariables = [],
  nodes = [],
  edges = [],
  globalVariables = {},
  selectedNodeId = null,
}) {
  const url = config?.url || "";
  const method = config?.method || "GET";
  const headers = config?.headers || {};
  const pathParams = config?.pathParams || {};
  const queryParams = config?.queryParams || {};
  const bodyParams = config?.bodyParams || {};
  const bodyType = config?.bodyType || "json"; // 'json' or 'params'
  const body = config?.body || "";
  const timeout = config?.timeout || 30000;

  const [newHeaderKey, setNewHeaderKey] = useState("");
  const [newHeaderValue, setNewHeaderValue] = useState("");
  const [newPathParamKey, setNewPathParamKey] = useState("");
  const [newPathParamValue, setNewPathParamValue] = useState("");
  const [newQueryKey, setNewQueryKey] = useState("");
  const [newQueryValue, setNewQueryValue] = useState("");
  const [newBodyParamKey, setNewBodyParamKey] = useState("");
  const [newBodyParamValue, setNewBodyParamValue] = useState("");
  const [testModalOpen, setTestModalOpen] = useState(false);
  const [headersExpanded, setHeadersExpanded] = useState(false);
  const [pathParamsExpanded, setPathParamsExpanded] = useState(false);
  const [queryParamsExpanded, setQueryParamsExpanded] = useState(false);
  const [bodyParamsExpanded, setBodyParamsExpanded] = useState(false);
  const [availableSecrets, setAvailableSecrets] = useState([]);

  // Load available secrets
  const loadSecrets = async () => {
    try {
      const response = await fetch("/api/admin/secrets");
      if (response.ok) {
        const data = await response.json();
        setAvailableSecrets(data.secrets || []);
      }
    } catch (error) {
      console.error("Error loading secrets:", error);
    }
  };

  // Load secrets on component mount
  useEffect(() => {
    loadSecrets();
  }, []);

  const handleChange = (field, value) => {
    onChange({
      ...config,
      [field]: value,
    });
  };

  const addHeader = () => {
    if (newHeaderKey) {
      const newHeaders = {
        ...headers,
        [newHeaderKey]: newHeaderValue,
      };
      handleChange("headers", newHeaders);
      setNewHeaderKey("");
      setNewHeaderValue("");
    }
  };

  const removeHeader = (key) => {
    const newHeaders = { ...headers };
    delete newHeaders[key];
    handleChange("headers", newHeaders);
  };

  const updateHeaderValue = (key, value) => {
    const newHeaders = {
      ...headers,
      [key]: value,
    };
    handleChange("headers", newHeaders);
  };


  // Path Parameters handlers
  const addPathParam = () => {
    if (newPathParamKey) {
      const newPathParams = {
        ...pathParams,
        [newPathParamKey]: newPathParamValue,
      };
      handleChange("pathParams", newPathParams);
      setNewPathParamKey("");
      setNewPathParamValue("");
    }
  };

  const removePathParam = (key) => {
    const newPathParams = { ...pathParams };
    delete newPathParams[key];
    handleChange("pathParams", newPathParams);
  };

  const updatePathParamValue = (key, value) => {
    const newPathParams = {
      ...pathParams,
      [key]: value,
    };
    handleChange("pathParams", newPathParams);
  };

  // Query Parameters handlers
  const addQueryParam = () => {
    if (newQueryKey) {
      const newQueryParams = {
        ...queryParams,
        [newQueryKey]: newQueryValue,
      };
      handleChange("queryParams", newQueryParams);
      setNewQueryKey("");
      setNewQueryValue("");
    }
  };

  const removeQueryParam = (key) => {
    const newQueryParams = { ...queryParams };
    delete newQueryParams[key];
    handleChange("queryParams", newQueryParams);
  };

  const updateQueryParamValue = (key, value) => {
    const newQueryParams = {
      ...queryParams,
      [key]: value,
    };
    handleChange("queryParams", newQueryParams);
  };

  // Body Parameters handlers
  const addBodyParam = () => {
    if (newBodyParamKey) {
      const newBodyParams = {
        ...bodyParams,
        [newBodyParamKey]: newBodyParamValue,
      };
      handleChange("bodyParams", newBodyParams);
      setNewBodyParamKey("");
      setNewBodyParamValue("");
    }
  };

  const removeBodyParam = (key) => {
    const newBodyParams = { ...bodyParams };
    delete newBodyParams[key];
    handleChange("bodyParams", newBodyParams);
  };

  const updateBodyParamValue = (key, value) => {
    const newBodyParams = {
      ...bodyParams,
      [key]: value,
    };
    handleChange("bodyParams", newBodyParams);
  };

  const headerEntries = Object.entries(headers);
  const pathParamEntries = Object.entries(pathParams);
  const queryParamEntries = Object.entries(queryParams);
  const bodyParamEntries = Object.entries(bodyParams);

  return (
    <div className="space-y-4">
      <div>
        <Label className="text-xs">URL</Label>
        <VariableInput
          value={url}
          onChange={(value) => handleChange("url", value)}
          availableVariables={availableVariables}
          availableSecrets={availableSecrets}
          placeholder="https://api.example.com/endpoint"
          className="mt-1"
        />
        <p className="text-xs text-muted-foreground mt-1">
          API endpoint URL (supports variable substitution)
        </p>
      </div>

      {/* Method Selector - Full Width */}
      <div>
        <Label className="text-xs">Method</Label>
        <Select
          value={method}
          onValueChange={(value) => handleChange("method", value)}
        >
          <SelectTrigger className="mt-1 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="w-full">
            <SelectItem value="GET">GET</SelectItem>
            <SelectItem value="POST">POST</SelectItem>
            <SelectItem value="PUT">PUT</SelectItem>
            <SelectItem value="DELETE">DELETE</SelectItem>
            <SelectItem value="PATCH">PATCH</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Headers - Collapsible */}
      <Collapsible
        open={headersExpanded}
        onOpenChange={setHeadersExpanded}
        className="border rounded-md"
      >
        <CollapsibleTrigger className="flex items-center justify-between w-full p-3 hover:bg-muted/50 transition-colors">
          <div className="flex items-center gap-2">
            <IconChevronRight
              className={`h-4 w-4 transition-transform ${
                headersExpanded ? "rotate-90" : ""
              }`}
            />
            <Label className="text-xs font-semibold cursor-pointer">
              Headers
            </Label>
            {headerEntries.length > 0 && (
              <span className="text-xs text-muted-foreground">
                ({headerEntries.length})
              </span>
            )}
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="p-3 pt-0 space-y-2">
          {headerEntries.length > 0 && (
            <div className="space-y-2 mb-2">
              {headerEntries.map(([key, value]) => (
                <div
                  key={key}
                  className="flex items-start gap-2 p-2 border rounded-md bg-card"
                >
                  <div className="flex-1 space-y-1">
                    <Badge
                      variant="outline"
                      className="w-fit text-telnyx-green border-telnyx-green/40 bg-telnyx-green/10 font-mono text-[11px]"
                    >
                      {key}
                    </Badge>
                    <VariableInput
                      value={value}
                      onChange={(newValue) => updateHeaderValue(key, newValue)}
                      availableVariables={availableVariables}
                      availableSecrets={availableSecrets}
                      placeholder="Header value"
                      className="text-xs"
                    />
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => removeHeader(key)}
                      className="h-8 w-8 p-0 text-destructive"
                    >
                      <IconTrash className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="space-y-2">
            <div className="grid grid-cols-1 gap-2">
              <Input
                value={newHeaderKey}
                onChange={(e) => setNewHeaderKey(e.target.value)}
                placeholder="Header name"
                className="text-xs"
              />
              <VariableInput
                value={newHeaderValue}
                onChange={setNewHeaderValue}
                availableVariables={availableVariables}
                availableSecrets={availableSecrets}
                placeholder="Header value"
                className="text-xs"
              />
            </div>
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={addHeader}
                disabled={!newHeaderKey}
                className="flex-shrink-0"
              >
                <IconPlus className="h-4 w-4 mr-1" />
                Add Header
              </Button>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Path Parameters - Collapsible */}
      <Collapsible
        open={pathParamsExpanded}
        onOpenChange={setPathParamsExpanded}
        className="border rounded-md"
      >
        <CollapsibleTrigger className="flex items-center justify-between w-full p-3 hover:bg-muted/50 transition-colors">
          <div className="flex items-center gap-2">
            <IconChevronRight
              className={`h-4 w-4 transition-transform ${
                pathParamsExpanded ? "rotate-90" : ""
              }`}
            />
            <Label className="text-xs font-semibold cursor-pointer">
              Path Parameters
            </Label>
            {pathParamEntries.length > 0 && (
              <span className="text-xs text-muted-foreground">
                ({pathParamEntries.length})
              </span>
            )}
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="p-3 pt-0 space-y-2">
          {pathParamEntries.length > 0 && (
            <div className="space-y-2 mb-2">
              {pathParamEntries.map(([key, value]) => (
                <div
                  key={key}
                  className="flex items-start gap-2 p-2 border rounded-md bg-card"
                >
                  <div className="flex-1 space-y-1">
                    <Badge
                      variant="outline"
                      className="w-fit text-telnyx-green border-telnyx-green/40 bg-telnyx-green/10 font-mono text-[11px]"
                    >
                      {key}
                    </Badge>
                    <VariableInput
                      value={value}
                      onChange={(newValue) =>
                        updatePathParamValue(key, newValue)
                      }
                      availableVariables={availableVariables}
                      availableSecrets={availableSecrets}
                      placeholder="Path value"
                      className="text-xs"
                    />
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => removePathParam(key)}
                    className="h-8 w-8 p-0 text-destructive"
                  >
                    <IconTrash className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
          <div className="space-y-2">
            <div className="grid grid-cols-1 gap-2">
              <Input
                value={newPathParamKey}
                onChange={(e) => setNewPathParamKey(e.target.value)}
                placeholder="Parameter name"
                className="text-xs"
              />
              <VariableInput
                value={newPathParamValue}
                onChange={setNewPathParamValue}
                availableVariables={availableVariables}
                availableSecrets={availableSecrets}
                placeholder="Parameter value"
                className="text-xs"
              />
            </div>
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={addPathParam}
                disabled={!newPathParamKey}
                className="flex-shrink-0"
              >
                <IconPlus className="h-4 w-4 mr-1" />
                Add Parameter
              </Button>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Query Parameters - Collapsible */}
      <Collapsible
        open={queryParamsExpanded}
        onOpenChange={setQueryParamsExpanded}
        className="border rounded-md"
      >
        <CollapsibleTrigger className="flex items-center justify-between w-full p-3 hover:bg-muted/50 transition-colors">
          <div className="flex items-center gap-2">
            <IconChevronRight
              className={`h-4 w-4 transition-transform ${
                queryParamsExpanded ? "rotate-90" : ""
              }`}
            />
            <Label className="text-xs font-semibold cursor-pointer">
              Query Parameters
            </Label>
            {queryParamEntries.length > 0 && (
              <span className="text-xs text-muted-foreground">
                ({queryParamEntries.length})
              </span>
            )}
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="p-3 pt-0 space-y-2">
          {queryParamEntries.length > 0 && (
            <div className="space-y-2 mb-2">
              {queryParamEntries.map(([key, value]) => (
                <div
                  key={key}
                  className="flex items-start gap-2 p-2 border rounded-md bg-card"
                >
                  <div className="flex-1 space-y-1">
                    <Badge
                      variant="outline"
                      className="w-fit text-telnyx-green border-telnyx-green/40 bg-telnyx-green/10 font-mono text-[11px]"
                    >
                      {key}
                    </Badge>
                    <VariableInput
                      value={value}
                      onChange={(newValue) =>
                        updateQueryParamValue(key, newValue)
                      }
                      availableVariables={availableVariables}
                      availableSecrets={availableSecrets}
                      placeholder="Query value"
                      className="text-xs"
                    />
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => removeQueryParam(key)}
                    className="h-8 w-8 p-0 text-destructive"
                  >
                    <IconTrash className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
          <div className="space-y-2">
            <div className="grid grid-cols-1 gap-2">
              <Input
                value={newQueryKey}
                onChange={(e) => setNewQueryKey(e.target.value)}
                placeholder="Parameter name"
                className="text-xs"
              />
              <VariableInput
                value={newQueryValue}
                onChange={setNewQueryValue}
                availableVariables={availableVariables}
                availableSecrets={availableSecrets}
                placeholder="Parameter value"
                className="text-xs"
              />
            </div>
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={addQueryParam}
                disabled={!newQueryKey}
                className="flex-shrink-0"
              >
                <IconPlus className="h-4 w-4 mr-1" />
                Add Parameter
              </Button>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Body Parameters - For POST/PUT/PATCH/DELETE - Collapsible */}
      {(method === "POST" ||
        method === "PUT" ||
        method === "PATCH" ||
        method === "DELETE") && (
        <Collapsible
          open={bodyParamsExpanded}
          onOpenChange={setBodyParamsExpanded}
          className="border rounded-md"
        >
          <CollapsibleTrigger className="flex items-center justify-between w-full p-3 hover:bg-muted/50 transition-colors">
            <div className="flex items-center gap-2">
              <IconChevronRight
                className={`h-4 w-4 transition-transform ${
                  bodyParamsExpanded ? "rotate-90" : ""
                }`}
              />
              <Label className="text-xs font-semibold cursor-pointer">
                Request Body
              </Label>
              {bodyType === "params" && bodyParamEntries.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  ({bodyParamEntries.length} params)
                </span>
              )}
            </div>
          </CollapsibleTrigger>
          <CollapsibleContent className="p-3 pt-0 space-y-3">
            {/* Body Type Toggle */}
            <div className="flex items-center gap-2 text-xs">
              <Button
                type="button"
                size="sm"
                variant={bodyType === "json" ? "secondary" : "outline"}
                onClick={() => handleChange("bodyType", "json")}
                className="h-7"
              >
                JSON
              </Button>
              <Button
                type="button"
                size="sm"
                variant={bodyType === "params" ? "secondary" : "outline"}
                onClick={() => handleChange("bodyType", "params")}
                className="h-7"
              >
                Parameters
              </Button>
            </div>

            {/* JSON Body */}
            {bodyType === "json" && (
              <div>
                <VariableTextarea
                  value={body}
                  onChange={(value) => handleChange("body", value)}
                  availableVariables={availableVariables}
                  availableSecrets={availableSecrets}
                  placeholder='{"key": "{{value}}"}'
                  rows={6}
                  className="font-mono text-xs"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Raw JSON body (supports variable substitution)
                </p>
              </div>
            )}

            {/* Body Parameters */}
            {bodyType === "params" && (
              <div className="space-y-2">
                {bodyParamEntries.length > 0 && (
                  <div className="space-y-2 mb-2">
                    {bodyParamEntries.map(([key, value]) => (
                      <div
                        key={key}
                        className="flex items-start gap-2 p-2 border rounded-md bg-card"
                      >
                        <div className="flex-1 space-y-1">
                          <Badge
                            variant="outline"
                            className="w-fit text-telnyx-green border-telnyx-green/40 bg-telnyx-green/10 font-mono text-[11px]"
                          >
                            {key}
                          </Badge>
                          <VariableInput
                            value={value}
                            onChange={(newValue) =>
                              updateBodyParamValue(key, newValue)
                            }
                            availableVariables={availableVariables}
                            availableSecrets={availableSecrets}
                            placeholder="Parameter value"
                            className="text-xs"
                          />
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => removeBodyParam(key)}
                          className="h-8 w-8 p-0 text-destructive"
                        >
                          <IconTrash className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="space-y-2">
                  <div className="grid grid-cols-1 gap-2">
                    <Input
                      value={newBodyParamKey}
                      onChange={(e) => setNewBodyParamKey(e.target.value)}
                      placeholder="Parameter name"
                      className="text-xs"
                    />
                    <VariableInput
                      value={newBodyParamValue}
                      onChange={setNewBodyParamValue}
                      availableVariables={availableVariables}
                      availableSecrets={availableSecrets}
                      placeholder="Parameter value"
                      className="text-xs"
                    />
                  </div>
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={addBodyParam}
                      disabled={!newBodyParamKey}
                      className="flex-shrink-0"
                    >
                      <IconPlus className="h-4 w-4 mr-1" />
                      Add Parameter
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Will be sent as JSON object
                </p>
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>
      )}

      <div>
        <Label className="text-xs">Timeout (ms)</Label>
        <Input
          type="number"
          value={timeout}
          onChange={(e) => handleChange("timeout", parseInt(e.target.value))}
          placeholder="30000"
          className="mt-1"
        />
        <p className="text-xs text-muted-foreground mt-1">
          Request timeout in milliseconds
        </p>
      </div>

      <div>
        <Label className="text-xs">Response Variable Name</Label>
        <Input
          value={config?.responseVariable || "http_response"}
          onChange={(e) => handleChange("responseVariable", e.target.value)}
          placeholder="http_response"
          className={`mt-1 ${
            config?.responseVariable &&
            checkDuplicateVariableName(
              config.responseVariable,
              { nodes, edges, globalVariables },
              { type: "http_request", id: selectedNodeId }
            ).isDuplicate
              ? "border-yellow-500"
              : ""
          }`}
        />
        {config?.responseVariable &&
          checkDuplicateVariableName(
            config.responseVariable,
            { nodes, edges, globalVariables },
            { type: "http_request", id: selectedNodeId }
          ).isDuplicate && (
            <p className="text-xs text-yellow-600 dark:text-yellow-500 mt-1 flex items-center gap-1">
              <IconAlertCircle className="h-3 w-3" />
              {
                checkDuplicateVariableName(
                  config.responseVariable,
                  { nodes, edges, globalVariables },
                  { type: "http_request", id: selectedNodeId }
                ).message
              }
            </p>
          )}
        {!checkDuplicateVariableName(
          config?.responseVariable || "http_response",
          { nodes, edges, globalVariables },
          { type: "http_request", id: selectedNodeId }
        ).isDuplicate && (
          <p className="text-xs text-muted-foreground mt-1">
            Variable name to store the response data
          </p>
        )}
      </div>

      {/* Test Button */}
      <div>
        <Button
          type="button"
          onClick={() => setTestModalOpen(true)}
          disabled={!url}
          variant="outline"
          className="w-full"
        >
          <IconExternalLink className="h-4 w-4 mr-2" />
          Test Request
        </Button>
        <p className="text-xs text-muted-foreground mt-1">
          Open test modal to provide variable values and test the request
        </p>
      </div>

      {/* Test Modal */}
      <HttpRequestTestModal
        open={testModalOpen}
        onOpenChange={setTestModalOpen}
        config={config}
        availableVariables={availableVariables}
      />
    </div>
  );
}
