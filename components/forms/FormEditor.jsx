"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { IconBlocks, IconEye, IconGitBranch, IconMessageCircle, IconPencil, IconPlus, IconSettings, IconTrash, IconWorldUpload } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { FORM_COMPONENT_TYPES, FORM_COMPONENT_REGISTRY, createDefaultForm, normalizeFormDefinition, slugifyFormName } from "@/lib/forms/form-schema";

const RAIL = [
  { id: "ai", label: "AI", icon: IconMessageCircle },
  { id: "blocks", label: "Blocks", icon: IconBlocks },
  { id: "fields", label: "Fields", icon: IconPencil },
  { id: "outline", label: "Outline", icon: IconGitBranch },
];

const BLOCK_GROUPS = [
  { title: "Basic", items: ["text", "textarea", "select", "checkbox", "radio"] },
  { title: "Content", items: ["label", "image", "context_value"] },
  { title: "Actions", items: ["button", "hidden"] },
];

function makeId(type) {
  return `${type}_${Math.random().toString(36).slice(2, 7)}`;
}

function newField(type) {
  const id = makeId(type);
  const base = { id, type, label: FORM_COMPONENT_REGISTRY[type]?.label || type, placeholder: "", required: false, options: [] };
  if (type === "select" || type === "radio") base.options = [{ label: "Option A", value: "a" }, { label: "Option B", value: "b" }];
  if (type === "button") base.label = "Submit";
  if (type === "context_value") base.contextPath = "caller.from_number";
  if (type === "image") base.props = { src: "" };
  return base;
}

export function FormEditor({ initialForm, isNew = false }) {
  const router = useRouter();
  const [form, setForm] = useState(() => normalizeFormDefinition(initialForm || createDefaultForm({ name: "New agent form" })));
  const [selectedId, setSelectedId] = useState(() => form.schema.fields[0]?.id || "form");
  const [activeTab, setActiveTab] = useState("ai");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [previewMode, setPreviewMode] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiMessages, setAiMessages] = useState([{ role: "assistant", text: "Tell me what this form should collect, or ask for a change. I’ll apply it to the draft and keep you in the visual builder." }]);

  const orderedFields = useMemo(() => {
    const byId = new Map((form.schema?.fields || []).map((f) => [f.id, f]));
    return (form.layout?.order || []).map((id) => byId.get(id)).filter(Boolean);
  }, [form]);
  const selectedField = orderedFields.find((f) => f.id === selectedId) || null;

  useEffect(() => {
    if (!selectedField && orderedFields[0]) setSelectedId(orderedFields[0].id);
  }, [orderedFields, selectedField]);

  function update(next) {
    setForm(normalizeFormDefinition(next));
  }
  function patchForm(patch) {
    update({ ...form, ...patch });
  }
  function updateField(id, patch) {
    update({ ...form, schema: { ...form.schema, fields: form.schema.fields.map((field) => field.id === id ? { ...field, ...patch } : field) } });
  }
  function addField(type) {
    const field = newField(type);
    update({ ...form, schema: { ...form.schema, fields: [...form.schema.fields, field] }, layout: { ...form.layout, order: [...(form.layout.order || []), field.id] } });
    setSelectedId(field.id);
    setActiveTab("fields");
  }
  function removeField(id) {
    const next = orderedFields.filter((field) => field.id !== id);
    update({ ...form, schema: { ...form.schema, fields: form.schema.fields.filter((field) => field.id !== id) }, layout: { ...form.layout, order: next.map((field) => field.id) } });
    setSelectedId(next[0]?.id || "form");
  }
  function duplicateField(field) {
    const copy = { ...field, id: makeId(field.type), label: `${field.label || field.id} copy` };
    const order = [...(form.layout.order || [])];
    const index = order.indexOf(field.id);
    order.splice(index + 1, 0, copy.id);
    update({ ...form, schema: { ...form.schema, fields: [...form.schema.fields, copy] }, layout: { ...form.layout, order } });
    setSelectedId(copy.id);
  }
  function moveField(id, dir) {
    const order = [...(form.layout.order || [])];
    const i = order.indexOf(id); const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    update({ ...form, layout: { ...form.layout, order } });
  }

  async function save(status) {
    setSaving(true); setMessage("");
    try {
      const payload = normalizeFormDefinition({ ...form, status: status || form.status, slug: form.slug || slugifyFormName(form.name) });
      const creating = isNew || !payload.id;
      const res = await fetch(creating ? "/api/admin/forms" : `/api/admin/forms/${payload.id}`, { method: creating ? "POST" : "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Save failed");
      setForm(normalizeFormDefinition(data.form));
      setMessage(status === "published" ? "Published." : "Saved.");
      if (creating && data.form?.id) router.replace(`/admin/forms/${data.form.id}`);
      return data.form;
    } catch (err) {
      setMessage(err.message || "Save failed");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function publish() {
    const saved = await save("published");
    if (!saved?.id) return;
    const res = await fetch(`/api/admin/forms/${saved.id}/publish`, { method: "POST" });
    const data = await res.json();
    if (data.ok) { setForm(normalizeFormDefinition(data.form)); setMessage("Published."); }
    else setMessage(data.error || "Publish failed");
  }

  async function sendAi() {
    const prompt = aiPrompt.trim();
    if (!prompt) return;
    setAiPrompt("");
    setAiMessages((prev) => [...prev, { role: "user", text: prompt }]);
    try {
      const res = await fetch(`/api/admin/forms/${form.id || "draft"}/ai`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, currentForm: form }) });
      const data = await res.json();
      if (data.form) setForm(normalizeFormDefinition(data.form));
      const text = data.ai?.reason || data.reason || data.todo || data.error || (data.form ? "Updated the draft form." : "I couldn’t apply a change.");
      setAiMessages((prev) => [...prev, { role: "assistant", text }]);
    } catch (err) {
      setAiMessages((prev) => [...prev, { role: "assistant", text: err.message || "AI edit failed." }]);
    }
  }

  return <div className="min-h-[calc(100vh-5rem)] bg-slate-100/80 -m-6 flex flex-col">
    <div className="h-16 border-b bg-background px-5 flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">Admin / Forms / Builder</div>
        <div className="flex items-center gap-2 min-w-0"><h1 className="text-lg font-semibold truncate">{form.name || "Untitled form"}</h1><Badge variant="outline">{form.status || "draft"}</Badge>{message ? <span className="text-xs text-muted-foreground">{message}</span> : null}</div>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setPreviewMode((v) => !v)}><IconEye className="h-4 w-4 mr-1" />{previewMode ? "Edit" : "View"}</Button>
        <Button variant="outline" size="sm" onClick={() => save()} disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
        <Button size="sm" onClick={publish} disabled={saving}><IconWorldUpload className="h-4 w-4 mr-1" />Publish</Button>
      </div>
    </div>

    <div className="flex flex-1 min-h-0">
      <aside className="w-16 border-r bg-background flex flex-col items-center py-3 gap-2">
        {RAIL.map(({ id, label, icon: Icon }) => <button key={id} type="button" onClick={() => setActiveTab(id)} className={`w-12 rounded-xl p-2 text-[10px] flex flex-col items-center gap-1 transition ${activeTab === id ? "bg-primary text-primary-foreground shadow" : "text-muted-foreground hover:bg-muted"}`}><Icon className="h-5 w-5" />{label}</button>)}
      </aside>

      <aside className="w-80 border-r bg-background/95 overflow-y-auto">
        <LeftPanel activeTab={activeTab} form={form} orderedFields={orderedFields} selectedId={selectedId} setSelectedId={setSelectedId} addField={addField} removeField={removeField} duplicateField={duplicateField} moveField={moveField} aiMessages={aiMessages} aiPrompt={aiPrompt} setAiPrompt={setAiPrompt} sendAi={sendAi} />
      </aside>

      <main className="flex-1 min-w-0 overflow-auto p-6">
        <div className="mx-auto max-w-4xl">
          <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground"><span>Visual canvas</span><span>100% · Desktop</span></div>
          <div className="rounded-2xl border bg-white shadow-sm min-h-[680px] p-8">
            <div className="mx-auto max-w-2xl space-y-6">
              <div className="border-b pb-5"><h2 className="text-2xl font-semibold tracking-tight">{form.name}</h2>{form.description ? <p className="mt-2 text-sm text-muted-foreground">{form.description}</p> : null}</div>
              {orderedFields.map((field) => <CanvasField key={field.id} field={field} selected={selectedId === field.id && !previewMode} readOnly={previewMode} onSelect={() => !previewMode && setSelectedId(field.id)} />)}
              {!orderedFields.length ? <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">Add blocks from the left palette to start building.</div> : null}
            </div>
          </div>
        </div>
      </main>

      <aside className="w-96 border-l bg-background overflow-y-auto">
        <PropertiesPanel form={form} patchForm={patchForm} selectedField={selectedField} selectedId={selectedId} setSelectedId={setSelectedId} updateField={updateField} />
      </aside>
    </div>
  </div>;
}

function LeftPanel(props) {
  const { activeTab, form, orderedFields, selectedId, setSelectedId, addField, removeField, duplicateField, moveField, aiMessages, aiPrompt, setAiPrompt, sendAi } = props;
  if (activeTab === "ai") return <div className="p-4 h-full flex flex-col gap-3"><div><h2 className="font-semibold">AI form agent</h2><p className="text-xs text-muted-foreground">Describe changes, then refine visually.</p></div><div className="flex-1 space-y-3 overflow-y-auto pr-1">{aiMessages.map((msg, i) => <div key={i} className={`rounded-xl p-3 text-sm ${msg.role === "user" ? "bg-primary text-primary-foreground ml-6" : "bg-muted mr-6"}`}>{msg.text}</div>)}</div><Textarea rows={4} placeholder="Add a customer verification section..." value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendAi(); }} /><Button onClick={sendAi}>Send to AI</Button></div>;
  if (activeTab === "blocks") return <div className="p-4 space-y-5"><div><h2 className="font-semibold">Blocks</h2><p className="text-xs text-muted-foreground">Add custom schema components. Drag/drop can come later; this iteration keeps controls explicit.</p></div>{BLOCK_GROUPS.map((group) => <div key={group.title} className="space-y-2"><h3 className="text-xs font-semibold uppercase text-muted-foreground">{group.title}</h3><div className="grid gap-2">{group.items.map((type) => <Button key={type} variant="outline" className="justify-start" onClick={() => addField(type)}><IconPlus className="h-4 w-4 mr-2" />{FORM_COMPONENT_REGISTRY[type]?.label || type}</Button>)}</div></div>)}</div>;
  if (activeTab === "outline") return <div className="p-4 space-y-3"><div><h2 className="font-semibold">Outline</h2><p className="text-xs text-muted-foreground">Page structure and render order.</p></div><div className="rounded-lg border bg-muted/30 p-2 text-sm font-medium">{form.name}</div><div className="ml-4 border-l pl-3 space-y-2">{orderedFields.map((field, index) => <button key={field.id} className={`block w-full rounded-md border p-2 text-left text-sm ${selectedId === field.id ? "border-primary bg-primary/5" : "bg-background"}`} onClick={() => setSelectedId(field.id)}>{index + 1}. {field.label || field.id}<div className="text-xs text-muted-foreground">{field.type}</div></button>)}</div></div>;
  return <div className="p-4 space-y-3"><div><h2 className="font-semibold">Fields</h2><p className="text-xs text-muted-foreground">Select, duplicate, remove, and reorder fields.</p></div>{orderedFields.map((field) => <div key={field.id} className={`rounded-xl border p-3 ${selectedId === field.id ? "border-primary bg-primary/5" : "bg-background"}`} onClick={() => setSelectedId(field.id)}><div className="flex items-start justify-between gap-2"><div><div className="text-sm font-medium">{field.label || field.id}</div><div className="text-xs text-muted-foreground">{field.id} · {field.type}</div></div><Badge variant="outline">{field.required ? "required" : "optional"}</Badge></div><div className="mt-3 flex flex-wrap gap-1"><Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); moveField(field.id, -1); }}>↑</Button><Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); moveField(field.id, 1); }}>↓</Button><Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); duplicateField(field); }}>Duplicate</Button><Button size="sm" variant="ghost" className="text-destructive" onClick={(e) => { e.stopPropagation(); removeField(field.id); }}><IconTrash className="h-4 w-4" /></Button></div></div>)}</div>;
}

function CanvasField({ field, selected, onSelect, readOnly }) {
  const shell = `relative rounded-xl border p-4 transition ${selected ? "border-primary ring-2 ring-primary/20 bg-primary/5" : "border-transparent hover:border-muted-foreground/25"}`;
  if (field.type === "hidden") return <div onClick={onSelect} className={shell}><Badge variant="outline">Hidden</Badge> <span className="text-sm text-muted-foreground">{field.id}</span></div>;
  if (field.type === "label") return <div onClick={onSelect} className={shell}><div className="text-base font-semibold">{field.label}</div>{field.helpText ? <p className="text-xs text-muted-foreground">{field.helpText}</p> : null}</div>;
  if (field.type === "context_value") return <div onClick={onSelect} className={shell}><Label>{field.label}</Label><div className="mt-2 rounded-md bg-muted p-3 font-mono text-xs">{field.contextPath || "caller.from_number"}</div></div>;
  if (field.type === "image") return <div onClick={onSelect} className={shell}>{field.props?.src ? <img src={field.props.src} alt={field.label || "Form image"} className="max-h-48 rounded-md border object-contain" /> : <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">Image block</div>}</div>;
  if (field.type === "button") return <div onClick={onSelect} className={shell}><Button disabled={readOnly}>{field.label || "Submit"}</Button></div>;
  return <div onClick={onSelect} className={shell}><Label>{field.label}{field.required ? <span className="text-destructive"> *</span> : null}</Label>{field.type === "textarea" ? <Textarea className="mt-2" placeholder={field.placeholder} disabled={readOnly} /> : field.type === "select" ? <Select disabled={readOnly}><SelectTrigger className="mt-2"><SelectValue placeholder={field.placeholder || "Select..."} /></SelectTrigger><SelectContent>{(field.options || []).map((o) => <SelectItem key={o.value} value={String(o.value)}>{o.label || o.value}</SelectItem>)}</SelectContent></Select> : field.type === "radio" ? <div className="mt-2 space-y-2">{(field.options || []).map((o) => <label key={o.value} className="flex items-center gap-2 text-sm"><input type="radio" disabled={readOnly} />{o.label || o.value}</label>)}</div> : field.type === "checkbox" ? <div className="mt-2 flex items-center gap-2"><Checkbox disabled={readOnly} /><span className="text-sm text-muted-foreground">{field.placeholder || "Yes"}</span></div> : <Input className="mt-2" placeholder={field.placeholder} disabled={readOnly} />}{field.helpText ? <p className="mt-2 text-xs text-muted-foreground">{field.helpText}</p> : null}</div>;
}

function PropertiesPanel({ form, patchForm, selectedField, selectedId, setSelectedId, updateField }) {
  return <div className="p-4 space-y-5"><div className="flex items-center gap-2"><IconSettings className="h-5 w-5" /><div><h2 className="font-semibold">Properties</h2><p className="text-xs text-muted-foreground">Form and selected component settings.</p></div></div><Card><CardContent className="p-4 space-y-3"><button className={`w-full rounded-md border p-2 text-left text-sm ${selectedId === "form" ? "border-primary bg-primary/5" : ""}`} onClick={() => setSelectedId("form")}>Form settings</button><div><Label>Name</Label><Input value={form.name || ""} onChange={(e) => patchForm({ name: e.target.value, slug: form.slug || slugifyFormName(e.target.value) })} /></div><div><Label>Slug</Label><Input value={form.slug || ""} onChange={(e) => patchForm({ slug: e.target.value })} /></div><div><Label>Category</Label><Input value={form.category || ""} onChange={(e) => patchForm({ category: e.target.value })} /></div><div><Label>Description</Label><Textarea rows={3} value={form.description || ""} onChange={(e) => patchForm({ description: e.target.value })} /></div><div><Label>Queue names</Label><Input value={(form.queue_names || []).join(", ")} onChange={(e) => patchForm({ queue_names: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></div><div className="flex items-center justify-between rounded-md border p-2"><Label>Auto-open</Label><Switch checked={Boolean(form.auto_open)} onCheckedChange={(checked) => patchForm({ auto_open: checked })} /></div></CardContent></Card>{selectedField ? <Card><CardContent className="p-4 space-y-3"><div className="flex items-center justify-between"><h3 className="font-medium">Selected field</h3><Badge variant="outline">{selectedField.type}</Badge></div><div><Label>Label</Label><Input value={selectedField.label || ""} onChange={(e) => updateField(selectedField.id, { label: e.target.value })} /></div><div><Label>Field name / id</Label><Input value={selectedField.id || ""} onChange={(e) => updateField(selectedField.id, { id: e.target.value })} /></div><div><Label>Type</Label><Select value={selectedField.type} onValueChange={(value) => updateField(selectedField.id, { type: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{FORM_COMPONENT_TYPES.map((type) => <SelectItem key={type} value={type}>{FORM_COMPONENT_REGISTRY[type]?.label || type}</SelectItem>)}</SelectContent></Select></div><div className="flex items-center justify-between rounded-md border p-2"><Label>Required</Label><Switch checked={Boolean(selectedField.required)} onCheckedChange={(checked) => updateField(selectedField.id, { required: checked })} /></div><div><Label>Placeholder</Label><Input value={selectedField.placeholder || ""} onChange={(e) => updateField(selectedField.id, { placeholder: e.target.value })} /></div><div><Label>Help text</Label><Input value={selectedField.helpText || ""} onChange={(e) => updateField(selectedField.id, { helpText: e.target.value })} /></div><div><Label>Binding path</Label><Input value={form.bindings?.[selectedField.id] || ""} placeholder="customer.name" onChange={(e) => patchForm({ bindings: { ...(form.bindings || {}), [selectedField.id]: e.target.value } })} /></div><div><Label>Context path</Label><Input value={selectedField.contextPath || ""} placeholder="caller.from_number" onChange={(e) => updateField(selectedField.id, { contextPath: e.target.value })} /></div><div><Label>Style tokens JSON</Label><Textarea rows={3} className="font-mono text-xs" value={JSON.stringify(selectedField.props || {}, null, 2)} onChange={(e) => { try { updateField(selectedField.id, { props: JSON.parse(e.target.value) }); } catch {} }} /></div><div><Label>Options JSON</Label><Textarea rows={5} className="font-mono text-xs" value={JSON.stringify(selectedField.options || [], null, 2)} onChange={(e) => { try { updateField(selectedField.id, { options: JSON.parse(e.target.value) }); } catch {} }} /></div></CardContent></Card> : null}</div>;
}
