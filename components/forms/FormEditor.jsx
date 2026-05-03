"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DndContext, DragOverlay, useDraggable, useDroppable } from "@dnd-kit/core";
import { useRouter } from "next/navigation";
import { IconArrowLeft, IconBlockquote, IconBlocks, IconCheck, IconCode, IconColumns, IconCursorText, IconForms, IconGripVertical, IconCheckbox, IconChevronDown, IconCircleDot, IconEye, IconGitBranch, IconGridDots, IconHeading, IconLayoutBottombar, IconLayoutCards, IconLoader2, IconMessageCircle, IconMinus, IconMoon, IconPencil, IconPhoto, IconPlus, IconRectangle, IconSettings, IconSun, IconTemplate, IconTrash, IconTypography, IconUpload, IconX, IconWorldUpload, IconDownload } from "@tabler/icons-react";
import * as TablerIcons from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { FORM_COMPONENT_TYPES, FORM_COMPONENT_REGISTRY, createDefaultForm, flattenPageOrder, getFieldChildIds, makePageId, normalizeFormDefinition, slugifyFormName } from "@/lib/forms/form-schema";
import { CodeBlock, CodeBlockCopyButton } from "@/components/ai-elements/code-block";
import { FormRenderer } from "@/components/forms/FormRenderer";
import { notify } from "@/components/ToastNotify";

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
  { title: "Layout", color: "border-l-sky-500", iconClass: "text-sky-500", items: ["section", "row", "columns", "grid", "flex", "spacer", "divider"] },
  { title: "Marketing", color: "border-l-violet-500", iconClass: "text-violet-500", items: ["hero", "stats", "card", "richtext"] },
  { title: "Basic", color: "border-l-emerald-500", iconClass: "text-emerald-500", items: ["text", "textarea", "select", "checkbox", "radio"] },
  { title: "Content", color: "border-l-amber-500", iconClass: "text-amber-500", items: ["label", "image", "codeblock", "context_value"] },
  { title: "Actions", color: "border-l-rose-500", iconClass: "text-rose-500", items: ["button", "hidden"] },
];

const FORM_CATEGORIES = ["General", "Sales", "Support", "Billing", "Customer onboarding", "Lead capture", "Feedback", "Complaint", "Appointment", "Compliance"];
const PADDING_VALUE_MAP = { none: 0, xs: 8, sm: 12, md: 16, lg: 24, xl: 32 };
const VARIANT_OPTIONS = [{ value: "primary", label: "Primary" }, { value: "secondary", label: "Secondary" }];
const DIRECTION_OPTIONS = [{ value: "vertical", label: "Vertical" }, { value: "horizontal", label: "Horizontal" }];
const SIZE_OPTIONS = ["sm", "md", "lg", "xl"];
const CODE_LANGUAGE_OPTIONS = [
  { value: "javascript", label: "JavaScript" },
  { value: "typescript", label: "TypeScript" },
  { value: "json", label: "JSON" },
  { value: "python", label: "Python" },
  { value: "bash", label: "Bash" },
  { value: "sql", label: "SQL" },
  { value: "yaml", label: "YAML" },
  { value: "xml", label: "XML / HTML" },
  { value: "css", label: "CSS" },
  { value: "markdown", label: "Markdown" },
  { value: "plaintext", label: "Plain text" },
];
const LEGACY_PAGE_ICON_MAP = { forms: "IconForms", user: "IconUser", phone: "IconPhone", mail: "IconMail", message: "IconMessageCircle", headset: "IconHeadset", info: "IconInfoCircle", home: "IconHome", star: "IconStar", check: "IconCheck" };
const PREFERRED_PAGE_ICONS = ["IconForms", "IconUser", "IconPhone", "IconMail", "IconMessageCircle", "IconHeadset", "IconInfoCircle", "IconHome", "IconStar", "IconCheck", "IconBuilding", "IconMapPin", "IconCalendar", "IconCreditCard", "IconShield", "IconFileText", "IconClipboardList", "IconDeviceMobile", "IconWorld", "IconSettings", "IconBell", "IconTag", "IconBriefcase", "IconHeart", "IconThumbUp"];
const PAGE_ICON_OPTIONS = Object.entries(TablerIcons)
  .filter(([name, value]) => /^Icon[A-Z]/.test(name) && (typeof value === "function" || (value && typeof value === "object")))
  .map(([value]) => ({ value, label: value.replace(/^Icon/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2") }))
  .sort((a, b) => {
    const ai = PREFERRED_PAGE_ICONS.indexOf(a.value); const bi = PREFERRED_PAGE_ICONS.indexOf(b.value);
    if (ai >= 0 || bi >= 0) return (ai >= 0 ? ai : 9999) - (bi >= 0 ? bi : 9999);
    return a.label.localeCompare(b.label);
  });
const PAGE_ICON_INITIAL_LIMIT = 96;
const PAGE_ICON_SEARCH_LIMIT = 240;
let pageIconsPreloaded = false;
function preloadPageIcons() {
  if (pageIconsPreloaded) return;
  pageIconsPreloaded = true;
  PAGE_ICON_OPTIONS.forEach((option) => { void TablerIcons[option.value]; });
}
function pageIconValue(value) { return LEGACY_PAGE_ICON_MAP[value] || value || ""; }
function PageIcon({ value, className = "h-4 w-4" }) {
  const Icon = TablerIcons[pageIconValue(value)];
  return Icon ? <Icon className={className} /> : null;
}

const ALIGN_OPTIONS = ["left", "center", "right"];
const QUEUE_BADGE_CLASS = { FIFO: "bg-blue-500", "Skill-based": "bg-purple-500", "Priority-based": "bg-orange-500" };
const STATUS_BADGE_CLASS = { draft: "border-amber-500 text-amber-700 dark:text-amber-300", published: "border-emerald-500 text-emerald-700 dark:text-emerald-300", archived: "border-slate-400 text-slate-600 dark:text-slate-300" };
const MESSAGE_BADGE_CLASS = { saved: "border-emerald-500 text-emerald-700 dark:text-emerald-300", error: "border-destructive text-destructive" };
const BLOCK_GROUP_BADGE_CLASS = {
  Layout: "border-sky-500 text-sky-700 dark:text-sky-300",
  Marketing: "border-violet-500 text-violet-700 dark:text-violet-300",
  Basic: "border-emerald-500 text-emerald-700 dark:text-emerald-300",
  Content: "border-amber-500 text-amber-700 dark:text-amber-300",
  Actions: "border-rose-500 text-rose-700 dark:text-rose-300",
};

function mergeProps(field, patch) { return { props: { ...(field.props || {}), ...patch } }; }
function isNumericPadding(value) { return value !== "" && value !== null && value !== undefined && Number.isFinite(Number(value)); }
function paddingNumber(value) { if (isNumericPadding(value)) return Math.max(0, Number(value)); return PADDING_VALUE_MAP[value || "md"] ?? PADDING_VALUE_MAP.md; }
function paddingClass(value) { return isNumericPadding(value) ? "" : ({ none: "p-0", xs: "p-2", sm: "p-3", md: "p-4", lg: "p-6", xl: "p-8" }[value || "md"] || "p-4"); }
function verticalPaddingClass(value) { return isNumericPadding(value) ? "" : ({ none: "py-0", xs: "py-2", sm: "py-3", md: "py-4", lg: "py-6", xl: "py-8" }[value || "md"] || "py-4"); }
function paddingStyle(value, base = {}) { return isNumericPadding(value) ? { ...base, padding: `${paddingNumber(value)}px` } : base; }
function verticalPaddingStyle(value, base = {}) { return isNumericPadding(value) ? { ...base, paddingTop: `${paddingNumber(value)}px`, paddingBottom: `${paddingNumber(value)}px` } : base; }
function normalizeOption(option = {}, index = 0) { if (typeof option === "string" || typeof option === "number") return { label: String(option), value: String(option) }; const value = option.value ?? option.id ?? option.label ?? `option_${index + 1}`; return { ...option, label: option.label ?? String(value), value: String(value) }; }
function normalizeOptions(options = []) { return Array.isArray(options) ? options.map(normalizeOption) : []; }
function optionDirection(props = {}) { return props.direction === "horizontal" || props.orientation === "horizontal" ? "horizontal" : "vertical"; }
function textSizeClass(value) { return ({ sm: "text-sm", md: "text-base", lg: "text-lg", xl: "text-2xl" }[value || "md"] || "text-base"); }
function alignClass(value) { return ({ left: "text-left", center: "text-center", right: "text-right" }[value || "left"] || "text-left"); }
function fieldStyle(field) { return field.props?.color ? { color: field.props.color } : undefined; }
function containerStyle(field, base = {}) {
  const props = field.props || {};
  const width = Number(props.borderWidth);
  if (!Number.isFinite(width)) return { ...base, ...fieldStyle(field) };
  return { ...base, ...fieldStyle(field), borderWidth: `${Math.max(0, width)}px`, borderColor: props.borderColor || "var(--border)", borderStyle: "solid" };
}
function gapPx(value, fallback = 12) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function queueLabel(queue) { return queue.display_name || queue.displayName || queue.name; }
function queueRouting(queue) { return queue.routing_strategy || queue.routingStrategy || "FIFO"; }
const BLOCK_DESCRIPTIONS = {
  section: "Group related fields with a title.", row: "Visual horizontal container.", columns: "Split content into columns.", grid: "Create an even grid layout.", flex: "Flexible row or column layout.", spacer: "Add visual breathing room.", divider: "Horizontal line separator.",
  hero: "Large header with CTA copy.", stats: "Metric cards for highlights.", card: "Framed content container.", richtext: "Formatted guidance or copy.",
  text: "Single-line text input.", textarea: "Multi-line notes or comments.", select: "Dropdown choice list.", checkbox: "Boolean consent or flag.", radio: "One choice from visible options.",
  label: "Static heading or helper label.", image: "Image or media block.", codeblock: "Syntax-highlighted code display.", context_value: "Show live client context.", button: "Submit or action button.", hidden: "Stored hidden value.",
};
const BLOCK_ICONS = { section: IconHeading, row: IconLayoutBottombar, columns: IconColumns, grid: IconGridDots, flex: IconRectangle, spacer: IconRectangle, divider: IconMinus, hero: IconBlockquote, stats: IconLayoutCards, card: IconLayoutCards, richtext: IconTypography, text: IconCursorText, textarea: IconCursorText, select: IconChevronDown, checkbox: IconCheckbox, radio: IconCircleDot, label: IconTypography, image: IconPhoto, codeblock: IconCode, context_value: IconGitBranch, button: IconRectangle, hidden: IconEye };
function blockDescription(type) { return BLOCK_DESCRIPTIONS[type] || "Add this block to the form."; }
function blockIcon(type) { return BLOCK_ICONS[type] || IconBlocks; }
function blockGroup(type) { return BLOCK_GROUPS.find((group) => group.items.includes(type)); }
function blockBadgeClass(type) { return BLOCK_GROUP_BADGE_CLASS[blockGroup(type)?.title] || "border-slate-400 text-slate-600 dark:text-slate-300"; }
function blockLabel(type) { return FORM_COMPONENT_REGISTRY[type]?.label || type; }
function mediaTitle(item = {}) { return item.title || item.display_name || item.displayName || String(item.name || item.filename || item.url || "Image").replace(/\.[^.]+$/, ""); }
function mediaFilename(item = {}) { return String(item.filename || item.name || item.url || "").split("/").pop(); }
function mediaSizeLabel(item = {}) {
  const size = Number(item.size_bytes || item.size || item.metadata?.size_bytes || item.metadata?.size || 0);
  if (!Number.isFinite(size) || size <= 0) return "Size unknown";
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}
function mediaDimensionsLabel(item = {}, fallback = null) {
  const width = Number(item.width || item.metadata?.width || item.metadata?.original_width || fallback?.width || 0);
  const height = Number(item.height || item.metadata?.height || item.metadata?.original_height || fallback?.height || 0);
  return width > 0 && height > 0 ? `${Math.round(width)} × ${Math.round(height)} px` : "Dimensions unknown";
}
function imagePropKey(field) { return field?.type === "hero" ? "imageUrl" : field?.type === "image" ? "src" : field?.type === "card" ? "imageUrl" : null; }
function isImageCapable(field) { return Boolean(imagePropKey(field)); }
function heroContent(field, props = {}) {
  return <div className="relative z-10 min-w-0"><div className="text-xs font-semibold uppercase tracking-wide text-primary">{props.quote || field.label}</div><h3 className="mt-2 text-3xl font-bold tracking-tight">{props.title || field.label}</h3>{props.description ? <p className="mt-3 text-sm text-muted-foreground">{props.description}</p> : null}{props.buttons?.length ? <div className="mt-4 flex flex-wrap gap-2"><Button size="sm">{props.buttons[0]?.label || "Action"}</Button></div> : null}</div>;
}
function heroShell(field, props = {}, toolbar = null) {
  const mode = props.imageMode === "background" ? "background" : "inline";
  if (mode === "background" && props.imageUrl) return <div className={`relative overflow-hidden rounded-xl border bg-card text-card-foreground ${verticalPaddingClass(props.padding)} px-6 ${alignClass(props.align)} min-h-[220px]`} style={verticalPaddingStyle(props.padding, fieldStyle(field) || {})}>{toolbar}<img src={props.imageUrl} alt={props.imageTitle || props.title || field.label} className="absolute inset-0 h-full w-full object-cover" /><div className="absolute inset-0 bg-gradient-to-r from-card via-card/85 to-card/10" /><div className="relative z-10 max-w-2xl py-4">{heroContent(field, props)}</div></div>;
  return <div className={`grid gap-5 rounded-xl border bg-card text-card-foreground ${verticalPaddingClass(props.padding)} px-6 ${alignClass(props.align)} md:grid-cols-[minmax(0,1fr)_220px]`} style={verticalPaddingStyle(props.padding, fieldStyle(field) || {})}>{toolbar}{heroContent(field, props)}{props.imageUrl ? <img src={props.imageUrl} alt={props.imageTitle || props.title || field.label} className="max-h-44 w-full rounded-lg border object-cover" /> : null}</div>;
}
function rebuildLayoutFromPages(form) { return { ...form, layout: { ...form.layout, order: flattenPageOrder(form.schema?.pages || [], form.schema?.fields || []) } }; }

function nestedSlotEntries(field = {}) {
  const props = field.props || {};
  if (["section", "row", "flex", "card"].includes(field.type)) return [{ kind: "children", label: "Content", ids: props.children || [] }];
  if (field.type === "columns") {
    const count = Math.max(1, Math.min(Number(props.columns || 2), 6));
    return Array.from({ length: count }, (_, index) => ({ kind: "slot", index, label: `Column ${index + 1}`, ids: props.slots?.[index] || [] }));
  }
  if (field.type === "grid") {
    const columns = Math.max(1, Math.min(Number(props.columns || 2), 6));
    const rows = Math.max(1, Math.min(Number(props.rows || 2), 12));
    return Array.from({ length: rows * columns }, (_, index) => { const row = Math.floor(index / columns); const column = index % columns; const key = `${row}:${column}`; return { kind: "cell", row, column, key, label: `Cell ${row + 1}.${column + 1}`, ids: props.cells?.[key] || [] }; });
  }
  return [];
}
function removeIdFromProps(props = {}, id) {
  const next = { ...props };
  if (Array.isArray(next.children)) next.children = next.children.filter((x) => x !== id);
  if (Array.isArray(next.slots)) next.slots = next.slots.map((slot) => Array.isArray(slot) ? slot.filter((x) => x !== id) : []);
  if (next.cells && typeof next.cells === "object") next.cells = Object.fromEntries(Object.entries(next.cells).map(([key, value]) => [key, Array.isArray(value) ? value.filter((x) => x !== id) : []]));
  if (next.layoutByChild && typeof next.layoutByChild === "object") {
    next.layoutByChild = { ...next.layoutByChild };
    delete next.layoutByChild[id];
  }
  return next;
}
function insertIdIntoProps(field, target, id, index) {
  let props = removeIdFromProps(field.props || {}, id);
  if (target.kind === "children") {
    const children = [...(props.children || [])]; children.splice(Math.max(0, Math.min(Number(index ?? children.length), children.length)), 0, id); return pruneLayoutByChild({ ...props, children }, children);
  }
  if (target.kind === "slot") {
    const count = Math.max(1, Math.min(Number(props.columns || 2), 6)); const slots = Array.from({ length: count }, (_, i) => Array.isArray(props.slots?.[i]) ? [...props.slots[i]] : []); const slot = slots[target.index] || [];
    slot.splice(Math.max(0, Math.min(Number(index ?? slot.length), slot.length)), 0, id); slots[target.index] = slot; return pruneLayoutByChild({ ...props, slots }, slots.flat());
  }
  if (target.kind === "cell") {
    const cells = { ...(props.cells || {}) }; const key = target.key || `${target.row}:${target.column}`; const ids = Array.isArray(cells[key]) ? [...cells[key]] : [];
    ids.splice(Math.max(0, Math.min(Number(index ?? ids.length), ids.length)), 0, id); cells[key] = ids; return pruneLayoutByChild({ ...props, cells }, Object.values(cells).flat());
  }
  return props;
}


const H_ALIGN_OPTIONS = ["left", "center", "right", "stretch"];
const V_ALIGN_OPTIONS = ["top", "center", "bottom", "stretch"];
function normalizeChildLayout(layout = {}) {
  const align = H_ALIGN_OPTIONS.includes(layout.align) ? layout.align : "stretch";
  const verticalAlign = V_ALIGN_OPTIONS.includes(layout.verticalAlign) ? layout.verticalAlign : "stretch";
  const columnSpan = Math.max(1, Math.min(Number(layout.columnSpan || layout.colSpan || 1), 6));
  const rowSpan = Math.max(1, Math.min(Number(layout.rowSpan || 1), 12));
  return { align, verticalAlign, columnSpan, rowSpan };
}
function layoutByChild(props = {}) { return props.layoutByChild && typeof props.layoutByChild === "object" ? props.layoutByChild : {}; }
function childLayoutFor(parent = {}, childId) { return normalizeChildLayout(layoutByChild(parent.props || {})[childId] || {}); }
function pruneLayoutByChild(props = {}, validIds = []) {
  const valid = new Set(validIds);
  const entries = Object.entries(layoutByChild(props)).filter(([id]) => valid.has(id));
  if (!entries.length) { const { layoutByChild: _layoutByChild, ...rest } = props; return rest; }
  return { ...props, layoutByChild: Object.fromEntries(entries.map(([id, layout]) => [id, normalizeChildLayout(layout)])) };
}
function childLayoutStyle(layout = {}, { isGrid = false } = {}) {
  const next = normalizeChildLayout(layout);
  const justifySelf = ({ left: "start", center: "center", right: "end", stretch: "stretch" }[next.align] || "stretch");
  const alignSelf = ({ top: "start", center: "center", bottom: "end", stretch: "stretch" }[next.verticalAlign] || "stretch");
  return { justifySelf, alignSelf, ...(isGrid ? { gridColumn: `span ${next.columnSpan}`, gridRow: `span ${next.rowSpan}` } : {}) };
}
function isButtonField(fieldsById, id) { return fieldsById?.get?.(id)?.type === "button"; }

function gridCellLayout(parent = {}, key, rows, columns) {
  const ids = parent.props?.cells?.[key] || [];
  const layout = ids.length ? childLayoutFor(parent, ids[0]) : normalizeChildLayout({});
  const [rowRaw, columnRaw] = String(key).split(":").map(Number);
  const row = Number.isFinite(rowRaw) ? rowRaw : 0;
  const column = Number.isFinite(columnRaw) ? columnRaw : 0;
  const rowSpan = Math.max(1, Math.min(layout.rowSpan, rows - row));
  const columnSpan = Math.max(1, Math.min(layout.columnSpan, columns - column));
  return { ids, row, column, layout: { ...layout, rowSpan, columnSpan } };
}
function visibleGridCells(parent = {}, rows, columns) {
  const occupied = new Set();
  const cells = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const key = `${row}:${column}`;
      if (occupied.has(key)) continue;
      const cell = gridCellLayout(parent, key, rows, columns);
      cells.push({ ...cell, key });
      if (cell.ids.length) {
        for (let r = row; r < row + cell.layout.rowSpan; r += 1) {
          for (let c = column; c < column + cell.layout.columnSpan; c += 1) {
            if (r !== row || c !== column) occupied.add(`${r}:${c}`);
          }
        }
      }
    }
  }
  return cells;
}
function gridCellStyle(cell) {
  return { gridColumnStart: cell.column + 1, gridRowStart: cell.row + 1, ...(cell.ids.length ? childLayoutStyle(cell.layout, { isGrid: true }) : {}) };
}


function replaceIdInProps(props = {}, from, to) {
  const repl = (ids) => Array.isArray(ids) ? ids.map((id) => id === from ? to : id) : [];
  const next = { ...props };
  if (Array.isArray(next.children)) next.children = repl(next.children);
  if (Array.isArray(next.slots)) next.slots = next.slots.map(repl);
  if (next.cells && typeof next.cells === "object") next.cells = Object.fromEntries(Object.entries(next.cells).map(([key, value]) => [key, repl(value)]));
  if (next.layoutByChild && typeof next.layoutByChild === "object" && next.layoutByChild[from]) {
    next.layoutByChild = { ...next.layoutByChild, [to]: next.layoutByChild[from] };
    delete next.layoutByChild[from];
  }
  return next;
}
function moveInsideArray(ids, id, dir) { const next = [...ids]; const i = next.indexOf(id); const j = i + dir; if (i < 0 || j < 0 || j >= next.length) return ids; [next[i], next[j]] = [next[j], next[i]]; return next; }
function outlineRows(rootFields, byId, prefix = "") {
  const rows = [];
  rootFields.forEach((field, index) => {
    const number = prefix ? `${prefix}.${index + 1}` : `${index + 1}`;
    rows.push({ field, number, depth: number.split(".").length - 1 });
    nestedSlotEntries(field).forEach((slot) => rows.push(...outlineRows((slot.ids || []).map((id) => byId.get(id)).filter(Boolean), byId, number)));
  });
  return rows;
}


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
  if (type === "columns") base.props = { columns: 2, gap: 12, padding: "md", slots: [[], []] };
  if (type === "grid") base.props = { rows: 2, columns: 2, gap: 12, padding: "md", cells: { "0:0": [], "0:1": [], "1:0": [], "1:1": [] } };
  if (type === "row") base.props = { padding: "md", children: [] };
  if (type === "flex") base.props = { direction: "row", justify: "start", gap: 16, wrap: true, padding: "md", children: [] };
  if (type === "spacer") base.props = { size: "md", direction: "vertical" };
  if (type === "divider") base.props = { padding: "md", borderWidth: 1, borderColor: "var(--border)" };
  if (type === "codeblock") { base.label = "Code block"; base.props = { code: "// Paste code here", language: "javascript", showLineNumbers: false, maxHeight: 360, padding: "md" }; }
  if (type === "hero") { base.label = "Hero section"; base.props = { title: "Help customers faster", quote: "Agent form", description: "Collect the right context during every conversation.", align: "left", padding: "xl", imageUrl: "", imageMode: "inline", buttons: [{ label: "Primary action", href: "#", variant: "primary" }] }; }
  if (type === "stats") { base.label = "Stats"; base.props = { padding: "lg", items: [{ title: "24/7", description: "Coverage", icon: "IconClock" }, { title: "95%", description: "CSAT", icon: "IconThumbUp" }, { title: "2m", description: "Avg response", icon: "IconBolt" }] }; }
  if (type === "card") { base.label = "Card"; base.props = { title: "Card title", description: "Short supporting description.", mode: "card", icon: "spark", padding: "md", imageUrl: "", children: [] }; }
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
  const initialSavedRef = useRef(JSON.stringify(normalizeFormDefinition(initialForm || createDefaultForm({ name: "New agent form" }))));
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [showExitDialog, setShowExitDialog] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState(null);

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
  const fieldsById = useMemo(() => new Map((form.schema?.fields || []).map((f) => [f.id, f])), [form]);
  const selectedField = orderedFields.find((f) => f.id === selectedId) || null;
  const outlineItems = useMemo(() => outlineRows(activePageFields, fieldsById), [activePageFields, fieldsById]);

  useEffect(() => {
    const run = () => preloadPageIcons();
    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      const id = window.requestIdleCallback(run, { timeout: 1200 });
      return () => window.cancelIdleCallback?.(id);
    }
    run();
  }, []);

  useEffect(() => {
    if (!pages.some((page) => page.id === activePageId) && pages[0]) setActivePageId(pages[0].id);
  }, [pages, activePageId]);
  useEffect(() => {
    if (selectedField) return;
    if (activePageFields[0]) setSelectedId(activePageFields[0].id);
  }, [activePageFields, selectedField]);

  useEffect(() => { setHasUnsavedChanges(JSON.stringify(normalizeFormDefinition(form)) !== initialSavedRef.current); }, [form]);
  useEffect(() => {
    const beforeUnload = (e) => { if (!hasUnsavedChanges) return; e.preventDefault(); e.returnValue = ""; return ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [hasUnsavedChanges]);
  useEffect(() => {
    const onClick = (e) => {
      if (!hasUnsavedChanges) return;
      const anchor = e.target?.closest?.("a[href]");
      if (!anchor || anchor.target || anchor.hasAttribute("download")) return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("mailto:")) return;
      e.preventDefault(); setPendingNavigation(href); setShowExitDialog(true);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [hasUnsavedChanges]);
  useEffect(() => {
    if (!selectedId || selectedId === "form") return;
    document.querySelector(`[data-form-field-id="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedId]);

  function update(next) {
    setForm(normalizeFormDefinition(next));
  }
  function patchForm(patch) {
    update({ ...form, ...patch });
  }
  function selectField(id) { setSelectedId(id); }
  function updateField(id, patch) {
    update({ ...form, schema: { ...form.schema, fields: form.schema.fields.map((field) => field.id === id ? { ...field, ...patch } : field) } });
  }
  function withoutFieldRefs(fields, id) { return fields.map((field) => ({ ...field, props: removeIdFromProps(field.props || {}, id) })); }
  function findFieldLocation(id) {
    for (const page of pages) { const index = (page.fields || []).indexOf(id); if (index >= 0) return { kind: "root", pageId: page.id, index }; }
    for (const field of form.schema.fields) for (const slot of nestedSlotEntries(field)) { const index = (slot.ids || []).indexOf(id); if (index >= 0) return { ...slot, containerId: field.id, index }; }
    return null;
  }
  function addField(type, target = null, options = {}) {
    const field = { ...newField(type), ...(options.fieldPatch || {}) };
    const pageId = target?.pageId || activePage?.id || pages[0]?.id || "page_1";
    let nextFields = [...form.schema.fields, field];
    let nextPages = pages.length ? pages : [{ id: pageId, title: "Page 1", fields: [] }];
    if (target?.containerId) {
      nextFields = nextFields.map((item) => item.id === target.containerId ? { ...item, props: insertIdIntoProps(item, target, field.id, target.index) } : item);
    } else {
      nextPages = nextPages.map((page) => {
        if (page.id !== pageId) return page;
        const fields = [...(page.fields || [])];
        const index = Number.isInteger(target?.index) ? Math.max(0, Math.min(target.index, fields.length)) : fields.length;
        fields.splice(index, 0, field.id);
        return { ...page, fields };
      });
    }
    update(rebuildLayoutFromPages({ ...form, schema: { ...form.schema, fields: nextFields, pages: nextPages } }));
    setSelectedId(field.id);
    if (options.switchToFields) setActiveTab("fields");
    return field.id;
  }
  function removeField(id) {
    const descendants = new Set([id]);
    const byId = new Map(form.schema.fields.map((field) => [field.id, field]));
    function collect(fieldId) { (getFieldChildIds(byId.get(fieldId)) || []).forEach((child) => { descendants.add(child); collect(child); }); }
    collect(id);
    let nextFields = form.schema.fields.filter((field) => !descendants.has(field.id));
    descendants.forEach((removeId) => { nextFields = withoutFieldRefs(nextFields, removeId); });
    const nextPages = pages.map((page) => ({ ...page, fields: (page.fields || []).filter((fieldId) => !descendants.has(fieldId)) }));
    const nextPageFields = activePageFields.filter((field) => !descendants.has(field.id));
    update(rebuildLayoutFromPages({ ...form, schema: { ...form.schema, fields: nextFields, pages: nextPages } }));
    setSelectedId(nextPageFields[0]?.id || "form");
  }
  function duplicateField(field) {
    const byId = new Map(form.schema.fields.map((item) => [item.id, item]));
    const clones = [];
    function clone(fieldId) {
      const source = byId.get(fieldId); if (!source) return null;
      const copy = { ...source, id: makeId(source.type), label: fieldId === field.id ? `${source.label || source.id} copy` : source.label, props: { ...(source.props || {}) } };
      clones.push(copy);
      if (["section", "row", "flex", "card"].includes(source.type)) copy.props.children = (source.props?.children || []).map(clone).filter(Boolean);
      if (source.type === "columns") copy.props.slots = (source.props?.slots || []).map((slot) => (slot || []).map(clone).filter(Boolean));
      if (source.type === "grid") copy.props.cells = Object.fromEntries(Object.entries(source.props?.cells || {}).map(([key, ids]) => [key, (ids || []).map(clone).filter(Boolean)]));
      return copy.id;
    }
    const copyId = clone(field.id); const location = findFieldLocation(field.id);
    let nextPages = pages; let nextFields = [...form.schema.fields, ...clones];
    if (location?.kind === "root") nextPages = pages.map((page) => page.id === location.pageId ? { ...page, fields: [...page.fields.slice(0, location.index + 1), copyId, ...page.fields.slice(location.index + 1)] } : page);
    else if (location?.containerId) nextFields = nextFields.map((item) => item.id === location.containerId ? { ...item, props: insertIdIntoProps(item, location, copyId, location.index + 1) } : item);
    update(rebuildLayoutFromPages({ ...form, schema: { ...form.schema, fields: nextFields, pages: nextPages } }));
    setSelectedId(copyId);
  }
  function moveField(id, dir) {
    const location = findFieldLocation(id); if (!location) return;
    let nextPages = pages; let nextFields = form.schema.fields;
    if (location.kind === "root") nextPages = pages.map((page) => page.id === location.pageId ? { ...page, fields: moveInsideArray(page.fields || [], id, dir) } : page);
    else nextFields = form.schema.fields.map((field) => field.id === location.containerId ? { ...field, props: insertIdIntoProps({ ...field, props: removeIdFromProps(field.props || {}, id) }, location, id, location.index + dir) } : field);
    update(rebuildLayoutFromPages({ ...form, schema: { ...form.schema, fields: nextFields, pages: nextPages } }));
  }
  function addPage() {
    const title = `Page ${pages.length + 1}`; const page = { id: makePageId(title), title, description: "", icon: "IconForms", fields: [] };
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
      const savedForm = normalizeFormDefinition(data.form);
      setForm(savedForm);
      initialSavedRef.current = JSON.stringify(savedForm);
      setHasUnsavedChanges(false);
      const savedMessage = status === "published" ? "Form published successfully" : "Form updated successfully";
      setMessage(savedMessage);
      notify({ title: savedMessage, description: "Your form changes are saved.", variant: "success" });
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
    if (data.ok) { const publishedForm = normalizeFormDefinition(data.form); setForm(publishedForm); initialSavedRef.current = JSON.stringify(publishedForm); setHasUnsavedChanges(false); setMessage("Form published successfully"); notify({ title: "Form published successfully", description: "Form is now published.", variant: "success" }); }
    else setMessage(data.error || "Publish failed");
  }

  function confirmExit() {
    setShowExitDialog(false); setHasUnsavedChanges(false);
    const target = pendingNavigation || "/admin/forms"; setPendingNavigation(null);
    if (/^https?:\/\//.test(target)) window.location.href = target; else router.push(target);
  }
  function cancelExit() { setShowExitDialog(false); setPendingNavigation(null); }

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
  useEffect(() => { if (activeTab === "media" || isImageCapable(selectedField)) loadMedia().catch(() => {}); }, [activeTab, selectedField?.id, selectedField?.type]);

  useEffect(() => {
    if (!formSettingsOpen || queues.length) return;
    fetch("/api/admin/queues?enabled=true&pageSize=100", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => setQueues(data.rows || []))
      .catch(() => setQueues([]));
  }, [formSettingsOpen, queues.length]);

  async function saveMediaTitle(item, title) {
    const cleanTitle = String(title || "").trim();
    setMedia((rows) => rows.map((row) => row.url === item.url ? { ...row, title: cleanTitle, display_name: cleanTitle } : row));
    try {
      const res = await fetch("/api/admin/forms/media", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: item.url, title: cleanTitle }) });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || "Title update failed");
    } catch (err) {
      setMessage(err.message || "Title update failed");
      loadMedia().catch(() => {});
    }
  }

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

  function targetFromOverId(overId) {
    if (!overId || overId === "form-canvas") return null;
    if (overId.startsWith("container:")) {
      const [, containerId, kind, a, b] = overId.split(":");
      return kind === "slot" ? { containerId, kind, index: Number(a) } : kind === "cell" ? { containerId, kind, row: Number(a), column: Number(b), key: `${a}:${b}` } : { containerId, kind: "children" };
    }
    if (overId.startsWith("field:")) {
      const fieldId = overId.slice("field:".length);
      const location = findFieldLocation(fieldId);
      if (location?.kind === "root") return { kind: "root", pageId: location.pageId, index: location.index + 1 };
      if (location?.containerId) return { ...location, index: location.index + 1 };
    }
    return null;
  }

  function setFieldImage(fieldId, item) {
    const field = fieldsById.get(fieldId);
    const key = imagePropKey(field);
    if (!key) return false;
    updateField(fieldId, { label: field.type === "image" ? mediaTitle(item) : field.label, props: { ...(field.props || {}), [key]: item.url, imageTitle: mediaTitle(item) } });
    setSelectedId(fieldId);
    return true;
  }

  function addMediaImage(item, target = null) {
    return addField("image", target, { fieldPatch: { label: mediaTitle(item), props: { src: item.url, imageTitle: mediaTitle(item) } } });
  }
  function isDescendantOf(candidateId, parentId) {
    const byId = fieldsById;
    const stack = [...(getFieldChildIds(byId.get(parentId)) || [])];
    while (stack.length) {
      const id = stack.pop();
      if (id === candidateId) return true;
      stack.push(...(getFieldChildIds(byId.get(id)) || []));
    }
    return false;
  }
  function moveFieldToTarget(id, target) {
    if (!id || !target || (target.containerId && (target.containerId === id || isDescendantOf(target.containerId, id)))) return;
    const current = findFieldLocation(id);
    if (!current) return;
    const sameRoot = current.kind === "root" && target.kind === "root" && current.pageId === target.pageId;
    const sameContainer = current.containerId && current.containerId === target.containerId && current.kind === target.kind && current.index !== undefined;
    if ((sameRoot || sameContainer) && current.index < Number(target.index ?? 0)) target = { ...target, index: Number(target.index) - 1 };
    let nextPages = pages.map((page) => ({ ...page, fields: (page.fields || []).filter((fieldId) => fieldId !== id) }));
    let nextFields = form.schema.fields.map((field) => ({ ...field, props: removeIdFromProps(field.props || {}, id) }));
    if (target.kind === "root") {
      nextPages = nextPages.map((page) => {
        if (page.id !== target.pageId) return page;
        const fields = [...(page.fields || [])];
        fields.splice(Math.max(0, Math.min(Number(target.index ?? fields.length), fields.length)), 0, id);
        return { ...page, fields };
      });
    } else if (target.containerId) {
      nextFields = nextFields.map((field) => field.id === target.containerId ? { ...field, props: insertIdIntoProps(field, target, id, target.index) } : field);
    }
    update(rebuildLayoutFromPages({ ...form, schema: { ...form.schema, fields: nextFields, pages: nextPages } }));
    setSelectedId(id);
  }

  function handleDragStart(event) {
    const data = event.active?.data?.current || {};
    setActiveDragType(data.dragKind === "media" ? "media" : data.dragKind === "field" ? fieldsById.get(data.fieldId)?.type || "field" : data.type || null);
  }
  function handleDragEnd(event) {
    const data = event.active?.data?.current || {};
    const type = data.type;
    const overId = String(event.over?.id || "");
    if (!overId) { setActiveDragType(null); return; }
    if (data.dragKind === "field" && data.fieldId) {
      moveFieldToTarget(data.fieldId, targetFromOverId(overId) || { kind: "root", pageId: activePage?.id || pages[0]?.id || "page_1" });
    } else if (data.dragKind === "media" && data.media) {
      if (overId.startsWith("field:") && setFieldImage(overId.slice("field:".length), data.media)) { setActiveDragType(null); return; }
      if (overId.startsWith("container:")) {
        const containerId = overId.split(":")[1];
        if (setFieldImage(containerId, data.media)) { setActiveDragType(null); return; }
      }
      addMediaImage(data.media, targetFromOverId(overId));
    } else if (type) {
      addField(type, targetFromOverId(overId));
    }
    setActiveDragType(null);
  }

  return <div className="h-[calc(100vh-var(--header-height)-2rem)] min-h-0 -my-4 md:-my-6 flex flex-col overflow-hidden bg-muted/40">
    <div className="h-16 shrink-0 border-b bg-background px-4 flex items-center justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3">
        <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => { if (hasUnsavedChanges) { setPendingNavigation("/admin/forms"); setShowExitDialog(true); } else router.push("/admin/forms"); }}><IconArrowLeft className="mr-1 h-4 w-4" />Forms</Button>
        <div className="flex min-w-0 items-center gap-2"><h1 className="truncate text-xl font-semibold tracking-tight">{form.name || "Untitled form"}</h1><Badge variant="outline" className={STATUS_BADGE_CLASS[form.status || "draft"] || STATUS_BADGE_CLASS.draft}>{form.status || "draft"}</Badge>{hasUnsavedChanges ? <Badge variant="outline" className="border-orange-500 text-orange-700 dark:text-orange-300">Unsaved</Badge> : <Badge variant="outline" className="border-emerald-500 text-emerald-700 dark:text-emerald-300">Saved</Badge>}{message ? <Badge variant="outline" className={message.toLowerCase().includes("fail") ? MESSAGE_BADGE_CLASS.error : MESSAGE_BADGE_CLASS.saved}>{message}</Badge> : null}</div>
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

    <AlertDialog open={showExitDialog} onOpenChange={setShowExitDialog}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
          <AlertDialogDescription>You have unsaved changes. Are you sure you want to leave? All unsaved changes will be lost.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={cancelExit}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={confirmExit} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Leave without saving</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <DndContext onDragStart={handleDragStart} onDragCancel={() => setActiveDragType(null)} onDragEnd={handleDragEnd}>
    <div className="grid flex-1 min-h-0 gap-3 p-3 grid-cols-[72px_320px_minmax(0,1fr)_360px]">
      <section className="min-h-0 overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="h-full overflow-y-auto p-2 flex flex-col items-center gap-2">
          {RAIL.map(({ id, label, icon: Icon }) => <button key={id} type="button" onClick={() => setActiveTab(id)} className={`w-14 rounded-lg px-2 py-3 text-[10px] flex flex-col items-center gap-1 transition ${activeTab === id ? "bg-primary text-primary-foreground shadow" : "text-muted-foreground hover:bg-muted"}`}><Icon className="h-5 w-5" />{label}</button>)}
        </div>
      </section>

      <section className="min-h-0 overflow-hidden rounded-xl border bg-card shadow-sm flex flex-col">
        <LeftPanel activeTab={activeTab} form={form} patchForm={patchForm} pages={pages} activePageId={activePage?.id} setActivePageId={setActivePageId} addPage={addPage} updatePage={updatePage} removePage={removePage} movePage={movePage} orderedFields={activePageFields} allFields={orderedFields} selectedId={selectedId} setSelectedId={selectField} outlineItems={outlineItems} addField={addField} removeField={removeField} duplicateField={duplicateField} moveField={moveField} aiMessages={aiMessages} aiPrompt={aiPrompt} setAiPrompt={setAiPrompt} sendAi={sendAi} clearAiChat={clearAiChat} aiLoading={aiLoading} aiMessagesEndRef={aiMessagesEndRef} templates={templates} createFromTemplate={createFromTemplate} media={media} uploadMediaFile={uploadMediaFile} uploadingMedia={uploadingMedia} addMediaImage={addMediaImage} setMedia={setMedia} saveMediaTitle={saveMediaTitle} />
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
          <div className="mx-auto w-full rounded-2xl border bg-background text-foreground shadow-sm min-h-full p-5 md:p-8">
            <div className="w-full space-y-6">
              {pages.length > 1 ? <PageTabs pages={pages} activePageId={activePage?.id} setActivePageId={setActivePageId} activeBorderColor={form.theme?.pageTabActiveBorderColor} /> : null}
              {activePageFields.map((field) => <CanvasField key={field.id} field={field} fieldsById={fieldsById} selectedId={selectedId} selected={selectedId === field.id && !previewMode} readOnly={previewMode} onSelect={(id) => !previewMode && selectField(id || field.id)} addField={addField} removeField={removeField} duplicateField={duplicateField} moveField={moveField} updateField={updateField} />)}
              {!activePageFields.length ? <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">Add blocks from the left palette to start building this page.</div> : null}
            </div>
          </div>
        </CanvasDropZone>
      </section>

      <section className="min-h-0 overflow-hidden rounded-xl border bg-card shadow-sm flex flex-col">
        <PropertiesPanel form={form} patchForm={patchForm} selectedField={selectedField} selectedId={selectedId} setSelectedId={setSelectedId} updateField={updateField} media={media} />
      </section>
    </div>
      <DragOverlay dropAnimation={null}>{activeDragType === "media" ? <MediaDragPreview /> : activeDragType ? <BlockDragPreview type={activeDragType} /> : null}</DragOverlay>
    </DndContext>
  </div>;
}


function RevertibleTextInput({ value = "", onCommit, restoreOnEmpty = false, fallbackValue = "", ...props }) {
  const externalValue = value ?? "";
  const [draft, setDraft] = useState(externalValue);
  const [focused, setFocused] = useState(false);
  const valueAtFocusRef = useRef(externalValue || fallbackValue);
  useEffect(() => { if (!focused) setDraft(externalValue); }, [externalValue, focused]);
  function commit(next) {
    if (restoreOnEmpty && !String(next || "").trim()) return;
    onCommit?.(next);
  }
  return <Input
    {...props}
    value={focused ? draft : externalValue}
    onFocus={(e) => { valueAtFocusRef.current = externalValue || fallbackValue; setFocused(true); setDraft(externalValue); props.onFocus?.(e); }}
    onChange={(e) => { const next = e.target.value; setDraft(next); commit(next); props.onChange?.(e); }}
    onBlur={(e) => {
      const next = e.target.value;
      setFocused(false);
      if (restoreOnEmpty && !next.trim()) {
        const restored = valueAtFocusRef.current || fallbackValue;
        setDraft(restored);
        onCommit?.(restored);
      } else { commit(next); }
      props.onBlur?.(e);
    }}
  />;
}


function isHexColor(value) { return /^#[0-9A-Fa-f]{6}$/.test(String(value || "")); }
function colorPickerValue(value) { return isHexColor(value) ? value : "#000000"; }

function ColorInput({ label, value = "", onChange, placeholder = "#ccbbaa" }) {
  const [draft, setDraft] = useState(value || "");
  useEffect(() => { setDraft(value || ""); }, [value]);
  function commit(nextValue) {
    setDraft(nextValue);
    if (nextValue === "" || isHexColor(nextValue)) onChange?.(nextValue);
  }
  return <div className="space-y-2">
    {label ? <Label>{label}</Label> : null}
    <div className="grid grid-cols-[1fr_auto] items-center gap-2">
      <Input className="font-mono" value={draft} placeholder={placeholder} onChange={(e) => commit(e.target.value)} onBlur={() => { if (draft && !isHexColor(draft) && value !== draft) setDraft(value || ""); }} />
      <label className="relative block h-10 w-12 shrink-0 cursor-pointer overflow-hidden rounded-md border border-input shadow-xs" title="Pick color">
        <span className="block h-full w-full" style={{ backgroundColor: colorPickerValue(value || draft) }} />
        <input type="color" className="absolute inset-0 h-full w-full cursor-pointer opacity-0" value={colorPickerValue(value || draft)} onChange={(e) => commit(e.target.value)} />
      </label>
    </div>
  </div>;
}

function PanelHeader({ title, description }) {
  return <div className="h-14 shrink-0 border-b px-4 flex flex-col justify-center">
    <h2 className="font-semibold text-sm">{title}</h2>
    <p className="text-xs text-muted-foreground">{description}</p>
  </div>;
}

function LeftPanel(props) {
  const { activeTab, form, patchForm, pages = [], activePageId, setActivePageId, addPage, updatePage, removePage, movePage, orderedFields, allFields = orderedFields, selectedId, setSelectedId, outlineItems = [], addField, removeField, duplicateField, moveField, aiMessages, aiPrompt, setAiPrompt, sendAi, clearAiChat, aiLoading, aiMessagesEndRef, templates = [], createFromTemplate, media = [], uploadMediaFile, uploadingMedia, addMediaImage, setMedia, saveMediaTitle } = props;
  const mediaInputRef = useRef(null);
  const [pexelsOpen, setPexelsOpen] = useState(false);
  const [pexelsQuery, setPexelsQuery] = useState("");
  const [pexelsResults, setPexelsResults] = useState([]);
  const [pexelsLoading, setPexelsLoading] = useState(false);
  const [pexelsError, setPexelsError] = useState("");
  const [pexelsDownloadingId, setPexelsDownloadingId] = useState(null);

  async function searchPexels(e) {
    e?.preventDefault?.();
    const query = pexelsQuery.trim();
    if (query.length < 2) { setPexelsError("Enter at least 2 characters to search Pexels."); return; }
    setPexelsLoading(true); setPexelsError("");
    try {
      const res = await fetch(`/api/admin/forms/media/pexels?query=${encodeURIComponent(query)}&perPage=40`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Pexels search failed");
      setPexelsResults(data.photos || []);
    } catch (err) {
      setPexelsResults([]);
      setPexelsError(err?.message || "Pexels search failed");
    } finally { setPexelsLoading(false); }
  }

  async function downloadPexelsPhoto(photo) {
    if (!photo?.id) return;
    setPexelsDownloadingId(photo.id); setPexelsError("");
    try {
      const res = await fetch("/api/admin/forms/media/pexels", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ photoId: photo.id }) });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Pexels download failed");
      setMedia?.((rows) => [data.media, ...(rows || []).filter((row) => row.url !== data.media.url)]);
      setPexelsOpen(false);
    } catch (err) {
      setPexelsError(err?.message || "Pexels download failed");
    } finally { setPexelsDownloadingId(null); }
  }

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
      <div className="shrink-0 space-y-3 border-b p-4">
        <ColorInput label="Active tab underline color" value={form.theme?.pageTabActiveBorderColor || ""} onChange={(color) => patchForm({ theme: { ...(form.theme || {}), pageTabActiveBorderColor: color } })} />
        <Button type="button" size="sm" variant="ghost" onClick={() => patchForm({ theme: { ...(form.theme || {}), pageTabActiveBorderColor: "" } })}>Use theme default</Button>
        <Button type="button" className="w-full" onClick={addPage}><IconPlus className="mr-2 h-4 w-4" />Add page</Button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        {pages.map((page, index) => <div key={page.id} className={`rounded-xl border p-3 ${activePageId === page.id ? "border-primary bg-primary/5" : "bg-background"}`}>
          <button type="button" className="mb-3 w-full text-left" onClick={() => setActivePageId(page.id)}>
            <div className="flex items-center gap-2 text-sm font-semibold"><PageIcon value={page.icon} />{page.title || `Page ${index + 1}`}</div>
            <div className="text-xs text-muted-foreground">{(page.fields || []).length} blocks · {page.id}</div>
          </button>
          <div className="space-y-2">
            <RevertibleTextInput value={page.title ?? ""} restoreOnEmpty fallbackValue={`Page ${index + 1}`} onCommit={(value) => updatePage(page.id, { title: value })} placeholder="Page title" />
            <PageIconPicker value={page.icon || ""} onChange={(icon) => updatePage(page.id, { icon })} />
            <Input value={page.description ?? ""} onChange={(e) => updatePage(page.id, { description: e.target.value })} placeholder="Optional description" />
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
    return <>
      <div className="h-full min-h-0 flex flex-col">
        <PanelHeader title="Media" description="Drag image cards onto the canvas or image blocks." />
        <div className="shrink-0 border-b p-4 space-y-3">
          <div className="rounded-xl border border-dashed bg-muted/25 p-3 text-center text-xs text-muted-foreground" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); uploadMediaFile?.(e.dataTransfer.files?.[0]); }}>
            Drop an image here to upload
          </div>
          <input ref={mediaInputRef} className="hidden" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" disabled={uploadingMedia} onChange={(e) => { uploadMediaFile?.(e.target.files?.[0]); e.target.value = ""; }} />
          <Button type="button" variant="outline" className="w-full" disabled={uploadingMedia} onClick={() => mediaInputRef.current?.click()}><IconUpload className="mr-2 h-4 w-4" />{uploadingMedia ? "Uploading..." : "Upload image"}</Button>
          <Button type="button" variant="outline" className="w-full" onClick={() => setPexelsOpen(true)}><IconWorldUpload className="mr-2 h-4 w-4" />Search in Pexels</Button>
          <p className="text-xs text-muted-foreground">Max 5MB. Safe filenames are generated automatically. Pexels photos are free to use; attribution is appreciated but not required.</p>
        </div>
        <div className="flex-1 min-h-0 w-full overflow-y-auto overflow-x-hidden p-4 space-y-3">
          {media.map((item) => <DraggableMediaCard key={item.url} item={item} onAdd={addMediaImage} onTitleCommit={(title) => saveMediaTitle?.(item, title)} />)}
          {!media.length ? <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No media uploaded yet.</div> : null}
        </div>
      </div>
      <Dialog open={pexelsOpen} onOpenChange={setPexelsOpen}>
        <DialogContent className="!flex h-[88vh] w-[50vw] min-w-[720px] !max-w-[50vw] flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Search in Pexels</DialogTitle>
            <DialogDescription>Search royalty-free Pexels photos and download one into this form media library.</DialogDescription>
          </DialogHeader>
          <form className="grid grid-cols-[1fr_auto] gap-2" onSubmit={searchPexels}>
            <Input value={pexelsQuery} onChange={(e) => setPexelsQuery(e.target.value)} placeholder="e.g. customer support, city, nature" />
            <Button type="submit" disabled={pexelsLoading}>{pexelsLoading ? "Searching..." : "Search"}</Button>
          </form>
          {pexelsError ? <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{pexelsError}</div> : null}
          <div className="grid min-h-0 flex-1 auto-rows-max gap-5 overflow-y-auto overflow-x-hidden pr-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {pexelsResults.map((photo) => <div key={photo.id} className="relative overflow-hidden rounded-xl border bg-background">
              <div className="aspect-video bg-muted"><img src={photo.src?.large || photo.src?.medium || photo.src?.small || photo.src?.tiny} alt={photo.alt || photo.title} className="h-full w-full object-cover" /></div>
              <Button type="button" size="icon" className="absolute right-2 top-2 h-8 w-8 rounded-full bg-background/90 text-foreground shadow backdrop-blur hover:bg-background" disabled={pexelsDownloadingId === photo.id} onClick={() => downloadPexelsPhoto(photo)} title={pexelsDownloadingId === photo.id ? "Downloading..." : "Download to media"} aria-label={pexelsDownloadingId === photo.id ? "Downloading Pexels photo" : "Download Pexels photo to media"}>{pexelsDownloadingId === photo.id ? <IconLoader2 className="h-4 w-4 animate-spin" /> : <IconDownload className="h-4 w-4" />}</Button>
              <div className="space-y-1 p-3">
                <div className="line-clamp-1 text-sm font-medium">{photo.title}</div>
                <div className="line-clamp-1 text-xs text-muted-foreground">Photo by {photo.photographer}</div>
              </div>
            </div>)}
          </div>
          {!pexelsResults.length && !pexelsLoading ? <p className="text-sm text-muted-foreground">No Pexels results yet. Try a search term above.</p> : null}
          <p className="text-xs text-muted-foreground">Pexels license: free to use and attribution is not required; do not imply endorsement, sell unaltered copies, redistribute as stock photos, or use imagery as a trademark/service mark.</p>
        </DialogContent>
      </Dialog>
    </>;
  }

  if (activeTab === "outline") {
    return <div className="h-full min-h-0 flex flex-col">
      <PanelHeader title="Outline" description="Page structure and render order." />
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        <div className="rounded-lg border bg-muted/30 p-2 text-sm font-medium">{form.name}</div>
        <div className="ml-4 border-l pl-3 space-y-2">
          {outlineItems.map(({ field, number, depth }) => <button key={field.id} className={`block w-full rounded-md border p-2 text-left text-sm ${selectedId === field.id ? "border-primary bg-primary/5" : "bg-background"}`} style={{ marginLeft: depth * 14 }} onClick={() => setSelectedId(field.id)}>
            {number}. {field.label || field.id}
            <div className="text-xs text-muted-foreground">{field.type}</div>
          </button>)}
        </div>
      </div>
    </div>;
  }

  return <div className="h-full min-h-0 flex flex-col">
    <PanelHeader title="Fields" description="Select, duplicate, remove, and reorder fields." />
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
      {(outlineItems.length ? outlineItems : orderedFields.map((field, index) => ({ field, number: `${index + 1}`, depth: 0 }))).map(({ field, number, depth }) => <div key={field.id} className={`rounded-xl border p-3 ${selectedId === field.id ? "border-primary bg-primary/5" : "bg-background"}`} style={{ marginLeft: depth * 12 }} onClick={() => setSelectedId(field.id)}>
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
  return <div ref={setNodeRef} className={`flex-1 min-h-0 overflow-auto p-4 md:p-6 transition ${themeClass} ${isOver ? "bg-primary/10" : "bg-muted/70"}`}>{children}</div>;
}

function PageTabs({ pages = [], activePageId, setActivePageId, activeBorderColor }) {
  return <div className="mb-6 flex items-center gap-1 border-b">
    {pages.map((page) => {
      const active = activePageId === page.id;
      return <button key={page.id} type="button" onClick={() => setActivePageId(page.id)} className={`relative inline-flex items-center gap-2 px-4 py-2 text-sm font-medium transition ${active ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
        <PageIcon value={page.icon} />
        {page.title || page.id}
        <span className={`absolute inset-x-0 -bottom-px h-0.5 rounded-full ${active && !activeBorderColor ? "bg-primary" : "bg-transparent"}`} style={active && activeBorderColor ? { backgroundColor: activeBorderColor } : undefined} />
      </button>;
    })}
  </div>;
}

function PageIconPicker({ value = "", onChange, label = "Page icon" }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const normalizedValue = pageIconValue(value);
  const selected = PAGE_ICON_OPTIONS.find((option) => option.value === normalizedValue);
  const q = query.trim().toLowerCase();
  const filtered = q ? PAGE_ICON_OPTIONS.filter((option) => option.label.toLowerCase().includes(q) || option.value.toLowerCase().includes(q)) : PAGE_ICON_OPTIONS;
  const visibleOptions = filtered.slice(0, q ? PAGE_ICON_SEARCH_LIMIT : PAGE_ICON_INITIAL_LIMIT);
  return <div className="space-y-2">
    <Label>{label}</Label>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="w-full justify-start gap-2 font-normal">
          <PageIcon value={normalizedValue} />
          <span className={selected ? "" : "text-muted-foreground"}>{selected?.label || "No icon"}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[300px] p-3">
        <div className="space-y-3">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search icons..." autoFocus />
          <div className="grid max-h-72 grid-cols-4 gap-2 overflow-y-auto pr-1">
            <button type="button" onClick={() => { onChange?.(""); setOpen(false); }} className={`flex h-16 flex-col items-center justify-center gap-1 rounded-md border text-[10px] transition hover:border-primary ${!normalizedValue ? "border-primary bg-primary/10" : "bg-background"}`}>None</button>
            {visibleOptions.map((option) => <button key={option.value} type="button" title={option.label} onClick={() => { onChange?.(option.value); setOpen(false); }} className={`flex h-16 min-w-0 flex-col items-center justify-center gap-1 rounded-md border p-1 text-[10px] transition hover:border-primary ${normalizedValue === option.value ? "border-primary bg-primary/10" : "bg-background"}`}>
              <PageIcon value={option.value} className="h-5 w-5" />
              <span className="w-full truncate text-center">{option.label}</span>
            </button>)}
          </div>
          {filtered.length > visibleOptions.length ? <p className="text-[11px] text-muted-foreground">Showing {visibleOptions.length} of {filtered.length} icons. Type to narrow the search.</p> : null}
        </div>
      </PopoverContent>
    </Popover>
  </div>;
}

function normalizeStatItem(item = {}, index = 0) {
  const source = item && typeof item === "object" ? item : {};
  return {
    ...source,
    title: source.title ?? `Stat ${index + 1}`,
    description: source.description ?? "Description",
    icon: pageIconValue(source.icon) || "",
    iconSize: source.iconSize ?? 28,
    iconColor: source.iconColor ?? "",
    titleColor: source.titleColor ?? "",
    descriptionColor: source.descriptionColor ?? "",
  };
}

function normalizeStatItems(items = []) {
  return Array.isArray(items) ? items.map(normalizeStatItem) : [];
}

function resizeStatItems(items = [], count = 0) {
  const safeCount = Math.max(0, Math.min(Number(count) || 0, 12));
  const normalized = normalizeStatItems(items);
  if (normalized.length >= safeCount) return normalized.slice(0, safeCount);
  return [
    ...normalized,
    ...Array.from({ length: safeCount - normalized.length }, (_, index) => normalizeStatItem({}, normalized.length + index)),
  ];
}

function StatIcon({ item = {}, className = "", style = {} }) {
  const Icon = TablerIcons[pageIconValue(item.icon)];
  if (!Icon) return null;
  const size = Math.max(8, Math.min(Number(item.iconSize || 28), 96));
  return <Icon className={className} style={{ width: size, height: size, color: item.iconColor || undefined, ...style }} />;
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

function DraggableMediaCard({ item, onAdd, onTitleCommit }) {
  const title = mediaTitle(item);
  const [draftTitle, setDraftTitle] = useState(title);
  const [editingOpen, setEditingOpen] = useState(false);
  const [loadedDimensions, setLoadedDimensions] = useState(null);
  useEffect(() => { setDraftTitle(title); }, [title, item.url]);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `media-${item.url}`, data: { dragKind: "media", media: { ...item, title, display_name: title } } });
  function confirmTitle(e) {
    e?.stopPropagation?.();
    const cleanTitle = draftTitle.trim() || mediaFilename(item).replace(/\.[^.]+$/, "") || "Image";
    setDraftTitle(cleanTitle);
    setEditingOpen(false);
    onTitleCommit?.(cleanTitle);
  }
  function cancelTitle(e) {
    e?.stopPropagation?.();
    setDraftTitle(title);
    setEditingOpen(false);
  }
  return <div ref={setNodeRef} className={`touch-none w-full max-w-full overflow-hidden rounded-xl border border-l-4 border-l-amber-500 bg-background p-2.5 shadow-sm transition hover:border-primary hover:bg-primary/5 hover:shadow ${isDragging ? "opacity-50" : ""}`} {...attributes}>
    <div className="flex w-full min-w-0 items-center gap-3">
      <button type="button" className="shrink-0 cursor-grab text-muted-foreground" {...listeners} aria-label="Drag media"><IconGripVertical className="h-4 w-4" /></button>
      <button type="button" onClick={() => onAdd?.({ ...item, title, display_name: title })} className="h-16 w-20 shrink-0 overflow-hidden rounded-lg border bg-muted" title="Add image to canvas">
        <img src={item.url} alt={title} className="h-full w-full object-cover" onLoad={(e) => setLoadedDimensions({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })} />
      </button>
      <div className="min-w-0 flex-1 overflow-hidden">
        <Popover open={editingOpen} onOpenChange={(open) => { setEditingOpen(open); if (open) setDraftTitle(title); }}>
          <PopoverTrigger asChild>
            <button type="button" className="block w-full min-w-0 truncate text-left text-sm font-semibold leading-tight text-foreground hover:text-primary" title={title} onClick={(e) => e.stopPropagation()}>
              {title}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" side="right" className="w-72 p-2" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-1.5">
              <Input autoFocus className="h-8 min-w-0 flex-1 text-sm" value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") confirmTitle(e); if (e.key === "Escape") cancelTitle(e); }} />
              <Button type="button" size="icon" className="h-8 w-8 bg-emerald-600 text-white hover:bg-emerald-700" onClick={confirmTitle} title="Save name"><IconCheck className="h-4 w-4" /></Button>
              <Button type="button" size="icon" variant="outline" className="h-8 w-8 border-red-500 text-red-600 hover:bg-red-500/10 hover:text-red-700" onClick={cancelTitle} title="Cancel"><IconX className="h-4 w-4" /></Button>
            </div>
          </PopoverContent>
        </Popover>
        <div className="mt-1 truncate text-[11px] leading-tight text-muted-foreground">{mediaDimensionsLabel(item, loadedDimensions)}</div>
        <div className="mt-0.5 truncate text-[11px] leading-tight text-muted-foreground">{mediaSizeLabel(item)}</div>
      </div>
    </div>
  </div>;
}

function MediaDragPreview() {
  return <div className="w-64 rounded-xl border border-l-4 border-l-amber-500 bg-background p-3 text-sm font-medium shadow-2xl ring-1 ring-black/5"><div className="flex items-center gap-2"><IconPhoto className="h-5 w-5 text-amber-500" />Media image</div></div>;
}

function BlockDragPreview({ type }) {
  const group = BLOCK_GROUPS.find((item) => item.items.includes(type)) || BLOCK_GROUPS[0];
  return <div className={`w-72 rounded-xl border border-l-4 ${group.color} bg-background p-3 text-left shadow-2xl ring-1 ring-black/5`}><BlockCardContent type={type} iconClass={group.iconClass} /></div>;
}

function MiniTemplatePreview({ form }) {
  return <FormRenderer form={form} readOnly />;
}

function FieldToolbar({ field, removeField, duplicateField, moveField, updateField }) {
  const supportsBold = ["label", "text", "textarea", "richtext", "section"].includes(field.type);
  const supportsAlign = ["label", "text", "richtext", "hero"].includes(field.type);
  const props = field.props || {};
  return <div className="absolute right-2 top-2 z-20 flex items-center gap-1 rounded-lg border bg-background/95 p-1 shadow-lg backdrop-blur">
    {supportsBold ? <Button type="button" size="sm" variant={props.bold ? "secondary" : "ghost"} className="h-7 px-2 font-bold" onClick={(e) => { e.stopPropagation(); updateField(field.id, { props: { ...props, bold: !props.bold } }); }}>B</Button> : null}
    {supportsAlign ? <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={(e) => { e.stopPropagation(); const order = ["left", "center", "right"]; const next = order[(order.indexOf(props.align || "left") + 1) % order.length]; updateField(field.id, { props: { ...props, align: next } }); }}>{(props.align || "left").slice(0, 1).toUpperCase()}</Button> : null}
    <Button type="button" size="sm" variant="ghost" className="h-7 px-2" title="Move up" onClick={(e) => { e.stopPropagation(); moveField(field.id, -1); }}>↑</Button>
    <Button type="button" size="sm" variant="ghost" className="h-7 px-2" title="Move down" onClick={(e) => { e.stopPropagation(); moveField(field.id, 1); }}>↓</Button>
    <Button type="button" size="sm" variant="ghost" className="h-7 px-2" title="Duplicate" onClick={(e) => { e.stopPropagation(); duplicateField(field); }}>⧉</Button>
    <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-destructive" title="Delete" onClick={(e) => { e.stopPropagation(); removeField(field.id); }}><IconTrash className="h-4 w-4" /></Button>
  </div>;
}

function ContainerDropZone({ id, children, label, empty = false, style }) {
  const { isOver, setNodeRef } = useDroppable({ id });
  return <div ref={setNodeRef} style={style} className={`min-h-16 min-w-0 rounded-lg border border-dashed p-3 transition ${isOver ? "border-primary bg-primary/10" : empty ? "border-muted-foreground/30 bg-muted/30" : "border-border/60 bg-muted/20"}`}>
    {children}
    {empty ? <div className="text-center text-xs text-muted-foreground">Drop blocks into {label}</div> : null}
  </div>;
}

function CanvasField({ field, fieldsById, selectedId, selected, onSelect, readOnly, addField, removeField, duplicateField, moveField, updateField }) {
  const props = field.props || {};
  const { isOver, setNodeRef: setDroppableRef } = useDroppable({ id: `field:${field.id}`, disabled: readOnly });
  const { attributes, listeners, setNodeRef: setDraggableRef, isDragging } = useDraggable({ id: `canvas-field:${field.id}`, data: { dragKind: "field", fieldId: field.id }, disabled: readOnly });
  const setNodeRef = (node) => { setDroppableRef(node); setDraggableRef(node); };
  const isSelected = selectedId === field.id && !readOnly;
  const shell = `group relative rounded-xl border transition ${paddingClass(props.padding)} ${isDragging ? "opacity-50" : ""} ${isOver ? "border-primary bg-primary/10" : isSelected ? "border-primary ring-2 ring-primary/20 bg-primary/5" : "border-transparent hover:border-muted-foreground/25"}`;
  const toolbar = isSelected ? <FieldToolbar field={field} removeField={removeField} duplicateField={duplicateField} moveField={moveField} updateField={updateField} /> : null;
  const dragHandle = !readOnly ? <button type="button" className={`absolute left-2 top-2 z-20 rounded-md border bg-background/90 p-1 text-muted-foreground opacity-0 shadow-sm transition hover:text-foreground group-hover:opacity-100 ${isSelected ? "opacity-100" : ""}`} onClick={(e) => { e.stopPropagation(); onSelect?.(field.id); }} {...listeners} {...attributes} aria-label={`Drag ${field.label || field.type}`} title="Drag element"><IconGripVertical className="h-4 w-4" /></button> : null;
  const renderChild = (id) => { const child = fieldsById.get(id); return child ? <CanvasField key={id} field={child} fieldsById={fieldsById} selectedId={selectedId} selected={selectedId === id} readOnly={readOnly} onSelect={() => !readOnly && onSelect?.(id)} addField={addField} removeField={removeField} duplicateField={duplicateField} moveField={moveField} updateField={updateField} /> : null; };
  const renderChildren = (ids = [], parent = field, options = {}) => {
    const runs = [];
    let current = [];
    ids.forEach((id) => {
      if (isButtonField(fieldsById, id)) current.push(id);
      else { if (current.length) { runs.push({ buttons: current }); current = []; } runs.push({ ids: [id] }); }
    });
    if (current.length) runs.push({ buttons: current });
    return runs.map((run, runIndex) => {
      const runIds = run.buttons || run.ids || [];
      const firstLayout = childLayoutFor(parent, runIds[0]);
      const style = childLayoutStyle(firstLayout, { isGrid: options.isGrid });
      const content = run.buttons ? <div className="flex flex-wrap items-center gap-2">{run.buttons.map(renderChild)}</div> : run.ids.map(renderChild);
      return <div key={`${runIds.join("-")}-${runIndex}`} style={style} className="min-w-0">{content}</div>;
    });
  };
  const baseProps = { ref: setNodeRef, "data-form-field-id": field.id, onClick: (e) => { e.stopPropagation(); onSelect?.(field.id); }, className: shell, style: paddingStyle(props.padding) };

  if (field.type === "section") return <div {...baseProps}>{toolbar}{dragHandle}<div className="rounded-lg border bg-muted/25 p-4" style={containerStyle(field)}><div className={`text-sm font-semibold ${props.bold ? "font-bold" : ""}`}>{field.label}</div>{field.helpText ? <p className="mt-1 text-xs text-muted-foreground">{field.helpText}</p> : null}<div className="mt-4 space-y-3"><ContainerDropZone id={`container:${field.id}:children`} label="section" empty={!props.children?.length}>{renderChildren(props.children || [], field)}</ContainerDropZone></div></div></div>;
  if (field.type === "row" || field.type === "flex") return <div {...baseProps}>{toolbar}{dragHandle}<div className="rounded-lg border border-dashed p-3" style={containerStyle(field)}><ContainerDropZone id={`container:${field.id}:children`} label={field.type} empty={!props.children?.length}><div className={`flex ${props.direction === "column" ? "flex-col" : "flex-row"} ${props.wrap === false ? "flex-nowrap" : "flex-wrap"}`} style={{ gap: gapPx(props.gap), justifyContent: props.justify || "flex-start" }}>{renderChildren(props.children || [], field)}</div></ContainerDropZone></div></div>;
  if (field.type === "columns") { const count = Math.max(1, Math.min(Number(props.columns || 2), 6)); return <div {...baseProps}>{toolbar}{dragHandle}<div className="rounded-lg border border-dashed p-3" style={containerStyle(field)}><div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`, gap: gapPx(props.gap) }}>{Array.from({ length: count }).map((_, i) => <ContainerDropZone key={i} id={`container:${field.id}:slot:${i}`} label={`column ${i + 1}`} empty={!props.slots?.[i]?.length}>{renderChildren(props.slots?.[i] || [], field)}</ContainerDropZone>)}</div></div></div>; }
  if (field.type === "grid") { const columns = Math.max(1, Math.min(Number(props.columns || 2), 6)); const rows = Math.max(1, Math.min(Number(props.rows || 2), 12)); return <div {...baseProps}>{toolbar}{dragHandle}<div className="rounded-lg border border-dashed p-3" style={containerStyle(field)}><div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, auto))`, gap: gapPx(props.gap) }}>{visibleGridCells(field, rows, columns).map((cell) => <ContainerDropZone key={cell.key} id={`container:${field.id}:cell:${cell.row}:${cell.column}`} label={`cell ${cell.row + 1}.${cell.column + 1}`} empty={!cell.ids.length} style={gridCellStyle(cell)}>{renderChildren(cell.ids, field)}</ContainerDropZone>)}</div></div></div>; }
  if (field.type === "spacer") return <div {...baseProps}>{toolbar}{dragHandle}<div className={`${props.direction === "horizontal" ? "h-4 w-24" : "h-12 w-full"} rounded border border-dashed bg-muted/40`} /></div>;
  if (field.type === "divider") return <div {...baseProps}>{toolbar}{dragHandle}<div className="py-2"><hr className="w-full rounded-full" style={{ borderWidth: `${Math.max(0, Number(props.borderWidth ?? 1))}px 0 0 0`, borderColor: props.borderColor || "var(--border)", borderStyle: "solid" }} /></div></div>;
  if (field.type === "hero") return <div {...baseProps} className={`${shell} ${alignClass(props.align)}`} style={fieldStyle(field)}>{dragHandle}{heroShell(field, props, toolbar)}</div>;
  if (field.type === "stats") return <div {...baseProps}>{toolbar}{dragHandle}<div className="grid gap-3 md:grid-cols-3">{normalizeStatItems(props.items || []).map((item, index) => <div key={index} className="relative overflow-hidden rounded-xl border bg-card p-4 pr-12 text-card-foreground"><StatIcon item={item} className="absolute right-4 top-4 opacity-80" /><div className="text-2xl font-bold" style={{ ...fieldStyle(field), color: item.titleColor || fieldStyle(field)?.color }}>{item.title}</div><div className="text-xs text-muted-foreground" style={item.descriptionColor ? { color: item.descriptionColor } : undefined}>{item.description}</div></div>)}</div></div>;
  if (field.type === "card") return <div {...baseProps}>{toolbar}{dragHandle}<div className={`overflow-hidden rounded-xl ${props.mode === "flat" ? "bg-muted/40" : "border bg-card shadow-sm"} text-card-foreground`} style={fieldStyle(field)}>{props.imageUrl ? <img src={props.imageUrl} alt={props.imageTitle || props.title || field.label} className="h-36 w-full object-cover" /> : null}<div className="p-4"><div className="text-sm font-semibold">{props.title || field.label}</div>{props.description ? <p className="mt-2 text-xs text-muted-foreground">{props.description}</p> : null}<div className="mt-4"><ContainerDropZone id={`container:${field.id}:children`} label="card" empty={!props.children?.length}>{renderChildren(props.children || [], field)}</ContainerDropZone></div></div></div></div>;
  if (field.type === "richtext") return <div {...baseProps}>{toolbar}{dragHandle}<div className={`prose prose-sm max-w-none dark:prose-invert ${props.bold ? "font-semibold" : ""} ${alignClass(props.align)}`} style={fieldStyle(field)}>{props.richtext || field.label}</div></div>;
  if (field.type === "codeblock") return <div {...baseProps}>{toolbar}{dragHandle}<CodeBlock code={props.code || ""} language={props.language || "javascript"} showLineNumbers={Boolean(props.showLineNumbers)} maxHeight={props.maxHeight || 360}><CodeBlockCopyButton type="button" /></CodeBlock></div>;
  if (field.type === "hidden") return <div {...baseProps}>{toolbar}{dragHandle}<Badge variant="outline">Hidden</Badge> <span className="text-sm text-muted-foreground">{field.id}</span></div>;
  if (field.type === "label") return <div {...baseProps} className={`${shell} ${textSizeClass(props.size)} ${alignClass(props.align)}`} style={paddingStyle(props.padding, fieldStyle(field) || {})}>{toolbar}{dragHandle}<div className={`font-semibold ${props.bold ? "font-bold" : ""}`}>{field.label}</div>{field.helpText ? <p className="text-xs text-muted-foreground">{field.helpText}</p> : null}</div>;
  if (field.type === "context_value") return <div {...baseProps}>{toolbar}{dragHandle}<Label style={fieldStyle(field)}>{field.label}</Label><div className="mt-2 rounded-md bg-muted p-3 font-mono text-xs">{field.contextPath || "caller.from_number"}</div></div>;
  if (field.type === "image") return <div {...baseProps}>{toolbar}{dragHandle}{field.props?.src ? <img src={field.props.src} alt={field.label || "Form image"} className="max-h-48 rounded-md border object-contain" /> : <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">Image block</div>}</div>;
  if (field.type === "button") return <div {...baseProps}>{toolbar}{dragHandle}<Button disabled={readOnly} variant={props.variant === "secondary" ? "secondary" : "default"}>{field.label || "Submit"}</Button></div>;
  return <div {...baseProps}>{toolbar}{dragHandle}<Label style={fieldStyle(field)} className={props.bold ? "font-bold" : ""}>{field.label}{field.required ? <span className="text-destructive"> *</span> : null}</Label>{field.type === "textarea" ? <Textarea className="mt-2" placeholder={field.placeholder} disabled={readOnly} /> : field.type === "select" ? <Select disabled={readOnly}><SelectTrigger className="mt-2"><SelectValue placeholder={field.placeholder || "Select..."} /></SelectTrigger><SelectContent>{normalizeOptions(field.options || []).map((o) => <SelectItem key={o.value} value={String(o.value)}>{o.label || o.value}</SelectItem>)}</SelectContent></Select> : field.type === "radio" ? <div className={`mt-2 ${optionDirection(props) === "horizontal" ? "flex flex-wrap gap-4" : "space-y-2"}`}>{normalizeOptions(field.options || []).map((o) => <label key={o.value} className="flex items-center gap-2 text-sm"><input type="radio" name={field.id} value={o.value} disabled={readOnly} />{o.label || o.value}</label>)}</div> : field.type === "checkbox" && normalizeOptions(field.options || []).length ? <div className={`mt-2 ${optionDirection(props) === "horizontal" ? "flex flex-wrap gap-4" : "space-y-2"}`}>{normalizeOptions(field.options || []).map((o) => <label key={o.value} className="flex items-center gap-2 text-sm"><Checkbox disabled={readOnly} />{o.label || o.value}</label>)}</div> : field.type === "checkbox" ? <div className="mt-2 flex items-center gap-2"><Checkbox disabled={readOnly} /><span className="text-sm text-muted-foreground">{field.placeholder || "Yes"}</span></div> : <Input className="mt-2" placeholder={field.placeholder} disabled={readOnly} />}{field.helpText ? <p className="mt-2 text-xs text-muted-foreground">{field.helpText}</p> : null}</div>;
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
    <div className="grid gap-2"><Label>Name</Label><RevertibleTextInput value={form.name ?? ""} restoreOnEmpty fallbackValue="New agent form" onCommit={(value) => patchForm({ name: value, slug: form.slug || slugifyFormName(value) })} /></div>
    <div className="grid gap-2"><Label>Slug</Label><RevertibleTextInput value={form.slug ?? ""} restoreOnEmpty fallbackValue={slugifyFormName(form.name)} onCommit={(value) => patchForm({ slug: value })} /></div>
    <div className="grid gap-2"><Label>Category</Label><Select value={form.category || "General"} onValueChange={(value) => patchForm({ category: value })}><SelectTrigger><SelectValue placeholder="Choose a category" /></SelectTrigger><SelectContent>{categoryOptions.map((category) => <SelectItem key={category} value={category}>{category}</SelectItem>)}</SelectContent></Select></div>
    <div className="grid gap-2"><Label>Description</Label><Textarea rows={3} value={form.description ?? ""} onChange={(e) => patchForm({ description: e.target.value })} /></div>
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

function PropertiesPanel({ form, patchForm, selectedField, updateField, media = [] }) {
  function setProps(field, patch) { updateField(field.id, mergeProps(field, patch).props ? { props: mergeProps(field, patch).props } : {}); }
  function findSelectedLocation(id) {
    for (const field of form.schema.fields || []) for (const slot of nestedSlotEntries(field)) { const index = (slot.ids || []).indexOf(id); if (index >= 0) return { ...slot, container: field, index }; }
    return null;
  }
  const selectedLocation = selectedField ? findSelectedLocation(selectedField.id) : null;
  function updateChildLayout(patch) {
    if (!selectedField || !selectedLocation?.container) return;
    const parent = selectedLocation.container;
    const current = childLayoutFor(parent, selectedField.id);
    updateField(parent.id, { props: { ...(parent.props || {}), layoutByChild: { ...layoutByChild(parent.props || {}), [selectedField.id]: normalizeChildLayout({ ...current, ...patch }) } } });
  }
  function renameField(field, nextId) {
    const clean = String(nextId || "").trim().replace(/[^A-Za-z0-9_:-]/g, "_");
    if (!clean) return;
    const nextBindings = { ...(form.bindings || {}) };
    if (field.id !== clean && nextBindings[field.id] !== undefined) { nextBindings[clean] = nextBindings[field.id]; delete nextBindings[field.id]; }
    const pages = (form.schema.pages || []).map((page) => ({ ...page, fields: (page.fields || []).map((id) => id === field.id ? clean : id) }));
    const fields = form.schema.fields.map((item) => ({ ...(item.id === field.id ? { ...item, id: clean } : item), props: replaceIdInProps(item.props || {}, field.id, clean) }));
    patchForm({ schema: { ...form.schema, fields, pages }, layout: { ...form.layout, order: (form.layout.order || []).map((id) => id === field.id ? clean : id) }, bindings: nextBindings });
  }
  const SelectedIcon = selectedField ? blockIcon(selectedField.type) : null;
  return <div className="h-full min-h-0 flex flex-col">
    <div className="h-14 shrink-0 border-b px-4 flex items-center gap-3">
      <IconSettings className="h-5 w-5 shrink-0" />
      <div className="min-w-0 flex-1"><h2 className="font-semibold text-sm">Properties</h2><p className="truncate text-xs text-muted-foreground">Selected canvas element settings.</p></div>
      {selectedField ? <Badge variant="outline" className={`shrink-0 gap-1.5 ${blockBadgeClass(selectedField.type)}`}>{SelectedIcon ? <SelectedIcon className="h-3.5 w-3.5" /> : null}{blockLabel(selectedField.type)}</Badge> : null}
    </div>
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-5">
      {selectedField ? <div className="space-y-4">
        <div><Label>Label</Label><RevertibleTextInput value={selectedField.label ?? ""} restoreOnEmpty fallbackValue={selectedField.id} onCommit={(value) => updateField(selectedField.id, { label: value })} /></div>
        {FORM_COMPONENT_REGISTRY[selectedField.type]?.data ? <div className="flex items-center justify-between rounded-md border p-2"><Label>Required</Label><Switch checked={Boolean(selectedField.required)} onCheckedChange={(checked) => updateField(selectedField.id, { required: checked })} /></div> : null}
        {!["hero", "stats", "card", "richtext", "spacer", "divider", "codeblock"].includes(selectedField.type) ? <><div><Label>Placeholder</Label><Input value={selectedField.placeholder || ""} onChange={(e) => updateField(selectedField.id, { placeholder: e.target.value })} /></div><div><Label>Help text</Label><Input value={selectedField.helpText || ""} onChange={(e) => updateField(selectedField.id, { helpText: e.target.value })} /></div></> : null}
        {FORM_COMPONENT_REGISTRY[selectedField.type]?.data ? <div><Label>Binding path</Label><Input value={form.bindings?.[selectedField.id] ?? ""} placeholder="customer.name" onChange={(e) => patchForm({ bindings: { ...(form.bindings || {}), [selectedField.id]: e.target.value } })} /></div> : null}
        {selectedField.type === "context_value" ? <div><Label>Context path</Label><Input value={selectedField.contextPath ?? ""} placeholder="caller.from_number" onChange={(e) => updateField(selectedField.id, { contextPath: e.target.value })} /></div> : null}
        {selectedLocation?.container ? <ChildLayoutControls field={selectedField} location={selectedLocation} layout={childLayoutFor(selectedLocation.container, selectedField.id)} updateLayout={updateChildLayout} /> : null}
        <BlockPropertyControls field={selectedField} updateField={updateField} setProps={(patch) => setProps(selectedField, patch)} media={media} />
      </div> : <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">Select an element on the canvas to edit its properties.</div>}
    </div>
  </div>;
}

function ChildLayoutControls({ field, location, layout, updateLayout }) {
  const parent = location?.container;
  const isGrid = parent?.type === "grid";
  const maxColumnSpan = isGrid ? Math.max(1, Math.min(Number(parent.props?.columns || 2) - Number(location.column || 0), 6)) : 1;
  const maxRowSpan = isGrid ? Math.max(1, Math.min(Number(parent.props?.rows || 2) - Number(location.row || 0), 12)) : 1;
  return <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
    <div className="text-xs font-semibold uppercase text-muted-foreground">Layout in parent</div>
    <div className="grid grid-cols-2 gap-3">
      <div><Label>Horizontal</Label><Select value={layout.align || "stretch"} onValueChange={(value) => updateLayout({ align: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{H_ALIGN_OPTIONS.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent></Select></div>
      <div><Label>Vertical</Label><Select value={layout.verticalAlign || "stretch"} onValueChange={(value) => updateLayout({ verticalAlign: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{V_ALIGN_OPTIONS.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent></Select></div>
    </div>
    {isGrid ? <div className="grid grid-cols-2 gap-3">
      <div><Label>Column span</Label><Input type="number" min="1" max={maxColumnSpan} value={layout.columnSpan || 1} onChange={(e) => updateLayout({ columnSpan: Math.max(1, Math.min(Number(e.target.value || 1), maxColumnSpan)) })} /></div>
      <div><Label>Row span</Label><Input type="number" min="1" max={maxRowSpan} value={layout.rowSpan || 1} onChange={(e) => updateLayout({ rowSpan: Math.max(1, Math.min(Number(e.target.value || 1), maxRowSpan)) })} /></div>
    </div> : null}
    <p className="text-[11px] text-muted-foreground">Applies to {field.label || field.id} inside {parent?.label || parent?.type}. Grid spans can merge adjacent cells from the child’s current cell.</p>
  </div>;
}

function BlockPropertyControls({ field, setProps, updateField, media = [] }) {
  const props = field.props || {};
  const supportsPadding = !["hidden"].includes(field.type);
  const supportsColor = ["hero", "stats", "card", "richtext", "label", "section", "text", "textarea", "select", "radio", "checkbox", "context_value"].includes(field.type);
  const supportsBorders = ["section", "row", "columns", "grid", "flex"].includes(field.type);
  return <div className="space-y-4 rounded-lg border bg-muted/20 p-3">
    <div className="text-xs font-semibold uppercase text-muted-foreground">Design</div>
    {supportsPadding ? <PaddingNumberControl value={props.padding} onChange={(padding) => setProps({ padding })} /> : null}
    {supportsColor ? <div className="space-y-2"><ColorInput label="Text color" value={props.color || ""} onChange={(color) => setProps({ color })} /><Button type="button" size="sm" variant="ghost" onClick={() => setProps({ color: "" })}>Use theme default</Button></div> : null}
    {supportsBorders ? <BorderControls props={props} setProps={setProps} /> : null}
    {["label", "hero", "text", "richtext"].includes(field.type) ? <TabsSelector label="Align" value={props.align || "left"} options={ALIGN_OPTIONS.map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }))} onChange={(align) => setProps({ align })} /> : null}
    {["label", "text", "richtext"].includes(field.type) ? <div><Label>Size</Label><Select value={props.size || "md"} onValueChange={(value) => setProps({ size: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{SIZE_OPTIONS.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent></Select></div> : null}
    <SpecificBlockControls field={field} props={props} setProps={setProps} updateField={updateField} media={media} />
  </div>;
}

function BorderControls({ props = {}, setProps }) {
  return <div className="space-y-3 rounded-md border bg-background p-3">
    <div className="text-xs font-medium text-muted-foreground">Border</div>
    <div><Label>Border width px</Label><Input type="number" min="0" value={props.borderWidth ?? ""} placeholder="Theme default" onChange={(e) => setProps({ borderWidth: e.target.value === "" ? undefined : Number(e.target.value) })} /></div>
    <ColorInput label="Border color" value={props.borderColor || ""} onChange={(color) => setProps({ borderColor: color })} />
    <Button type="button" size="sm" variant="ghost" onClick={() => setProps({ borderWidth: undefined, borderColor: "" })}>Use default border</Button>
    <p className="text-[11px] text-muted-foreground">Set width to 0 to hide the border.</p>
  </div>;
}

function ImageSelector({ label = "Image", value = "", media = [], onChange }) {
  return <div className="w-full max-w-full min-w-0 space-y-2 overflow-hidden">
    <Label>{label}</Label>
    {media.length ? <div className="max-h-56 w-full max-w-full space-y-2 overflow-y-auto overflow-x-hidden rounded-md border bg-background p-2">
      {media.map((item) => <button key={item.url} type="button" onClick={() => onChange?.(item.url, item)} className={`flex w-full min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-md border p-1.5 text-left transition ${value === item.url ? "border-primary bg-primary/5 ring-2 ring-primary/20" : "hover:border-primary"}`} title={mediaTitle(item)}><img src={item.url} alt={mediaTitle(item)} className="h-10 w-14 shrink-0 rounded border object-cover" /><span className="min-w-0 flex-1 overflow-hidden"><span className="block truncate text-xs font-medium">{mediaTitle(item)}</span><span className="block truncate text-[10px] text-muted-foreground">{mediaFilename(item)}</span></span></button>)}
    </div> : <p className="text-xs text-muted-foreground">Open Media to upload library images, or paste any URL below.</p>}
    <Input className="w-full max-w-full min-w-0" value={value ?? ""} placeholder="https://example.com/image.png or /media/file.png" onChange={(e) => onChange?.(e.target.value, null)} />
  </div>;
}

function TabsSelector({ label, value, options = [], onChange }) {
  return <div className="space-y-2">{label ? <Label>{label}</Label> : null}<div className="grid gap-1 rounded-lg border bg-background p-1" style={{ gridTemplateColumns: `repeat(${Math.max(1, options.length)}, minmax(0, 1fr))` }} role="tablist" aria-label={label}>{options.map((option) => { const active = value === option.value; return <button key={option.value} type="button" role="tab" aria-selected={active} onClick={() => onChange?.(option.value)} className={`inline-flex min-w-0 items-center justify-center rounded-md px-2 py-2 text-xs font-medium transition ${active ? "border border-primary bg-primary/10 text-foreground shadow-sm" : "border border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"}`}><span className="truncate">{option.label}</span></button>; })}</div></div>;
}

function PaddingNumberControl({ value, onChange }) {
  return <div><Label>Padding (px)</Label><Input type="number" min="0" value={paddingNumber(value)} onChange={(e) => onChange?.(Math.max(0, Number(e.target.value || 0)))} /></div>;
}

function ChoiceOptionsControl({ field, updateField, props, setProps, kind = "radio" }) {
  const options = normalizeOptions(field.options || []);
  function updateOption(index, patch) { updateField(field.id, { options: options.map((option, i) => i === index ? normalizeOption({ ...option, ...patch }, i) : option) }); }
  function addOption() { const index = options.length; updateField(field.id, { options: [...options, { label: `Option ${index + 1}`, value: `option_${index + 1}` }] }); }
  function removeOption(index) { updateField(field.id, { options: options.filter((_, i) => i !== index) }); }
  return <div className="space-y-4">{kind !== "select" ? <TabsSelector label="Layout" value={optionDirection(props)} options={DIRECTION_OPTIONS} onChange={(direction) => setProps({ direction })} /> : null}<div className="space-y-2"><div className="flex items-center justify-between gap-2"><Label>{kind === "checkbox" ? "Checkbox items" : kind === "select" ? "Select options" : "Radio options"}</Label><Button type="button" size="sm" variant="outline" onClick={addOption}><IconPlus className="mr-1 h-3.5 w-3.5" />Add</Button></div>{options.length ? <div className="space-y-2">{options.map((option, index) => <div key={`${option.value}-${index}`} className="grid grid-cols-[1fr_1fr_auto] gap-2 rounded-md border bg-background p-2"><Input value={option.label || ""} placeholder="Label" onChange={(e) => updateOption(index, { label: e.target.value })} /><Input value={option.value || ""} placeholder="Value" onChange={(e) => updateOption(index, { value: e.target.value })} /><Button type="button" size="icon" variant="ghost" className="text-destructive" onClick={() => removeOption(index)} aria-label="Remove option"><IconTrash className="h-4 w-4" /></Button></div>)}</div> : <div className="rounded-md border border-dashed p-3 text-center text-sm text-muted-foreground">No options yet. Add items to create structured choices.</div>}</div></div>;
}

function HeroImageModeTabs({ value = "inline", onChange }) {
  const options = [
    { value: "inline", label: "Inline", icon: IconPhoto },
    { value: "background", label: "Background", icon: IconRectangle },
  ];
  return <div className="space-y-2">
    <Label>Image mode</Label>
    <div className="grid grid-cols-2 gap-1 rounded-lg border bg-background p-1" role="tablist" aria-label="Hero image mode">
      {options.map(({ value: optionValue, label, icon: Icon }) => {
        const active = value === optionValue;
        return <button key={optionValue} type="button" role="tab" aria-selected={active} onClick={() => onChange?.(optionValue)} className={`inline-flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs font-medium transition ${active ? "border border-primary bg-primary/10 text-foreground shadow-sm" : "border border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
          <Icon className="h-4 w-4 shrink-0" />
          <span className="truncate">{label}</span>
        </button>;
      })}
    </div>
  </div>;
}

function SpecificBlockControls({ field, props, setProps, updateField, media = [] }) {
  if (field.type === "columns") return <div className="grid grid-cols-2 gap-3"><div><Label>Columns</Label><Input type="number" min="1" max="6" value={props.columns || 2} onChange={(e) => setProps({ columns: Number(e.target.value) })} /></div><div><Label>Gap</Label><Input type="number" min="0" value={gapPx(props.gap)} onChange={(e) => setProps({ gap: Number(e.target.value) })} /></div></div>;
  if (field.type === "grid") return <div className="grid grid-cols-3 gap-3"><div><Label>Rows</Label><Input type="number" min="1" max="12" value={props.rows || 2} onChange={(e) => setProps({ rows: Number(e.target.value) })} /></div><div><Label>Columns</Label><Input type="number" min="1" max="6" value={props.columns || 2} onChange={(e) => setProps({ columns: Number(e.target.value) })} /></div><div><Label>Gap</Label><Input type="number" min="0" value={gapPx(props.gap)} onChange={(e) => setProps({ gap: Number(e.target.value) })} /></div></div>;
  if (field.type === "flex") return <div className="grid gap-3"><div><Label>Direction</Label><Select value={props.direction || "row"} onValueChange={(value) => setProps({ direction: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="row">Row</SelectItem><SelectItem value="column">Column</SelectItem></SelectContent></Select></div><div><Label>Justify</Label><Select value={props.justify || "start"} onValueChange={(value) => setProps({ justify: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="start">Start</SelectItem><SelectItem value="center">Center</SelectItem><SelectItem value="end">End</SelectItem></SelectContent></Select></div><div><Label>Gap px</Label><Input type="number" min="0" value={props.gap ?? 16} onChange={(e) => setProps({ gap: Number(e.target.value) })} /></div><div className="flex items-center justify-between rounded-md border p-2"><Label>Wrap</Label><Switch checked={props.wrap !== false} onCheckedChange={(checked) => setProps({ wrap: checked })} /></div></div>;
  if (field.type === "spacer") return <div className="grid grid-cols-2 gap-3"><div><Label>Size</Label><Select value={props.size || "md"} onValueChange={(value) => setProps({ size: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{SIZE_OPTIONS.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent></Select></div><div><Label>Direction</Label><Select value={props.direction || "vertical"} onValueChange={(value) => setProps({ direction: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="vertical">Vertical</SelectItem><SelectItem value="horizontal">Horizontal</SelectItem><SelectItem value="both">Both</SelectItem></SelectContent></Select></div></div>;
  if (field.type === "divider") return <div className="space-y-3"><div><Label>Line width px</Label><Input type="number" min="0" value={props.borderWidth ?? 1} onChange={(e) => setProps({ borderWidth: Number(e.target.value) })} /></div><ColorInput label="Line color" value={props.borderColor || ""} onChange={(color) => setProps({ borderColor: color })} /><p className="text-[11px] text-muted-foreground">Set width to 0 to hide the divider line.</p></div>;
  if (field.type === "hero") return <div className="min-w-0 space-y-3"><div><Label>Quote / eyebrow</Label><Input value={props.quote ?? ""} onChange={(e) => setProps({ quote: e.target.value })} /></div><div><Label>Title</Label><RevertibleTextInput value={props.title ?? ""} restoreOnEmpty fallbackValue={field.label} onCommit={(value) => setProps({ title: value })} /></div><div><Label>Description</Label><Textarea rows={3} value={props.description ?? ""} onChange={(e) => setProps({ description: e.target.value })} /></div><HeroImageModeTabs value={props.imageMode === "background" ? "background" : "inline"} onChange={(imageMode) => setProps({ imageMode })} /><ImageSelector label="Hero image" value={props.imageUrl || ""} media={media} onChange={(url, item) => setProps({ imageUrl: url, imageTitle: item ? mediaTitle(item) : props.imageTitle })} /><HeroButtonsControl buttons={props.buttons || []} onChange={(buttons) => setProps({ buttons })} /></div>;
  if (field.type === "stats") return <StatsItemsControl items={props.items || []} setItems={(items) => setProps({ items })} />;
  if (field.type === "card") return <div className="space-y-3"><div><Label>Title</Label><RevertibleTextInput value={props.title ?? ""} restoreOnEmpty fallbackValue={field.label} onCommit={(value) => setProps({ title: value })} /></div><div><Label>Description</Label><Textarea rows={3} value={props.description ?? ""} onChange={(e) => setProps({ description: e.target.value })} /></div><div><Label>Mode</Label><Select value={props.mode || "card"} onValueChange={(value) => setProps({ mode: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="card">Card</SelectItem><SelectItem value="flat">Flat</SelectItem></SelectContent></Select></div><ImageSelector label="Card image" value={props.imageUrl || ""} media={media} onChange={(url, item) => setProps({ imageUrl: url, imageTitle: item ? mediaTitle(item) : props.imageTitle })} /></div>;
  if (field.type === "richtext") return <div><Label>Rich text</Label><Textarea rows={5} value={props.richtext ?? ""} onChange={(e) => setProps({ richtext: e.target.value })} /></div>;
  if (field.type === "codeblock") return <div className="space-y-3"><div><Label>Language</Label><Select value={props.language || "javascript"} onValueChange={(value) => setProps({ language: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{CODE_LANGUAGE_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></div><div><Label>Code</Label><Textarea rows={10} className="font-mono text-xs" value={props.code ?? ""} onChange={(e) => setProps({ code: e.target.value })} /></div><div><Label>Max height px</Label><Input type="number" min="120" value={props.maxHeight ?? 360} onChange={(e) => setProps({ maxHeight: Number(e.target.value) })} /></div><div className="flex items-center justify-between rounded-md border p-2"><Label>Show line numbers</Label><Switch checked={Boolean(props.showLineNumbers)} onCheckedChange={(checked) => setProps({ showLineNumbers: checked })} /></div></div>;
  if (field.type === "image") return <ImageSelector label="Image" value={props.src || ""} media={media} onChange={(url, item) => setProps({ src: url, imageTitle: item ? mediaTitle(item) : props.imageTitle })} />;
  if (field.type === "select") return <ChoiceOptionsControl field={field} updateField={updateField} props={props} setProps={setProps} kind="select" />;
  if (field.type === "radio") return <ChoiceOptionsControl field={field} updateField={updateField} props={props} setProps={setProps} kind="radio" />;
  if (field.type === "checkbox") return <ChoiceOptionsControl field={field} updateField={updateField} props={props} setProps={setProps} kind="checkbox" />;
  if (field.type === "button") return <TabsSelector label="Variant" value={props.variant || "primary"} options={VARIANT_OPTIONS} onChange={(variant) => setProps({ variant })} />;
  return null;
}


function StatsItemsControl({ items = [], setItems }) {
  const normalizedItems = normalizeStatItems(items);
  const [activeItem, setActiveItem] = useState(normalizedItems.length ? "item-0" : "");
  useEffect(() => {
    if (!normalizedItems.length) {
      if (activeItem) setActiveItem("");
      return;
    }
    const activeIndex = Number(String(activeItem).replace("item-", ""));
    if (!activeItem || !Number.isInteger(activeIndex) || activeIndex < 0 || activeIndex >= normalizedItems.length) setActiveItem("item-0");
  }, [activeItem, normalizedItems.length]);
  function updateCount(nextCount) {
    setItems(resizeStatItems(normalizedItems, nextCount));
  }
  function updateItem(index, patch) {
    setItems(normalizedItems.map((item, itemIndex) => itemIndex === index ? normalizeStatItem({ ...item, ...patch }, itemIndex) : item));
  }
  function resetItemColors(index) {
    updateItem(index, { iconColor: "", titleColor: "", descriptionColor: "" });
  }
  return <div className="space-y-4">
    <div>
      <Label>Number of stat cards</Label>
      <Input type="number" min="0" max="12" value={normalizedItems.length} onChange={(e) => updateCount(e.target.value)} />
      <p className="mt-1 text-[11px] text-muted-foreground">Changing the count preserves existing card values and only adds or removes cards at the end.</p>
    </div>
    <div>
      {normalizedItems.length ? <Accordion type="single" value={activeItem} onValueChange={(value) => { if (value) setActiveItem(value); }} className="space-y-2">
        {normalizedItems.map((item, index) => <AccordionItem key={index} value={`item-${index}`} className="rounded-md border bg-background px-3 last:border-b">
          <AccordionTrigger className="py-3 hover:no-underline">
            <div className="flex min-w-0 flex-1 items-center justify-between gap-2 pr-2">
              <div className="min-w-0 text-left">
                <div className="text-xs font-semibold uppercase text-muted-foreground">Stat card {index + 1}</div>
                <div className="truncate text-sm font-medium">{item.title || `Card ${index + 1}`}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-muted-foreground"><StatIcon item={item} className="shrink-0" /><span className="text-[11px]">Preview</span></div>
            </div>
          </AccordionTrigger>
          <AccordionContent className="space-y-3 pb-3">
            <div><Label>Title</Label><Input value={item.title ?? ""} onChange={(e) => updateItem(index, { title: e.target.value })} /></div>
            <div><Label>Description</Label><Input value={item.description ?? ""} onChange={(e) => updateItem(index, { description: e.target.value })} /></div>
            <PageIconPicker label="Icon" value={item.icon || ""} onChange={(icon) => updateItem(index, { icon })} />
            <div><Label>Icon size px</Label><Input type="number" min="8" max="96" value={item.iconSize ?? 28} onChange={(e) => updateItem(index, { iconSize: Number(e.target.value) || 28 })} /></div>
            <div className="space-y-3 rounded-md border bg-muted/20 p-3">
              <div className="text-xs font-medium text-muted-foreground">Per-card colors</div>
              <ColorInput label="Icon color" value={item.iconColor || ""} onChange={(color) => updateItem(index, { iconColor: color })} />
              <ColorInput label="Title color" value={item.titleColor || ""} onChange={(color) => updateItem(index, { titleColor: color })} />
              <ColorInput label="Description color" value={item.descriptionColor || ""} onChange={(color) => updateItem(index, { descriptionColor: color })} />
              <Button type="button" size="sm" variant="ghost" onClick={() => resetItemColors(index)}>Use theme colors</Button>
            </div>
          </AccordionContent>
        </AccordionItem>)}
      </Accordion> : <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">No stat cards. Increase the count to add one.</div>}
    </div>
  </div>;
}


function normalizeHeroButton(button = {}, index = 0) {
  return {
    label: button.label ?? (index === 0 ? "Action" : `Button ${index + 1}`),
    href: button.href ?? button.url ?? "",
    variant: button.variant || (index === 0 ? "primary" : "secondary"),
  };
}

function HeroButtonsControl({ buttons = [], onChange }) {
  const normalizedButtons = (buttons || []).map(normalizeHeroButton);
  function updateCount(nextCount) {
    const count = Math.max(0, Math.min(Number(nextCount) || 0, 4));
    const next = [...normalizedButtons];
    while (next.length < count) next.push(normalizeHeroButton({}, next.length));
    onChange?.(next.slice(0, count));
  }
  function updateButton(index, patch) {
    onChange?.(normalizedButtons.map((button, buttonIndex) => buttonIndex === index ? normalizeHeroButton({ ...button, ...patch }, buttonIndex) : button));
  }
  return <div className="space-y-3">
    <div>
      <Label>Buttons</Label>
      <Input type="number" min="0" max="4" value={normalizedButtons.length} onChange={(e) => updateCount(e.target.value)} />
      <p className="mt-1 text-[11px] text-muted-foreground">Add up to four hero buttons. Existing labels, links, and variants are preserved.</p>
    </div>
    <div className="space-y-3">
      {normalizedButtons.map((button, index) => <div key={index} className="space-y-3 rounded-md border bg-background p-3">
        <div className="text-xs font-semibold uppercase text-muted-foreground">Button {index + 1}</div>
        <div><Label>Label</Label><Input value={button.label || ""} onChange={(e) => updateButton(index, { label: e.target.value })} /></div>
        <div><Label>Link</Label><Input value={button.href || ""} placeholder="https://example.com or /path" onChange={(e) => updateButton(index, { href: e.target.value })} /></div>
        <TabsSelector label="Variant" value={button.variant || "secondary"} options={VARIANT_OPTIONS} onChange={(variant) => updateButton(index, { variant })} />
      </div>)}
    </div>
  </div>;
}
