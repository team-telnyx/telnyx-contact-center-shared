"use client";

import { useState, useMemo, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { VariableInput } from "./VariableInput";
import { VariableTextarea } from "./VariableTextarea";
import {
  getEntitySchema,
  getFieldsForAction,
  getEntityBasePath,
  getEntityTableName,
} from "@/lib/data-sources-schema.js";
import { checkDuplicateVariableName } from "@/lib/variable-utils";
import { IconAlertCircle, IconApi, IconFlask, IconInfoCircle } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import ApiSchemaSheet from "@/components/data-sources/ApiSchemaSheet";
import DataActionTestSheet from "./DataActionTestSheet";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * Data Actions Node Editor
 * Editor for performing CRUD operations on Contacts, KB Articles, and Tasks
 */
export default function DataActionsNodeEditor({
  config,
  onChange,
  availableVariables = [],
  nodes = [],
  edges = [],
  globalVariables = {},
  selectedNodeId = null,
}) {
  const dataSource = config?.dataSource || "";
  const action = config?.action || "";
  const fields = config?.fields || {};
  const recordId = config?.recordId || "";
  const queryParams = config?.queryParams || {};
  const responseVariable = config?.responseVariable || "data_response";

  // State for API schema sheet
  const [schemaSheetOpen, setSchemaSheetOpen] = useState(false);
  const [testSheetOpen, setTestSheetOpen] = useState(false);
  const latestConfigRef = useRef(config || {});
  latestConfigRef.current = config || {};

  const handleTestSuccess = (testResponse, testedConfig) => {
    onChange({
      ...(testedConfig || latestConfigRef.current),
      testResponse: {
        ...testResponse,
        testedAt: new Date().toISOString(),
      },
    });
  };

  // Get q parameter information for info popover
  const getQParameterInfo = (entityId) => {
    switch (entityId) {
      case "contacts":
        return {
          description:
            "General text search query. Searches across text fields using case-insensitive pattern matching. Note: Does NOT search phone numbers - use the 'phone' parameter instead.",
          searches: [
            "first_name",
            "last_name",
            "display_name",
            "company_name",
            "notes",
          ],
          examples: ["John", "Acme Corp", "Customer Service"],
          note: "To search by phone number, use the 'phone' parameter instead of 'q'.",
        };
      case "kb_articles":
        return {
          description:
            "General text search query. Searches across article content and metadata.",
          searches: ["title", "summary", "content", "category"],
          examples: ["installation", "getting started", "troubleshooting"],
        };
      case "tasks":
        return {
          description:
            "General text search query. Searches across task title, description, and caller name.",
          searches: ["title", "description", "caller_name"],
          examples: ["complaint", "John Doe", "urgent issue"],
          note: "Does NOT search phone numbers. Use 'contact_id' to find tasks linked to a contact.",
        };
      default:
        return null;
    }
  };

  // Get phone parameter information for info popover (contacts only)
  const getPhoneParameterInfo = (entityId) => {
    if (entityId === "contacts") {
      return {
        description:
          "Search for phone numbers. Searches across all phone number fields using case-insensitive pattern matching.",
        searches: [
          "phone",
          "mobile",
          "business_phone_1",
          "business_phone_2",
          "home_phone_1",
          "home_phone_2",
        ],
        examples: ["+1234567890", "123456789", "555-1234"],
        note: "Use this parameter instead of 'q' when searching specifically by phone number. Supports partial matches.",
      };
    }
    return null;
  };

  // Get schema and fields for current data source and action
  const entitySchema = useMemo(() => {
    if (!dataSource) return {};
    return getEntitySchema(dataSource);
  }, [dataSource]);

  const actionFields = useMemo(() => {
    if (!dataSource || !action) {
      return {};
    }
    try {
      const fields = getFieldsForAction(dataSource, action);
      return fields;
    } catch (error) {
      return {};
    }
  }, [dataSource, action]);

  const handleChange = (field, value) => {
    const newConfig = {
      ...config,
      [field]: value,
    };
    onChange(newConfig);
  };

  const handleFieldChange = (fieldName, value) => {
    const newFields = {
      ...fields,
      [fieldName]: value,
    };
    // Remove empty values
    if (!value || value === "") {
      delete newFields[fieldName];
    }
    handleChange("fields", newFields);
  };

  const handleQueryParamChange = (paramName, value) => {
    const newQueryParams = {
      ...queryParams,
      [paramName]: value,
    };
    // Remove empty values
    if (!value || value === "") {
      delete newQueryParams[paramName];
    }
    handleChange("queryParams", newQueryParams);
  };

  // Render field input based on field type
  const renderFieldInput = (fieldName, fieldDef) => {
    const fieldValue = fields[fieldName] || "";

    if (fieldDef.type === "enum" && fieldDef.enum) {
      // Enum field - use Select dropdown
      return (
        <Select
          value={fieldValue || ""}
          onValueChange={(value) => handleFieldChange(fieldName, value)}
        >
          <SelectTrigger className="mt-1">
            <SelectValue placeholder={`Select ${fieldName}`} />
          </SelectTrigger>
          <SelectContent>
            {fieldDef.enum.map((enumValue) => (
              <SelectItem key={enumValue} value={enumValue}>
                {enumValue}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    } else if (fieldDef.type === "array") {
      // Array field - use text input with comma-separated values
      return (
        <VariableInput
          value={Array.isArray(fieldValue) ? fieldValue.join(", ") : fieldValue}
          onChange={(value) => {
            // Convert comma-separated string to array, or keep as variable reference
            if (typeof value === "string" && !value.includes("{{")) {
              const arrayValue = value
                .split(",")
                .map((item) => item.trim())
                .filter((item) => item !== "");
              handleFieldChange(
                fieldName,
                arrayValue.length > 0 ? arrayValue : "",
              );
            } else {
              handleFieldChange(fieldName, value);
            }
          }}
          availableVariables={availableVariables}
          placeholder='e.g., "tag1, tag2" or {{tags}}'
          className="mt-1"
        />
      );
    } else if (fieldDef.type === "object") {
      // JSONB/object field - use textarea for JSON input
      return (
        <VariableTextarea
          value={
            typeof fieldValue === "object"
              ? JSON.stringify(fieldValue, null, 2)
              : fieldValue || ""
          }
          onChange={(value) => {
            // Try to parse as JSON, otherwise store as string
            try {
              if (value && !value.includes("{{")) {
                const parsed = JSON.parse(value);
                handleFieldChange(fieldName, parsed);
              } else {
                handleFieldChange(fieldName, value);
              }
            } catch {
              handleFieldChange(fieldName, value);
            }
          }}
          availableVariables={availableVariables}
          placeholder='{"key": "value"} or {{metadata}}'
          rows={4}
          className="mt-1 font-mono text-xs"
        />
      );
    } else {
      // String/number field - use VariableInput
      const isTextarea =
        fieldName === "description" ||
        fieldName === "content" ||
        fieldName === "notes" ||
        fieldName === "summary";
      if (isTextarea) {
        return (
          <VariableTextarea
            value={fieldValue}
            onChange={(value) => handleFieldChange(fieldName, value)}
            availableVariables={availableVariables}
            placeholder={`Enter ${fieldName}`}
            rows={4}
            className="mt-1"
          />
        );
      }
      return (
        <VariableInput
          value={fieldValue}
          onChange={(value) => handleFieldChange(fieldName, value)}
          availableVariables={availableVariables}
          placeholder={`Enter ${fieldName}`}
          className="mt-1"
        />
      );
    }
  };

  return (
    <div className="space-y-4">
      {/* Data Source Selector */}
      <div>
        <Label className="text-xs">
          Data Source <span className="text-red-500">*</span>
        </Label>
        <div className="flex items-center gap-2 mt-1">
          <Select
            value={dataSource || undefined}
            onValueChange={(value) => {
              // Keep the current action - don't clear it
              // Fields will recalculate automatically when dataSource changes
              const newConfig = {
                ...config,
                dataSource: value,
                // Keep action - fields will recalculate based on new dataSource + existing action
                fields: {}, // Clear fields since they're data-source specific
                queryParams: {}, // Clear query params since they're data-source specific
              };
              onChange(newConfig);
            }}
          >
            <SelectTrigger className="flex-1">
              <SelectValue placeholder="Select data source" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="contacts">Contacts</SelectItem>
              <SelectItem value="kb_articles">KB Articles</SelectItem>
              <SelectItem value="tasks">Tasks</SelectItem>
            </SelectContent>
          </Select>
          {dataSource && (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-10 w-10 flex-shrink-0"
              onClick={() => setSchemaSheetOpen(true)}
              title="View API Schema"
            >
              <IconApi className="h-4 w-4" />
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Select the data source to operate on
        </p>
      </div>

      {/* Action Selector */}
      {dataSource && (
        <div>
          <Label className="text-xs">
            Action <span className="text-red-500">*</span>
          </Label>
          <Select
            value={action || undefined}
            onValueChange={(value) => {
              const newConfig = {
                ...config,
                action: value,
                fields: {}, // Clear fields when action changes
                queryParams: {}, // Clear query params when action changes
              };
              onChange(newConfig);
            }}
          >
            <SelectTrigger className="mt-1 w-full">
              <SelectValue placeholder="Select action" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="create">Create</SelectItem>
              <SelectItem value="read">Read (Get Single)</SelectItem>
              <SelectItem value="update">Update</SelectItem>
              <SelectItem value="delete">Delete</SelectItem>
              <SelectItem value="list">List/Search</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground mt-1">
            Select the operation to perform
          </p>
          {!action && (
            <p className="text-xs text-blue-600 dark:text-blue-400 mt-2">
              Please select an action to configure fields
            </p>
          )}
        </div>
      )}

      {/* Record ID for read/update/delete */}
      {(action === "read" || action === "update" || action === "delete") && (
        <div>
          <Label className="text-xs">
            Record ID <span className="text-red-500">*</span>
          </Label>
          <VariableInput
            value={recordId}
            onChange={(value) => handleChange("recordId", value)}
            availableVariables={availableVariables}
            placeholder="Enter record ID or {{variable}}"
            className="mt-1"
          />
          <p className="text-xs text-muted-foreground mt-1">
            ID of the record to {action} (supports variable substitution)
          </p>
        </div>
      )}

      {/* Field inputs for create/update */}
      {(action === "create" || action === "update") && dataSource && action && (
        <div
          key={`${dataSource}-${action}`}
          className="space-y-4 border-t pt-4"
        >
          {Object.keys(actionFields).length > 0 ? (
            <>
              <Label className="text-xs font-semibold">Fields</Label>
              {Object.entries(actionFields).map(([fieldName, fieldDef]) => (
                <div key={fieldName}>
                  <Label className="text-xs">
                    {fieldName.replace(/_/g, " ")}
                    {fieldDef.required && (
                      <span className="text-red-500 ml-1">*</span>
                    )}
                  </Label>
                  {renderFieldInput(fieldName, fieldDef)}
                  {fieldDef.description && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {fieldDef.description}
                    </p>
                  )}
                  {fieldDef.enum && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Allowed values: {fieldDef.enum.join(", ")}
                    </p>
                  )}
                </div>
              ))}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              Loading fields for {action} action...
            </p>
          )}
        </div>
      )}

      {/* Query parameters for list/search */}
      {action === "list" && dataSource && (
        <div className="space-y-4 border-t pt-4">
          {Object.keys(actionFields).length > 0 ? (
            <>
              <Label className="text-xs font-semibold">Query Parameters</Label>
              {Object.entries(actionFields).map(([paramName, paramDef]) => {
                const isQParam = paramName === "q";
                const isPhoneParam = paramName === "phone";
                const qParamInfo = getQParameterInfo(dataSource);
                const phoneParamInfo = getPhoneParameterInfo(dataSource);
                const paramInfo = isQParam
                  ? qParamInfo
                  : isPhoneParam
                    ? phoneParamInfo
                    : null;
                return (
                  <div key={paramName}>
                    <div className="flex items-center gap-2">
                      <Label className="text-xs">
                        {paramName.replace(/_/g, " ")}
                        {paramDef.required && (
                          <span className="text-red-500 ml-1">*</span>
                        )}
                      </Label>
                      {paramInfo && (
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-4 w-4 p-0"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <IconInfoCircle className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent
                            className="w-80 p-3"
                            side="right"
                            align="start"
                          >
                            <div className="space-y-2">
                              <div className="font-semibold text-sm">
                                {isQParam
                                  ? "Search Query (q)"
                                  : isPhoneParam
                                    ? "Phone Search (phone)"
                                    : paramName}
                              </div>
                              <p className="text-xs text-muted-foreground">
                                {paramInfo.description}
                              </p>
                              {paramInfo.searches && (
                                <div>
                                  <div className="text-xs font-medium mb-1">
                                    Searches in fields:
                                  </div>
                                  <div className="flex flex-wrap gap-1">
                                    {paramInfo.searches.map((field) => (
                                      <span
                                        key={field}
                                        className="text-xs bg-muted px-1.5 py-0.5 rounded"
                                      >
                                        {field}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {paramInfo.examples && (
                                <div>
                                  <div className="text-xs font-medium mb-1">
                                    Examples:
                                  </div>
                                  <div className="space-y-1">
                                    {paramInfo.examples.map((example, idx) => (
                                      <code
                                        key={idx}
                                        className="text-xs bg-muted px-2 py-1 rounded block"
                                      >
                                        {example}
                                      </code>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {paramInfo.note && (
                                <div className="text-xs text-blue-600 dark:text-blue-400 pt-1 border-t">
                                  <strong>Note:</strong> {paramInfo.note}
                                </div>
                              )}
                            </div>
                          </PopoverContent>
                        </Popover>
                      )}
                    </div>
                    <VariableInput
                      value={queryParams[paramName] || ""}
                      onChange={(value) =>
                        handleQueryParamChange(paramName, value)
                      }
                      availableVariables={availableVariables}
                      placeholder={`Enter ${paramName}`}
                      className="mt-1"
                    />
                    {paramDef.description && (
                      <p className="text-xs text-muted-foreground mt-1">
                        {paramDef.description}
                      </p>
                    )}
                  </div>
                );
              })}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              Loading query parameters...
            </p>
          )}
        </div>
      )}

      {/* Response Variable */}
      <div className="border-t pt-4">
        <Label className="text-xs">Response Variable Name</Label>
        <Input
          value={responseVariable}
          onChange={(e) => handleChange("responseVariable", e.target.value)}
          placeholder="data_response"
          className={`mt-1 ${
            responseVariable &&
            checkDuplicateVariableName(
              responseVariable,
              { nodes, edges, globalVariables },
              { type: "data_action", id: selectedNodeId },
            ).isDuplicate
              ? "border-yellow-500"
              : ""
          }`}
        />
        {responseVariable &&
          checkDuplicateVariableName(
            responseVariable,
            { nodes, edges, globalVariables },
            { type: "data_action", id: selectedNodeId },
          ).isDuplicate && (
            <p className="text-xs text-yellow-600 dark:text-yellow-500 mt-1 flex items-center gap-1">
              <IconAlertCircle className="h-3 w-3" />
              {
                checkDuplicateVariableName(
                  responseVariable,
                  { nodes, edges, globalVariables },
                  { type: "data_action", id: selectedNodeId },
                ).message
              }
            </p>
          )}
        {!checkDuplicateVariableName(
          responseVariable || "data_response",
          { nodes, edges, globalVariables },
          { type: "data_action", id: selectedNodeId },
        ).isDuplicate && (
          <p className="text-xs text-muted-foreground mt-1">
            Variable name to store the API response data
          </p>
        )}
      </div>

      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={() => setTestSheetOpen(true)}
        disabled={!dataSource || !action}
      >
        <IconFlask className="h-4 w-4 mr-2" />
        Test Data Action
      </Button>

      {/* API Schema Sheet */}
      {dataSource && (
        <ApiSchemaSheet
          entityId={dataSource}
          basePath={getEntityBasePath(dataSource)}
          dbTable={getEntityTableName(dataSource)}
          open={schemaSheetOpen}
          onOpenChange={setSchemaSheetOpen}
        />
      )}

      <DataActionTestSheet
        open={testSheetOpen}
        onOpenChange={setTestSheetOpen}
        config={latestConfigRef.current}
        onTestSuccess={handleTestSuccess}
      />
    </div>
  );
}
