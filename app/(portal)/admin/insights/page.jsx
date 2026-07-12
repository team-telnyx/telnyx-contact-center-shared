"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import {
  IconBrain,
  IconListDetails,
  IconLayoutGrid,
  IconPlus,
  IconPencil,
  IconTrash,
  IconListCheck,
} from "@tabler/icons-react";
import { toast } from "@/lib/toast";
import { Badge } from "@/components/ui/badge";
import { AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";
import { AiAssistantsSectionPage } from "@/components/assistants/AiAssistantsSectionNav";

// ------------------ Helpers ------------------

const PARAM_TYPES = [
  { value: "string", label: "string" },
  { value: "enum", label: "enum" },
  { value: "number", label: "number" },
  { value: "integer", label: "integer" },
  { value: "boolean", label: "boolean" },
  { value: "array", label: "array" },
  { value: "array:string", label: "array (string)" },
  { value: "array:number", label: "array (number)" },
  { value: "array:integer", label: "array (integer)" },
  { value: "array:boolean", label: "array (boolean)" },
];

function buildJsonSchema(parameters) {
  const props = {};
  const required = [];
  for (const p of parameters) {
    if (!p?.name?.trim()) continue;
    const name = p.name.trim();
    const type = p.type || "string";
    const node = {};
    if (type.startsWith("array:")) {
      node.type = "array";
      const itemType = type.split(":")[1] || "string";
      node.items = { type: itemType };
    } else if (type === "array") {
      node.type = "array";
    } else if (type === "enum") {
      node.type = "string";
      const values = (p.enumValues || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (values.length > 0) node.enum = values;
    } else {
      node.type = type;
    }
    if (p.description) node.description = p.description;
    props[name] = node;
    if (p.required) required.push(name);
  }
  const schema = { type: "object", properties: props };
  if (required.length > 0) schema.required = required;
  return schema;
}

// ------------------ Page ------------------

export default function AiInsightsManagerPage() {
  const [tab, setTab] = useState("insights");
  const [insights, setInsights] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loadingInsights, setLoadingInsights] = useState(false);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [view, setView] = useState("list");
  const [openInsightEditor, setOpenInsightEditor] = useState(false);
  const [editingInsight, setEditingInsight] = useState(null);
  const [openGroupEditor, setOpenGroupEditor] = useState(false);
  const [editingGroup, setEditingGroup] = useState(null);

  async function loadInsights() {
    setLoadingInsights(true);
    try {
      const res = await fetch("/api/ai/conversations/insights", {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok || data?.ok === false)
        throw new Error(data?.error || "Failed to fetch insights");
      setInsights(Array.isArray(data.items) ? data.items : []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingInsights(false);
    }
  }

  async function loadGroups() {
    setLoadingGroups(true);
    try {
      const res = await fetch("/api/ai/conversations/insight-groups", {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok || data?.ok === false)
        throw new Error(data?.error || "Failed to fetch groups");
      setGroups(Array.isArray(data.items) ? data.items : []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingGroups(false);
    }
  }

  useEffect(() => {
    loadInsights();
    loadGroups();
  }, []);

  return (
    <AdminPageShell>
      <AdminPageHeader
        title="Insights"
        icon={IconBrain}
        badges={<Badge variant="secondary">{insights.length} insights</Badge>}
        actions={tab === "insights" ? (
          <Button size="sm" onClick={() => { setEditingInsight(null); setOpenInsightEditor(true); }}><IconPlus />Add Insight</Button>
        ) : (
          <Button size="sm" onClick={() => { setEditingGroup(null); setOpenGroupEditor(true); }}><IconPlus />Add Group</Button>
        )}
      />
      <AiAssistantsSectionPage activeId="insights">
      <Card className="w-full">
        <CardContent className="space-y-4 pt-6">
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-md border overflow-hidden">
              <button
                type="button"
                className={`px-3 py-1 text-sm ${
                  tab === "insights"
                    ? "bg-primary text-primary-foreground"
                    : "bg-background"
                }`}
                onClick={() => setTab("insights")}
              >
                Insights
              </button>
              <button
                type="button"
                className={`px-3 py-1 text-sm border-l ${
                  tab === "groups"
                    ? "bg-primary text-primary-foreground"
                    : "bg-background"
                }`}
                onClick={() => setTab("groups")}
              >
                Groups
              </button>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <Button
                type="button"
                variant={view === "list" ? "default" : "secondary"}
                onClick={() => setView("list")}
                title="List view"
              >
                <IconListDetails className="size-4" />
              </Button>
              <Button
                type="button"
                variant={view === "cards" ? "default" : "secondary"}
                onClick={() => setView("cards")}
                title="Cards view"
              >
                <IconLayoutGrid className="size-4" />
              </Button>
            </div>
          </div>

          {tab === "insights" ? (
            loadingInsights ? (
              <div className="border rounded-md overflow-hidden p-4 space-y-2">
                <Skeleton className="h-6 w-40" />
                {[...Array(6)].map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : view === "list" ? (
              <div className="border rounded-md overflow-x-auto">
                <Table className="table-fixed min-w-[1000px]">
                  <TableHeader>
                    <TableRow className="bg-muted">
                      <TableHead className="px-[10px] w-[25%]">Name</TableHead>
                      <TableHead className="px-[10px] w-[45%]">
                        Instructions / Schema
                      </TableHead>
                      <TableHead className="px-[10px] w-[15%]">Type</TableHead>
                      <TableHead className="px-[10px] text-right">
                        Actions
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {insights.map((ins) => {
                      const hasSchema = !!ins?.json_schema;
                      return (
                        <TableRow key={ins.id}>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap">
                            {ins.name || ins.id}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs truncate max-w-[600px]">
                            {hasSchema
                              ? "JSON Schema"
                              : (ins.instructions || "").slice(0, 140)}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs">
                            {hasSchema ? "Structured" : "Instructions"}
                          </TableCell>
                          <TableCell className="px-[10px] text-xs whitespace-nowrap text-right">
                            <div className="inline-flex items-center gap-2">
                              <button
                                type="button"
                                className="inline-flex items-center text-telnyx-green"
                                title="Edit"
                                onClick={() => {
                                  setEditingInsight(ins);
                                  setOpenInsightEditor(true);
                                }}
                              >
                                <IconPencil className="size-4" />
                              </button>
                              <button
                                type="button"
                                className="inline-flex items-center text-red-500 hover:text-red-700"
                                title="Delete"
                                onClick={async () => {
                                  if (!confirm("Delete this insight?")) return;
                                  try {
                                    const res = await fetch(
                                      `/api/ai/conversations/insights/${encodeURIComponent(
                                        ins.id
                                      )}`,
                                      { method: "DELETE" }
                                    );
                                    const data = await res
                                      .json()
                                      .catch(() => ({}));
                                    if (!res.ok || data?.ok === false)
                                      throw new Error(
                                        data?.error || "Delete failed"
                                      );
                                    toast.success("Insight deleted");
                                    loadInsights();
                                  } catch (err) {
                                    toast.error(String(err?.message || err));
                                  }
                                }}
                              >
                                <IconTrash className="size-4" />
                              </button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {insights.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={4}
                          className="text-center py-8 text-sm text-muted-foreground"
                        >
                          No insights
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {insights.map((ins) => (
                  <Card
                    key={ins.id}
                    className="border-1 border-telnyx-green dark:border-telnyx-green/60"
                  >
                    <CardContent className="px-4 py-2">
                      <div className="flex items-start justify-between">
                        <div
                          className="font-medium text-sm truncate"
                          title={ins.name}
                        >
                          {ins.name || ins.id}
                        </div>
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            className="inline-flex items-center text-telnyx-green"
                            title="Edit"
                            onClick={() => {
                              setEditingInsight(ins);
                              setOpenInsightEditor(true);
                            }}
                          >
                            <IconPencil className="size-4" />
                          </button>
                          <button
                            type="button"
                            className="inline-flex items-center text-red-500 hover:text-red-700"
                            title="Delete"
                            onClick={async () => {
                              if (!confirm("Delete this insight?")) return;
                              try {
                                const res = await fetch(
                                  `/api/ai/conversations/insights/${encodeURIComponent(
                                    ins.id
                                  )}`,
                                  { method: "DELETE" }
                                );
                                const data = await res.json().catch(() => ({}));
                                if (!res.ok || data?.ok === false)
                                  throw new Error(
                                    data?.error || "Delete failed"
                                  );
                                toast.success("Insight deleted");
                                loadInsights();
                              } catch (err) {
                                toast.error(String(err?.message || err));
                              }
                            }}
                          >
                            <IconTrash className="size-4" />
                          </button>
                        </div>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground truncate">
                        {(
                          ins.instructions ||
                          (ins.json_schema ? "JSON Schema" : "")
                        ).slice(0, 140)}
                      </div>
                    </CardContent>
                  </Card>
                ))}
                {insights.length === 0 && (
                  <div className="text-center py-8 text-sm text-muted-foreground border rounded-md">
                    No insights
                  </div>
                )}
              </div>
            )
          ) : loadingGroups ? (
            <div className="border rounded-md overflow-hidden p-4 space-y-2">
              <Skeleton className="h-6 w-40" />
              {[...Array(6)].map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : view === "list" ? (
            <div className="border rounded-md overflow-x-auto">
              <Table className="table-fixed min-w-[1000px]">
                <TableHeader>
                  <TableRow className="bg-muted">
                    <TableHead className="px-[10px] w-[25%]">Name</TableHead>
                    <TableHead className="px-[10px] w-[45%]">
                      Webhook URL
                    </TableHead>
                    <TableHead className="px-[10px] w-[15%]">
                      Insights
                    </TableHead>
                    <TableHead className="px-[10px] text-right">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groups.map((g) => (
                    <TableRow key={g.id}>
                      <TableCell className="px-[10px] text-xs whitespace-nowrap">
                        {g.name || g.id}
                      </TableCell>
                      <TableCell className="px-[10px] text-xs truncate max-w-[600px]">
                        {g.webhook || ""}
                      </TableCell>
                      <TableCell className="px-[10px] text-xs">
                        {Array.isArray(g.insights) ? g.insights.length : 0}
                      </TableCell>
                      <TableCell className="px-[10px] text-xs whitespace-nowrap text-right">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            className="inline-flex items-center text-telnyx-green"
                            title="Edit"
                            onClick={() => {
                              setEditingGroup(g);
                              setOpenGroupEditor(true);
                            }}
                          >
                            <IconPencil className="size-4" />
                          </button>
                          <button
                            type="button"
                            className="inline-flex items-center text-red-500 hover:text-red-700"
                            title="Delete"
                            onClick={async () => {
                              if (!confirm("Delete this group?")) return;
                              try {
                                const res = await fetch(
                                  `/api/ai/conversations/insight-groups/${encodeURIComponent(
                                    g.id
                                  )}`,
                                  { method: "DELETE" }
                                );
                                const data = await res.json().catch(() => ({}));
                                if (!res.ok || data?.ok === false)
                                  throw new Error(
                                    data?.error || "Delete failed"
                                  );
                                toast.success("Group deleted");
                                loadGroups();
                              } catch (err) {
                                toast.error(String(err?.message || err));
                              }
                            }}
                          >
                            <IconTrash className="size-4" />
                          </button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {groups.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className="text-center py-8 text-sm text-muted-foreground"
                      >
                        No groups
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {groups.map((g) => (
                <Card
                  key={g.id}
                  className="border-1 border-telnyx-green dark:border-telnyx-green/60"
                >
                  <CardContent className="px-4 py-2">
                    <div className="flex items-start justify-between">
                      <div
                        className="font-medium text-sm truncate"
                        title={g.name}
                      >
                        {g.name || g.id}
                      </div>
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          className="inline-flex items-center text-telnyx-green"
                          title="Edit"
                          onClick={() => {
                            setEditingGroup(g);
                            setOpenGroupEditor(true);
                          }}
                        >
                          <IconPencil className="size-4" />
                        </button>
                        <button
                          type="button"
                          className="inline-flex items-center text-red-500 hover:text-red-700"
                          title="Delete"
                          onClick={async () => {
                            if (!confirm("Delete this group?")) return;
                            try {
                              const res = await fetch(
                                `/api/ai/conversations/insight-groups/${encodeURIComponent(
                                  g.id
                                )}`,
                                { method: "DELETE" }
                              );
                              const data = await res.json().catch(() => ({}));
                              if (!res.ok || data?.ok === false)
                                throw new Error(data?.error || "Delete failed");
                              toast.success("Group deleted");
                              loadGroups();
                            } catch (err) {
                              toast.error(String(err?.message || err));
                            }
                          }}
                        >
                          <IconTrash className="size-4" />
                        </button>
                      </div>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground truncate">
                      {g.webhook || ""}
                    </div>
                    <div className="mt-1 text-xs">
                      <span className="text-muted-foreground">Insights:</span>{" "}
                      {Array.isArray(g.insights) ? g.insights.length : 0}
                    </div>
                  </CardContent>
                </Card>
              ))}
              {groups.length === 0 && (
                <div className="text-center py-8 text-sm text-muted-foreground border rounded-md">
                  No groups
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Sheet open={openInsightEditor} onOpenChange={setOpenInsightEditor}>
        <SheetContent side="right" className="w-full sm:max-w-xl overflow-hidden flex flex-col p-0 bg-background">
          <SheetHeader className="px-6 py-4 border-b border-border">
            <SheetTitle className="text-xl font-bold text-telnyx-green flex items-center gap-2">
              <IconListCheck className="size-5" />
              {editingInsight ? "Edit Insight" : "Create Insight"}
            </SheetTitle>
            <SheetDescription>Configure conversational AI insight extraction.</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto">
            <Card className="mx-5 my-4 border-muted-foreground/20 bg-card"><CardContent className="p-6">
          <InsightEditor
            insight={editingInsight}
            onCancel={() => setOpenInsightEditor(false)}
            onSaved={() => {
              setOpenInsightEditor(false);
              setEditingInsight(null);
              loadInsights();
            }}
          />
            </CardContent></Card>
          </div>
          <SheetFooter className="px-6 py-4 border-t border-border flex flex-row justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpenInsightEditor(false)}>Cancel</Button>
            <Button type="submit" form="insight-editor-form">{editingInsight ? "Save" : "Create"}</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <Sheet open={openGroupEditor} onOpenChange={setOpenGroupEditor}>
        <SheetContent side="right" className="w-full sm:max-w-xl overflow-hidden flex flex-col p-0 bg-background">
          <SheetHeader className="px-6 py-4 border-b border-border">
            <SheetTitle className="text-xl font-bold text-telnyx-green flex items-center gap-2">
              <IconListCheck className="size-5" />
              {editingGroup ? "Edit Group" : "Create Group"}
            </SheetTitle>
            <SheetDescription>Configure insight grouping and webhook settings.</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto">
            <Card className="mx-5 my-4 border-muted-foreground/20 bg-card"><CardContent className="p-6">
          <GroupEditor
            group={editingGroup}
            insights={insights}
            onCancel={() => setOpenGroupEditor(false)}
            onSaved={() => {
              setOpenGroupEditor(false);
              setEditingGroup(null);
              loadGroups();
            }}
          />
            </CardContent></Card>
          </div>
          <SheetFooter className="px-6 py-4 border-t border-border flex flex-row justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpenGroupEditor(false)}>Cancel</Button>
            <Button type="submit" form="group-editor-form">{editingGroup ? "Save" : "Create"}</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      </AiAssistantsSectionPage>
    </AdminPageShell>
  );
}

// ------------------ Insight Editor ------------------

function InsightEditor({ insight, onCancel, onSaved }) {
  const isEdit = !!insight?.id;
  const [name, setName] = useState(insight?.name || "");
  const [mode, setMode] = useState(
    insight?.json_schema ? "structured" : "instructions"
  );
  const [instructions, setInstructions] = useState(insight?.instructions || "");
  const [webhook, setWebhook] = useState(insight?.webhook || "");
  const [parameters, setParameters] = useState(() => {
    if (insight?.json_schema?.properties) {
      const props = insight.json_schema.properties;
      const req = Array.isArray(insight.json_schema.required)
        ? insight.json_schema.required
        : [];
      return Object.entries(props).map(([key, def]) => {
        const t = def?.type || "string";
        const isArray = t === "array";
        const itemType = isArray ? def?.items?.type || "string" : null;
        const typeValue = isArray && itemType ? `array:${itemType}` : t;
        return {
          name: key,
          type: def?.enum ? "enum" : typeValue,
          enumValues: Array.isArray(def?.enum) ? def.enum.join(",") : "",
          required: req.includes(key),
          description: def?.description || "",
        };
      });
    }
    return [
      {
        name: "name",
        type: "string",
        required: true,
        description: "Name of the candidate",
      },
    ];
  });
  const [saving, setSaving] = useState(false);

  const jsonSchema = useMemo(() => {
    if (mode !== "structured") return undefined;
    return buildJsonSchema(parameters);
  }, [mode, parameters]);

  const saveDisabled = useMemo(() => {
    if (!name.trim()) return true;
    if (mode === "instructions" && !instructions.trim()) return true;
    if (mode === "structured" && (!parameters || parameters.length === 0))
      return true;
    const dupes = new Set();
    for (const p of parameters) {
      if (!p?.name?.trim()) return true;
      const k = p.name.trim();
      if (dupes.has(k)) return true;
      dupes.add(k);
    }
    return false;
  }, [name, instructions, mode, parameters]);

  async function handleSave() {
    setSaving(true);
    try {
      const payload = {
        name,
        instructions: mode === "structured" ? "" : instructions,
        webhook: webhook || undefined,
        json_schema: mode === "structured" ? jsonSchema : undefined,
      };
      const url = isEdit
        ? `/api/ai/conversations/insights/${encodeURIComponent(insight.id)}`
        : "/api/ai/conversations/insights";
      const method = isEdit ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || data?.ok === false)
        throw new Error(data?.error || "Save failed");
      toast.success(isEdit ? "Insight updated" : "Insight created");
      onSaved?.(data?.insight || null);
    } catch (err) {
      toast.error(String(err?.message || err));
    } finally {
      setSaving(false);
    }
  }

  function updateParam(index, patch) {
    setParameters((list) =>
      list.map((p, i) => (i === index ? { ...p, ...patch } : p))
    );
  }

  return (
    <form
      id="insight-editor-form"
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!saving && !saveDisabled) handleSave();
      }}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="text-xs">Name</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="save_data"
          />
        </div>
        <div>
          <label className="text-xs">Webhook URL (optional)</label>
          <Input
            value={webhook}
            onChange={(e) => setWebhook(e.target.value)}
            placeholder="https://example.com/insights"
          />
        </div>
      </div>

      <div className="inline-flex rounded-md border overflow-hidden w-fit">
        <button
          type="button"
          className={`px-3 py-1 text-sm ${
            mode === "instructions"
              ? "bg-primary text-primary-foreground"
              : "bg-background"
          }`}
          onClick={() => setMode("instructions")}
        >
          Instructions
        </button>
        <button
          type="button"
          className={`px-3 py-1 text-sm border-l ${
            mode === "structured"
              ? "bg-primary text-primary-foreground"
              : "bg-background"
          }`}
          onClick={() => setMode("structured")}
        >
          Structured data
        </button>
      </div>

      {mode === "instructions" ? (
        <div>
          <label className="text-xs">Instructions</label>
          <Textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="What the assistant should extract or compute"
            className="min-h-[120px]"
          />
        </div>
      ) : (
        <div className="space-y-2">
          <div className="text-sm font-medium">Parameters</div>
          <div className="rounded-md border">
            <ScrollArea className="h-[300px] w-full">
              <div className="divide-y">
                {parameters.map((p, idx) => (
                  <div
                    key={idx}
                    className="grid grid-cols-1 md:grid-cols-12 gap-2 p-2 items-start"
                  >
                    <div className="md:col-span-3">
                      <Label className="text-xs">Name</Label>
                      <Input
                        value={p.name}
                        onChange={(e) =>
                          updateParam(idx, { name: e.target.value })
                        }
                        placeholder="name"
                      />
                    </div>
                    <div className="md:col-span-3">
                      <Label className="text-xs">Type</Label>
                      <Select
                        value={p.type || "string"}
                        onValueChange={(value) =>
                          updateParam(idx, { type: value })
                        }
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PARAM_TYPES.map((t) => (
                            <SelectItem key={t.value} value={t.value}>
                              {t.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="md:col-span-2">
                      <Label className="text-xs" htmlFor={`req-${idx}`}>
                        Required
                      </Label>
                      <div className="pt-1">
                        <Switch
                          id={`req-${idx}`}
                          checked={!!p.required}
                          onCheckedChange={(v) =>
                            updateParam(idx, { required: Boolean(v) })
                          }
                        />
                      </div>
                    </div>
                    <div className="md:col-span-12">
                      <Label className="text-xs">Description</Label>
                      <Input
                        value={p.description || ""}
                        onChange={(e) =>
                          updateParam(idx, { description: e.target.value })
                        }
                        placeholder="What this parameter represents"
                      />
                    </div>
                    {p.type === "enum" && (
                      <div className="md:col-span-12">
                        <Label className="text-xs">
                          Allowed values (comma separated)
                        </Label>
                        <Input
                          value={p.enumValues || ""}
                          onChange={(e) =>
                            updateParam(idx, { enumValues: e.target.value })
                          }
                          placeholder="pending, accepted, rejected"
                        />
                      </div>
                    )}
                    <div className="md:col-span-12 -mt-1">
                      <div className="flex justify-end">
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            setParameters((list) =>
                              list.filter((_, i) => i !== idx)
                            )
                          }
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
                <div className="p-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setParameters((list) => [
                        ...list,
                        {
                          name: "",
                          type: "string",
                          required: false,
                          description: "",
                        },
                      ])
                    }
                  >
                    <IconPlus className="mr-1 size-4" /> Add parameter
                  </Button>
                </div>
              </div>
            </ScrollArea>
          </div>
        </div>
      )}

      <input type="hidden" disabled={saving || saveDisabled} />
    </form>
  );
}

// ------------------ Group Editor ------------------

function GroupEditor({ group, insights, onCancel, onSaved }) {
  const isEdit = !!group?.id;
  const [name, setName] = useState(group?.name || "");
  const [webhook, setWebhook] = useState(group?.webhook || "");
  const [selectedIds, setSelectedIds] = useState(
    () =>
      new Set(
        (Array.isArray(group?.insights) ? group.insights : []).map((i) => i.id)
      )
  );
  const [saving, setSaving] = useState(false);

  function toggle(id, on) {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  }

  const atLeastOne = selectedIds.size > 0;

  async function saveDetails() {
    const url = isEdit
      ? `/api/ai/conversations/insight-groups/${encodeURIComponent(group.id)}`
      : "/api/ai/conversations/insight-groups";
    const method = isEdit ? "PUT" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, webhook }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false)
      throw new Error(data?.error || "Save failed");
    return data?.group || data?.data || { id: group?.id };
  }

  async function syncAssignments(groupId) {
    const existing = new Set(
      (Array.isArray(group?.insights) ? group.insights : []).map((i) => i.id)
    );
    const desired = selectedIds;
    const toAssign = [...desired].filter((id) => !existing.has(id));
    const toUnassign = [...existing].filter((id) => !desired.has(id));
    for (const id of toAssign) {
      const res = await fetch(
        `/api/ai/conversations/insight-groups/${encodeURIComponent(
          groupId
        )}/insights/${encodeURIComponent(id)}/assign`,
        { method: "POST" }
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "Assign failed");
      }
    }
    for (const id of toUnassign) {
      const res = await fetch(
        `/api/ai/conversations/insight-groups/${encodeURIComponent(
          groupId
        )}/insights/${encodeURIComponent(id)}/unassign`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "Unassign failed");
      }
    }
  }

  async function handleSave() {
    if (selectedIds.size === 0) {
      toast.error("At least one insight must be selected");
      return;
    }
    setSaving(true);
    try {
      const saved = await saveDetails();
      const groupId = saved?.id || group?.id;
      await syncAssignments(groupId);
      toast.success(isEdit ? "Group updated" : "Group created");
      onSaved?.(saved);
    } catch (err) {
      toast.error(String(err?.message || err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      id="group-editor-form"
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!saving && name.trim() && atLeastOne) handleSave();
      }}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="text-xs">Name</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Default Group"
          />
        </div>
        <div>
          <label className="text-xs">Webhook URL (optional)</label>
          <Input
            value={webhook}
            onChange={(e) => setWebhook(e.target.value)}
            placeholder="https://example.com/insights"
          />
        </div>
      </div>

      <div className="text-sm font-medium flex items-center gap-1">
        <IconListCheck className="size-4 text-telnyx-green" /> Assign Insights
      </div>
      <div className="rounded-md border h-72">
        <ScrollArea className="h-72 w-full">
          <div className="p-2 space-y-1">
            {insights.map((ins) => {
              const checked = selectedIds.has(ins.id);
              return (
                <label
                  key={ins.id}
                  className="flex items-center gap-2 text-sm px-2 py-1 rounded hover:bg-muted cursor-pointer"
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(v) => toggle(ins.id, Boolean(v))}
                  />
                  <span className="truncate" title={ins.name}>
                    {ins.name}
                  </span>
                </label>
              );
            })}
            {insights.length === 0 && (
              <div className="text-xs text-muted-foreground px-2 py-1">
                No insights available. Create an insight first.
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
      {!atLeastOne && (
        <div className="text-xs text-red-500">
          At least one insight is required.
        </div>
      )}

      <input type="hidden" disabled={saving || !name.trim() || !atLeastOne} />
    </form>
  );
}
