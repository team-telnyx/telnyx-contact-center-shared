"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { IconArchive, IconPencil, IconPlus, IconWorldUpload } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { FormRenderer } from "@/components/forms/FormRenderer";
import { createDefaultForm, slugifyFormName } from "@/lib/forms/form-schema";

function formThemeStyle(theme = {}, base = {}) {
  const pairs = [["primary", "--primary"], ["primaryColor", "--primary"], ["primaryForeground", "--primary-foreground"], ["primaryForegroundColor", "--primary-foreground"], ["background", "--background"], ["backgroundColor", "--background"], ["foreground", "--foreground"], ["textColor", "--foreground"], ["card", "--card"], ["cardColor", "--card"], ["cardForeground", "--card-foreground"], ["border", "--border"], ["borderColor", "--border"], ["accent", "--accent"], ["accentColor", "--accent"], ["accentForeground", "--accent-foreground"], ["muted", "--muted"], ["mutedColor", "--muted"]];
  return pairs.reduce((style, [key, variable]) => theme?.[key] ? { ...style, [variable]: theme[key] } : style, base);
}
function themeColor(theme = {}, ...keys) { return keys.map((key) => theme?.[key]).find(Boolean); }
function formPreviewStyle(form = {}) {
  const theme = form.theme || {};
  const primary = themeColor(theme, "primary", "primaryColor", "pageTabActiveBorderColor") || "var(--primary)";
  const background = themeColor(theme, "background", "backgroundColor") || "var(--background)";
  const border = themeColor(theme, "border", "borderColor", "pageTabActiveBorderColor") || "var(--border)";
  return { ...formThemeStyle(theme), background: `linear-gradient(135deg, color-mix(in srgb, ${primary} 14%, transparent), ${background} 44%)`, borderColor: border };
}

export default function AdminFormsPage() {
  const router = useRouter();
  const [forms, setForms] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  async function load() {
    const res = await fetch("/api/admin/forms?status=all", { cache: "no-store" });
    const data = await res.json();
    if (data.ok) setForms(data.forms || []);
    else setMessage(data.error || "Failed to load forms");
  }

  useEffect(() => { load(); }, []);

  async function createForm() {
    setLoading(true); setMessage("");
    try {
      const draft = createDefaultForm({ name: "New agent form", slug: `${slugifyFormName("New agent form")}-${Date.now().toString(36)}` });
      const res = await fetch("/api/admin/forms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Failed to create form");
      router.push(`/admin/forms/${data.form.id}`);
    } catch (err) {
      setMessage(err.message || "Failed to create form");
    } finally {
      setLoading(false);
    }
  }

  async function archiveForm(form) {
    if (!window.confirm(`Archive “${form.name}”? It will be hidden from published form lists.`)) return;
    setLoading(true); setMessage("");
    try {
      const res = await fetch(`/api/admin/forms/${form.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Archive failed");
      setMessage("Form archived.");
      await load();
    } catch (err) {
      setMessage(err.message || "Archive failed");
    } finally {
      setLoading(false);
    }
  }

  async function publishForm(form) {
    setLoading(true); setMessage("");
    try {
      const res = await fetch(`/api/admin/forms/${form.id}/publish`, { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Publish failed");
      setMessage("Form published.");
      await load();
    } catch (err) {
      setMessage(err.message || "Publish failed");
    } finally {
      setLoading(false);
    }
  }

  return <div className="container mx-auto p-6 space-y-6">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold">Agent Forms</h1>
        <p className="text-sm text-muted-foreground">Custom queue forms for agent desktop and Agent Assist.</p>
      </div>
      <Button onClick={createForm} disabled={loading}><IconPlus className="h-4 w-4 mr-2" />New form</Button>
    </div>

    {message ? <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">{message}</div> : null}

    {forms.length === 0 ? <Card><CardContent className="p-10 text-center"><h2 className="font-medium">No forms yet</h2><p className="mt-1 text-sm text-muted-foreground">Create the first form, then refine it in the visual builder or with the AI agent.</p><Button className="mt-4" onClick={createForm}>Create form</Button></CardContent></Card> : null}

    <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
      {forms.map((form) => <Card key={form.id} className="overflow-hidden flex flex-col">
        <CardHeader className="space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0"><CardTitle className="text-base truncate">{form.name}</CardTitle><p className="text-xs text-muted-foreground truncate">{form.slug}</p></div>
            <Badge variant={form.status === "published" ? "default" : "outline"}>{form.status}</Badge>
          </div>
          <div className="flex flex-wrap gap-1 text-xs">{form.category ? <Badge variant="secondary">{form.category}</Badge> : null}{(form.queue_names || []).slice(0, 2).map((queue) => <Badge key={queue} variant="outline">{queue}</Badge>)}{(form.queue_names || []).length > 2 ? <Badge variant="outline">+{form.queue_names.length - 2}</Badge> : null}</div>
        </CardHeader>
        <CardContent className="flex-1">
          <div className="h-56 overflow-hidden rounded-xl border p-4" style={formPreviewStyle(form)}>
            <div className="origin-top-left scale-[0.72] w-[135%] pointer-events-none rounded-lg bg-background p-5 text-foreground shadow-sm ring-1 ring-border/70" style={formThemeStyle(form.theme)}>
              <FormRenderer form={form} readOnly />
            </div>
          </div>
          {form.description ? <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">{form.description}</p> : null}
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2 border-t bg-muted/30 p-3">
          <Button size="sm" onClick={() => router.push(`/admin/forms/${form.id}`)}><IconPencil className="h-4 w-4 mr-1" />Edit</Button>
          <Button size="sm" variant="outline" onClick={() => publishForm(form)} disabled={loading || form.status === "published"}><IconWorldUpload className="h-4 w-4 mr-1" />Publish</Button>
          <Button size="sm" variant="ghost" className="text-destructive" onClick={() => archiveForm(form)} disabled={loading || form.status === "archived"}><IconArchive className="h-4 w-4 mr-1" />Archive</Button>
        </CardFooter>
      </Card>)}
    </div>
  </div>;
}
