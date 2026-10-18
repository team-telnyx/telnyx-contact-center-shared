"use client";
import { createContext, useContext, useId, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  IconPlus,
  IconTrash,
  IconInfoCircle,
  IconArrowUp,
  IconArrowDown,
} from "@tabler/icons-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useUiText } from "@/components/i18n/use-ui-text";
import {
  assistantSchemas,
  resolveAssistantSchema,
  initialSchemaValue,
  validateAssistantValue,
  assistantValidationValue,
  schemaTypeBranches,
} from "@/lib/ai/assistant-contract.mjs";

const fieldLabels = {
  tool_call_audio: "Audio while tools run",
  avatar_settings: "Assistant avatar",
  post_conversation_settings: "After-call processing",
  observability_settings: "Observability",
  websocket_settings: "Live event connection",
  a2a_agents: "Connected agents",
  disable_greeting_interruption: "Protect the greeting from interruption",
  interrupt_prediction_threshold: "Interruption confidence",
  warm_transfer_acceptance: "Transfer acceptance",
  warm_message_delay_ms: "Handoff message delay (ms)",
  preset_body_fields: "Preset body fields",
  preset_query_params: "Preset query parameters",
  api_key_ref: "API key reference",
  auth_ref: "Authentication secret",
  timeout_ms: "Timeout (ms)",
  async_timeout_ms: "Background timeout (ms)",
  dynamic_variables_webhook_timeout_ms: "Variable lookup timeout (ms)",
  ttl_days: "Retention (days)",
  tools_mode: "Tool behavior",
  timing_ms: "Delay (ms)",
  url: "Endpoint URL",
  sip_auth_username: "SIP username",
  sip_auth_password: "SIP password",
  secret_key_ref: "Private key secret",
  public_key_ref: "Public key secret",
  prompt_sync: "Sync prompt changes",
};
const human = (name) =>
  fieldLabels[name] ||
  String(name)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
const choiceLabel = (schema) => {
  const value =
    schema.properties?.type?.const ||
    schema.properties?.type?.enum?.[0] ||
    schema.properties?.provider?.const;
  const labels = {
    predefined_media:
      schema.properties?.value?.enum?.length === 1 &&
      schema.properties.value.enum[0] === "typing"
        ? "Keyboard typing"
        : "Built-in sound",
    media_url: "Audio URL",
    media_name: "Media Storage",
    request_start: "When the request starts",
    request_response_delayed: "If the response is delayed",
    telnyx: "Telnyx",
    llm: "AI decision",
    expression: "Condition",
    default: "Default route",
    node: "Workflow step",
    assistant: "Another assistant",
  };
  return value
    ? labels[value] || human(value)
    : schema.type === "array"
      ? "List of destinations"
      : schema.type === "string"
        ? "Dynamic variable"
        : "Custom configuration";
};
function FieldHeading({ id, name, description }) {
  const tUi = useUiText();
  return (
    <div className="flex items-center gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {tUi(human(name))}
      </label>
      {description ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={tUi("More information")}
                className="text-muted-foreground hover:text-foreground"
              >
                <IconInfoCircle className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm whitespace-pre-wrap text-xs leading-relaxed">
              {description}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
    </div>
  );
}
function formInitialValue(raw) {
  const schema = resolveAssistantSchema(raw);
  const value = initialSchemaValue(schema);
  if (schema.properties)
    return {
      ...value,
      ...Object.fromEntries(
        Object.entries(schema.properties)
          .filter(
            ([, field]) =>
              field.const !== undefined || field.enum?.length === 1,
          )
          .map(([key, field]) => [key, field.const ?? field.enum[0]]),
      ),
    };
  return value;
}
export const AssistantJsonDraftContext = createContext(null);
function ObjectPairs({ value, onChange, path }) {
  const tUi = useUiText();
  const [advanced, setAdvanced] = useState(false);
  const entries = Object.entries(value || {});
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setAdvanced(!advanced)}
        >
          {advanced ? tUi("Simple fields") : tUi("Advanced JSON")}
        </Button>
      </div>
      {advanced ? (
        <JsonValue value={value} onChange={onChange} path={path} />
      ) : (
        <>
          {entries.map(([key, entry], index) => (
            <div
              key={index}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] items-start gap-2"
            >
              <Input
                aria-label={tUi("Field name")}
                value={key}
                placeholder={tUi("Field name")}
                onChange={(event) => {
                  const name = event.target.value;
                  if (name !== key && Object.hasOwn(value, name)) return;
                  onChange(
                    Object.fromEntries(
                      entries.map(([k, v], i) => [i === index ? name : k, v]),
                    ),
                  );
                }}
              />
              {typeof entry === "boolean" ? (
                <Switch
                  aria-label={key}
                  checked={entry}
                  onCheckedChange={(next) =>
                    onChange({ ...value, [key]: next })
                  }
                />
              ) : entry !== null && typeof entry === "object" ? (
                <JsonValue
                  value={entry}
                  path={`${path}.${key}`}
                  onChange={(next) => onChange({ ...value, [key]: next })}
                />
              ) : (
                <Input
                  aria-label={tUi("Field value")}
                  type={typeof entry === "number" ? "number" : "text"}
                  value={entry ?? ""}
                  placeholder={tUi("Value or dynamic variable")}
                  onChange={(event) =>
                    onChange({
                      ...value,
                      [key]:
                        typeof entry === "number" && event.target.value !== ""
                          ? Number(event.target.value)
                          : event.target.value,
                    })
                  }
                />
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={tUi("Remove")}
                onClick={() =>
                  onChange(
                    Object.fromEntries(entries.filter((_, i) => i !== index)),
                  )
                }
              >
                <IconTrash className="size-4" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              let key = "";
              let n = 1;
              while (Object.hasOwn(value || {}, key)) key = `field_${n++}`;
              onChange({ ...value, [key]: "" });
            }}
          >
            <IconPlus className="size-4" />
            {tUi("Add field")}
          </Button>
        </>
      )}
    </div>
  );
}
function JsonValue({ value, onChange, path }) {
  const tUi = useUiText();
  const shared = useContext(AssistantJsonDraftContext);
  const [local, setLocal] = useState(null);
  const source = JSON.stringify(value ?? {}, null, 2),
    cached = shared?.drafts[path] || local;
  const draft =
    cached && (cached.error || cached.source === source)
      ? cached
      : { text: source, error: "", source };
  function update(text) {
    let error = "";
    try {
      onChange(JSON.parse(text));
    } catch {
      error = "Enter valid JSON before saving.";
    }
    const next = {
      text,
      error,
      source: error ? source : JSON.stringify(JSON.parse(text), null, 2),
    };
    if (shared) shared.setDrafts((current) => ({ ...current, [path]: next }));
    else setLocal(next);
  }
  return (
    <div className="space-y-2">
      <Textarea
        aria-label={tUi("Advanced JSON value")}
        rows={8}
        className="font-mono text-xs"
        value={draft.text}
        onChange={(e) => update(e.target.value)}
      />
      {draft.error ? (
        <p role="alert" className="text-xs text-destructive">
          {tUi(draft.error)}
        </p>
      ) : null}
    </div>
  );
}

function branchFor(branches, value) {
  const index = branches.findIndex((raw) => {
    const s = resolveAssistantSchema(raw);
    if (s.type === "null") return value === null;
    if (s.const !== undefined) return s.const === value;
    if (s.enum) return s.enum.includes(value);
    if (s.properties) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
      return Object.entries(s.properties).every(
        ([k, v]) =>
          (v.const === undefined && !v.enum) ||
          value[k] === v.const ||
          v.enum?.includes(value[k]),
      );
    }
    return (
      s.type === typeof value ||
      (s.type === "integer" && Number.isInteger(value)) ||
      (s.type === "array" && Array.isArray(value))
    );
  });
  return Math.max(0, index);
}
export function SchemaValue({
  schema: raw,
  value,
  onChange,
  name,
  depth = 0,
  path = name,
  required = false,
}) {
  const tUi = useUiText(),
    id = useId();
  const schema = resolveAssistantSchema(raw);
  const canOmit = !required && path.includes(".") && schema.const === undefined;
  const canReset =
    schema.const === undefined && (canOmit || schema.default !== undefined);
  const resetValue = canOmit ? undefined : schema.default;
  if (
    schema.readOnly ||
    schema.const !== undefined ||
    schema.enum?.length === 1
  )
    return null;
  const types = Array.isArray(schema.type) ? schema.type : null;
  const branches =
    schema.oneOf ||
    schema.anyOf ||
    (types && !schema.enum ? schemaTypeBranches(schema) : null);
  if (branches) {
    const choices = branches.filter(
      (branch) => resolveAssistantSchema(branch).type !== "null",
    );
    const nullable = choices.length !== branches.length || schema.uiNullable;
    // Null and JSON container types are transport details, never user choices.
    if (choices.length === 1)
      return (
        <SchemaValue
          schema={{
            ...resolveAssistantSchema(choices[0]),
            uiNullable: nullable,
            description:
              schema.description ||
              resolveAssistantSchema(choices[0]).description,
          }}
          value={value}
          onChange={(next) =>
            onChange(
              nullable &&
                (next === undefined ||
                  next === "" ||
                  (Array.isArray(next) && !next.length))
                ? null
                : next,
            )
          }
          name={name}
          depth={depth}
          path={path}
          required={required}
        />
      );
    const index = branchFor(choices, value);
    const active = value != null;
    return (
      <div className="space-y-4 rounded-xl border bg-card p-5">
        <div className="flex items-center justify-between gap-4">
          <FieldHeading id={id} name={name} description={schema.description} />
          {nullable ? (
            <Switch
              id={id}
              checked={active}
              onCheckedChange={(enabled) =>
                onChange(enabled ? formInitialValue(choices[index]) : null)
              }
            />
          ) : null}
        </div>
        {!nullable || active ? (
          <>
            <Select
              value={String(index)}
              onValueChange={(next) =>
                onChange(formInitialValue(choices[Number(next)]))
              }
            >
              <SelectTrigger
                aria-label={tUi("Configuration mode")}
                className="w-full h-10"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {choices.map((b, i) => {
                  const s = resolveAssistantSchema(b);
                  return (
                    <SelectItem key={i} value={String(i)}>
                      {tUi(choiceLabel(s))}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <SchemaValue
              schema={{
                ...resolveAssistantSchema(choices[index]),
                uiInline: true,
              }}
              value={value}
              onChange={onChange}
              name={name}
              path={path}
              depth={depth + 1}
              required={required}
            />
          </>
        ) : null}
      </div>
    );
  }
  if (schema.type === "null") return null;
  if (schema.type === "object" || schema.properties) {
    const hasEnabled = schema.properties?.enabled?.type === "boolean";
    const statusSchema = resolveAssistantSchema(
      schema.properties?.status || {},
    );
    const hasStatus =
      statusSchema.enum?.length === 2 &&
      statusSchema.enum.includes("enabled") &&
      statusSchema.enum.includes("disabled");
    const activationKey = hasEnabled ? "enabled" : hasStatus ? "status" : null;
    if (!schema.properties || depth > 5)
      return (
        <div className="space-y-3 rounded-xl border bg-card p-5">
          <FieldHeading name={name} description={schema.description} />
          {schema.additionalProperties && depth <= 5 ? (
            <ObjectPairs value={value} onChange={onChange} path={path} />
          ) : (
            <JsonValue value={value} onChange={onChange} path={path} />
          )}
        </div>
      );
    const enabled = hasEnabled
      ? (value?.enabled ?? schema.properties.enabled.default ?? false)
      : hasStatus
        ? (value?.status ?? statusSchema.default) === "enabled"
        : !schema.uiNullable || value != null;
    const childEntries = Object.entries(schema.properties).filter(
      ([key, s]) =>
        !s.readOnly &&
        s.const === undefined &&
        s.enum?.length !== 1 &&
        key !== activationKey,
    );
    const base = { ...formInitialValue(schema), ...(value || {}) };
    return (
      <div
        className={
          schema.uiInline
            ? "space-y-4"
            : "space-y-4 rounded-xl border bg-card p-5"
        }
      >
        {!schema.uiInline || activationKey ? (
          <div className="flex items-center justify-between gap-3">
            <FieldHeading
              id={id}
              name={name}
              description={schema.description}
            />
            {activationKey || schema.uiNullable ? (
              <Switch
                id={id}
                checked={enabled}
                onCheckedChange={(next) =>
                  onChange(
                    hasEnabled
                      ? { ...base, enabled: next }
                      : hasStatus
                        ? { ...base, status: next ? "enabled" : "disabled" }
                        : next
                          ? base
                          : null,
                  )
                }
              />
            ) : null}
          </div>
        ) : null}
        {enabled ? (
          <div className="grid gap-x-5 gap-y-4 md:grid-cols-2">
            {childEntries.map(([key, s]) => (
              <div
                key={key}
                className={
                  ["object", "array"].includes(
                    resolveAssistantSchema(s).type,
                  ) ||
                  s.anyOf ||
                  s.oneOf ||
                  resolveAssistantSchema(s).properties
                    ? "md:col-span-2"
                    : ""
                }
              >
                <SchemaValue
                  key={key}
                  schema={s}
                  name={
                    key === "value" && value?.type === "media_url"
                      ? "Audio URL"
                      : key
                  }
                  path={`${path}.${key}`}
                  value={value?.[key]}
                  onChange={(next) => onChange({ ...base, [key]: next })}
                  depth={depth + 1}
                  required={schema.required?.includes(key)}
                />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  if (schema.type === "array")
    return (
      <div className="space-y-4 rounded-xl border bg-card p-5">
        <div className="flex items-center justify-between">
          <FieldHeading name={name} description={schema.description} />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={
              schema.maxItems !== undefined &&
              (value?.length || 0) >= schema.maxItems
            }
            onClick={() =>
              onChange([...(value || []), formInitialValue(schema.items)])
            }
          >
            <IconPlus className="size-4" />
            {tUi("Add")}
          </Button>
        </div>
        {(value || []).map((item, i) => (
          <div
            key={i}
            className="flex items-start gap-3 rounded-lg border bg-muted/10 p-3"
          >
            <div className="min-w-0 flex-1">
              <SchemaValue
                schema={{
                  ...resolveAssistantSchema(schema.items),
                  uiInline: true,
                }}
                name={tUi("Item {value0}", { value0: i + 1 })}
                path={`${path}[${i}]`}
                value={item}
                onChange={(next) =>
                  onChange(value.map((v, j) => (j === i ? next : v)))
                }
                depth={depth + 1}
                required
              />
            </div>
            <div className="flex shrink-0 gap-1">
              {value.length > 1 ? (
                <>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    disabled={i === 0}
                    aria-label={tUi("Move up")}
                    onClick={() => {
                      const next = [...value];
                      [next[i - 1], next[i]] = [next[i], next[i - 1]];
                      onChange(next);
                    }}
                  >
                    <IconArrowUp className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    disabled={i === value.length - 1}
                    aria-label={tUi("Move down")}
                    onClick={() => {
                      const next = [...value];
                      [next[i + 1], next[i]] = [next[i], next[i + 1]];
                      onChange(next);
                    }}
                  >
                    <IconArrowDown className="size-4" />
                  </Button>
                </>
              ) : null}
              <Button
                type="button"
                size="icon"
                className="size-7 text-muted-foreground hover:text-destructive"
                aria-label={tUi("Remove")}
                variant="ghost"
                onClick={() => onChange(value.filter((_, j) => i !== j))}
              >
                <IconTrash className="size-4" />
              </Button>
            </div>
          </div>
        ))}
        {!(value || []).length ? (
          <p className="text-xs text-muted-foreground">
            {tUi("No entries configured")}
          </p>
        ) : null}
      </div>
    );
  const enumeration =
    schema.enum || (schema.const !== undefined ? [schema.const] : null);
  const isStatus =
    enumeration?.length === 2 &&
    enumeration.includes("enabled") &&
    enumeration.includes("disabled");
  if (schema.type === "boolean" || isStatus)
    return (
      <div className="flex items-center justify-between gap-4 rounded-lg border bg-card px-4 py-3">
        <div className="flex items-center justify-between gap-4">
          <FieldHeading id={id} name={name} description={schema.description} />
        </div>
        <Switch
          id={id}
          checked={
            isStatus
              ? (value ?? schema.default) === "enabled"
              : Boolean(value ?? schema.default ?? false)
          }
          onCheckedChange={(next) =>
            onChange(isStatus ? (next ? "enabled" : "disabled") : next)
          }
        />
      </div>
    );
  return (
    <div className="space-y-2">
      <FieldHeading id={id} name={name} description={schema.description} />
      {enumeration ? (
        <Select
          value={String(
            enumeration.findIndex((option) => Object.is(option, value)),
          )}
          onValueChange={(next) =>
            onChange(next === "-1" ? resetValue : enumeration[Number(next)])
          }
        >
          <SelectTrigger id={id} className="h-10 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="-1" disabled={!canReset}>
              {tUi("Use default")}
            </SelectItem>
            {enumeration.map((v, index) => (
              <SelectItem key={index} value={String(index)}>
                {v === null
                  ? tUi("Disabled")
                  : typeof v === "string" && !v.includes("/")
                    ? tUi(human(v))
                    : String(v)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : ["integer", "number"].includes(schema.type) ? (
        <Input
          id={id}
          className="h-10"
          type="number"
          min={schema.minimum}
          max={schema.maximum}
          step={schema.multipleOf ?? (schema.type === "integer" ? 1 : "any")}
          value={value ?? ""}
          placeholder={
            schema.default === undefined
              ? tUi("Use default")
              : String(schema.default)
          }
          onChange={(e) =>
            onChange(e.target.value === "" ? undefined : Number(e.target.value))
          }
        />
      ) : (
        <Input
          id={id}
          className="h-10"
          type={name.toLowerCase().includes("password") ? "password" : "text"}
          value={value ?? ""}
          maxLength={schema.maxLength}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}
export default function AssistantSchemaFields({
  fields,
  values,
  setValues,
  schemas = assistantSchemas.UpdateAssistantRequest.properties,
  pathPrefix = "",
  requiredFields = [],
  originalValues,
}) {
  const [initial] = useState(() => values);
  const [touched, setTouched] = useState({});
  const baseline = originalValues || values._original || initial;
  return (
    <div className="space-y-5">
      {fields.map((name) => {
        const errors = touched[name]
          ? validateAssistantValue(
              schemas[name],
              assistantValidationValue(
                values[name],
                baseline[name],
                schemas[name],
              ),
              name,
            )
          : [];
        return (
          <div
            key={name}
            data-setting-path={pathPrefix ? `${pathPrefix}.${name}` : name}
          >
            <SchemaValue
              path={pathPrefix ? `${pathPrefix}.${name}` : name}
              name={name}
              schema={schemas[name]}
              required={requiredFields.includes(name)}
              value={values[name]}
              onChange={(next) => {
                setTouched((current) => ({ ...current, [name]: true }));
                setValues((v) => ({ ...v, [name]: next }));
              }}
            />
            {errors.length ? (
              <p className="mt-2 text-xs text-destructive" role="alert">
                {errors.join(" ")}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
