"use client";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getContextValue } from "@/lib/forms/form-context";


function paddingClass(value) { return ({ none: "p-0", xs: "p-2", sm: "p-3", md: "p-4", lg: "p-6", xl: "p-8" }[value || "md"] || "p-4"); }
function verticalPaddingClass(value) { return ({ none: "py-0", xs: "py-2", sm: "py-3", md: "py-4", lg: "py-6", xl: "py-8" }[value || "md"] || "py-4"); }
function textSizeClass(value) { return ({ sm: "text-sm", md: "text-base", lg: "text-lg", xl: "text-2xl" }[value || "md"] || "text-base"); }
function alignClass(value) { return ({ left: "text-left", center: "text-center", right: "text-right" }[value || "left"] || "text-left"); }
function fieldStyle(field) { return field.props?.color ? { color: field.props.color } : undefined; }

function orderedFields(form) {
  const source = form?.schema?.fields || []; const byId = new Map(source.map((f) => [f.id, f])); const order = form?.layout?.order || source.map((f) => f.id); return order.map((id) => byId.get(id)).filter(Boolean);
}

function LayoutBlock({ field }) {
  const props = field.props || {};
  const style = fieldStyle(field);
  if (field.type === "section") return <div className={`rounded-lg border bg-muted/25 ${paddingClass(props.padding)}`} style={style}><div className="text-sm font-semibold">{field.label}</div>{field.helpText ? <p className="mt-1 text-xs text-muted-foreground">{field.helpText}</p> : null}</div>;
  if (field.type === "row") return <div className={`rounded-lg border border-dashed ${paddingClass(props.padding)} text-xs font-medium text-muted-foreground`}>Row · {field.label}</div>;
  if (field.type === "columns") {
    const count = Math.max(2, Math.min(Number(props.columns || props.columnCount || 2), 4));
    return <div className={`rounded-lg border border-dashed ${paddingClass(props.padding)}`}><div className="mb-2 text-xs font-medium text-muted-foreground">{field.label || `${count} columns`}</div><div className="grid" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`, gap: Number(props.gap || 8) }}>{Array.from({ length: count }).map((_, i) => <div key={i} className="min-h-14 rounded-md bg-muted/50" />)}</div></div>;
  }
  if (field.type === "grid") { const count = Math.max(1, Math.min(Number(props.columns || 2), 6)); return <div className={`rounded-lg border border-dashed ${paddingClass(props.padding)} text-xs font-medium text-muted-foreground`}><div className="mb-2">Grid · {field.label}</div><div className="grid" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`, gap: Number(props.gap || 8) }}>{Array.from({ length: count }).map((_, i) => <div key={i} className="h-10 rounded-md bg-muted/50" />)}</div></div>; }
  if (field.type === "flex") return <div className={`rounded-lg border border-dashed ${paddingClass(props.padding)} text-xs font-medium text-muted-foreground`}>Flex · {props.direction || "row"}</div>;
  if (field.type === "spacer") return <div className={props.direction === "horizontal" ? "inline-block h-4 w-24" : "h-12 w-full"} />;
  if (field.type === "hero") return <section className={`rounded-xl border bg-card text-card-foreground ${verticalPaddingClass(props.padding)} px-6 ${alignClass(props.align)}`} style={style}><div className="text-xs font-semibold uppercase tracking-wide text-primary">{props.quote || field.label}</div><h2 className="mt-2 text-3xl font-bold tracking-tight">{props.title || field.label}</h2>{props.description ? <p className="mt-3 text-sm text-muted-foreground">{props.description}</p> : null}{props.buttons?.length ? <div className="mt-4 flex flex-wrap gap-2">{props.buttons.map((button, i) => <Button key={i} type="button" variant={button.variant === "secondary" ? "secondary" : "default"}>{button.label || "Action"}</Button>)}</div> : null}</section>;
  if (field.type === "stats") return <div className={`grid gap-3 md:grid-cols-3 ${paddingClass(props.padding)}`}>{(props.items || []).map((item, index) => <div key={index} className="rounded-xl border bg-card p-4 text-card-foreground"><div className="text-2xl font-bold" style={style}>{item.title}</div><div className="text-xs text-muted-foreground">{item.description}</div></div>)}</div>;
  if (field.type === "card") return <div className={`${paddingClass(props.padding)} rounded-xl ${props.mode === "flat" ? "bg-muted/40" : "border bg-card shadow-sm"} text-card-foreground`} style={style}><div className="text-sm font-semibold">{props.title || field.label}</div>{props.description ? <p className="mt-2 text-xs text-muted-foreground">{props.description}</p> : null}</div>;
  if (field.type === "richtext") return <div className={`${paddingClass(props.padding)} ${textSizeClass(props.size)} ${alignClass(props.align)}`} style={style}>{props.richtext || field.label}</div>;
  return null;
}

export function FormRenderer({ form, initialValues = {}, context = {}, onSubmit, submitting = false, readOnly = false }) {
  const [values, setValues] = useState(initialValues || {});
  const fields = useMemo(() => orderedFields(form), [form]);
  function setValue(id, value) { setValues((prev) => ({ ...prev, [id]: value })); }
  async function handleSubmit(e) { e?.preventDefault?.(); await onSubmit?.(values); }
  if (!form) return <div className="text-sm text-muted-foreground">No form selected.</div>;
  return <form onSubmit={handleSubmit} className="space-y-4">
    {fields.map((field) => {
      if (["section", "row", "columns", "grid", "flex", "spacer", "hero", "stats", "card", "richtext"].includes(field.type)) return <LayoutBlock key={field.id} field={field} />;
      if (field.type === "hidden") return null;
      if (field.type === "label") return <div key={field.id} className={`font-medium ${textSizeClass(field.props?.size)} ${alignClass(field.props?.align)} ${paddingClass(field.props?.padding)}`} style={fieldStyle(field)}>{field.label}</div>;
      if (field.type === "context_value") return <div key={field.id} className="rounded-md bg-muted p-3 text-sm"><Label>{field.label}</Label><div className="mt-1 font-mono text-xs">{String(getContextValue(context, field.contextPath) || "—")}</div></div>;
      if (field.type === "image") return field.props?.src ? <img key={field.id} src={field.props.src} alt={field.label || "Form image"} className="max-h-48 rounded-md border object-contain" /> : null;
      if (field.type === "button") return <Button key={field.id} type="submit" disabled={submitting || readOnly}>{field.label || "Submit"}</Button>;
      const value = values[field.id] ?? field.defaultValue ?? "";
      return <div key={field.id} className="space-y-2">
        <Label htmlFor={field.id} style={fieldStyle(field)}>{field.label}{field.required ? <span className="text-destructive"> *</span> : null}</Label>
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
