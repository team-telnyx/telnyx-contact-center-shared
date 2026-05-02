"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DndContext, useDraggable, useDroppable } from "@dnd-kit/core";
import { useRouter } from "next/navigation";
import { IconBlocks, IconEye, IconGitBranch, IconLoader2, IconMessageCircle, IconPencil, IconPhoto, IconPlus, IconSettings, IconTemplate, IconTrash, IconWorldUpload } from "@tabler/icons-react";
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
import { FormRenderer } from "@/components/forms/FormRenderer";

const RAIL = [
  { id: "ai", label: "AI", icon: IconMessageCircle },
  { id: "blocks", label: "Blocks", icon: IconBlocks },
  { id: "templates", label: "Templates", icon: IconTemplate },
  { id: "media", label: "Media", icon: IconPhoto },
  { id: "fields", label: "Fields", icon: IconPencil },
  { id: "outline", label: "Outline", icon: IconGitBranch },
];

const BLOCK_GROUPS = [
  { title: "Layout", items: ["section", "row", "columns", "grid"] },
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
  if (type === "section") base.helpText = "Group related fields under this heading.";
  if (type === "columns") base.props = { columns: 2 };
  if (type === "grid") base.props = { columns: 2, gap: "md" };
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
  const [aiLoading, setAiLoading] = useState(false);
  const aiMessagesEndRef = useRef(null);
  const [aiMessages, setAiMessages] = useState([{ role: "assistant", text: "Tell me what this form should collect, or ask for a change. I’ll apply it to the draft and keep you in the visual builder." }]);
  const [templates, setTemplates] = useState([]);
  const [media, setMedia] = useState([]);
  const [uploadingMedia, setUploadingMedia] = useState(false);

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
    if (!prompt || aiLoading) return;
    setAiPrompt("");
    setAiLoading(true);
    setAiMessages((prev) => [...prev, { role: "user", text: prompt }]);
    try {
      const res = await fetch(`/api/admin/forms/${form.id || "draft"}/ai`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, currentForm: form }) });
      const data = await res.json();
      if (data.ok !== false && data.form) setForm(normalizeFormDefinition(data.form));
      const text = data.ai?.reason || data.reason || data.todo || data.error || (data.form && data.ok !== false ? "Updated the draft form." : "I couldn’t apply a change.");
      setAiMessages((prev) => [...prev, { role: "assistant", text }]);
    } catch (err) {
      setAiMessages((prev) => [...prev, { role: "assistant", text: err.message || "AI edit failed." }]);
    } finally {
      setAiLoading(false);
    }
  }

  function clearAiChat() {
    setAiPrompt("");
    setAiMessages([{ role: "assistant", text: "Tell me what this form should collect, or ask for a change. I’ll apply it to the draft and keep you in the visual builder." }]);
  }

  useEffect(() => {
    aiMessagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [aiMessages, aiLoading, activeTab]);

  useEffect(() => {
    if (activeTab !== "templates" || templates.length) return;
    fetch("/api/admin/form-templates", { cache: "no-store" }).then((r) => r.json()).then((data) => { if (data.ok) setTemplates(data.templates || []); }).catch(() => {});
  }, [activeTab, templates.length]);

  async function loadMedia() {
    const res = await fetch("/api/admin/forms/media", { cache: "no-store" });
    const data = await res.json();
    if (data.ok) setMedia(data.media || []);
  }
  useEffect(() => { if (activeTab === "media") loadMedia().catch(() => {}); }, [activeTab]);

  async function uploadMediaFile(file) {
    if (!file) return;
    setUploadingMedia(true); setMessage("");
    try {
      const body = new FormData(); body.append("file", file);
      const res = await fetch("/api/admin/forms/media", { method: "POST", body });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Upload failed");
      setMedia(data.mediaList || []); setMessage("Media uploaded.");
    } catch (err) { setMessage(err.message || "Upload failed"); }
    finally { setUploadingMedia(false); }
  }

  async function createFromTemplate(template) {
    const draft = normalizeFormDefinition({ ...template, id: undefined, status: "draft", slug: `${slugifyFormName(template.name)}-${Date.now().toString(36)}` });
    const res = await fetch("/api/admin/forms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
    const data = await res.json();
    if (!res.ok || !data.ok) { setMessage(data.error || "Template create failed"); return; }
    router.push(`/admin/forms/${data.form.id}`);
  }

  function addMediaImage(item) {
    const field = newField("image");
    field.label = item.name; field.props = { src: item.url };
    update({ ...form, schema: { ...form.schema, fields: [...form.schema.fields, field] }, layout: { ...form.layout, order: [...(form.layout.order || []), field.id] } });
    setSelectedId(field.id); setActiveTab("fields");
  }

  function handleDragEnd(event) {
    const type = event.active?.data?.current?.type;
    if (event.over?.id === "form-canvas" && type) addField(type);
  }

  return <div className="h-[calc(100vh-var(--header-height)-2rem)] min-h-0 -my-4 md:-my-6 flex flex-col overflow-hidden bg-muted/40">
    <div className="h-14 shrink-0 border-b bg-background px-4 flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0"><h1 className="text-base font-semibold truncate">{form.name || "Untitled form"}</h1><Badge variant="outline">{form.status || "draft"}</Badge>{message ? <span className="text-xs text-muted-foreground truncate">{message}</span> : null}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setPreviewMode((v) => !v)}><IconEye className="h-4 w-4 mr-1" />{previewMode ? "Edit" : "View"}</Button>
        <Button variant="outline" size="sm" onClick={() => save()} disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
        <Button size="sm" onClick={publish} disabled={saving}><IconWorldUpload className="h-4 w-4 mr-1" />Publish</Button>
      </div>
    </div>

    <DndContext onDragEnd={handleDragEnd}>
    <div className="grid flex-1 min-h-0 gap-3 p-3 grid-cols-[72px_320px_minmax(0,1fr)_360px]">
      <section className="min-h-0 overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="h-full overflow-y-auto p-2 flex flex-col items-center gap-2">
          {RAIL.map(({ id, label, icon: Icon }) => <button key={id} type="button" onClick={() => setActiveTab(id)} className={`w-14 rounded-lg px-2 py-3 text-[10px] flex flex-col items-center gap-1 transition ${activeTab === id ? "bg-primary text-primary-foreground shadow" : "text-muted-foreground hover:bg-muted"}`}><Icon className="h-5 w-5" />{label}</button>)}
        </div>
      </section>

      <section className="min-h-0 overflow-hidden rounded-xl border bg-card shadow-sm flex flex-col">
        <LeftPanel activeTab={activeTab} form={form} orderedFields={orderedFields} selectedId={selectedId} setSelectedId={setSelectedId} addField={addField} removeField={removeField} duplicateField={duplicateField} moveField={moveField} aiMessages={aiMessages} aiPrompt={aiPrompt} setAiPrompt={setAiPrompt} sendAi={sendAi} clearAiChat={clearAiChat} aiLoading={aiLoading} aiMessagesEndRef={aiMessagesEndRef} templates={templates} createFromTemplate={createFromTemplate} media={media} uploadMediaFile={uploadMediaFile} uploadingMedia={uploadingMedia} addMediaImage={addMediaImage} />
      </section>

      <section className="min-h-0 overflow-hidden rounded-xl border bg-card shadow-sm flex flex-col">
        <div className="h-12 shrink-0 border-b px-4 flex items-center justify-between bg-card">
          <div><div className="text-sm font-semibold">Visual canvas</div><div className="text-[11px] text-muted-foreground">Form preview and component selection</div></div>
          <div className="text-xs text-muted-foreground">100% · Desktop</div>
        </div>
        <CanvasDropZone>
          <div className="mx-auto max-w-4xl rounded-2xl border bg-white shadow-sm min-h-full p-8">
            <div className="mx-auto max-w-2xl space-y-6">
              <div className="border-b pb-5"><h2 className="text-2xl font-semibold tracking-tight text-slate-950">{form.name}</h2>{form.description ? <p className="mt-2 text-sm text-slate-500">{form.description}</p> : null}</div>
              {orderedFields.map((field) => <CanvasField key={field.id} field={field} selected={selectedId === field.id && !previewMode} readOnly={previewMode} onSelect={() => !previewMode && setSelectedId(field.id)} />)}
              {!orderedFields.length ? <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">Add blocks from the left palette to start building.</div> : null}
            </div>
          </div>
        </CanvasDropZone>
      </section>

      <section className="min-h-0 overflow-hidden rounded-xl border bg-card shadow-sm flex flex-col">
        <PropertiesPanel form={form} patchForm={patchForm} selectedField={selectedField} selectedId={selectedId} setSelectedId={setSelectedId} updateField={updateField} />
      </section>
    </div>
    </DndContext>
  </div>;
}

function PanelHeader({ title, description }) {
  return <div className="h-14 shrink-0 border-b px-4 flex flex-col justify-center">
    <h2 className="font-semibold text-sm">{title}</h2>
    <p className="text-xs text-muted-foreground">{description}</p>
  </div>;
}

function LeftPanel(props) {
  const { activeTab, form, orderedFields, selectedId, setSelectedId, addField, removeField, duplicateField, moveField, aiMessages, aiPrompt, setAiPrompt, sendAi, clearAiChat, aiLoading, aiMessagesEndRef, templates = [], createFromTemplate, media = [], uploadMediaFile, uploadingMedia, addMediaImage } = props;

  if (activeTab === "ai") {
    return <div className="h-full min-h-0 flex flex-col">
      <div className="h-14 shrink-0 border-b px-4 flex items-center justify-between gap-2">
        <div className="min-w-0"><h2 className="font-semibold text-sm">AI form agent</h2><p className="text-xs text-muted-foreground">Describe changes, then refine visually.</p></div>
        <Button size="sm" variant="ghost" onClick={clearAiChat} disabled={aiLoading}>Clear</Button>
      </div>
      <div className="flex-1 min-h-0 space-y-3 overflow-y-auto p-4">
        {aiMessages.map((msg, i) => <div key={i} className={`rounded-xl p-3 text-sm ${msg.role === "user" ? "bg-primary text-primary-foreground ml-6" : "bg-muted mr-6"}`}>{msg.text}</div>)}
        {aiLoading ? <div className="mr-6 flex items-center gap-2 rounded-xl bg-muted p-3 text-sm text-muted-foreground"><IconLoader2 className="h-4 w-4 animate-spin" />Waiting for a response...</div> : null}
        <div ref={aiMessagesEndRef} />
      </div>
      <div className="shrink-0 border-t p-4 space-y-2">
        <Textarea rows={4} placeholder="Add a customer verification section..." value={aiPrompt} disabled={aiLoading} onChange={(e) => setAiPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendAi(); } }} />
        <Button className="w-full" onClick={sendAi} disabled={aiLoading || !aiPrompt.trim()}>{aiLoading ? <><IconLoader2 className="mr-2 h-4 w-4 animate-spin" />Waiting...</> : "Send to AI"}</Button>
      </div>
    </div>;
  }

  if (activeTab === "blocks") {
    return <div className="h-full min-h-0 flex flex-col">
      <PanelHeader title="Blocks" description="Add custom schema components." />
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-5">
        {BLOCK_GROUPS.map((group) => <div key={group.title} className="space-y-2">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground">{group.title}</h3>
          <div className="grid gap-2">
            {group.items.map((type) => <DraggableBlock key={type} type={type} addField={addField} />)}
          </div>
        </div>)}
      </div>
    </div>;
  }

  if (activeTab === "templates") {
    return <div className="h-full min-h-0 flex flex-col">
      <PanelHeader title="Templates" description="Start from one of 9 seeded examples." />
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        {templates.map((template) => <button key={template.slug || template.id} type="button" onClick={() => createFromTemplate?.(template)} className="w-full rounded-xl border bg-background p-3 text-left transition hover:border-primary hover:bg-primary/5">
          <div className="flex items-start justify-between gap-2"><div><div className="text-sm font-semibold">{template.name}</div><div className="text-xs text-muted-foreground">{template.category}</div></div><Badge variant="outline">Use</Badge></div>
          <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{template.description}</p>
          <div className="mt-3 h-28 overflow-hidden rounded-lg border bg-slate-50 p-2"><div className="origin-top-left scale-[0.48] w-[200%] pointer-events-none rounded bg-white p-3"><MiniTemplatePreview form={template} /></div></div>
        </button>)}
      </div>
    </div>;
  }

  if (activeTab === "media") {
    return <div className="h-full min-h-0 flex flex-col">
      <PanelHeader title="Media" description="Upload images to /public/media and add them to forms." />
      <div className="shrink-0 border-b p-4 space-y-2">
        <Input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" disabled={uploadingMedia} onChange={(e) => uploadMediaFile?.(e.target.files?.[0])} />
        <p className="text-xs text-muted-foreground">Max 5MB. Safe filenames are generated automatically.</p>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-4 grid grid-cols-2 gap-3">
        {media.map((item) => <button key={item.url} type="button" onClick={() => addMediaImage?.(item)} className="rounded-xl border bg-background p-2 text-left hover:border-primary">
          <div className="aspect-video rounded-md bg-muted overflow-hidden flex items-center justify-center"><img src={item.url} alt={item.name} className="max-h-full max-w-full object-contain" /></div>
          <div className="mt-2 truncate text-xs font-medium">{item.name}</div>
        </button>)}
        {!media.length ? <div className="col-span-2 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No media uploaded yet.</div> : null}
      </div>
    </div>;
  }

  if (activeTab === "outline") {
    return <div className="h-full min-h-0 flex flex-col">
      <PanelHeader title="Outline" description="Page structure and render order." />
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        <div className="rounded-lg border bg-muted/30 p-2 text-sm font-medium">{form.name}</div>
        <div className="ml-4 border-l pl-3 space-y-2">
          {orderedFields.map((field, index) => <button key={field.id} className={`block w-full rounded-md border p-2 text-left text-sm ${selectedId === field.id ? "border-primary bg-primary/5" : "bg-background"}`} onClick={() => setSelectedId(field.id)}>
            {index + 1}. {field.label || field.id}
            <div className="text-xs text-muted-foreground">{field.type}</div>
          </button>)}
        </div>
      </div>
    </div>;
  }

  return <div className="h-full min-h-0 flex flex-col">
    <PanelHeader title="Fields" description="Select, duplicate, remove, and reorder fields." />
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
      {orderedFields.map((field) => <div key={field.id} className={`rounded-xl border p-3 ${selectedId === field.id ? "border-primary bg-primary/5" : "bg-background"}`} onClick={() => setSelectedId(field.id)}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-sm font-medium">{field.label || field.id}</div>
            <div className="text-xs text-muted-foreground">{field.id} · {field.type}</div>
          </div>
          <Badge variant="outline">{field.required ? "required" : "optional"}</Badge>
        </div>
        <div className="mt-3 flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); moveField(field.id, -1); }}>↑</Button>
          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); moveField(field.id, 1); }}>↓</Button>
          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); duplicateField(field); }}>Duplicate</Button>
          <Button size="sm" variant="ghost" className="text-destructive" onClick={(e) => { e.stopPropagation(); removeField(field.id); }}><IconTrash className="h-4 w-4" /></Button>
        </div>
      </div>)}
    </div>
  </div>;
}

function CanvasDropZone({ children }) {
  const { isOver, setNodeRef } = useDroppable({ id: "form-canvas" });
  return <div ref={setNodeRef} className={`flex-1 min-h-0 overflow-auto p-6 transition ${isOver ? "bg-primary/10" : "bg-slate-200/70"}`}>{children}</div>;
}

function DraggableBlock({ type, addField }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `block-${type}`, data: { type } });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;
  return <Button ref={setNodeRef} style={style} variant="outline" className={`justify-start touch-none ${isDragging ? "opacity-60 shadow-lg" : ""}`} onClick={() => addField(type)} {...listeners} {...attributes}><IconPlus className="h-4 w-4 mr-2" />{FORM_COMPONENT_REGISTRY[type]?.label || type}</Button>;
}

function MiniTemplatePreview({ form }) {
  return <FormRenderer form={form} readOnly />;
}

function CanvasField({ field, selected, onSelect, readOnly }) {
  const shell = `relative rounded-xl border p-4 transition ${selected ? "border-primary ring-2 ring-primary/20 bg-primary/5" : "border-transparent hover:border-muted-foreground/25"}`;
  if (field.type === "section") return <div onClick={onSelect} className={shell}><div className="rounded-lg border bg-muted/25 p-4"><div className="text-sm font-semibold">{field.label}</div>{field.helpText ? <p className="mt-1 text-xs text-muted-foreground">{field.helpText}</p> : null}</div></div>;
  if (field.type === "row") return <div onClick={onSelect} className={shell}><div className="rounded-lg border border-dashed p-3 text-xs font-medium text-muted-foreground">Row · {field.label}</div></div>;
  if (field.type === "columns") { const count = Math.max(2, Math.min(Number(field.props?.columns || 2), 4)); return <div onClick={onSelect} className={shell}><div className="rounded-lg border border-dashed p-3"><div className="mb-2 text-xs font-medium text-muted-foreground">{field.label || `${count} columns`}</div><div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>{Array.from({ length: count }).map((_, i) => <div key={i} className="min-h-16 rounded-md bg-muted/60" />)}</div></div></div>; }
  if (field.type === "grid") return <div onClick={onSelect} className={shell}><div className="rounded-lg border border-dashed p-3 text-xs font-medium text-muted-foreground">Grid · {field.label}</div></div>;
  if (field.type === "hidden") return <div onClick={onSelect} className={shell}><Badge variant="outline">Hidden</Badge> <span className="text-sm text-muted-foreground">{field.id}</span></div>;
  if (field.type === "label") return <div onClick={onSelect} className={shell}><div className="text-base font-semibold">{field.label}</div>{field.helpText ? <p className="text-xs text-muted-foreground">{field.helpText}</p> : null}</div>;
  if (field.type === "context_value") return <div onClick={onSelect} className={shell}><Label>{field.label}</Label><div className="mt-2 rounded-md bg-muted p-3 font-mono text-xs">{field.contextPath || "caller.from_number"}</div></div>;
  if (field.type === "image") return <div onClick={onSelect} className={shell}>{field.props?.src ? <img src={field.props.src} alt={field.label || "Form image"} className="max-h-48 rounded-md border object-contain" /> : <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">Image block</div>}</div>;
  if (field.type === "button") return <div onClick={onSelect} className={shell}><Button disabled={readOnly}>{field.label || "Submit"}</Button></div>;
  return <div onClick={onSelect} className={shell}><Label>{field.label}{field.required ? <span className="text-destructive"> *</span> : null}</Label>{field.type === "textarea" ? <Textarea className="mt-2" placeholder={field.placeholder} disabled={readOnly} /> : field.type === "select" ? <Select disabled={readOnly}><SelectTrigger className="mt-2"><SelectValue placeholder={field.placeholder || "Select..."} /></SelectTrigger><SelectContent>{(field.options || []).map((o) => <SelectItem key={o.value} value={String(o.value)}>{o.label || o.value}</SelectItem>)}</SelectContent></Select> : field.type === "radio" ? <div className="mt-2 space-y-2">{(field.options || []).map((o) => <label key={o.value} className="flex items-center gap-2 text-sm"><input type="radio" disabled={readOnly} />{o.label || o.value}</label>)}</div> : field.type === "checkbox" ? <div className="mt-2 flex items-center gap-2"><Checkbox disabled={readOnly} /><span className="text-sm text-muted-foreground">{field.placeholder || "Yes"}</span></div> : <Input className="mt-2" placeholder={field.placeholder} disabled={readOnly} />}{field.helpText ? <p className="mt-2 text-xs text-muted-foreground">{field.helpText}</p> : null}</div>;
}

function PropertiesPanel({ form, patchForm, selectedField, selectedId, setSelectedId, updateField }) {
  return <div className="h-full min-h-0 flex flex-col"><div className="h-14 shrink-0 border-b px-4 flex items-center gap-2"><IconSettings className="h-5 w-5" /><div><h2 className="font-semibold text-sm">Properties</h2><p className="text-xs text-muted-foreground">Form and selected component settings.</p></div></div><div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-5"><Card><CardContent className="p-4 space-y-3"><button className={`w-full rounded-md border p-2 text-left text-sm ${selectedId === "form" ? "border-primary bg-primary/5" : ""}`} onClick={() => setSelectedId("form")}>Form settings</button><div><Label>Name</Label><Input value={form.name || ""} onChange={(e) => patchForm({ name: e.target.value, slug: form.slug || slugifyFormName(e.target.value) })} /></div><div><Label>Slug</Label><Input value={form.slug || ""} onChange={(e) => patchForm({ slug: e.target.value })} /></div><div><Label>Category</Label><Input value={form.category || ""} onChange={(e) => patchForm({ category: e.target.value })} /></div><div><Label>Description</Label><Textarea rows={3} value={form.description || ""} onChange={(e) => patchForm({ description: e.target.value })} /></div><div><Label>Queue names</Label><Input value={(form.queue_names || []).join(", ")} onChange={(e) => patchForm({ queue_names: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></div><div className="flex items-center justify-between rounded-md border p-2"><Label>Auto-open</Label><Switch checked={Boolean(form.auto_open)} onCheckedChange={(checked) => patchForm({ auto_open: checked })} /></div></CardContent></Card>{selectedField ? <Card><CardContent className="p-4 space-y-3"><div className="flex items-center justify-between"><h3 className="font-medium">Selected field</h3><Badge variant="outline">{selectedField.type}</Badge></div><div><Label>Label</Label><Input value={selectedField.label || ""} onChange={(e) => updateField(selectedField.id, { label: e.target.value })} /></div><div><Label>Field name / id</Label><Input value={selectedField.id || ""} onChange={(e) => updateField(selectedField.id, { id: e.target.value })} /></div><div><Label>Type</Label><Select value={selectedField.type} onValueChange={(value) => updateField(selectedField.id, { type: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{FORM_COMPONENT_TYPES.map((type) => <SelectItem key={type} value={type}>{FORM_COMPONENT_REGISTRY[type]?.label || type}</SelectItem>)}</SelectContent></Select></div><div className="flex items-center justify-between rounded-md border p-2"><Label>Required</Label><Switch checked={Boolean(selectedField.required)} onCheckedChange={(checked) => updateField(selectedField.id, { required: checked })} /></div><div><Label>Placeholder</Label><Input value={selectedField.placeholder || ""} onChange={(e) => updateField(selectedField.id, { placeholder: e.target.value })} /></div><div><Label>Help text</Label><Input value={selectedField.helpText || ""} onChange={(e) => updateField(selectedField.id, { helpText: e.target.value })} /></div><div><Label>Binding path</Label><Input value={form.bindings?.[selectedField.id] || ""} placeholder="customer.name" onChange={(e) => patchForm({ bindings: { ...(form.bindings || {}), [selectedField.id]: e.target.value } })} /></div><div><Label>Context path</Label><Input value={selectedField.contextPath || ""} placeholder="caller.from_number" onChange={(e) => updateField(selectedField.id, { contextPath: e.target.value })} /></div><div><Label>Style tokens JSON</Label><Textarea rows={3} className="font-mono text-xs" value={JSON.stringify(selectedField.props || {}, null, 2)} onChange={(e) => { try { updateField(selectedField.id, { props: JSON.parse(e.target.value) }); } catch {} }} /></div><div><Label>Options JSON</Label><Textarea rows={5} className="font-mono text-xs" value={JSON.stringify(selectedField.options || [], null, 2)} onChange={(e) => { try { updateField(selectedField.id, { options: JSON.parse(e.target.value) }); } catch {} }} /></div></CardContent></Card> : null}</div></div>;
}
