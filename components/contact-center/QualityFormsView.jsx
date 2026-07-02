"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  IconArchive,
  IconClipboardCheck,
  IconDeviceFloppy,
  IconPencil,
  IconPlus,
  IconRosetteDiscountCheck,
  IconTrash,
} from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";

function emptyCriterion() {
  return {
    id: `criterion-${Math.random().toString(36).slice(2, 9)}`,
    label: "",
    description: "",
    type: "score",
    maxScore: 5,
    weight: 1,
    criticalFail: false,
    aiRubric: { excellent: "", poor: "", evidenceRequired: true },
  };
}

function emptySection() {
  return {
    id: `section-${Math.random().toString(36).slice(2, 9)}`,
    title: "",
    criteria: [emptyCriterion()],
  };
}

function formMaxScore(sections) {
  let max = 0;
  for (const section of sections || []) {
    for (const criterion of section.criteria || []) {
      max += Number(criterion.maxScore || 0) * Number(criterion.weight || 1);
    }
  }
  return max;
}

const STATUS_BADGE = {
  draft: "border-sky-500/40 text-sky-700 dark:text-sky-300",
  published: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
  archived: "text-muted-foreground",
};

export default function QualityFormsView({ refreshNonce = 0 }) {
  const [forms, setForms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [localNonce, setLocalNonce] = useState(0);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingForm, setEditingForm] = useState(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [sections, setSections] = useState([emptySection()]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch("/api/contact-center/quality/forms", { cache: "no-store" });
        const payload = await res.json();
        if (!res.ok) throw new Error(payload?.error || "Failed to load forms");
        if (!cancelled) setForms(payload.forms || []);
      } catch (error) {
        if (!cancelled) {
          notify({
            title: "Quality forms load failed",
            description: String(error.message || error),
            variant: "error",
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [refreshNonce, localNonce]);

  const openCreate = useCallback(() => {
    setEditingForm(null);
    setName("");
    setDescription("");
    setCategory("");
    setSections([emptySection()]);
    setEditorOpen(true);
  }, []);

  const openEdit = useCallback((form) => {
    setEditingForm(form);
    setName(form.name || "");
    setDescription(form.description || "");
    setCategory(form.category || "");
    const schemaSections = form.schema?.sections;
    setSections(
      Array.isArray(schemaSections) && schemaSections.length > 0
        ? JSON.parse(JSON.stringify(schemaSections))
        : [emptySection()],
    );
    setEditorOpen(true);
  }, []);

  const updateSection = useCallback((sectionIndex, updates) => {
    setSections((previous) =>
      previous.map((section, index) =>
        index === sectionIndex ? { ...section, ...updates } : section,
      ),
    );
  }, []);

  const updateCriterion = useCallback((sectionIndex, criterionIndex, updates) => {
    setSections((previous) =>
      previous.map((section, index) => {
        if (index !== sectionIndex) return section;
        return {
          ...section,
          criteria: section.criteria.map((criterion, cIndex) =>
            cIndex === criterionIndex ? { ...criterion, ...updates } : criterion,
          ),
        };
      }),
    );
  }, []);

  const updateRubric = useCallback((sectionIndex, criterionIndex, updates) => {
    setSections((previous) =>
      previous.map((section, index) => {
        if (index !== sectionIndex) return section;
        return {
          ...section,
          criteria: section.criteria.map((criterion, cIndex) =>
            cIndex === criterionIndex
              ? { ...criterion, aiRubric: { ...(criterion.aiRubric || {}), ...updates } }
              : criterion,
          ),
        };
      }),
    );
  }, []);

  const saveForm = useCallback(
    async (publish = false) => {
      if (!name.trim()) {
        notify({ title: "Form name is required", variant: "error" });
        return;
      }
      const cleanSections = sections
        .filter((section) => section.title.trim())
        .map((section) => ({
          ...section,
          criteria: (section.criteria || []).filter((criterion) => criterion.label.trim()),
        }))
        .filter((section) => section.criteria.length > 0);
      if (cleanSections.length === 0) {
        notify({
          title: "Add at least one section with one criterion",
          variant: "error",
        });
        return;
      }

      setSaving(true);
      try {
        const payloadBody = {
          name: name.trim(),
          description: description.trim() || null,
          category: category.trim() || null,
          schema: { sections: cleanSections },
          scoring_config: {
            maxScore: formMaxScore(cleanSections),
            passThresholdPercent: 80,
            criticalFailZeroesScore: true,
          },
        };
        if (publish) payloadBody.status = "published";

        const url = editingForm
          ? `/api/contact-center/quality/forms/${editingForm.id}`
          : "/api/contact-center/quality/forms";
        const res = await fetch(url, {
          method: editingForm ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payloadBody),
        });
        const payload = await res.json();
        if (!res.ok) throw new Error(payload?.error || "Failed to save form");

        if (!editingForm && publish && payload.form?.id) {
          const publishRes = await fetch(`/api/contact-center/quality/forms/${payload.form.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "published" }),
          });
          if (!publishRes.ok) {
            const publishPayload = await publishRes.json().catch(() => ({}));
            throw new Error(publishPayload?.error || "Form saved but publishing failed");
          }
        }

        notify({
          title: publish ? "Form published" : "Form saved",
          variant: "success",
        });
        setEditorOpen(false);
        setLocalNonce((nonce) => nonce + 1);
      } catch (error) {
        notify({
          title: "Failed to save form",
          description: String(error.message || error),
          variant: "error",
        });
      } finally {
        setSaving(false);
      }
    },
    [name, description, category, sections, editingForm],
  );

  const setFormStatus = useCallback(async (form, status) => {
    try {
      const res = await fetch(`/api/contact-center/quality/forms/${form.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || "Failed to update form");
      notify({ title: status === "published" ? "Form published" : "Form archived", variant: "success" });
      setLocalNonce((nonce) => nonce + 1);
    } catch (error) {
      notify({
        title: "Failed to update form",
        description: String(error.message || error),
        variant: "error",
      });
    }
  }, []);

  return (
    <div className="space-y-5" data-testid="quality-forms-view">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Evaluation scorecards used by supervisors and the AI assistant. Separate from agent
          scripting forms.
        </p>
        <Button type="button" size="sm" onClick={openCreate}>
          <IconPlus className="mr-2 h-4 w-4" />
          New form
        </Button>
      </div>

      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-44 rounded-2xl" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {forms.map((form) => {
            const criteriaCount = (form.schema?.sections || []).reduce(
              (sum, section) => sum + (section.criteria?.length || 0),
              0,
            );
            return (
              <Card key={form.id} className="border bg-background/85 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
                <CardContent className="flex h-full flex-col p-5">
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
                      <IconClipboardCheck className="h-5 w-5" />
                    </span>
                    <div className="flex items-center gap-1.5">
                      {form.is_template ? (
                        <Badge variant="outline" className="text-[11px] text-muted-foreground">Template</Badge>
                      ) : null}
                      <Badge variant="outline" className={STATUS_BADGE[form.status] || ""}>
                        {form.status}
                      </Badge>
                    </div>
                  </div>
                  <h4 className="mt-4 text-base font-semibold leading-tight">{form.name}</h4>
                  <p className="mt-1 line-clamp-2 flex-1 text-sm text-muted-foreground">
                    {form.description || "No description"}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span>v{form.version}</span>
                    <span>· {criteriaCount} criteria</span>
                    <span>· {form.evaluation_count || 0} evaluations</span>
                    {form.category ? <span>· {form.category}</span> : null}
                  </div>
                  <div className="mt-4 flex gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => openEdit(form)}>
                      <IconPencil className="mr-1.5 h-4 w-4" />
                      Edit
                    </Button>
                    {form.status === "draft" ? (
                      <Button type="button" variant="outline" size="sm" onClick={() => setFormStatus(form, "published")}>
                        <IconRosetteDiscountCheck className="mr-1.5 h-4 w-4" />
                        Publish
                      </Button>
                    ) : null}
                    {form.status !== "archived" ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground"
                        onClick={() => setFormStatus(form, "archived")}
                      >
                        <IconArchive className="mr-1.5 h-4 w-4" />
                        Archive
                      </Button>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Sheet open={editorOpen} onOpenChange={setEditorOpen}>
        <SheetContent className="flex w-full flex-col overflow-hidden p-0 sm:max-w-2xl">
          <SheetHeader className="border-b px-6 py-4">
            <SheetTitle>{editingForm ? "Edit quality form" : "New quality form"}</SheetTitle>
            <SheetDescription>
              Define sections and criteria. The AI rubric guides the assistant when scoring calls
              automatically.
            </SheetDescription>
          </SheetHeader>

          {/* Scrollable content: form metadata + sections/criteria */}
          <div className="flex-1 overflow-y-auto">
            <div className="space-y-5 px-6 py-4">
            <div className="grid gap-3">
              <div>
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">Name</Label>
                <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Billing Support Scorecard" />
              </div>
              <div>
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">Description</Label>
                <Textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={2} />
              </div>
              <div>
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">Category</Label>
                <Input value={category} onChange={(event) => setCategory(event.target.value)} placeholder="e.g. customer-service" />
              </div>
            </div>

            {sections.map((section, sectionIndex) => (
              <Card key={section.id} className="border bg-muted/20">
                <CardContent className="space-y-4 p-4">
                  <div className="flex items-center gap-2">
                    <Input
                      value={section.title}
                      onChange={(event) => updateSection(sectionIndex, { title: event.target.value })}
                      placeholder="Section title (e.g. Opening)"
                      className="font-medium"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="shrink-0 text-muted-foreground"
                      onClick={() =>
                        setSections((previous) => previous.filter((_, index) => index !== sectionIndex))
                      }
                      disabled={sections.length <= 1}
                    >
                      <IconTrash className="h-4 w-4" />
                    </Button>
                  </div>

                  {section.criteria.map((criterion, criterionIndex) => (
                    <div key={criterion.id} className="space-y-3 rounded-xl border border-border/60 bg-background/70 p-3">
                      <div className="flex items-center gap-2">
                        <Input
                          value={criterion.label}
                          onChange={(event) =>
                            updateCriterion(sectionIndex, criterionIndex, { label: event.target.value })
                          }
                          placeholder="Criterion (e.g. Professional greeting)"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="shrink-0 text-muted-foreground"
                          onClick={() =>
                            updateSection(sectionIndex, {
                              criteria: section.criteria.filter((_, index) => index !== criterionIndex),
                            })
                          }
                          disabled={section.criteria.length <= 1}
                        >
                          <IconTrash className="h-4 w-4" />
                        </Button>
                      </div>
                      <Textarea
                        value={criterion.description}
                        onChange={(event) =>
                          updateCriterion(sectionIndex, criterionIndex, { description: event.target.value })
                        }
                        placeholder="What should the evaluator look for?"
                        rows={2}
                      />
                      <div className="flex flex-wrap items-center gap-4">
                        <div>
                          <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Type</Label>
                          <Select
                            value={criterion.type}
                            onValueChange={(value) =>
                              updateCriterion(sectionIndex, criterionIndex, {
                                type: value,
                                maxScore: value === "boolean" ? 1 : criterion.maxScore || 5,
                              })
                            }
                          >
                            <SelectTrigger className="w-[130px]"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="score">Score</SelectItem>
                              <SelectItem value="boolean">Pass / Fail</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        {criterion.type === "score" ? (
                          <div>
                            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Max score</Label>
                            <Input
                              type="number"
                              min={1}
                              max={10}
                              value={criterion.maxScore}
                              onChange={(event) =>
                                updateCriterion(sectionIndex, criterionIndex, {
                                  maxScore: Math.max(1, Math.min(10, Number(event.target.value) || 1)),
                                })
                              }
                              className="w-[90px]"
                            />
                          </div>
                        ) : null}
                        <div>
                          <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Weight</Label>
                          <Input
                            type="number"
                            min={1}
                            max={5}
                            value={criterion.weight}
                            onChange={(event) =>
                              updateCriterion(sectionIndex, criterionIndex, {
                                weight: Math.max(1, Math.min(5, Number(event.target.value) || 1)),
                              })
                            }
                            className="w-[80px]"
                          />
                        </div>
                        <div className="flex items-center gap-2 pt-4">
                          <Switch
                            checked={Boolean(criterion.criticalFail)}
                            onCheckedChange={(checked) =>
                              updateCriterion(sectionIndex, criterionIndex, { criticalFail: checked })
                            }
                          />
                          <span className="text-xs text-muted-foreground">Critical fail</span>
                        </div>
                      </div>
                      <div className="grid gap-2 md:grid-cols-2">
                        <div>
                          <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">AI rubric · excellent</Label>
                          <Textarea
                            value={criterion.aiRubric?.excellent || ""}
                            onChange={(event) => updateRubric(sectionIndex, criterionIndex, { excellent: event.target.value })}
                            rows={2}
                            placeholder="What does a top score look like?"
                          />
                        </div>
                        <div>
                          <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">AI rubric · poor</Label>
                          <Textarea
                            value={criterion.aiRubric?.poor || ""}
                            onChange={(event) => updateRubric(sectionIndex, criterionIndex, { poor: event.target.value })}
                            rows={2}
                            placeholder="What does a failing score look like?"
                          />
                        </div>
                      </div>
                    </div>
                  ))}

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      updateSection(sectionIndex, {
                        criteria: [...section.criteria, emptyCriterion()],
                      })
                    }
                  >
                    <IconPlus className="mr-1.5 h-4 w-4" />
                    Add criterion
                  </Button>
                </CardContent>
              </Card>
            ))}

            <Button type="button" variant="outline" onClick={() => setSections((previous) => [...previous, emptySection()])}>
              <IconPlus className="mr-1.5 h-4 w-4" />
              Add section
            </Button>

            <div className="flex items-center justify-between rounded-xl border border-border/60 bg-muted/30 p-3 text-sm">
              <span className="text-muted-foreground">Maximum score</span>
              <span className="font-semibold">{formMaxScore(sections)} pts</span>
            </div>
            </div>
          </div>

          {/* Fixed Footer */}
          <SheetFooter className="flex flex-row justify-end gap-2 border-t px-6 py-4">
            <Button type="button" variant="outline" onClick={() => setEditorOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="button" variant="outline" onClick={() => saveForm(false)} disabled={saving}>
              <IconDeviceFloppy className="mr-1.5 h-4 w-4" />
              Save draft
            </Button>
            <Button type="button" onClick={() => saveForm(true)} disabled={saving}>
              <IconRosetteDiscountCheck className="mr-1.5 h-4 w-4" />
              {saving ? "Saving…" : "Save & publish"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
