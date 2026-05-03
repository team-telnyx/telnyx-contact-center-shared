"use client";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import * as TablerIcons from "@tabler/icons-react";
import { CodeBlock, CodeBlockCopyButton } from "@/components/ai-elements/code-block";
import { getContextValue } from "@/lib/forms/form-context";
import { getFieldChildIds, normalizeFormDefinition } from "@/lib/forms/form-schema";

const PADDING_VALUE_MAP = { none: 0, xs: 8, sm: 12, md: 16, lg: 24, xl: 32 };
function isNumericPadding(value) { return value !== "" && value !== null && value !== undefined && Number.isFinite(Number(value)); }
function paddingNumber(value) { if (isNumericPadding(value)) return Math.max(0, Number(value)); return PADDING_VALUE_MAP[value || "md"] ?? PADDING_VALUE_MAP.md; }
function paddingClass(value) { return isNumericPadding(value) ? "" : ({ none: "p-0", xs: "p-2", sm: "p-3", md: "p-4", lg: "p-6", xl: "p-8" }[value || "md"] || "p-4"); }
function verticalPaddingClass(value) { return isNumericPadding(value) ? "" : ({ none: "py-0", xs: "py-2", sm: "py-3", md: "py-4", lg: "py-6", xl: "py-8" }[value || "md"] || "py-4"); }
function paddingStyle(value, base = {}) { return isNumericPadding(value) ? { ...base, padding: `${paddingNumber(value)}px` } : base; }
function verticalPaddingStyle(value, base = {}) { return isNumericPadding(value) ? { ...base, paddingTop: `${paddingNumber(value)}px`, paddingBottom: `${paddingNumber(value)}px` } : base; }
function normalizeOption(option = {}, index = 0) { if (typeof option === "string" || typeof option === "number") return { label: String(option), value: String(option) }; const value = option.value ?? option.id ?? option.label ?? `option_${index + 1}`; return { ...option, label: option.label ?? String(value), value: String(value) }; }
function normalizeOptions(options = []) { return Array.isArray(options) ? options.map(normalizeOption) : []; }
function optionDirection(props = {}) { return props.direction === "horizontal" || props.orientation === "horizontal" ? "horizontal" : "vertical"; }
function formThemeStyle(theme = {}, base = {}) {
  const pairs = [["primary", "--primary"], ["primaryColor", "--primary"], ["primaryForeground", "--primary-foreground"], ["primaryForegroundColor", "--primary-foreground"], ["background", "--background"], ["backgroundColor", "--background"], ["foreground", "--foreground"], ["textColor", "--foreground"], ["card", "--card"], ["cardColor", "--card"], ["cardForeground", "--card-foreground"], ["border", "--border"], ["borderColor", "--border"], ["accent", "--accent"], ["accentColor", "--accent"], ["accentForeground", "--accent-foreground"], ["muted", "--muted"], ["mutedColor", "--muted"]];
  return pairs.reduce((style, [key, variable]) => theme?.[key] ? { ...style, [variable]: theme[key] } : style, base);
}
function textSizeClass(value) { return ({ sm: "text-sm", md: "text-base", lg: "text-lg", xl: "text-2xl" }[value || "md"] || "text-base"); }
function alignClass(value) { return ({ left: "text-left", center: "text-center", right: "text-right" }[value || "left"] || "text-left"); }
function fieldStyle(field) { return field.props?.color ? { color: field.props.color } : undefined; }
function containerStyle(field, base = {}) {
  const props = field.props || {};
  const width = Number(props.borderWidth);
  if (!Number.isFinite(width)) return { ...base, ...fieldStyle(field) };
  return { ...base, ...fieldStyle(field), borderWidth: `${Math.max(0, width)}px`, borderColor: props.borderColor || "var(--border)", borderStyle: "solid" };
}
const LEGACY_PAGE_ICON_MAP = { forms: "IconForms", user: "IconUser", phone: "IconPhone", mail: "IconMail", message: "IconMessageCircle", headset: "IconHeadset", info: "IconInfoCircle", home: "IconHome", star: "IconStar", check: "IconCheck" };
function PageIcon({ value, className = "h-4 w-4" }) { const Icon = TablerIcons[LEGACY_PAGE_ICON_MAP[value] || value]; return Icon ? <Icon className={className} /> : null; }

function normalizeStatItem(item = {}, index = 0) {
  const source = item && typeof item === "object" ? item : {};
  return {
    ...source,
    title: source.title ?? `Stat ${index + 1}`,
    description: source.description ?? "Description",
    icon: LEGACY_PAGE_ICON_MAP[source.icon] || source.icon || "",
    iconSize: source.iconSize ?? 28,
    iconColor: source.iconColor ?? "",
    titleColor: source.titleColor ?? "",
    descriptionColor: source.descriptionColor ?? "",
  };
}
function normalizeStatItems(items = []) { return Array.isArray(items) ? items.map(normalizeStatItem) : []; }
function StatIcon({ item = {}, className = "", style = {} }) {
  const Icon = TablerIcons[LEGACY_PAGE_ICON_MAP[item.icon] || item.icon];
  if (!Icon) return null;
  const size = Math.max(8, Math.min(Number(item.iconSize || 28), 96));
  return <Icon className={className} style={{ width: size, height: size, color: item.iconColor || undefined, ...style }} />;
}
function gapValue(value, fallback = 12) { return typeof value === "number" ? value : Number(value || fallback); }
function childFields(ids = [], byId) { return ids.map((id) => byId.get(id)).filter(Boolean); }
function normalizeChildLayout(layout = {}) {
  return {
    align: ["left", "center", "right", "stretch"].includes(layout.align) ? layout.align : "stretch",
    verticalAlign: ["top", "center", "bottom", "stretch"].includes(layout.verticalAlign) ? layout.verticalAlign : "stretch",
    columnSpan: Math.max(1, Math.min(Number(layout.columnSpan || layout.colSpan || 1), 6)),
    rowSpan: Math.max(1, Math.min(Number(layout.rowSpan || 1), 12)),
  };
}
function childLayoutFor(parent = {}, childId) { return normalizeChildLayout(parent.props?.layoutByChild?.[childId] || {}); }
function childLayoutStyle(layout = {}, { isGrid = false } = {}) {
  const next = normalizeChildLayout(layout);
  return {
    justifySelf: ({ left: "start", center: "center", right: "end", stretch: "stretch" }[next.align] || "stretch"),
    alignSelf: ({ top: "start", center: "center", bottom: "end", stretch: "stretch" }[next.verticalAlign] || "stretch"),
    ...(isGrid ? { gridColumn: `span ${next.columnSpan}`, gridRow: `span ${next.rowSpan}` } : {}),
  };
}

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

function renderChildRuns(ids = [], parent, byId, renderField, options = {}) {
  const runs = []; let buttons = [];
  ids.forEach((id) => {
    if (byId.get(id)?.type === "button") buttons.push(id);
    else { if (buttons.length) { runs.push({ buttons }); buttons = []; } runs.push({ ids: [id] }); }
  });
  if (buttons.length) runs.push({ buttons });
  return runs.map((run, index) => {
    const runIds = run.buttons || run.ids || [];
    const style = childLayoutStyle(childLayoutFor(parent, runIds[0]), options);
    const content = run.buttons ? <div className="flex flex-wrap items-center gap-2">{childFields(run.buttons, byId).map(renderField)}</div> : childFields(run.ids, byId).map(renderField);
    return <div key={`${runIds.join("-")}-${index}`} className="min-w-0" style={style}>{content}</div>;
  });
}
function heroContent(field, props = {}) {
  return <div className="relative z-10 min-w-0"><div className="text-xs font-semibold uppercase tracking-wide text-primary">{props.quote || field.label}</div><h2 className="mt-2 text-3xl font-bold tracking-tight">{props.title || field.label}</h2>{props.description ? <p className="mt-3 text-sm text-muted-foreground">{props.description}</p> : null}{props.buttons?.length ? <div className="mt-4 flex flex-wrap gap-2">{props.buttons.map((button, i) => <Button key={i} type="button" variant={button.variant === "secondary" ? "secondary" : "default"}>{button.label || "Action"}</Button>)}</div> : null}</div>;
}
function heroSection(field, props = {}) {
  const mode = props.imageMode === "background" ? "background" : "inline";
  if (mode === "background" && props.imageUrl) return <section className={`relative min-h-[220px] overflow-hidden rounded-xl border bg-card text-card-foreground ${verticalPaddingClass(props.padding)} px-6 ${alignClass(props.align)}`} style={verticalPaddingStyle(props.padding, fieldStyle(field) || {})}><img src={props.imageUrl} alt={props.imageTitle || props.title || field.label} className="absolute inset-0 h-full w-full object-cover" /><div className="absolute inset-0 bg-gradient-to-r from-card via-card/85 to-card/10" /><div className="relative z-10 max-w-2xl py-4">{heroContent(field, props)}</div></section>;
  return <section className={`grid gap-5 rounded-xl border bg-card text-card-foreground ${verticalPaddingClass(props.padding)} px-6 ${alignClass(props.align)} md:grid-cols-[minmax(0,1fr)_220px]`} style={verticalPaddingStyle(props.padding, fieldStyle(field) || {})}>{heroContent(field, props)}{props.imageUrl ? <img src={props.imageUrl} alt={props.imageTitle || props.title || field.label} className="max-h-44 w-full rounded-lg border object-cover" /> : null}</section>;
}
function rootFields(form, pageId) {
  const normalized = normalizeFormDefinition(form || {}); const byId = new Map((normalized.schema?.fields || []).map((f) => [f.id, f]));
  const pages = normalized.schema?.pages || []; const active = pages.find((page) => page.id === pageId) || pages[0];
  const nested = new Set((normalized.schema?.fields || []).flatMap(getFieldChildIds));
  const order = active?.fields?.length ? active.fields : (normalized.layout?.order || []).filter((id) => !nested.has(id));
  return order.map((id) => byId.get(id)).filter(Boolean);
}

function LayoutContainer({ field, byId, renderField }) {
  const props = field.props || {}; const style = fieldStyle(field);
  if (field.type === "section") return <section className={`rounded-lg border bg-muted/25 ${paddingClass(props.padding)}`} style={paddingStyle(props.padding, containerStyle(field))}><div className="text-sm font-semibold">{field.label}</div>{field.helpText ? <p className="mt-1 text-xs text-muted-foreground">{field.helpText}</p> : null}<div className="mt-4 space-y-4">{renderChildRuns(props.children, field, byId, renderField)}</div></section>;
  if (field.type === "row" || field.type === "flex") return <div className={`rounded-lg border border-dashed ${paddingClass(props.padding)}`} style={paddingStyle(props.padding, containerStyle(field))}><div className={`flex ${props.direction === "column" ? "flex-col" : "flex-row"} ${props.wrap === false ? "flex-nowrap" : "flex-wrap"}`} style={{ gap: gapValue(props.gap, 12), justifyContent: props.justify || "flex-start" }}>{renderChildRuns(props.children, field, byId, renderField)}</div></div>;
  if (field.type === "columns") { const count = Math.max(1, Math.min(Number(props.columns || 2), 6)); return <div className={`rounded-lg border border-dashed ${paddingClass(props.padding)}`} style={paddingStyle(props.padding, containerStyle(field))}><div className="grid" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`, gap: gapValue(props.gap, 12) }}>{Array.from({ length: count }).map((_, i) => <div key={i} className="min-w-0 space-y-4">{renderChildRuns(props.slots?.[i], field, byId, renderField)}</div>)}</div></div>; }
  if (field.type === "grid") { const cols = Math.max(1, Math.min(Number(props.columns || 2), 6)); const rows = Math.max(1, Math.min(Number(props.rows || 2), 12)); return <div className={`rounded-lg border border-dashed ${paddingClass(props.padding)}`} style={paddingStyle(props.padding, containerStyle(field))}><div className="grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, auto))`, gap: gapValue(props.gap, 12) }}>{visibleGridCells(field, rows, cols).map((cell) => <div key={cell.key} className="min-h-10 min-w-0 space-y-4" style={gridCellStyle(cell)}>{renderChildRuns(cell.ids, field, byId, renderField)}</div>)}</div></div>; }
  if (field.type === "spacer") return <div className={props.direction === "horizontal" ? "inline-block h-4 w-24" : "h-12 w-full"} />;
  if (field.type === "divider") return <div className={paddingClass(props.padding)} style={paddingStyle(props.padding)}><hr className="w-full rounded-full" style={{ borderWidth: `${Math.max(0, Number(props.borderWidth ?? 1))}px 0 0 0`, borderColor: props.borderColor || "var(--border)", borderStyle: "solid" }} /></div>;
  if (field.type === "hero") return heroSection(field, props);
  if (field.type === "stats") return <div className={`grid gap-3 md:grid-cols-3 ${paddingClass(props.padding)}`}>{normalizeStatItems(props.items || []).map((item, index) => <div key={index} className="relative overflow-hidden rounded-xl border bg-card p-4 pr-12 text-card-foreground"><StatIcon item={item} className="absolute right-4 top-4 opacity-80" /><div className="text-2xl font-bold" style={{ ...style, color: item.titleColor || style?.color }}>{item.title}</div><div className="text-xs text-muted-foreground" style={item.descriptionColor ? { color: item.descriptionColor } : undefined}>{item.description}</div></div>)}</div>;
  if (field.type === "card") return <div className={`overflow-hidden rounded-xl ${props.mode === "flat" ? "bg-muted/40" : "border bg-card shadow-sm"} text-card-foreground`} style={style}>{props.imageUrl ? <img src={props.imageUrl} alt={props.imageTitle || props.title || field.label} className="h-36 w-full object-cover" /> : null}<div className={paddingClass(props.padding)}><div className="text-sm font-semibold">{props.title || field.label}</div>{props.description ? <p className="mt-2 text-xs text-muted-foreground">{props.description}</p> : null}<div className="mt-4 space-y-4">{renderChildRuns(props.children, field, byId, renderField)}</div></div></div>;
  if (field.type === "richtext") return <div className={`${paddingClass(props.padding)} ${textSizeClass(props.size)} ${alignClass(props.align)} ${props.bold ? "font-semibold" : ""}`} style={style}>{props.richtext || field.label}</div>;
  if (field.type === "codeblock") return <div className={paddingClass(props.padding)}><CodeBlock code={props.code || ""} language={props.language || "javascript"} showLineNumbers={Boolean(props.showLineNumbers)} maxHeight={props.maxHeight || 360}><CodeBlockCopyButton type="button" /></CodeBlock></div>;
  return null;
}

export function FormRenderer({ form, initialValues = {}, context = {}, onSubmit, submitting = false, readOnly = false }) {
  const normalized = useMemo(() => form ? normalizeFormDefinition(form) : null, [form]);
  const pages = normalized?.schema?.pages || [];
  const [activePageId, setActivePageId] = useState(pages[0]?.id || "page_1");
  const [values, setValues] = useState(initialValues || {});
  const byId = useMemo(() => new Map((normalized?.schema?.fields || []).map((field) => [field.id, field])), [normalized]);
  const fields = useMemo(() => normalized ? rootFields(normalized, activePageId) : [], [normalized, activePageId]);
  function setValue(id, value) { setValues((prev) => ({ ...prev, [id]: value })); }
  async function handleSubmit(e) { e?.preventDefault?.(); await onSubmit?.(values); }
  if (!form) return <div className="text-sm text-muted-foreground">No form selected.</div>;
  const renderField = (field) => {
    if (["section", "row", "columns", "grid", "flex", "spacer", "divider", "hero", "stats", "card", "richtext", "codeblock"].includes(field.type)) return <LayoutContainer key={field.id} field={field} byId={byId} renderField={renderField} />;
    if (field.type === "hidden") return null;
    if (field.type === "label") return <div key={field.id} className={`font-medium ${textSizeClass(field.props?.size)} ${alignClass(field.props?.align)} ${paddingClass(field.props?.padding)} ${field.props?.bold ? "font-bold" : ""}`} style={paddingStyle(field.props?.padding, fieldStyle(field) || {})}>{field.label}</div>;
    if (field.type === "context_value") return <div key={field.id} className="rounded-md bg-muted p-3 text-sm"><Label>{field.label}</Label><div className="mt-1 font-mono text-xs">{String(getContextValue(context, field.contextPath) || "—")}</div></div>;
    if (field.type === "image") return field.props?.src ? <img key={field.id} src={field.props.src} alt={field.label || "Form image"} className="max-h-48 rounded-md border object-contain" /> : null;
    if (field.type === "button") return <Button key={field.id} type="submit" disabled={submitting || readOnly}>{field.label || "Submit"}</Button>;
    const value = values[field.id] ?? field.defaultValue ?? "";
    return <div key={field.id} className="space-y-2 min-w-0">
      <Label htmlFor={field.id} style={fieldStyle(field)} className={field.props?.bold ? "font-bold" : ""}>{field.label}{field.required ? <span className="text-destructive"> *</span> : null}</Label>
      {field.type === "textarea" && <Textarea id={field.id} value={value} placeholder={field.placeholder} disabled={readOnly} onChange={(e) => setValue(field.id, e.target.value)} />}
      {field.type === "text" && <Input id={field.id} value={value} placeholder={field.placeholder} disabled={readOnly} onChange={(e) => setValue(field.id, e.target.value)} />}
      {field.type === "select" && <Select value={String(value || "")} disabled={readOnly} onValueChange={(v) => setValue(field.id, v)}><SelectTrigger><SelectValue placeholder={field.placeholder || "Select..."} /></SelectTrigger><SelectContent>{normalizeOptions(field.options || []).map((o) => <SelectItem key={o.value} value={String(o.value)}>{o.label || o.value}</SelectItem>)}</SelectContent></Select>}
      {field.type === "radio" && <div className={optionDirection(field.props) === "horizontal" ? "flex flex-wrap gap-4" : "space-y-1"}>{normalizeOptions(field.options || []).map((o) => <label key={o.value} className="flex items-center gap-2 text-sm"><input type="radio" name={field.id} value={o.value} checked={String(value) === String(o.value)} disabled={readOnly} onChange={() => setValue(field.id, o.value)} />{o.label || o.value}</label>)}</div>}
      {field.type === "checkbox" && (normalizeOptions(field.options || []).length ? <div className={optionDirection(field.props) === "horizontal" ? "flex flex-wrap gap-4" : "space-y-1"}>{normalizeOptions(field.options || []).map((o) => { const selected = Array.isArray(value) ? value.map(String).includes(String(o.value)) : Boolean(value) && String(value) === String(o.value); return <label key={o.value} className="flex items-center gap-2 text-sm"><Checkbox checked={selected} disabled={readOnly} onCheckedChange={(checked) => { const current = Array.isArray(values[field.id]) ? values[field.id].map(String) : []; setValue(field.id, checked ? Array.from(new Set([...current, String(o.value)])) : current.filter((item) => item !== String(o.value))); }} />{o.label || o.value}</label>; })}</div> : <div className="flex items-center gap-2"><Checkbox id={field.id} checked={Boolean(value)} disabled={readOnly} onCheckedChange={(checked) => setValue(field.id, Boolean(checked))} /><span className="text-sm text-muted-foreground">{field.placeholder || "Yes"}</span></div>)}
      {field.helpText ? <p className="text-xs text-muted-foreground">{field.helpText}</p> : null}
    </div>;
  };
  return <form onSubmit={handleSubmit} className="space-y-4" style={formThemeStyle(normalized?.theme)}>
    {pages.length > 1 ? <div className="mb-6 flex items-center gap-1 border-b">{pages.map((page) => { const active = activePageId === page.id; const activeBorderColor = normalized?.theme?.pageTabActiveBorderColor; return <button key={page.id} type="button" onClick={() => setActivePageId(page.id)} className={`relative inline-flex items-center gap-2 px-4 py-2 text-sm font-medium transition ${active ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}><PageIcon value={page.icon} />{page.title || page.id}<span className={`absolute inset-x-0 -bottom-px h-0.5 rounded-full ${active && !activeBorderColor ? "bg-primary" : "bg-transparent"}`} style={active && activeBorderColor ? { backgroundColor: activeBorderColor } : undefined} /></button>; })}</div> : null}
    {fields.map(renderField)}
    {!fields.some((f) => f.type === "button") && onSubmit ? <Button type="submit" disabled={submitting || readOnly}>Submit</Button> : null}
  </form>;
}
