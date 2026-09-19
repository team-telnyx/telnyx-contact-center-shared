"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  IconDeviceDesktopCog,
  IconInfoCircle,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import {
  CLIENT_SIDE_PARAMETER_TYPES,
  DEFAULT_CLIENT_SIDE_PARAMETERS,
  clientSideParametersSupportVisualMode,
  clientSideParametersToRows,
  clientSideRowsToParameters,
  validateClientSideParameterRows,
} from "@/lib/ai/client-side-tool-parameters";

function formatSchema(schema) {
  return JSON.stringify(schema || DEFAULT_CLIENT_SIDE_PARAMETERS, null, 2);
}

function withRowIds(rows) {
  return rows.map((row, index) => ({
    ...row,
    id: row.id || `client-side-parameter-${index}`,
  }));
}

function validateParameters(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "Parameters must be valid JSON." };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "Parameters must be a JSON object." };
  }
  if (parsed.type !== "object") {
    return { error: 'Parameters must include "type": "object".' };
  }
  if (
    !parsed.properties ||
    typeof parsed.properties !== "object" ||
    Array.isArray(parsed.properties)
  ) {
    return { error: 'Parameters must include a "properties" object.' };
  }
  if (!Array.isArray(parsed.required)) {
    return { error: 'Parameters must include a "required" array.' };
  }

  return { parsed };
}

export default function ClientSideToolEditor({
  value,
  onChange,
  onValidationChange,
}) {
  const config = value?.client_side_tool || {};
  const parameters = useMemo(
    () => config.parameters || DEFAULT_CLIENT_SIDE_PARAMETERS,
    [config.parameters]
  );
  const [parametersText, setParametersText] = useState(() =>
    formatSchema(parameters)
  );
  const [parametersError, setParametersError] = useState("");
  const [modeNotice, setModeNotice] = useState("");

  const [visualRows, setVisualRows] = useState(() =>
    withRowIds(clientSideParametersToRows(parameters))
  );
  const [visualRowsError, setVisualRowsError] = useState("");
  const [advancedMode, setAdvancedMode] = useState(
    () => !clientSideParametersSupportVisualMode(parameters)
  );
  const lastParametersRef = useRef(JSON.stringify(parameters));

  useEffect(() => {
    const serializedParameters = JSON.stringify(parameters);
    if (serializedParameters === lastParametersRef.current) return;
    lastParametersRef.current = serializedParameters;

    // Refresh the draft when an existing tool is replaced by another selection.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setParametersText(formatSchema(parameters));
    setParametersError("");
    setModeNotice("");
    setVisualRowsError("");

    if (clientSideParametersSupportVisualMode(parameters)) {
      setVisualRows(withRowIds(clientSideParametersToRows(parameters)));
    } else {
      setAdvancedMode(true);
    }
  }, [parameters]);

  useEffect(() => {
    onValidationChange?.(parametersError || visualRowsError);
  }, [onValidationChange, parametersError, visualRowsError]);

  function updateConfig(partial) {
    const nextConfig = { ...config, ...partial };
    const previousName = String(config.name || "");
    const nextName = String(nextConfig.name || "");
    const shouldSyncDisplayName =
      !value?.display_name || value.display_name === previousName;

    onChange?.({
      ...(value || { type: "client_side_tool" }),
      type: "client_side_tool",
      ...(shouldSyncDisplayName ? { display_name: nextName } : {}),
      client_side_tool: nextConfig,
    });
  }

  function commitParameters(nextParameters) {
    const serializedParameters = JSON.stringify(nextParameters);
    lastParametersRef.current = serializedParameters;
    setParametersText(formatSchema(nextParameters));
    setParametersError("");
    updateConfig({ parameters: nextParameters });
  }

  function updateParametersText(nextText) {
    setParametersText(nextText);
    setModeNotice("");
    const result = validateParameters(nextText);
    if (result.error) {
      setParametersError(result.error);
      return;
    }
    setParametersError("");
    lastParametersRef.current = JSON.stringify(result.parsed);
    updateConfig({ parameters: result.parsed });
  }

  function commitVisualRows(nextRows) {
    setVisualRows(nextRows);
    const validationError = validateClientSideParameterRows(nextRows);
    setVisualRowsError(validationError);
    if (validationError) return;

    commitParameters(clientSideRowsToParameters(nextRows, parameters));
  }

  function updateVisualRow(index, partial) {
    commitVisualRows(
      visualRows.map((row, rowIndex) =>
        rowIndex === index ? { ...row, ...partial } : row
      )
    );
  }

  function addVisualRow() {
    commitVisualRows([
      ...visualRows,
      {
        id: `client-side-parameter-${crypto.randomUUID()}`,
        name: "",
        type: "string",
        required: true,
        description: "",
        enumValues: "",
      },
    ]);
  }

  function removeVisualRow(index) {
    commitVisualRows(
      visualRows.filter((_, rowIndex) => rowIndex !== index)
    );
  }

  function handleAdvancedModeChange(checked) {
    const nextAdvancedMode = checked === true;
    if (nextAdvancedMode) {
      setAdvancedMode(true);
      setParametersText(formatSchema(parameters));
      setParametersError("");
      setModeNotice("");
      setVisualRowsError("");
      return;
    }

    const result = validateParameters(parametersText);
    if (result.error) {
      setParametersError(result.error);
      return;
    }
    if (!clientSideParametersSupportVisualMode(result.parsed)) {
      setModeNotice(
        "This JSON Schema uses nested objects, unsupported arrays, or advanced property options. Keep Advanced mode enabled to edit it without losing data."
      );
      return;
    }

    setVisualRows(withRowIds(clientSideParametersToRows(result.parsed)));
    setVisualRowsError("");
    setParametersError("");
    setModeNotice("");
    setAdvancedMode(false);
  }

  const name = String(config.name || "");
  const nameError =
    name && !/^[A-Za-z0-9_-]+$/.test(name)
      ? "Use only letters, numbers, underscores, and hyphens."
      : "";

  return (
    <div className="space-y-5">
      <Alert variant="info">
        <IconDeviceDesktopCog className="size-4" />
        <AlertDescription>
          This function runs in the connected Voice SDK client (browser or
          mobile), not on a server. It is available to WebRTC voice and chat
          clients; SIP and PSTN calls cannot execute it.
        </AlertDescription>
      </Alert>

      <div className="space-y-2">
        <Label htmlFor="client-side-tool-name">Name</Label>
        <Input
          id="client-side-tool-name"
          value={name}
          onChange={(event) => updateConfig({ name: event.target.value })}
          placeholder="show_order_details"
          aria-invalid={Boolean(nameError)}
        />
        {nameError ? (
          <p className="text-xs text-destructive">{nameError}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            The function name registered by the Voice SDK client.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="client-side-tool-description">Description</Label>
        <Textarea
          id="client-side-tool-description"
          value={config.description || ""}
          onChange={(event) =>
            updateConfig({ description: event.target.value })
          }
          placeholder="Show the selected order in the customer's browser."
          rows={3}
        />
        <p className="text-xs text-muted-foreground">
          Tell the assistant when it should invoke this client-side function.
        </p>
      </div>

      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Checkbox
            id="client-side-tool-advanced-mode"
            checked={advancedMode}
            onCheckedChange={handleAdvancedModeChange}
          />
          <Label
            htmlFor="client-side-tool-advanced-mode"
            className="cursor-pointer font-normal"
          >
            Advanced mode
          </Label>
        </div>

        {advancedMode ? (
          <div className="space-y-2">
            <Label
              htmlFor="client-side-tool-parameters"
              className="inline-flex items-center gap-1.5"
            >
              Parameters (JSON Schema)
              <IconInfoCircle className="size-4 text-muted-foreground" />
            </Label>
            <Textarea
              id="client-side-tool-parameters"
              value={parametersText}
              onChange={(event) => updateParametersText(event.target.value)}
              rows={14}
              spellCheck={false}
              className="font-mono text-xs"
              aria-invalid={Boolean(parametersError)}
            />
            {parametersError ? (
              <p className="text-xs text-destructive">{parametersError}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                The root schema must define <code>type</code>,{" "}
                <code>properties</code>, and <code>required</code>.
              </p>
            )}
            {modeNotice ? (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {modeNotice}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-4">
            {visualRows.length === 0 ? (
              <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                No parameters have been added yet.
              </p>
            ) : null}

            {visualRows.map((row, index) => (
              <div
                key={row.id}
                className="space-y-3 rounded-lg border p-4"
              >
                <div className="grid grid-cols-1 gap-3 md:grid-cols-12 md:items-end">
                  <div className="space-y-2 md:col-span-4">
                    <Label htmlFor={`${row.id}-name`}>Name</Label>
                    <Input
                      id={`${row.id}-name`}
                      value={row.name}
                      onChange={(event) =>
                        updateVisualRow(index, { name: event.target.value })
                      }
                      aria-invalid={
                        Boolean(visualRowsError) && !row.name.trim()
                      }
                    />
                  </div>

                  <div className="space-y-2 md:col-span-4">
                    <Label htmlFor={`${row.id}-type`}>Type</Label>
                    <Select
                      value={row.type}
                      onValueChange={(type) =>
                        updateVisualRow(index, { type })
                      }
                    >
                      <SelectTrigger id={`${row.id}-type`} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CLIENT_SIDE_PARAMETER_TYPES.map((option) => (
                          <SelectItem
                            key={option.value}
                            value={option.value}
                          >
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2 md:col-span-3">
                    <Label htmlFor={`${row.id}-required`}>Required</Label>
                    <div className="flex h-9 items-center">
                      <Checkbox
                        id={`${row.id}-required`}
                        checked={row.required}
                        onCheckedChange={(required) =>
                          updateVisualRow(index, {
                            required: required === true,
                          })
                        }
                      />
                    </div>
                  </div>

                  <div className="flex md:col-span-1 md:justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove parameter ${index + 1}`}
                      onClick={() => removeVisualRow(index)}
                    >
                      <IconTrash className="size-4" />
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label
                    htmlFor={`${row.id}-description`}
                    className="inline-flex items-center gap-1.5"
                  >
                    Description
                    <IconInfoCircle className="size-4 text-muted-foreground" />
                  </Label>
                  <Input
                    id={`${row.id}-description`}
                    value={row.description}
                    onChange={(event) =>
                      updateVisualRow(index, {
                        description: event.target.value,
                      })
                    }
                  />
                </div>

                {row.type === "enum" ? (
                  <div className="space-y-2">
                    <Label htmlFor={`${row.id}-enum-values`}>
                      Enum values (comma separated)
                    </Label>
                    <Input
                      id={`${row.id}-enum-values`}
                      value={row.enumValues}
                      placeholder="pending, shipped, delivered"
                      onChange={(event) =>
                        updateVisualRow(index, {
                          enumValues: event.target.value,
                        })
                      }
                    />
                  </div>
                ) : null}
              </div>
            ))}

            {visualRowsError ? (
              <p className="text-xs text-destructive">{visualRowsError}</p>
            ) : null}

            <div className="flex justify-end">
              <Button type="button" variant="outline" onClick={addVisualRow}>
                <IconPlus className="size-4" />
                Add parameter
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="client-side-tool-timeout">Timeout (ms)</Label>
        <Input
          id="client-side-tool-timeout"
          type="number"
          min={1}
          step={100}
          value={value?.timeout_ms ?? 5000}
          onChange={(event) =>
            onChange?.({
              ...(value || { type: "client_side_tool" }),
              type: "client_side_tool",
              timeout_ms: Math.max(1, Number(event.target.value || 1)),
            })
          }
        />
        <p className="text-xs text-muted-foreground">
          Maximum time Telnyx waits for the client to return a result.
        </p>
      </div>
    </div>
  );
}
