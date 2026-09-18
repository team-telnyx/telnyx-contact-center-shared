"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import Combobox from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  IconBrandWhatsapp,
  IconLoader2,
  IconPlus,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import { getWhatsAppTemplateVariableFields } from "@/lib/whatsapp-templates";
import { validateWhatsAppTemplateVariableCounts } from "@/lib/ai/assistant-tool-validation";

const EMPTY_TEMPLATE = {
  name: "",
  template_name: "",
  template_id: "",
  language: "",
  description: "",
  variables: [],
};

function templateOption(template) {
  const language = String(template?.language || "");
  return {
    value: String(template?.id || ""),
    label: language
      ? `${template?.name || template?.id} — ${language}`
      : template?.name || template?.id,
  };
}

function parseVariableNames(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function VariableNamesInput({ value, onChange, expectedCount }) {
  const joined = Array.isArray(value) ? value.join(", ") : String(value || "");
  const [text, setText] = useState(joined);

  useEffect(() => {
    setText(joined);
  }, [joined]);

  return (
    <div className="space-y-2">
      <Label>Variables</Label>
      <Input
        value={text}
        onChange={(event) => {
          const nextText = event.target.value;
          setText(nextText);
          onChange(parseVariableNames(nextText));
        }}
        placeholder={
          expectedCount > 0
            ? Array.from(
                { length: expectedCount },
                (_, index) => `variable_${index + 1}`
              ).join(", ")
            : "No variables"
        }
      />
      <p className="text-xs text-muted-foreground">
        Comma-separated names in positional order: {"{{1}}"}, {"{{2}}"}, …
        {expectedCount > 0
          ? ` This template has ${expectedCount} runtime value${
              expectedCount === 1 ? "" : "s"
            }.`
          : " Leave empty for templates without variables."}
      </p>
    </div>
  );
}

export default function WhatsAppTemplateToolEditor({
  value,
  onChange,
  onValidationChange,
}) {
  const config = value?.whatsapp_template || {};
  const configuredTemplates = useMemo(
    () =>
      Array.isArray(config.templates) && config.templates.length
        ? config.templates
        : [EMPTY_TEMPLATE],
    [config.templates]
  );
  const [approvedTemplates, setApprovedTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const loadApprovedTemplates = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const params = new URLSearchParams({
        "page[number]": "1",
        "page[size]": "100",
        "filter[status]": "APPROVED",
      });
      const response = await fetch(
        `/api/messaging/whatsapp/templates?${params.toString()}`,
        { cache: "no-store" }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.ok === false) {
        throw new Error(data?.error || "Failed to load WhatsApp templates");
      }
      setApprovedTemplates(Array.isArray(data?.data) ? data.data : []);
    } catch (error) {
      setApprovedTemplates([]);
      setLoadError(error?.message || "Failed to load WhatsApp templates");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadApprovedTemplates();
  }, [loadApprovedTemplates]);

  const templatesById = useMemo(
    () =>
      new Map(
        approvedTemplates
          .filter((template) => template?.id)
          .map((template) => [String(template.id), template])
      ),
    [approvedTemplates]
  );

  const options = useMemo(() => {
    const next = approvedTemplates
      .filter((template) => template?.id)
      .map(templateOption);
    for (const configured of configuredTemplates) {
      const id = String(configured?.template_id || "");
      if (!id || next.some((option) => option.value === id)) continue;
      next.unshift({
        value: id,
        label: configured?.template_name
          ? `${configured.template_name}${
              configured.language ? ` — ${configured.language}` : ""
            }`
          : id,
      });
    }
    return next;
  }, [approvedTemplates, configuredTemplates]);
  const variablesError = useMemo(
    () =>
      loading || loadError
        ? ""
        : validateWhatsAppTemplateVariableCounts(
            configuredTemplates,
            approvedTemplates
          ),
    [approvedTemplates, configuredTemplates, loadError, loading]
  );

  useEffect(() => {
    onValidationChange?.(variablesError);
  }, [onValidationChange, variablesError]);

  function updateTemplates(nextTemplates) {
    onChange?.({
      ...(value || { type: "whatsapp_template" }),
      type: "whatsapp_template",
      whatsapp_template: {
        ...config,
        templates: nextTemplates,
      },
    });
  }

  function updateTemplate(index, partial) {
    updateTemplates(
      configuredTemplates.map((template, templateIndex) =>
        templateIndex === index ? { ...template, ...partial } : template
      )
    );
  }

  return (
    <div className="space-y-5">
      <Alert variant="info">
        <IconBrandWhatsapp className="size-4" />
        <AlertDescription>
          Approved WhatsApp templates can be sent even when the 24-hour
          customer-service window is closed.
        </AlertDescription>
      </Alert>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="whatsapp-tool-display-name">Display Name</Label>
          <Input
            id="whatsapp-tool-display-name"
            value={value?.display_name || ""}
            onChange={(event) =>
              onChange?.({
                ...(value || { type: "whatsapp_template" }),
                type: "whatsapp_template",
                display_name: event.target.value,
              })
            }
            placeholder="WhatsApp Templates"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="whatsapp-tool-timeout">Timeout (ms)</Label>
          <Input
            id="whatsapp-tool-timeout"
            type="number"
            min={1}
            step={100}
            value={value?.timeout_ms ?? 5000}
            onChange={(event) =>
              onChange?.({
                ...(value || { type: "whatsapp_template" }),
                type: "whatsapp_template",
                timeout_ms: Math.max(1, Number(event.target.value || 1)),
              })
            }
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">WhatsApp Templates</h3>
          <p className="text-xs text-muted-foreground">
            Add one or more approved templates the assistant may choose from.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={loadApprovedTemplates}
            disabled={loading}
          >
            {loading ? (
              <IconLoader2 className="size-4 animate-spin" />
            ) : (
              <IconRefresh className="size-4" />
            )}
            Refresh
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() =>
              updateTemplates([...configuredTemplates, { ...EMPTY_TEMPLATE }])
            }
          >
            <IconPlus className="size-4" />
            Add Template
          </Button>
        </div>
      </div>

      {loadError ? (
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : null}

      {!loading && !loadError && approvedTemplates.length === 0 ? (
        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          No approved WhatsApp templates were found. Create a template in
          Messaging → WhatsApp and wait for approval before selecting it here.
        </div>
      ) : null}

      <div className="space-y-4">
        {configuredTemplates.map((template, index) => {
          const selectedTemplate = templatesById.get(
            String(template?.template_id || "")
          );
          const expectedVariables = selectedTemplate
            ? getWhatsAppTemplateVariableFields(selectedTemplate).length
            : Array.isArray(template?.variables)
              ? template.variables.length
              : 0;
          const handle = String(template?.name || "");
          const handleError =
            handle && !/^[A-Za-z0-9_-]+$/.test(handle)
              ? "Use only letters, numbers, underscores, and hyphens."
              : "";

          return (
            <div
              key={`${template?.template_id || "new"}-${index}`}
              className="space-y-4 rounded-lg border bg-muted/20 p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium">Template {index + 1}</p>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  disabled={configuredTemplates.length === 1}
                  onClick={() =>
                    updateTemplates(
                      configuredTemplates.filter(
                        (_, templateIndex) => templateIndex !== index
                      )
                    )
                  }
                  aria-label={`Remove template ${index + 1}`}
                >
                  <IconTrash className="size-4" />
                </Button>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>WhatsApp template</Label>
                  <Combobox
                    value={template?.template_id || ""}
                    onChange={(templateId) => {
                      const selected = templatesById.get(String(templateId));
                      updateTemplate(index, {
                        template_id: selected?.id || templateId,
                        template_name: selected?.name || "",
                        language: selected?.language || "",
                      });
                    }}
                    options={options}
                    placeholder={
                      loading ? "Loading templates…" : "Select a template"
                    }
                    emptyLabel="No approved WhatsApp templates found"
                    triggerClassName="w-full"
                    contentClassName="w-[420px]"
                    disabled={loading || options.length === 0}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Name</Label>
                  <Input
                    value={handle}
                    onChange={(event) =>
                      updateTemplate(index, { name: event.target.value })
                    }
                    placeholder="auth_code"
                    aria-invalid={Boolean(handleError)}
                  />
                  {handleError ? (
                    <p className="text-xs text-destructive">{handleError}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Short handle the assistant uses to choose this template.
                    </p>
                  )}
                </div>

                <div className="space-y-2 md:col-span-2">
                  <Label>Description</Label>
                  <Textarea
                    value={template?.description || ""}
                    onChange={(event) =>
                      updateTemplate(index, {
                        description: event.target.value,
                      })
                    }
                    placeholder="Send the customer their login verification code."
                    rows={3}
                  />
                  <p className="text-xs text-muted-foreground">
                    Tell the assistant when it should use this template.
                  </p>
                </div>

                <div className="md:col-span-2">
                  <VariableNamesInput
                    value={template?.variables}
                    expectedCount={expectedVariables}
                    onChange={(variables) =>
                      updateTemplate(index, { variables })
                    }
                  />
                  {selectedTemplate &&
                  Array.isArray(template?.variables) &&
                  template.variables.length !== expectedVariables ? (
                    <p className="mt-2 text-xs text-destructive">
                      Enter exactly {expectedVariables} variable name
                      {expectedVariables === 1 ? "" : "s"} for this template.
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
