"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DndContext, DragOverlay, useDraggable, useDroppable } from "@dnd-kit/core";
import { useRouter } from "next/navigation";
import { IconBlockquote, IconBlocks, IconColumns, IconCursorText, IconForms, IconGripVertical, IconCheckbox, IconChevronDown, IconCircleDot, IconEye, IconGitBranch, IconGridDots, IconHeading, IconLayoutBottombar, IconLayoutCards, IconLoader2, IconMessageCircle, IconMoon, IconPencil, IconPhoto, IconPlus, IconRectangle, IconSettings, IconSun, IconTemplate, IconTrash, IconTypography, IconWorldUpload } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { ColorPicker } from "@/components/ui/color-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { FORM_COMPONENT_TYPES, FORM_COMPONENT_REGISTRY, createDefaultForm, flattenPageOrder, makePageId, normalizeFormDefinition, slugifyFormName } from "@/lib/forms/form-schema";
import { FormRenderer } from "@/components/forms/FormRenderer";

const RAIL = [
  { id: "ai", label: "AI", icon: IconMessageCircle },
  { id: "pages", label: "Pages", icon: IconForms },
  { id: "blocks", label: "Blocks", icon: IconBlocks },
  { id: "templates", label: "Templates", icon: IconTemplate },
  { id: "media", label: "Media", icon: IconPhoto },
  { id: "fields", label: "Fields", icon: IconPencil },
  { id: "outline", label: "Outline", icon: IconGitBranch },
];

const BLOCK_GROUPS = [
  { title: "Layout", color: "border-l-sky-500", iconClass: "text-sky-500", items: ["section", "row", "columns", "grid", "flex", "spacer"] },
  { title: "Marketing", color: "border-l-violet-500", iconClass: "text-violet-500", items: ["hero", "stats", "card", "richtext"] },
  { title: "Basic", color: "border-l-emerald-500", iconClass: "text-emerald-500", items: ["text", "textarea", "select", "checkbox", "radio"] },
  { title: "Content", color: "border-l-amber-500", iconClass: "text-amber-500", items: ["label", "image", "context_value"] },
  { title: "Actions", color: "border-l-rose-500", iconClass: "text-rose-500", items: ["button", "hidden"] },
];

const FORM_CATEGORIES = ["General", "Sales", "Support", "Billing", "Customer onboarding", "Lead capture", "Feedback", "Complaint", "Appointment", "Compliance"];
const PADDING_OPTIONS = ["none", "xs", "sm", "md", "lg", "xl"];
const SIZE_OPTIONS = ["sm", "md", "lg", "xl"];
const ALIGN_OPTIONS = ["left", "center", "right"];
const QUEUE_BADGE_CLASS = { FIFO: "bg-blue-500", "Skill-based": "bg-purple-500", "Priority-based": "bg-orange-500" };

function mergeProps(field, patch) { return { props: { ...(field.props || {}), ...patch } }; }
function paddingClass(value) { return ({ none: "p-0", xs: "p-2", sm: "p-3", md: "p-4", lg: "p-6", xl: "p-8" }[value || "md"] || "p-4"); }
function verticalPaddingClass(value) { return ({ none: "py-0", xs: "py-2", sm: "py-3", md: "py-4", lg: "py-6", xl: "py-8" }[value || "md"] || "py-4"); }
function textSizeClass(value) { return ({ sm: "text-sm", md: "text-base", lg: "text-lg", xl: "text-2xl" }[value || "md"] || "text-base"); }
function alignClass(value) { return ({ left: "text-left", center: "text-center", right: "text-right" }[value || "left"] || "text-left"); }
function fieldStyle(field) { return field.props?.color ? { color: field.props.color } : undefined; }
function queueLabel(queue) { return queue.display_name || queue.displayName || queue.name; }
function queueRouting(queue) { return queue.routing_strategy || queue.routingStrategy || "FIFO"; }
const BLOCK_DESCRIPTIONS = {
  section: "Group related fields with a title.", row: "Visual horizontal container.", columns: "Split content into columns.", grid: "Create an even grid layout.", flex: "Flexible row or column layout.", spacer: "Add visual breathing room.",
  hero: "Large header with CTA copy.", stats: "Metric cards for highlights.", card: "Framed content container.", richtext: "Formatted guidance or copy.",
  text: "Single-line text input.", textarea: "Multi-line notes or comments.", select: "Dropdown choice list.", checkbox: "Boolean consent or flag.", radio: "One choice from visible options.",
  label: "Static heading or helper label.", image: "Image or media block.", context_value: "Show live client context.", button: "Submit or action button.", hidden: "Stored hidden value.",
};
const BLOCK_ICONS = { section: IconHeading, row: IconLayoutBottombar, columns: IconColumns, grid: IconGridDots, flex: IconRectangle, spacer: IconRectangle, hero: IconBlockquote, stats: IconLayoutCards, card: IconLayoutCards, richtext: IconTypography, text: IconCursorText, textarea: IconCursorText, select: IconChevronDown, checkbox: IconCheckbox, radio: IconCircleDot, label: IconTypography, image: IconPhoto, context_value: IconGitBranch, button: IconRectangle, hidden: IconEye };
function blockDescription(type) { return BLOCK_DESCRIPTIONS[type] || "Add this block to the form."; }
function blockIcon(type) { return BLOCK_ICONS[type] || IconBlocks; }
function rebuildLayoutFromPages(form) { return { ...form, layout: { ...form.layout, order: flattenPageOrder(form.schema?.pages || []) } }; }

function makeId(type) {
  return `${type}_${Math.random().toString(36).slice(2, 7)}`;
}

function newField(type) {
  const id = makeId(type);
  const base = { id, type, label: FORM_COMPONENT_REGISTRY[type]?.label || type, placeholder: "", required: false, options: [] };
  if (type === "select" || type === "radio") base.options = [{ label: "Option A", value: "a" }, { label: "Option B", value: "b" }];
  if (type === "button") base.label = "Submit";
  if (type === "context_value") base.contextPath = "caller.from_number";
  if (type === "image") base.props = { src: "", padding: "md" };
  if (type === "section") base.helpText = "Group related fields under this heading.";
  if (type === "section") base.props = { padding: "md" };
  if (type === "columns") base.props = { columns: 2, gap: "md", padding: "md" };
  if (type === "grid") base.props = { columns: 2, gap: "md", padding: "md" };
  if (type === "row") base.props = { padding: "md" };
  if (type === "flex") base.props = { direction: "row", justify: "start", gap: 16, wrap: true, padding: "md" };
  if (type === "spacer") base.props = { size: "md", direction: "vertical" };
  if (type === "hero") { base.label = "Hero section"; base.props = { title: "Help customers faster", quote: "Agent form", description: "Collect the right context during every conversation.", align: "left", padding: "xl", imageUrl: "", imageMode: "cover", buttons: [{ label: "Primary action", href: "#", variant: "primary" }] }; }
  if (type === "stats") { base.label = "Stats"; base.props = { padding: "lg", items: [{ title: "24/7", description: "Coverage" }, { title: "95%", description: "CSAT" }, { title: "2m", description: "Avg response" }] }; }
  if (type === "card") { base.label = "Card"; base.props = { title: "Card title", description: "Short supporting description.", mode: "card", icon: "spark", padding: "md" }; }
  if (type === "richtext") { base.label = "Rich text"; base.props = { richtext: "Use this block for formatted guidance or copy.", padding: "md" }; }
  return base;
}

export function FormEditor({ initialForm, isNew = false }) {
  const router = useRouter();
  const [form, setForm] = useState(() => normalizeFormDefinition(initialForm || createDefaultForm({ name: "New agent form" })));
  const [selectedId, setSelectedId] = useState(() => form.schema.fields[0]?.id || "form");
  const [activePageId, setActivePageId] = useState(() => form.schema.pages?.[0]?.id || "page_1");
  const [activeTab, setActiveTab] = useState("ai");
  const [activeDragType, setActiveDragType] = useState(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [previewMode, setPreviewMode] = useState(false);
  const [formSettingsOpen, setFormSettingsOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const aiMessagesEndRef = useRef(null);
  const [aiMessages, setAiMessages] = useState([{ role: "assistant", text: "Tell me what this form should collect, or ask for a change. I’ll apply it to the draft and keep you in the visual builder." }]);
  const [templates, setTemplates] = useState([]);
  const [media, setMedia] = useState([]);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [queues, setQueues] = useState([]);
  const [previewTheme, setPreviewTheme] = useState("system");

  const pages = form.schema?.pages || [];
  const activePage = pages.find((page) => page.id === activePageId) || pages[0];
  const orderedFields = useMemo(() => {
    const byId = new Map((form.schema?.fields || []).map((f) => [f.id, f]));
    return (form.layout?.order || []).map((id) => byId.get(id)).filter(Boolean);
  }, [form]);
  const activePageFields = useMemo(() => {
    const byId = new Map((form.schema?.fields || []).map((f) => [f.id, f]));
    return (activePage?.fields || []).map((id) => byId.get(id)).filter(Boolean);
  }, [form, activePage]);
  const selectedField = orderedFields.find((f) => f.id === selectedId) || null;

  useEffect(() => {
    if (!pages.some((page) => page.id === activePageId) && pages[0]) setActivePageId(pages[0].id);
  }, [pages, activePageId]);
  useEffect(() => {
    if (selectedField && activePage?.fields?.includes(selectedField.id)) return;
    if (activePageFields[0]) setSelectedId(activePageFields[0].id);
  }, [activePageFields, activePage, selectedField]);

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
    const pageId = activePage?.id || pages[0]?.id || "page_1";
    const nextPages = (pages.length ? pages : [{ id: pageId, title: "Page 1", fields: [] }]).map((page) => page.id === pageId ? { ...page, fields: [...(page.fields || []), field.id] } : page);
    update(rebuildLayoutFromPages({ ...form, schema: { ...form.schema, fields: [...form.schema.fields, field], pages: nextPages } }));
    setSelectedId(field.id);
    setActiveTab("fields");
  }
  function removeField(id) {
    const nextFields = form.schema.fields.filter((field) => field.id !== id);
    const nextPages = pages.map((page) => ({ ...page, fields: (page.fields || []).filter((fieldId) => fieldId !== id) }));
    const nextPageFields = activePageFields.filter((field) => field.id !== id);
    update(rebuildLayoutFromPages({ ...form, schema: { ...form.schema, fields: nextFields, pages: nextPages } }));
    setSelectedId(nextPageFields[0]?.id || "form");
  }
  function duplicateField(field) {
    const copy = { ...field, id: makeId(field.type), label: `${field.label || field.id} copy` };
    const pageId = pages.find((page) => (page.fields || []).includes(field.id))?.id || activePage?.id;
    const nextPages = pages.map((page) => {
      if (page.id !== pageId) return page;
      const fields = [...(page.fields || [])]; const index = fields.indexOf(field.id); fields.splice(index + 1, 0, copy.id);
      return { ...page, fields };
    });
    update(rebuildLayoutFromPages({ ...form, schema: { ...form.schema, fields: [...form.schema.fields, copy], pages: nextPages } }));
    setSelectedId(copy.id);
  }
  function moveField(id, dir) {
    const pageId = pages.find((page) => (page.fields || []).includes(id))?.id || activePage?.id;
    const nextPages = pages.map((page) => {
      if (page.id !== pageId) return page;
      const fields = [...(page.fields || [])]; const i = fields.indexOf(id); const j = i + dir;
      if (i < 0 || j < 0 || j >= fields.length) return page;
      [fields[i], fields[j]] = [fields[j], fields[i]];
      return { ...page, fields };
    });
    update(rebuildLayoutFromPages({ ...form, schema: { ...form.schema, pages: nextPages } }));
  }
  function addPage() {
    const title = `Page ${pages.length + 1}`; const page = { id: makePageId(title), title, description: "", fields: [] };
    update(rebuildLayoutFromPages({ ...form, schema: { ...form.schema, pages: [...pages, page] } }));
    setActivePageId(page.id); setSelectedId("form"); setActiveTab("pages");
  }
  function updatePage(id, patch) { update({ ...form, schema: { ...form.schema, pages: pages.map((page) => page.id === id ? { ...page, ...patch } : page) } }); }
  function removePage(id) {
    if (pages.length <= 1) return;
    const removed = pages.find((page) => page.id === id); const remaining = pages.filter((page) => page.id !== id);
    if (removed?.fields?.length) remaining[0] = { ...remaining[0], fields: [...(remaining[0].fields || []), ...removed.fields] };
    update(rebuildLayoutFromPages({ ...form, schema: { ...form.schema, pages: remaining } }));
    setActivePageId(remaining[0]?.id || "page_1"); setSelectedId(remaining[0]?.fields?.[0] || "form");
  }
  function movePage(id, dir) {
    const nextPages = [...pages]; const i = nextPages.findIndex((page) => page.id === id); const j = i + dir;
    if (i < 0 || j < 0 || j >= nextPages.length) return;
    [nextPages[i], nextPages[j]] = [nextPages[j], nextPages[i]];
    update(rebuildLayoutFromPages({ ...form, schema: { ...form.schema, pages: nextPages } }));
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

  useEffect(() => {
    if (!formSettingsOpen || queues.length) return;
    fetch("/api/admin/queues?enabled=true&pageSize=100", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => setQueues(data.rows || []))
      .catch(() => setQueues([]));
  }, [formSettingsOpen, queues.length]);

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
    const pageId = activePage?.id || pages[0]?.id || "page_1";
    const nextPages = (pages.length ? pages : [{ id: pageId, title: "Page 1", fields: [] }]).map((page) => page.id === pageId ? { ...page, fields: [...(page.fields || []), field.id] } : page);
    update(rebuildLayoutFromPages({ ...form, schema: { ...form.schema, fields: [...form.schema.fields, field], pages: nextPages } }));
    setSelectedId(field.id); setActiveTab("fields");
  }

  function handleDragStart(event) { setActiveDragType(event.active?.data?.current?.type || null); }
  function handleDragEnd(event) {
    const type = event.active?.data?.current?.type;
    if (event.over?.id === "form-canvas" && type) addField(type);
    setActiveDragType(null);
  }

  return <div className="h-[calc(100vh-var(--header-height)-2rem)] min-h-0 -my-4 md:-my-6 flex flex-col overflow-hidden bg-muted/40">
    <div className="h-14 shrink-0 border-b bg-background px-4 flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0"><h1 className="text-base font-semibold truncate">{form.name || "Untitled form"}</h1><Badge variant="outline">{form.status || "draft"}</Badge>{message ? <span className="text-xs text-muted-foreground truncate">{message}</span> : null}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setPreviewMode((v) => !v)}><IconEye className="h-4 w-4 mr-1" />{previewMode ? "Edit" : "View"}</Button>
        <Button variant="outline" size="sm" onClick={() => setFormSettingsOpen(true)}><IconSettings className="h-4 w-4 mr-1" />Form settings</Button>
        <Button variant="outline" size="sm" onClick={() => save()} disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
        <Button size="sm" onClick={publish} disabled={saving}><IconWorldUpload className="h-4 w-4 mr-1" />Publish</Button>
      </div>
    </div>

    <Dialog open={formSettingsOpen} onOpenChange={setFormSettingsOpen}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Form settings</DialogTitle>
          <DialogDescription>Edit global settings for this form. Component-level settings stay in the right Properties panel.</DialogDescription>
        </DialogHeader>
        <FormSettingsFields form={form} patchForm={patchForm} queues={queues} />
      </DialogContent>
    </Dialog>

    <DndContext onDragStart={handleDragStart} onDragCancel={() => setActiveDragType(null)} onDragEnd={handleDragEnd}>
    <div className="grid flex-1 min-h-0 gap-3 p-3 grid-cols-[72px_320px_minmax(0,1fr)_360px]">
      <section className="min-h-0 overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="h-full overflow-y-auto p-2 flex flex-col items-center gap-2">
          {RAIL.map(({ id, label, icon: Icon }) => <button key={id} type="button" onClick={() => setActiveTab(id)} className={`w-14 rounded-lg px-2 py-3 text-[10px] flex flex-col items-center gap-1 transition ${activeTab === id ? "bg-primary text-primary-foreground shadow" : "text-muted-foreground hover:bg-muted"}`}><Icon className="h-5 w-5" />{label}</button>)}
        </div>
      </section>

      <section className="min-h-0 overflow-hidden rounded-xl border bg-card shadow-sm flex flex-col">
        <LeftPanel activeTab={activeTab} form={form} pages={pages} activePageId={activePage?.id} setActivePageId={setActivePageId} addPage={addPage} updatePage={updatePage} removePage={removePage} movePage={movePage} orderedFields={activePageFields} allFields={orderedFields} selectedId={selectedId} setSelectedId={setSelectedId} addField={addField} removeField={removeField} duplicateField={duplicateField} moveField={moveField} aiMessages={aiMessages} aiPrompt={aiPrompt} setAiPrompt={setAiPrompt} sendAi={sendAi} clearAiChat={clearAiChat} aiLoading={aiLoading} aiMessagesEndRef={aiMessagesEndRef} templates={templates} createFromTemplate={createFromTemplate} media={media} uploadMediaFile={uploadMediaFile} uploadingMedia={uploadingMedia} addMediaImage={addMediaImage} />
      </section>

      <section className="min-h-0 overflow-hidden rounded-xl border bg-card shadow-sm flex flex-col">
        <div className="h-14 shrink-0 border-b px-4 flex items-center justify-between bg-card">
          <div><div className="text-sm font-semibold">Visual canvas</div><div className="text-[11px] text-muted-foreground">Form preview and component selection</div></div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-md border bg-background p-0.5" aria-label="Preview theme">
              <Button type="button" variant={previewTheme === "light" ? "secondary" : "ghost"} size="sm" className="h-7 px-2" onClick={() => setPreviewTheme("light")} title="Preview light theme"><IconSun className="h-4 w-4" /></Button>
              <Button type="button" variant={previewTheme === "system" ? "secondary" : "ghost"} size="sm" className="h-7 px-2 text-[11px]" onClick={() => setPreviewTheme("system")} title="Follow app theme">Auto</Button>
              <Button type="button" variant={previewTheme === "dark" ? "secondary" : "ghost"} size="sm" className="h-7 px-2" onClick={() => setPreviewTheme("dark")} title="Preview dark theme"><IconMoon className="h-4 w-4" /></Button>
            </div>
            <div className="text-xs text-muted-foreground">100% · Desktop</div>
          </div>
        </div>
        <CanvasDropZone previewTheme={previewTheme}>
          <div className="mx-auto max-w-4xl rounded-2xl border bg-background text-foreground shadow-sm min-h-full p-8">
            <div className="mx-auto max-w-2xl space-y-6">
              <div className="border-b pb-5"><h2 className="text-2xl font-semibold tracking-tight">{form.name}</h2>{form.description ? <p className="mt-2 text-sm text-muted-foreground">{form.description}</p> : null}</div>
              {pages.length > 1 ? <PageTabs pages={pages} activePageId={activePage?.id} setActivePageId={setActivePageId} /> : null}
              {activePageFields.map((field) => <CanvasField key={field.id} field={field} selected={selectedId === field.id && !previewMode} readOnly={previewMode} onSelect={() => !previewMode && setSelectedId(field.id)} />)}
              {!activePageFields.length ? <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">Add blocks from the left palette to start building this page.</div> : null}
            </div>
          </div>
        </CanvasDropZone>
      </section>

      <section className="min-h-0 overflow-hidden rounded-xl border bg-card shadow-sm flex flex-col">
        <PropertiesPanel form={form} patchForm={patchForm} selectedField={selectedField} selectedId={selectedId} setSelectedId={setSelectedId} updateField={updateField} />
      </section>
    </div>
      <DragOverlay dropAnimation={null}>{activeDragType ? <BlockDragPreview type={activeDragType} /> : null}</DragOverlay>
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
  const { activeTab, form, pages = [], activePageId, setActivePageId, addPage, updatePage, removePage, movePage, orderedFields, allFields = orderedFields, selectedId, setSelectedId, addField, removeField, duplicateField, moveField, aiMessages, aiPrompt, setAiPrompt, sendAi, clearAiChat, aiLoading, aiMessagesEndRef, templates = [], createFromTemplate, media = [], uploadMediaFile, uploadingMedia, addMediaImage } = props;

  if (activeTab === "ai") {
    return <div className="h-full min-h-0 flex flex-col">
      <div className="h-14 shrink-0 border-b px-4 flex items-center justify-between gap-2">
        <div className="min-w-0"><h2 className="font-semibold text-sm">AI form agent</h2><p className="text-xs text-muted-foreground">Describe changes, then refine visually.</p></div>
      </div>
      <div className="flex-1 min-h-0 space-y-3 overflow-y-auto p-4">
        {aiMessages.map((msg, i) => <div key={i} className={`rounded-xl p-3 text-sm ${msg.role === "user" ? "bg-primary text-primary-foreground ml-6" : "bg-muted mr-6"}`}>{msg.text}</div>)}
        {aiLoading ? <div className="mr-6 flex items-center gap-2 rounded-xl bg-muted p-3 text-sm text-muted-foreground"><IconLoader2 className="h-4 w-4 animate-spin" />Waiting for a response...</div> : null}
        <div ref={aiMessagesEndRef} />
      </div>
      <form className="shrink-0 border-t p-4 space-y-2" onSubmit={(e) => { e.preventDefault(); sendAi(); }}>
        <Textarea rows={4} placeholder="Add a customer verification section..." value={aiPrompt} disabled={aiLoading} onChange={(e) => setAiPrompt(e.target.value)} onKeyDownCapture={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendAi(); } }} />
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Button type="submit" className="w-full" disabled={aiLoading || !aiPrompt.trim()}>{aiLoading ? <><IconLoader2 className="mr-2 h-4 w-4 animate-spin" />Waiting...</> : "Send to AI"}</Button>
          <Button type="button" variant="outline" onClick={clearAiChat} disabled={aiLoading}>Clear</Button>
        </div>
      </form>
    </div>;
  }

  if (activeTab === "pages") {
    return <div className="h-full min-h-0 flex flex-col">
      <PanelHeader title="Pages" description="Add, rename, reorder, and select form pages." />
      <div className="shrink-0 border-b p-4"><Button type="button" className="w-full" onClick={addPage}><IconPlus className="mr-2 h-4 w-4" />Add page</Button></div>
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        {pages.map((page, index) => <div key={page.id} className={`rounded-xl border p-3 ${activePageId === page.id ? "border-primary bg-primary/5" : "bg-background"}`}>
          <button type="button" className="mb-3 w-full text-left" onClick={() => setActivePageId(page.id)}>
            <div className="text-sm font-semibold">{page.title || `Page ${index + 1}`}</div>
            <div className="text-xs text-muted-foreground">{(page.fields || []).length} blocks · {page.id}</div>
          </button>
          <div className="space-y-2">
            <Input value={page.title || ""} onChange={(e) => updatePage(page.id, { title: e.target.value })} placeholder="Page title" />
            <Input value={page.description || ""} onChange={(e) => updatePage(page.id, { description: e.target.value })} placeholder="Optional description" />
          </div>
          <div className="mt-3 flex flex-wrap gap-1">
            <Button type="button" size="sm" variant="ghost" onClick={() => movePage(page.id, -1)}>↑</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => movePage(page.id, 1)}>↓</Button>
            <Button type="button" size="sm" variant="ghost" className="text-destructive" disabled={pages.length <= 1} onClick={() => removePage(page.id)}><IconTrash className="h-4 w-4" /></Button>
          </div>
        </div>)}
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
            {group.items.map((type) => <DraggableBlock key={type} type={type} addField={addField} colorClass={group.color} iconClass={group.iconClass} />)}
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
          {allFields.map((field, index) => <button key={field.id} className={`block w-full rounded-md border p-2 text-left text-sm ${selectedId === field.id ? "border-primary bg-primary/5" : "bg-background"}`} onClick={() => setSelectedId(field.id)}>
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

function CanvasDropZone({ children, previewTheme = "system" }) {
  const { isOver, setNodeRef } = useDroppable({ id: "form-canvas" });
  const themeClass = previewTheme === "dark" ? "dark" : previewTheme === "light" ? "form-preview-light" : "";
  return <div ref={setNodeRef} className={`flex-1 min-h-0 overflow-auto p-6 transition ${themeClass} ${isOver ? "bg-primary/10" : "bg-muted/70"}`}>{children}</div>;
}

function PageTabs({ pages = [], activePageId, setActivePageId }) {
  return <div className="flex items-center gap-1 border-b">
    {pages.map((page) => <button key={page.id} type="button" onClick={() => setActivePageId(page.id)} className={`relative px-4 py-2 text-sm font-medium transition ${activePageId === page.id ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
      {page.title || page.id}
      <span className={`absolute inset-x-0 -bottom-px h-0.5 rounded-full ${activePageId === page.id ? "bg-primary" : "bg-transparent"}`} />
    </button>)}
  </div>;
}

function BlockCardContent({ type, iconClass = "text-primary" }) {
  const Icon = blockIcon(type);
  return <div className="flex items-start gap-3">
    <IconGripVertical className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
    <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${iconClass}`} />
    <div className="min-w-0 flex-1">
      <div className="text-sm font-semibold text-foreground">{FORM_COMPONENT_REGISTRY[type]?.label || type}</div>
      <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{blockDescription(type)}</p>
    </div>
  </div>;
}

function DraggableBlock({ type, addField, colorClass, iconClass }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `block-${type}`, data: { type } });
  return <button ref={setNodeRef} type="button" className={`touch-none rounded-xl border border-l-4 ${colorClass} bg-background p-3 text-left shadow-sm transition hover:border-primary hover:bg-primary/5 hover:shadow ${isDragging ? "opacity-50" : ""}`} onClick={() => addField(type)} {...listeners} {...attributes}>
    <BlockCardContent type={type} iconClass={iconClass} />
  </button>;
}

function BlockDragPreview({ type }) {
  const group = BLOCK_GROUPS.find((item) => item.items.includes(type)) || BLOCK_GROUPS[0];
  return <div className={`w-72 rounded-xl border border-l-4 ${group.color} bg-background p-3 text-left shadow-2xl ring-1 ring-black/5`}><BlockCardContent type={type} iconClass={group.iconClass} /></div>;
}

function MiniTemplatePreview({ form }) {
  return <FormRenderer form={form} readOnly />;
}

function CanvasField({ field, selected, onSelect, readOnly }) {
  const props = field.props || {};
  const shell = `relative rounded-xl border transition ${paddingClass(props.padding)} ${selected ? "border-primary ring-2 ring-primary/20 bg-primary/5" : "border-transparent hover:border-muted-foreground/25"}`;
  if (field.type === "section") return <div onClick={onSelect} className={shell}><div className="rounded-lg border bg-muted/25 p-4" style={fieldStyle(field)}><div className="text-sm font-semibold">{field.label}</div>{field.helpText ? <p className="mt-1 text-xs text-muted-foreground">{field.helpText}</p> : null}</div></div>;
  if (field.type === "row") return <div onClick={onSelect} className={shell}><div className="rounded-lg border border-dashed p-3 text-xs font-medium text-muted-foreground">Row · {field.label}</div></div>;
  if (field.type === "columns") { const count = Math.max(2, Math.min(Number(props.columns || 2), 4)); return <div onClick={onSelect} className={shell}><div className="rounded-lg border border-dashed p-3"><div className="mb-2 text-xs font-medium text-muted-foreground">{field.label || `${count} columns`}</div><div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>{Array.from({ length: count }).map((_, i) => <div key={i} className="min-h-16 rounded-md bg-muted/60" />)}</div></div></div>; }
  if (field.type === "grid") { const count = Math.max(1, Math.min(Number(props.columns || 2), 6)); return <div onClick={onSelect} className={shell}><div className="rounded-lg border border-dashed p-3"><div className="mb-2 text-xs font-medium text-muted-foreground">Grid · {field.label}</div><div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>{Array.from({ length: count }).map((_, i) => <div key={i} className="h-12 rounded-md bg-muted/60" />)}</div></div></div>; }
  if (field.type === "flex") return <div onClick={onSelect} className={shell}><div className="rounded-lg border border-dashed p-3 text-xs font-medium text-muted-foreground">Flex · {props.direction || "row"} · gap {props.gap || 16}px</div></div>;
  if (field.type === "spacer") return <div onClick={onSelect} className={shell}><div className={`${props.direction === "horizontal" ? "h-4 w-24" : "h-12 w-full"} rounded border border-dashed bg-muted/40`} /></div>;
  if (field.type === "hero") return <div onClick={onSelect} className={`${shell} ${alignClass(props.align)}`} style={fieldStyle(field)}><div className={`rounded-xl border bg-card text-card-foreground ${verticalPaddingClass(props.padding)} px-6`}><div className="text-xs font-semibold uppercase tracking-wide text-primary">{props.quote || field.label}</div><h3 className="mt-2 text-3xl font-bold tracking-tight">{props.title || field.label}</h3>{props.description ? <p className="mt-3 text-sm text-muted-foreground">{props.description}</p> : null}{props.buttons?.length ? <div className="mt-4 flex flex-wrap gap-2"><Button size="sm">{props.buttons[0]?.label || "Action"}</Button></div> : null}</div></div>;
  if (field.type === "stats") return <div onClick={onSelect} className={shell}><div className="grid gap-3 md:grid-cols-3">{(props.items || []).map((item, index) => <div key={index} className="rounded-xl border bg-card p-4 text-card-foreground"><div className="text-2xl font-bold" style={fieldStyle(field)}>{item.title}</div><div className="text-xs text-muted-foreground">{item.description}</div></div>)}</div></div>;
  if (field.type === "card") return <div onClick={onSelect} className={shell}><div className={`rounded-xl ${props.mode === "flat" ? "bg-muted/40" : "border bg-card shadow-sm"} p-4 text-card-foreground`} style={fieldStyle(field)}><div className="text-sm font-semibold">{props.title || field.label}</div>{props.description ? <p className="mt-2 text-xs text-muted-foreground">{props.description}</p> : null}</div></div>;
  if (field.type === "richtext") return <div onClick={onSelect} className={shell}><div className="prose prose-sm max-w-none dark:prose-invert" style={fieldStyle(field)}>{props.richtext || field.label}</div></div>;
  if (field.type === "hidden") return <div onClick={onSelect} className={shell}><Badge variant="outline">Hidden</Badge> <span className="text-sm text-muted-foreground">{field.id}</span></div>;
  if (field.type === "label") return <div onClick={onSelect} className={`${shell} ${textSizeClass(props.size)} ${alignClass(props.align)}`} style={fieldStyle(field)}><div className="font-semibold">{field.label}</div>{field.helpText ? <p className="text-xs text-muted-foreground">{field.helpText}</p> : null}</div>;
  if (field.type === "context_value") return <div onClick={onSelect} className={shell}><Label style={fieldStyle(field)}>{field.label}</Label><div className="mt-2 rounded-md bg-muted p-3 font-mono text-xs">{field.contextPath || "caller.from_number"}</div></div>;
  if (field.type === "image") return <div onClick={onSelect} className={shell}>{field.props?.src ? <img src={field.props.src} alt={field.label || "Form image"} className="max-h-48 rounded-md border object-contain" /> : <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">Image block</div>}</div>;
  if (field.type === "button") return <div onClick={onSelect} className={shell}><Button disabled={readOnly} variant={props.variant === "secondary" ? "secondary" : "default"}>{field.label || "Submit"}</Button></div>;
  return <div onClick={onSelect} className={shell}><Label style={fieldStyle(field)}>{field.label}{field.required ? <span className="text-destructive"> *</span> : null}</Label>{field.type === "textarea" ? <Textarea className="mt-2" placeholder={field.placeholder} disabled={readOnly} /> : field.type === "select" ? <Select disabled={readOnly}><SelectTrigger className="mt-2"><SelectValue placeholder={field.placeholder || "Select..."} /></SelectTrigger><SelectContent>{(field.options || []).map((o) => <SelectItem key={o.value} value={String(o.value)}>{o.label || o.value}</SelectItem>)}</SelectContent></Select> : field.type === "radio" ? <div className="mt-2 space-y-2">{(field.options || []).map((o) => <label key={o.value} className="flex items-center gap-2 text-sm"><input type="radio" disabled={readOnly} />{o.label || o.value}</label>)}</div> : field.type === "checkbox" ? <div className="mt-2 flex items-center gap-2"><Checkbox disabled={readOnly} /><span className="text-sm text-muted-foreground">{field.placeholder || "Yes"}</span></div> : <Input className="mt-2" placeholder={field.placeholder} disabled={readOnly} />}{field.helpText ? <p className="mt-2 text-xs text-muted-foreground">{field.helpText}</p> : null}</div>;
}

function FormSettingsFields({ form, patchForm, queues = [] }) {
  const selectedNames = form.queue_names || [];
  const categoryOptions = FORM_CATEGORIES.includes(form.category) || !form.category ? FORM_CATEGORIES : [form.category, ...FORM_CATEGORIES];
  const selectedMissingQueues = selectedNames.filter((name) => !queues.some((q) => q.name === name || queueLabel(q) === name));
  function toggleQueue(name) {
    const next = selectedNames.includes(name) ? selectedNames.filter((item) => item !== name) : [...selectedNames, name];
    patchForm({ queue_names: next });
  }
  return <div className="grid gap-4 py-2">
    <div className="grid gap-2"><Label>Name</Label><Input value={form.name || ""} onChange={(e) => patchForm({ name: e.target.value, slug: form.slug || slugifyFormName(e.target.value) })} /></div>
    <div className="grid gap-2"><Label>Slug</Label><Input value={form.slug || ""} onChange={(e) => patchForm({ slug: e.target.value })} /></div>
    <div className="grid gap-2"><Label>Category</Label><Select value={form.category || "General"} onValueChange={(value) => patchForm({ category: value })}><SelectTrigger><SelectValue placeholder="Choose a category" /></SelectTrigger><SelectContent>{categoryOptions.map((category) => <SelectItem key={category} value={category}>{category}</SelectItem>)}</SelectContent></Select></div>
    <div className="grid gap-2"><Label>Description</Label><Textarea rows={3} value={form.description || ""} onChange={(e) => patchForm({ description: e.target.value })} /></div>
    <div className="grid gap-2">
      <Label>Queue names</Label>
      <Popover>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" className="min-h-10 h-auto justify-between whitespace-normal text-left font-normal">
            <span className="flex flex-wrap gap-1">
              {selectedNames.length ? selectedNames.map((name) => {
                const queue = queues.find((q) => q.name === name || queueLabel(q) === name);
                const routing = queue ? queueRouting(queue) : "Existing";
                return <Badge key={name} variant="secondary" className="gap-1"><span>{name}</span><span className={`rounded px-1 py-0.5 text-[9px] font-semibold text-white ${QUEUE_BADGE_CLASS[routing] || "bg-gray-500"}`}>{routing === "Existing" ? "SAVED" : routing}</span></Badge>;
              }) : <span className="text-muted-foreground">Select queues...</span>}
            </span>
            <IconChevronDown className="h-4 w-4 shrink-0 opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[420px] p-2">
          <div className="max-h-72 overflow-y-auto space-y-1">
            {selectedMissingQueues.map((name) => <button key={`saved-${name}`} type="button" onClick={() => toggleQueue(name)} className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-muted">
              <Checkbox checked />
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{name}</span><span className="block truncate text-xs text-muted-foreground">Saved queue name</span></span>
              <span className="rounded bg-gray-500 px-2 py-1 text-[10px] font-semibold text-white">SAVED</span>
            </button>)}
            {queues.map((queue) => {
              const name = queue.name;
              const checked = selectedNames.includes(name);
              const routing = queueRouting(queue);
              return <button key={queue.id || name} type="button" onClick={() => toggleQueue(name)} className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-muted">
                <Checkbox checked={checked} onCheckedChange={() => toggleQueue(name)} onClick={(e) => e.stopPropagation()} />
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{queueLabel(queue) || name}</span><span className="block truncate text-xs text-muted-foreground">{name}</span></span>
                <span className={`rounded px-2 py-1 text-[10px] font-semibold text-white ${QUEUE_BADGE_CLASS[routing] || "bg-gray-500"}`}>{routing}</span>
              </button>;
            })}
            {!queues.length ? <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No queues loaded. Existing saved queue names are preserved above.</div> : null}
          </div>
        </PopoverContent>
      </Popover>
      <p className="text-xs text-muted-foreground">Saved queue names are preserved even if a matching queue is not currently returned by the API.</p>
    </div>
    <div className="flex items-center justify-between rounded-md border p-3"><div><Label>Auto-open</Label><p className="text-xs text-muted-foreground">Open this form automatically for matching queues.</p></div><Switch checked={Boolean(form.auto_open)} onCheckedChange={(checked) => patchForm({ auto_open: checked })} /></div>
  </div>;
}

function PropertiesPanel({ form, patchForm, selectedField, updateField }) {
  function setProps(field, patch) { updateField(field.id, mergeProps(field, patch).props ? { props: mergeProps(field, patch).props } : {}); }
  function renameField(field, nextId) {
    const clean = String(nextId || "").trim().replace(/[^A-Za-z0-9_:-]/g, "_");
    if (!clean) return;
    const nextBindings = { ...(form.bindings || {}) };
    if (field.id !== clean && nextBindings[field.id] !== undefined) { nextBindings[clean] = nextBindings[field.id]; delete nextBindings[field.id]; }
    const pages = (form.schema.pages || []).map((page) => ({ ...page, fields: (page.fields || []).map((id) => id === field.id ? clean : id) }));
    patchForm({ schema: { ...form.schema, fields: form.schema.fields.map((item) => item.id === field.id ? { ...item, id: clean } : item), pages }, layout: { ...form.layout, order: (form.layout.order || []).map((id) => id === field.id ? clean : id) }, bindings: nextBindings });
  }
  return <div className="h-full min-h-0 flex flex-col">
    <div className="h-14 shrink-0 border-b px-4 flex items-center gap-2"><IconSettings className="h-5 w-5" /><div><h2 className="font-semibold text-sm">Properties</h2><p className="text-xs text-muted-foreground">Selected canvas element settings.</p></div></div>
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-5">
      {selectedField ? <Card><CardContent className="p-4 space-y-4">
        <div className="flex items-center justify-between"><h3 className="font-medium">Selected field</h3><Badge variant="outline">{selectedField.type}</Badge></div>
        <div><Label>Label</Label><Input value={selectedField.label || ""} onChange={(e) => updateField(selectedField.id, { label: e.target.value })} /></div>
        <div><Label>Field name / id</Label><Input value={selectedField.id || ""} onChange={(e) => renameField(selectedField, e.target.value)} /></div>
        <div><Label>Type</Label><Select value={selectedField.type} onValueChange={(value) => updateField(selectedField.id, { type: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{FORM_COMPONENT_TYPES.map((type) => <SelectItem key={type} value={type}>{FORM_COMPONENT_REGISTRY[type]?.label || type}</SelectItem>)}</SelectContent></Select></div>
        {FORM_COMPONENT_REGISTRY[selectedField.type]?.data ? <div className="flex items-center justify-between rounded-md border p-2"><Label>Required</Label><Switch checked={Boolean(selectedField.required)} onCheckedChange={(checked) => updateField(selectedField.id, { required: checked })} /></div> : null}
        {!["hero", "stats", "card", "richtext", "spacer"].includes(selectedField.type) ? <><div><Label>Placeholder</Label><Input value={selectedField.placeholder || ""} onChange={(e) => updateField(selectedField.id, { placeholder: e.target.value })} /></div><div><Label>Help text</Label><Input value={selectedField.helpText || ""} onChange={(e) => updateField(selectedField.id, { helpText: e.target.value })} /></div></> : null}
        {FORM_COMPONENT_REGISTRY[selectedField.type]?.data ? <div><Label>Binding path</Label><Input value={form.bindings?.[selectedField.id] || ""} placeholder="customer.name" onChange={(e) => patchForm({ bindings: { ...(form.bindings || {}), [selectedField.id]: e.target.value } })} /></div> : null}
        {selectedField.type === "context_value" ? <div><Label>Context path</Label><Input value={selectedField.contextPath || ""} placeholder="caller.from_number" onChange={(e) => updateField(selectedField.id, { contextPath: e.target.value })} /></div> : null}
        <BlockPropertyControls field={selectedField} updateField={updateField} setProps={(patch) => setProps(selectedField, patch)} />
        {FORM_COMPONENT_REGISTRY[selectedField.type]?.options ? <div><Label>Options JSON</Label><Textarea rows={5} className="font-mono text-xs" value={JSON.stringify(selectedField.options || [], null, 2)} onChange={(e) => { try { updateField(selectedField.id, { options: JSON.parse(e.target.value) }); } catch {} }} /></div> : null}
        <details className="rounded-md border p-3"><summary className="cursor-pointer text-sm font-medium">Advanced JSON props</summary><Textarea rows={4} className="mt-3 font-mono text-xs" value={JSON.stringify(selectedField.props || {}, null, 2)} onChange={(e) => { try { updateField(selectedField.id, { props: JSON.parse(e.target.value) }); } catch {} }} /></details>
      </CardContent></Card> : <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">Select an element on the canvas to edit its properties.</div>}
    </div>
  </div>;
}

function BlockPropertyControls({ field, setProps, updateField }) {
  const props = field.props || {};
  const supportsPadding = !["hidden"].includes(field.type);
  const supportsColor = ["hero", "stats", "card", "richtext", "label", "section", "text", "textarea", "select", "radio", "checkbox", "context_value"].includes(field.type);
  return <div className="space-y-4 rounded-lg border bg-muted/20 p-3">
    <div className="text-xs font-semibold uppercase text-muted-foreground">Design</div>
    {supportsPadding ? <div><Label>Padding</Label><Select value={props.padding || "md"} onValueChange={(value) => setProps({ padding: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{PADDING_OPTIONS.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent></Select></div> : null}
    {supportsColor ? <div className="space-y-2"><ColorPicker label="Text color" value={props.color || ""} onChange={(oklch) => setProps({ color: oklch })} /><Button type="button" size="sm" variant="ghost" onClick={() => setProps({ color: "" })}>Use theme default</Button></div> : null}
    {["label", "hero", "text", "richtext"].includes(field.type) ? <div><Label>Align</Label><Select value={props.align || "left"} onValueChange={(value) => setProps({ align: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{ALIGN_OPTIONS.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent></Select></div> : null}
    {["label", "text", "richtext"].includes(field.type) ? <div><Label>Size</Label><Select value={props.size || "md"} onValueChange={(value) => setProps({ size: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{SIZE_OPTIONS.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent></Select></div> : null}
    <SpecificBlockControls field={field} props={props} setProps={setProps} updateField={updateField} />
  </div>;
}

function SpecificBlockControls({ field, props, setProps, updateField }) {
  if (["columns", "grid"].includes(field.type)) return <div className="grid grid-cols-2 gap-3"><div><Label>Columns</Label><Input type="number" min="1" max="6" value={props.columns || 2} onChange={(e) => setProps({ columns: Number(e.target.value) })} /></div><div><Label>Gap</Label><Input type="number" min="0" value={props.gap || 12} onChange={(e) => setProps({ gap: Number(e.target.value) })} /></div></div>;
  if (field.type === "flex") return <div className="grid gap-3"><div><Label>Direction</Label><Select value={props.direction || "row"} onValueChange={(value) => setProps({ direction: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="row">Row</SelectItem><SelectItem value="column">Column</SelectItem></SelectContent></Select></div><div><Label>Justify</Label><Select value={props.justify || "start"} onValueChange={(value) => setProps({ justify: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="start">Start</SelectItem><SelectItem value="center">Center</SelectItem><SelectItem value="end">End</SelectItem></SelectContent></Select></div><div><Label>Gap px</Label><Input type="number" min="0" value={props.gap || 16} onChange={(e) => setProps({ gap: Number(e.target.value) })} /></div><div className="flex items-center justify-between rounded-md border p-2"><Label>Wrap</Label><Switch checked={props.wrap !== false} onCheckedChange={(checked) => setProps({ wrap: checked })} /></div></div>;
  if (field.type === "spacer") return <div className="grid grid-cols-2 gap-3"><div><Label>Size</Label><Select value={props.size || "md"} onValueChange={(value) => setProps({ size: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{SIZE_OPTIONS.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent></Select></div><div><Label>Direction</Label><Select value={props.direction || "vertical"} onValueChange={(value) => setProps({ direction: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="vertical">Vertical</SelectItem><SelectItem value="horizontal">Horizontal</SelectItem><SelectItem value="both">Both</SelectItem></SelectContent></Select></div></div>;
  if (field.type === "hero") return <div className="space-y-3"><div><Label>Quote / eyebrow</Label><Input value={props.quote || ""} onChange={(e) => setProps({ quote: e.target.value })} /></div><div><Label>Title</Label><Input value={props.title || ""} onChange={(e) => setProps({ title: e.target.value })} /></div><div><Label>Description</Label><Textarea rows={3} value={props.description || ""} onChange={(e) => setProps({ description: e.target.value })} /></div><div><Label>Image URL</Label><Input value={props.imageUrl || ""} onChange={(e) => setProps({ imageUrl: e.target.value })} /></div><ArrayJsonControl label="Buttons" value={props.buttons || []} onChange={(buttons) => setProps({ buttons })} /></div>;
  if (field.type === "stats") return <ArrayJsonControl label="Items" value={props.items || []} onChange={(items) => setProps({ items })} />;
  if (field.type === "card") return <div className="space-y-3"><div><Label>Title</Label><Input value={props.title || ""} onChange={(e) => setProps({ title: e.target.value })} /></div><div><Label>Description</Label><Textarea rows={3} value={props.description || ""} onChange={(e) => setProps({ description: e.target.value })} /></div><div><Label>Mode</Label><Select value={props.mode || "card"} onValueChange={(value) => setProps({ mode: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="card">Card</SelectItem><SelectItem value="flat">Flat</SelectItem></SelectContent></Select></div></div>;
  if (field.type === "richtext") return <div><Label>Rich text</Label><Textarea rows={5} value={props.richtext || ""} onChange={(e) => setProps({ richtext: e.target.value })} /></div>;
  if (field.type === "image") return <div><Label>Image URL</Label><Input value={props.src || ""} onChange={(e) => setProps({ src: e.target.value })} /></div>;
  if (field.type === "button") return <div><Label>Variant</Label><Select value={props.variant || "primary"} onValueChange={(value) => setProps({ variant: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="primary">Primary</SelectItem><SelectItem value="secondary">Secondary</SelectItem></SelectContent></Select></div>;
  return null;
}

function ArrayJsonControl({ label, value, onChange }) {
  return <div><Label>{label} JSON</Label><Textarea rows={5} className="font-mono text-xs" value={JSON.stringify(value || [], null, 2)} onChange={(e) => { try { onChange(JSON.parse(e.target.value)); } catch {} }} /></div>;
}
