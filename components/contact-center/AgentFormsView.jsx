"use client";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormRenderer } from "@/components/forms/FormRenderer";
import { normalizeFormDefinition } from "@/lib/forms/form-schema";
import { notify } from "@/components/ToastNotify";

export function AgentFormsView({
  selectedInteraction,
  onBackToInteraction,
  formIds = [],
  autoOpenOnly = false,
  selectedFormId,
  onSelectedFormIdChange,
  onFormsLoaded,
  hideHeader = false,
  showCards = true,
}) {
  const [forms, setForms] = useState([]);
  const [internalSelectedId, setInternalSelectedId] = useState("");
  const [renderData, setRenderData] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const selectedId = selectedFormId ?? internalSelectedId;
  const setSelectedId = (value) => {
    if (selectedFormId === undefined) setInternalSelectedId(value);
    onSelectedFormIdChange?.(value);
  };

  const queueName = selectedInteraction?.queue_name || selectedInteraction?.routing_metadata?.queueName || "";
  const queueId = selectedInteraction?.queue_id || selectedInteraction?.routing_metadata?.queueId || "";
  const hasExplicitFormIds = formIds.length > 0;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const params = new URLSearchParams();
      if (queueName) params.set("queueName", queueName);
      if (queueId) params.set("queueId", queueId);
      if (formIds.length) params.set("formIds", formIds.join(","));
      const res = await fetch(`/api/contact-center/forms?${params.toString()}`, { cache: "no-store" });
      const data = await res.json();
      if (cancelled) return;
      let list = data.forms || [];
      if (autoOpenOnly) list = list.filter((f) => f.auto_open || formIds.includes(f.id));
      setForms(list);
      onFormsLoaded?.(list);
      const stillValid = selectedId && list.some((form) => form.id === selectedId);
      if (!stillValid) setSelectedId(list[0]?.id || "");
    }
    load().catch(() => {
      if (!cancelled) {
        setForms([]);
        onFormsLoaded?.([]);
        setSelectedId("");
      }
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueName, queueId, formIds.join(","), autoOpenOnly]);

  useEffect(() => {
    let cancelled = false;
    async function render() {
      if (!selectedId) {
        setRenderData(null);
        return;
      }
      const params = new URLSearchParams();
      if (selectedInteraction?.id) params.set("interactionId", selectedInteraction.id);
      const res = await fetch(`/api/contact-center/forms/${selectedId}/render?${params.toString()}`, { cache: "no-store" });
      const data = await res.json();
      if (!cancelled) setRenderData(data.ok ? data : null);
    }
    render().catch(() => { if (!cancelled) setRenderData(null); });
    return () => { cancelled = true; };
  }, [selectedId, selectedInteraction?.id]);

  function objectOrEmpty(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function interactionFormData() {
    const metadata = objectOrEmpty(selectedInteraction?.metadata);
    const routingMetadata = objectOrEmpty(selectedInteraction?.routing_metadata || selectedInteraction?.routingMetadata);
    const metadataClientState = objectOrEmpty(metadata.client_state || metadata.clientState);
    const routingClientState = objectOrEmpty(routingMetadata.client_state || routingMetadata.clientState);
    return objectOrEmpty(
      routingMetadata.form_data ||
      routingMetadata.formData ||
      routingClientState.form_data ||
      routingClientState.formData ||
      metadataClientState.form_data ||
      metadataClientState.formData ||
      metadata.agent_assist_config?.form_data_resolved,
    );
  }

  const selectedForm = useMemo(() => forms.find((f) => f.id === selectedId), [forms, selectedId]);

  const rendererInitialValues = useMemo(() => {
    const base = renderData?.initialValues || {};
    if (!renderData?.form || !selectedId || !formIds.includes(selectedId)) return base;
    const formData = interactionFormData();
    if (!Object.keys(formData).length) return base;
    const normalized = normalizeFormDefinition(renderData.form);
    const mapped = { ...base };
    for (const field of normalized.schema?.fields || []) {
      if (field.variableName && Object.prototype.hasOwnProperty.call(formData, field.variableName)) {
        mapped[field.id] = formData[field.variableName];
      }
    }
    return mapped;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderData?.form, renderData?.initialValues, selectedId, formIds.join(","), selectedInteraction?.id, selectedInteraction?.routing_metadata, selectedInteraction?.metadata]);

  function toastVariantForStatus(data) {
    const actionStatus = data?.dataAction?.status || data?.status;
    const normalized = String(actionStatus || "").toLowerCase();
    if (data?.ok === false || data?.dataAction?.success === false || normalized === "error" || normalized === "failed") return "error";
    if (normalized === "warning") return "warning";
    if (normalized === "info") return "info";
    return "success";
  }

  function showSubmitToast(data = {}) {
    const variant = toastVariantForStatus(data);
    const description = data.dataAction?.message || (data.ok ? "Form submitted." : (data.validation?.errors?.[0]?.message || data.error || "Submission failed"));
    const title = data.dataAction
      ? variant === "error" ? "Data action failed" : variant === "success" ? "Data action completed" : "Data action status"
      : variant === "error" ? "Form submission failed" : "Form submitted";
    notify({ title, description, variant });
  }

  async function submit(values, meta = {}) {
    if (!selectedId) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/contact-center/forms/${selectedId}/submissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          interactionId: selectedInteraction?.id,
          data: values,
          context: renderData?.context,
          button: meta.button,
          dataActionFlowId: meta.dataActionFlowId || meta.button?.props?.dataActionFlowId || "",
        }),
      });
      const data = await res.json();
      showSubmitToast(data);
    } catch (err) {
      notify({ title: "Form submission failed", description: err?.message || "Submission failed", variant: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  return <div className="flex flex-col h-full overflow-hidden">
    {!hideHeader ? <div className="px-4 py-3 bg-muted/50 border-b rounded-t-lg flex items-center justify-between gap-3">
      <div className="min-w-0"><h3 className="text-sm font-semibold">Forms</h3><p className="text-xs text-muted-foreground">{queueName ? `Queue: ${queueName}` : "Published agent forms"}</p></div>
      <div className="flex items-center gap-2">
        {forms.length ? <Select value={selectedId || undefined} onValueChange={setSelectedId}>
          <SelectTrigger className="h-8 w-[220px]"><SelectValue placeholder="Select form" /></SelectTrigger>
          <SelectContent>{forms.map((form) => <SelectItem key={form.id} value={form.id}>{form.name}</SelectItem>)}</SelectContent>
        </Select> : null}
        {onBackToInteraction ? <Button size="sm" variant="ghost" onClick={onBackToInteraction}>Back</Button> : null}
      </div>
    </div> : null}
    <div className="flex-1 overflow-y-auto p-3 space-y-3">
      {forms.length === 0 ? <p className="text-sm text-muted-foreground">{hasExplicitFormIds ? "No selected published forms are available for this interaction." : "No published forms assigned to this queue."}</p> : showCards ? <div className="grid gap-2">{forms.map((form) => <Card key={form.id} className={`cursor-pointer ${selectedId === form.id ? "border-primary bg-primary/5" : ""}`} onClick={() => setSelectedId(form.id)}><CardContent className="p-3"><div className="flex items-center justify-between"><span className="font-medium text-sm">{form.name}</span>{form.auto_open ? <Badge variant="secondary">auto</Badge> : null}</div><p className="text-xs text-muted-foreground">{form.description || form.category}</p></CardContent></Card>)}</div> : null}
      {selectedForm && renderData ? <Card><CardContent className="p-4"><FormRenderer form={renderData.form} initialValues={rendererInitialValues} context={renderData.context} onSubmit={submit} submitting={submitting} /></CardContent></Card> : null}
    </div>
  </div>;
}
