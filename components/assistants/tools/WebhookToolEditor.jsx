"use client";
import { useUiText } from "@/components/i18n/use-ui-text";


import { useMemo, useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { VariableInput } from "@/components/voice-flow/VariableInput";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { IconTrash, IconFlask, IconInfoCircle } from "@tabler/icons-react";
import SecretSelector from "@/components/assistants/SecretSelector";
import WebhookTestSheet from "./WebhookTestSheet";

export default function WebhookToolEditor({
  value,
  onChange,
  assistantId,
  toolId,
  availableVariables = [],
}) {
  const tUi = useUiText();
  const wh = value?.webhook || {};
  const headers = Array.isArray(wh.headers) ? wh.headers : [];
  const body = wh.body_parameters || {};
  const path = wh.path_parameters || {};
  const query = wh.query_parameters || {};
  const dynamicVariableAssignments = Array.isArray(
    wh.store_fields_as_variables
  )
    ? wh.store_fields_as_variables
    : [];
  const fillerMessages = Array.isArray(wh.messages)
    ? wh.messages
    : [];
  const isAsync = (value?.async ?? wh.async) === true;
  const [testSheetOpen, setTestSheetOpen] = useState(false);

  // Check if testing is enabled (both assistantId and toolId must be present)
  const canTest = assistantId && toolId;

  // Extract path parameters from URL (ignore {{dynamic_variables}})
  const pathParams = useMemo(() => {
    const url = wh.url || "";
    // Match {param} but not {{dynamic_variable}}
    const matches = url.match(/\{(?!\{)([^}]+)\}/g);
    if (!matches) return [];
    return matches.map((m) => m.slice(1, -1)); // Remove { and }
  }, [wh.url]);

  // Auto-sync path parameters when URL changes
  useEffect(() => {
    const currentProps = path?.properties || {};
    const currentKeys = Object.keys(currentProps);
    const paramsSet = new Set(pathParams);

    // Check if we need to update
    const needsUpdate =
      pathParams.length !== currentKeys.length ||
      pathParams.some((p) => !currentProps[p]) ||
      currentKeys.some((k) => !paramsSet.has(k));

    if (needsUpdate) {
      const nextProps = {};
      pathParams.forEach((param) => {
        // Preserve existing param config if it exists
        nextProps[param] = currentProps[param] || {
          type: "string",
          description: "",
        };
      });

      const required = pathParams; // All path params are required
      update({
        path_parameters: {
          type: "object",
          properties: nextProps,
          required,
        },
      });
    }
  }, [pathParams, wh.url]);

  function update(partial) {
    const next = {
      ...(value || { type: "webhook" }),
      webhook: { ...(value?.webhook || {}), ...partial },
    };
    onChange?.(next);
  }

  function addEmptyField(existing) {
    const schema = existing || {};
    const props = schema.properties || {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    const base = "field";
    let name = base;
    let i = 1;
    while (props[name]) name = `${base}_${i++}`;
    const nextProps = { ...props, [name]: { type: "string", description: "" } };
    return { type: "object", properties: nextProps, required };
  }

  return (
    <div className="h-full flex flex-col gap-4">
      {/* Async toggle */}
      <div className="flex items-center gap-2">
        <Switch
          id="webhook-async"
          checked={isAsync}
          onCheckedChange={(checked) =>
            onChange?.({ ...value, async: undefined, webhook: { ...wh, async: checked } })
          }
        />
        <label htmlFor="webhook-async" className="text-sm font-medium cursor-pointer">{tUi("Async (Fire & Forget)")}</label>
      </div>
      <p className="text-xs text-muted-foreground -mt-2">{tUi("Call this webhook asynchronously — the assistant won't wait for the response.")}</p>

      {/* Static top section */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="text-xs">{tUi("Name")}</label>
          <Input
            value={wh.name || ""}
            onChange={(e) => update({ name: e.target.value })}
          />
        </div>
        <div className="md:col-span-2">
          <label className="text-xs">{tUi("Description")}</label>
          <VariableInput
            value={wh.description || ""}
            availableVariables={availableVariables}
            secrets={[]}
            onChange={(next) => update({ description: next })}
          />
        </div>
        <div className="md:col-span-2">
          <label className="text-xs">{tUi("URL")}</label>
          <VariableInput
            value={wh.url || ""}
            availableVariables={availableVariables}
            secrets={[]}
            onChange={(next) => update({ url: next })}
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:col-span-2">
          <div>
            <label className="text-xs">{tUi("Method")}</label>
            <Select
              value={wh.method || "POST"}
              onValueChange={(val) => update({ method: val })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {"GET POST PUT DELETE PATCH".split(" ").map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {!isAsync && (
            <div>
              <label className="text-xs">{tUi("Timeout (seconds)")}</label>
              <Input
                type="number"
                min={0.001}
                max={60}
                step={0.001}
                value={(value?.timeout_ms ?? wh.timeout_ms ?? (wh.timeout_secs * 1000 || 5000)) / 1000}
                onChange={(e) =>
                  onChange?.({ ...value, timeout_ms: Math.round(Number(e.target.value) * 1000), webhook: { ...wh, timeout_secs: undefined, timeout_ms: undefined } })
                }
              />
            </div>
          )}

        </div>
      </div>

      {/* Tabs with scrollable content */}
      <Tabs defaultValue="headers" className="flex-1 flex flex-col min-h-0">
        <TabsList>
          <TabsTrigger value="headers">{tUi("Headers")}</TabsTrigger>
          <TabsTrigger value="path">{tUi("Path")}</TabsTrigger>
          <TabsTrigger value="query">{tUi("Query")}</TabsTrigger>
          <TabsTrigger value="body">{tUi("Body")}</TabsTrigger>
          <TabsTrigger value="dynamic_variables">{tUi("Dynamic Variables")}</TabsTrigger>
          {!isAsync && (
            <TabsTrigger value="filler_messages" className="relative">{tUi("Filler Messages")}{fillerMessages.length > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center min-w-4 h-4 px-1 text-[10px] font-medium rounded-full bg-destructive text-destructive-foreground">
                  {fillerMessages.length}
                </span>
              )}
            </TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="headers" className="flex-1 min-h-0">
          <ScrollArea className="h-full pr-2">
            <SectionLabel>{tUi("Headers")}</SectionLabel>
            <div className="space-y-2">
              {headers.map((h, i) => (
                <div
                  key={i}
                  className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center"
                >
                  <Input
                    className="md:col-span-4"
                    placeholder={tUi("Header name")}
                    value={h?.name || ""}
                    onChange={(e) => {
                      const next = headers.map((x, idx) =>
                        idx === i ? { ...x, name: e.target.value } : x
                      );
                      update({ headers: next });
                    }}
                  />
                  <div className="md:col-span-6">
                    <VariableInput
                      placeholder={tUi("Header value")}
                      value={h?.value || ""}
                      availableVariables={availableVariables}
                      secrets={[]}
                      onChange={(nextValue) => {
                        const next = headers.map((x, idx) =>
                          idx === i ? { ...x, value: nextValue } : x
                        );
                        update({ headers: next });
                      }}
                    />
                  </div>
                  <div className="md:col-span-1 flex justify-center">
                    <SecretSelector
                      onSelect={(template) => {
                        const next = headers.map((x, idx) =>
                          idx === i ? { ...x, value: template } : x
                        );
                        update({ headers: next });
                      }}
                    />
                  </div>
                  <div className="md:col-span-1 flex justify-end">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() =>
                        update({
                          headers: headers.filter((_, idx) => idx !== i),
                        })
                      }
                      aria-label={tUi("Remove")}
                    >
                      <IconTrash />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-end mt-2 mb-4">
              <Button
                type="button"
                onClick={() =>
                  update({ headers: [...headers, { name: "", value: "" }] })
                }
              >{tUi("Add")}</Button>
            </div>
          </ScrollArea>
        </TabsContent>
        <TabsContent value="path" className="flex-1 min-h-0">
          <ScrollArea className="h-full pr-2">
            <div className="space-y-2">
              {pathParams.length === 0 ? (
                <div className="text-xs text-muted-foreground p-4 border rounded bg-muted/50">
                  <p className="mb-2">{tUi("No parameters have been added yet, path parameters are inferred from the URL path, use this syntax:")}{" "}
                    <code className="bg-background px-1 py-0.5 rounded">
                      /path/&#123;path_param1&#125;/&#123;path_param2&#125;
                    </code>
                  </p>
                  <p>{tUi("You can also use dynamic variables in paths:")}{" "}
                    <code className="bg-background px-1 py-0.5 rounded">
                      /path/&#123;&#123;dynamic_variable&#125;&#125;/&#123;path_param&#125;
                    </code>
                  </p>
                </div>
              ) : (
                <SchemaEditor
                  title={tUi("Path Parameters")}
                  value={path}
                  onChange={(val) => update({ path_parameters: val })}
                  readOnly={true}
                  availableTypes={[
                    "string",
                    "enum",
                    "number",
                    "integer",
                    "boolean",
                  ]}
                  availableVariables={availableVariables}
                />
              )}
            </div>
          </ScrollArea>
        </TabsContent>
        <TabsContent value="query" className="flex-1 min-h-0">
          <ScrollArea className="h-full pr-2">
            <div className="space-y-2">
              <SchemaEditor
                title={tUi("Query Parameters")}
                value={query}
                onChange={(val) => update({ query_parameters: val })}
                availableTypes={[
                  "string",
                  "enum",
                  "number",
                  "integer",
                  "boolean",
                  "array",
                  "array (string)",
                  "array (number)",
                  "array (boolean)",
                ]}
                availableVariables={availableVariables}
              />
              <div className="flex justify-end">
                <Button
                  type="button"
                  onClick={() =>
                    update({ query_parameters: addEmptyField(query) })
                  }
                >{tUi("Add")}</Button>
              </div>
            </div>
          </ScrollArea>
        </TabsContent>
        <TabsContent value="body" className="flex-1 min-h-0">
          <ScrollArea className="h-full pr-2">
            <div className="space-y-2">
              <SchemaEditor
                title={tUi("Body Parameters")}
                value={body}
                onChange={(val) => update({ body_parameters: val })}
                availableTypes={[
                  "string",
                  "enum",
                  "number",
                  "integer",
                  "boolean",
                  "array",
                  "array (string)",
                  "array (number)",
                  "array (boolean)",
                ]}
                availableVariables={availableVariables}
              />
              <div className="flex justify-end">
                <Button
                  type="button"
                  onClick={() =>
                    update({ body_parameters: addEmptyField(body) })
                  }
                >{tUi("Add")}</Button>
              </div>
            </div>
          </ScrollArea>
        </TabsContent>
        <TabsContent value="dynamic_variables" className="flex-1 min-h-0">
          <ScrollArea className="h-full pr-2">
            <div className="space-y-3">
              <SectionLabel>{tUi("Dynamic Variables")}</SectionLabel>
              <p className="text-xs text-muted-foreground">{tUi("Configure which dynamic variables should be updated from this webhook response.")}</p>
              {dynamicVariableAssignments.map((assignment, i) => (
                <div
                  key={i}
                  className="grid grid-cols-1 md:grid-cols-12 gap-2 items-end border-b pb-3"
                >
                  <div className="md:col-span-4">
                    <label className="text-xs">{tUi("Dynamic Variable")}</label>
                    <Input
                      value={assignment?.name || ""}
                      placeholder={tUi("customer_name")}
                      onChange={(e) => {
                        const next = dynamicVariableAssignments.map((x, idx) =>
                          idx === i ? { ...x, name: e.target.value } : x
                        );
                        update({ store_fields_as_variables: next });
                      }}
                    />
                  </div>
                  <div className="md:col-span-7">
                    <label className="text-xs">{tUi("Response Path")}</label>
                    <Input
                      value={assignment?.value_path || ""}
                      placeholder={tUi("data.customer.name")}
                      onChange={(e) => {
                        const next = dynamicVariableAssignments.map((x, idx) =>
                          idx === i ? { ...x, value_path: e.target.value } : x
                        );
                        update({ store_fields_as_variables: next });
                      }}
                    />
                  </div>
                  <div className="md:col-span-1 flex justify-end">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() =>
                        update({
                          store_fields_as_variables:
                            dynamicVariableAssignments.filter(
                              (_, idx) => idx !== i
                            ),
                        })
                      }
                      aria-label={tUi("Remove dynamic variable assignment")}
                    >
                      <IconTrash />
                    </Button>
                  </div>
                </div>
              ))}
              {dynamicVariableAssignments.length === 0 && (
                <div className="text-xs text-muted-foreground p-4 border rounded bg-muted/50">{tUi("No dynamic variable assignments configured.")}</div>
              )}
              <div className="flex justify-end">
                <Button
                  type="button"
                  onClick={() =>
                    update({
                      store_fields_as_variables: [
                        ...dynamicVariableAssignments,
                        { name: "", value_path: "" },
                      ],
                    })
                  }
                >{tUi("Add dynamic variable assignment")}</Button>
              </div>
            </div>
          </ScrollArea>
        </TabsContent>
        {!isAsync && (
          <TabsContent value="filler_messages" className="flex-1 min-h-0">
            <ScrollArea className="h-full pr-2">
              <div className="space-y-3">
                <SectionLabel>{tUi("Filler Messages")}</SectionLabel>
                <p className="text-xs text-muted-foreground">{tUi("Sentences the assistant speaks while a synchronous webhook is running, so the caller isn't left in silence.")}</p>
                {fillerMessages.map((fm, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-1 md:grid-cols-12 gap-2 items-end border-b pb-3"
                  >
                    <div className="md:col-span-4">
                      <label className="text-xs">{tUi("When")}</label>
                      <Select
                        value={fm?.type || "request_start"}
                        onValueChange={(val) => {
                          const next = fillerMessages.map((x, idx) =>
                            idx === i ? { ...x, type: val, ...(val === "request_response_delayed" ? { timing_ms: x.timing_ms ?? 3000 } : {}) } : x
                          );
                          update({ messages: next });
                        }}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="request_start">{tUi("When the request starts")}</SelectItem>
                          <SelectItem value="request_response_delayed">{tUi("If the response is delayed")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="md:col-span-5">
                      <label className="text-xs">{tUi("Message")}</label>
                      <Input
                        value={fm?.content || ""}
                        placeholder={tUi("e.g. Let me check that for you...")}
                        onChange={(e) => {
                          const next = fillerMessages.map((x, idx) =>
                            idx === i ? { ...x, content: e.target.value } : x
                          );
                          update({ messages: next });
                        }}
                      />
                    </div>
                    {fm?.type === "request_response_delayed" ? (
                      <div className="md:col-span-2">
                        <label className="text-xs flex items-center gap-1">{tUi("Delay (ms)")}<span className="relative group cursor-help">
                            <IconInfoCircle size={12} className="text-muted-foreground" />
                            <span className="absolute bottom-full right-0 mb-2 w-48 p-2 rounded bg-popover text-popover-foreground text-xs shadow-lg border opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">{tUi("How long to wait (in milliseconds, 100–120000) before speaking this message. Only used for delayed messages.")}</span>
                          </span>
                        </label>
                        <Input
                          type="number"
                          min={100}
                          max={120000}
                          value={fm?.timing_ms ?? 3000}
                          onChange={(e) => {
                            const next = fillerMessages.map((x, idx) =>
                              idx === i
                                ? { ...x, timing_ms: Number(e.target.value) }
                                : x
                            );
                            update({ messages: next });
                          }}
                        />
                      </div>
                    ) : null}
                    <div className="md:col-span-1 flex justify-end">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() =>
                          update({
                            messages: fillerMessages.filter(
                              (_, idx) => idx !== i
                            ),
                          })
                        }
                        aria-label={tUi("Remove filler message")}
                      >
                        <IconTrash />
                      </Button>
                    </div>
                  </div>
                ))}
                {fillerMessages.length === 0 && (
                  <div className="text-xs text-muted-foreground p-4 border rounded bg-muted/50">{tUi("No filler messages configured. The caller will be in silence while the webhook runs.")}</div>
                )}
                <div className="flex justify-end">
                  <Button
                    type="button"
                    onClick={() =>
                      update({
                        messages: [
                          ...fillerMessages,
                          { type: "request_start", content: "" },
                        ],
                      })
                    }
                  >{tUi("+ Add filler message")}</Button>
                </div>
              </div>
            </ScrollArea>
          </TabsContent>
        )}
      </Tabs>

      {/* Test Sheet */}
      <WebhookTestSheet
        open={testSheetOpen}
        onOpenChange={setTestSheetOpen}
        webhookConfig={wh}
        assistantId={assistantId}
        toolId={toolId}
      />
    </div>
  );
}

function SectionLabel({ children }) {
  return <div className="text-xs font-medium mt-4">{children}</div>;
}

function PropertyField({
  propKey,
  definition,
  required,
  readOnly,
  availableTypes,
  availableVariables = [],
  onNameChange,
  onTypeChange,
  onDescriptionChange,
  onEnumChange,
  onRequiredChange,
  onRemove,
}) {
  const tUi = useUiText();
  const [localName, setLocalName] = useState(propKey);

  // Update local name when prop key changes externally
  useEffect(() => {
    setLocalName(propKey);
  }, [propKey]);

  const handleNameBlur = () => {
    if (localName !== propKey && localName.trim()) {
      onNameChange(propKey, localName.trim());
    } else if (!localName.trim()) {
      // Reset to original if empty
      setLocalName(propKey);
    }
  };

  const handleNameKeyDown = (e) => {
    if (e.key === "Enter") {
      e.target.blur();
    }
  };

  return (
    <div className="border rounded p-2 grid grid-cols-1 md:grid-cols-12 gap-2">
      <div className="md:col-span-12 grid grid-cols-1 md:grid-cols-5 gap-2 items-center">
        <div className="md:col-span-2">
          <label className="text-xs">{tUi("Name")}</label>
          <Input
            value={localName}
            onChange={(e) => setLocalName(e.target.value)}
            onBlur={handleNameBlur}
            onKeyDown={handleNameKeyDown}
            disabled={readOnly}
          />
        </div>
        <div className="md:col-span-2">
          <label className="text-xs">{tUi("Type")}</label>
          <Select
            value={definition.type || "string"}
            onValueChange={(val) => onTypeChange(propKey, val)}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {availableTypes.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="md:col-span-1 flex items-end">
          <div>
            <label className="text-xs">{tUi("Required")}</label>
            <div className="h-[38px] flex items-center">
              <Switch
                checked={required}
                onCheckedChange={(val) => onRequiredChange(propKey, val)}
                disabled={readOnly}
              />
            </div>
          </div>
        </div>
      </div>
      <div className={readOnly ? "md:col-span-12" : "md:col-span-11"}>
        <label className="text-xs">{tUi("Description")}</label>
        <VariableInput
          placeholder={tUi("Description")}
          value={definition.description || ""}
          availableVariables={availableVariables}
          secrets={[]}
          onChange={(next) => onDescriptionChange(propKey, next)}
        />
      </div>
      {!readOnly && (
        <div className="md:col-span-1 flex items-end justify-end">
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => onRemove(propKey)}
            aria-label={tUi("Remove")}
          >
            <IconTrash />
          </Button>
        </div>
      )}
      {definition.type === "enum" && (
        <div className="md:col-span-12">
          <label className="text-xs">{tUi("Enum Values (comma separated)")}</label>
          <VariableInput
            placeholder={tUi("e.g., value1, value2, value3")}
            value={
              Array.isArray(definition.enum) ? definition.enum.join(", ") : ""
            }
            availableVariables={availableVariables}
            secrets={[]}
            onChange={(next) => onEnumChange(propKey, next)}
          />
        </div>
      )}
    </div>
  );
}

function SchemaEditor({
  title,
  value,
  onChange,
  readOnly = false,
  availableTypes = [
    "string",
    "integer",
    "number",
    "boolean",
    "array",
    "object",
  ],
  availableVariables = [],
}) {
  const tUi = useUiText();
  const schema = value || {};
  const properties = schema?.properties || {};
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const keys = useMemo(() => Object.keys(properties), [properties]);

  function setPropName(oldKey, newKey) {
    if (readOnly) return;
    if (!oldKey || oldKey === newKey) return;
    // Don't allow empty keys or overwriting existing keys
    if (
      !newKey ||
      (properties[newKey] && properties[newKey] !== properties[oldKey])
    )
      return;
    const nextProps = { ...properties };
    nextProps[newKey] = properties[oldKey];
    delete nextProps[oldKey];
    onChange({ ...schema, properties: nextProps });
  }

  function setPropType(key, type) {
    const nextProps = {
      ...properties,
      [key]: { ...(properties[key] || {}), type },
    };
    // If switching away from enum, remove the enum array
    if (type !== "enum" && properties[key]?.enum) {
      delete nextProps[key].enum;
    }
    onChange({ ...schema, properties: nextProps });
  }

  function setEnumValues(key, enumString) {
    const enumValues = enumString
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    const nextProps = {
      ...properties,
      [key]: { ...(properties[key] || {}), enum: enumValues },
    };
    onChange({ ...schema, properties: nextProps });
  }

  function setPropDescription(key, description) {
    const nextProps = {
      ...properties,
      [key]: { ...(properties[key] || {}), description },
    };
    onChange({ ...schema, properties: nextProps });
  }

  function setRequired(key, isReq) {
    const set = new Set(required);
    if (isReq) set.add(key);
    else set.delete(key);
    onChange({ ...schema, required: Array.from(set) });
  }

  function addProperty() {
    const base = "field";
    let name = base;
    let i = 1;
    while (properties[name]) {
      name = `${base}_${i++}`;
    }
    const nextProps = {
      ...properties,
      [name]: { type: "string", description: "" },
    };
    onChange({ ...schema, type: "object", properties: nextProps, required });
  }

  function removeProperty(key) {
    if (readOnly) return;
    const nextProps = { ...properties };
    delete nextProps[key];
    const set = new Set(required);
    set.delete(key);
    onChange({ ...schema, properties: nextProps, required: Array.from(set) });
  }

  return (
    <div className="space-y-2">
      <SectionLabel>{title}</SectionLabel>
      {keys.length === 0 ? (
        <div className="text-xs text-muted-foreground">{tUi("No fields defined.")}</div>
      ) : null}
      {keys.map((key, index) => (
        <PropertyField
          key={index}
          propKey={key}
          definition={properties[key] || {}}
          required={required.includes(key)}
          readOnly={readOnly}
          availableTypes={availableTypes}
          availableVariables={availableVariables}
          onNameChange={setPropName}
          onTypeChange={setPropType}
          onDescriptionChange={setPropDescription}
          onEnumChange={setEnumValues}
          onRequiredChange={setRequired}
          onRemove={removeProperty}
        />
      ))}
      {/* Add button moved to each tab panel; no global add here */}
    </div>
  );
}
