"use client";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FORM_COMPONENT_TYPES, flattenPageOrder, normalizeFormDefinition } from "@/lib/forms/form-schema";
import { FormRenderer } from "./FormRenderer";

export function FormBuilder({ value, onChange }) {
  const form = useMemo(() => normalizeFormDefinition(value || {}), [value]); const [selectedId, setSelectedId] = useState(form.schema.fields[0]?.id || ""); const selected = form.schema.fields.find((f) => f.id === selectedId) || form.schema.fields[0];
  function update(next) { onChange?.(normalizeFormDefinition(next)); }
  function updateField(id, patch) { update({ ...form, schema: { ...form.schema, fields: form.schema.fields.map((f) => f.id === id ? { ...f, ...patch } : f) } }); }
  function withPageLayout(next) { return { ...next, layout: { ...next.layout, order: flattenPageOrder(next.schema.pages || []) } }; }
  function addField(type) { const id = `${type}_${Math.floor(Date.now()/1000)}`; const pages = (form.schema.pages || [{ id: "page_1", title: "Page 1", fields: [] }]).map((page, index) => index === 0 ? { ...page, fields: [...(page.fields || []), id] } : page); update(withPageLayout({ ...form, schema: { ...form.schema, fields: [...form.schema.fields, { id, type, label: `${type} field`, options: type === "select" || type === "radio" ? [{ label: "Option A", value: "a" }] : [] }], pages } })); setSelectedId(id); }
  function move(id, dir) { const pages = (form.schema.pages || []).map((page) => { const order = [...(page.fields || [])]; const i = order.indexOf(id); const j = i + dir; if (i < 0 || j < 0 || j >= order.length) return page; [order[i], order[j]] = [order[j], order[i]]; return { ...page, fields: order }; }); update(withPageLayout({ ...form, schema: { ...form.schema, pages } })); }
  function remove(id) { const pages = (form.schema.pages || []).map((page) => ({ ...page, fields: (page.fields || []).filter((x) => x !== id) })); update(withPageLayout({ ...form, schema: { ...form.schema, fields: form.schema.fields.filter((f) => f.id !== id), pages } })); }
  return <div className="grid gap-4 lg:grid-cols-[280px_1fr_360px]">
    <Card><CardHeader><CardTitle className="text-base">Palette</CardTitle></CardHeader><CardContent className="grid grid-cols-2 gap-2">{FORM_COMPONENT_TYPES.map((type) => <Button key={type} type="button" variant="outline" size="sm" onClick={() => addField(type)}>{type}</Button>)}</CardContent></Card>
    <Card><CardHeader><CardTitle className="text-base">Layout</CardTitle></CardHeader><CardContent className="space-y-2">{(form.layout.order || []).map((id) => { const f = form.schema.fields.find((x) => x.id === id); if (!f) return null; return <div key={id} className={`rounded-md border p-3 ${selectedId === id ? "border-primary bg-primary/5" : ""}`} onClick={() => setSelectedId(id)}><div className="flex items-center justify-between gap-2"><div><div className="font-medium text-sm">{f.label}</div><div className="text-xs text-muted-foreground">{f.id} · {f.type}</div></div><div className="flex gap-1"><Button type="button" size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); move(id, -1); }}>↑</Button><Button type="button" size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); move(id, 1); }}>↓</Button><Button type="button" size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); remove(id); }}>×</Button></div></div></div>; })}</CardContent></Card>
    <div className="space-y-4"><Card><CardHeader><CardTitle className="text-base">Properties</CardTitle></CardHeader><CardContent className="space-y-3">{selected ? <><div><Label>Label</Label><Input value={selected.label || ""} onChange={(e) => updateField(selected.id, { label: e.target.value })} /></div><div><Label>Placeholder</Label><Input value={selected.placeholder || ""} onChange={(e) => updateField(selected.id, { placeholder: e.target.value })} /></div><div><Label>Options JSON</Label><Textarea rows={4} value={JSON.stringify(selected.options || [], null, 2)} onChange={(e) => { try { updateField(selected.id, { options: JSON.parse(e.target.value) }); } catch {} }} /></div></> : <p className="text-sm text-muted-foreground">Select a field.</p>}</CardContent></Card><Card><CardHeader><CardTitle className="text-base">Preview</CardTitle></CardHeader><CardContent><FormRenderer form={form} readOnly /></CardContent></Card></div>
  </div>;
}
