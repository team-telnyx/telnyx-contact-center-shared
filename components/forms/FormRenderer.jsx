"use client";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getContextValue } from "@/lib/forms/form-context";

export function FormRenderer({ form, initialValues = {}, context = {}, onSubmit, submitting = false, readOnly = false }) {
  const [values, setValues] = useState(initialValues || {});
  const fields = useMemo(() => {
    const source = form?.schema?.fields || []; const byId = new Map(source.map((f) => [f.id, f])); const order = form?.layout?.order || source.map((f) => f.id); return order.map((id) => byId.get(id)).filter(Boolean);
  }, [form]);
  function setValue(id, value) { setValues((prev) => ({ ...prev, [id]: value })); }
  async function handleSubmit(e) { e?.preventDefault?.(); await onSubmit?.(values); }
  if (!form) return <div className="text-sm text-muted-foreground">No form selected.</div>;
  return <form onSubmit={handleSubmit} className="space-y-4">
    {fields.map((field) => {
      if (field.type === "hidden") return null;
      if (field.type === "label") return <div key={field.id} className="text-sm font-medium">{field.label}</div>;
      if (field.type === "context_value") return <div key={field.id} className="rounded-md bg-muted p-3 text-sm"><Label>{field.label}</Label><div className="mt-1 font-mono text-xs">{String(getContextValue(context, field.contextPath) || "—")}</div></div>;
      if (field.type === "image") return field.props?.src ? <img key={field.id} src={field.props.src} alt={field.label || "Form image"} className="max-h-48 rounded-md border object-contain" /> : null;
      if (field.type === "button") return <Button key={field.id} type="submit" disabled={submitting || readOnly}>{field.label || "Submit"}</Button>;
      const value = values[field.id] ?? field.defaultValue ?? "";
      return <div key={field.id} className="space-y-2">
        <Label htmlFor={field.id}>{field.label}{field.required ? <span className="text-destructive"> *</span> : null}</Label>
        {field.type === "textarea" && <Textarea id={field.id} value={value} placeholder={field.placeholder} disabled={readOnly} onChange={(e) => setValue(field.id, e.target.value)} />}
        {field.type === "text" && <Input id={field.id} value={value} placeholder={field.placeholder} disabled={readOnly} onChange={(e) => setValue(field.id, e.target.value)} />}
        {field.type === "select" && <Select value={String(value || "")} disabled={readOnly} onValueChange={(v) => setValue(field.id, v)}><SelectTrigger><SelectValue placeholder={field.placeholder || "Select..."} /></SelectTrigger><SelectContent>{(field.options || []).map((o) => <SelectItem key={o.value} value={String(o.value)}>{o.label || o.value}</SelectItem>)}</SelectContent></Select>}
        {field.type === "radio" && <div className="space-y-1">{(field.options || []).map((o) => <label key={o.value} className="flex items-center gap-2 text-sm"><input type="radio" name={field.id} value={o.value} checked={value === o.value} disabled={readOnly} onChange={() => setValue(field.id, o.value)} />{o.label || o.value}</label>)}</div>}
        {field.type === "checkbox" && <div className="flex items-center gap-2"><Checkbox id={field.id} checked={Boolean(value)} disabled={readOnly} onCheckedChange={(checked) => setValue(field.id, Boolean(checked))} /><span className="text-sm text-muted-foreground">{field.placeholder || "Yes"}</span></div>}
        {field.helpText ? <p className="text-xs text-muted-foreground">{field.helpText}</p> : null}
      </div>;
    })}
    {!fields.some((f) => f.type === "button") && onSubmit ? <Button type="submit" disabled={submitting || readOnly}>Submit</Button> : null}
  </form>;
}
