"use client";
import { useUiText } from "@/components/i18n/use-ui-text";


import { useEffect, useRef, useState } from "react";
import { IconLoader2, IconPlus, IconTag, IconX } from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function TagsSection({ assistantId, initialTags = [], value, onChange }) {
  const tUi = useUiText();
  const [savedTags, setTags] = useState(initialTags);
  const tags = onChange ? value || [] : savedTags;
  const [loadedFor, setLoadedFor] = useState(null);
  const loading = !onChange && assistantId && !initialTags.length && loadedFor !== assistantId;
  const [adding, setAdding] = useState(false);
  const [newTag, setNewTag] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    if (onChange || !assistantId || initialTags.length) return;
    let cancelled = false;
    fetch(`/api/ai/assistants/${encodeURIComponent(assistantId)}/tags`, { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => { if (!cancelled && data.ok && Array.isArray(data.tags)) setTags(data.tags); })
      .catch(() => {})
      .finally(() => !cancelled && setLoadedFor(assistantId));
    return () => { cancelled = true; };
  }, [assistantId, initialTags.length, onChange]);

  async function addTag() {
    const tag = newTag.trim();
    if (!tag) return;
    if (tags.includes(tag)) { notify({ title: "Tag already exists", description: tag, variant: "warning" }); return; }
    if (onChange) { onChange([...tags, tag]); setNewTag(""); inputRef.current?.focus(); return; }
    setAdding(true);
    try {
      const response = await fetch(`/api/ai/assistants/${encodeURIComponent(assistantId)}/tags`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tags: [tag] }) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Failed to add tag");
      setTags((current) => [...current, tag]); setNewTag(""); inputRef.current?.focus();
      notify({ title: "Tag added", description: tag, variant: "success" });
    } catch (error) { notify({ title: "Failed to add tag", description: error.message, variant: "error" }); }
    finally { setAdding(false); }
  }

  async function removeTag(tag) {
    if (onChange) { onChange(tags.filter(item => item !== tag)); return; }
    try {
      const response = await fetch(`/api/ai/assistants/${encodeURIComponent(assistantId)}/tags?tag=${encodeURIComponent(tag)}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Failed to remove tag");
      setTags((current) => current.filter((item) => item !== tag));
      notify({ title: "Tag removed", description: tag, variant: "success" });
    } catch (error) { notify({ title: "Failed to remove tag", description: error.message, variant: "error" }); }
  }

  if (!assistantId && !onChange) return null;
  return <div className="shrink-0 space-y-2 border-t pt-3"><div className="flex items-center gap-2"><IconTag className="size-4 text-muted-foreground" /><span className="text-sm font-medium">{tUi("Tags")}</span>{loading ? <IconLoader2 className="size-3 animate-spin text-muted-foreground" /> : null}</div><div className="flex max-h-16 min-h-7 flex-wrap gap-2 overflow-y-auto">{loading ? <Skeleton className="h-7 w-32"/> : null}{!tags.length && !loading ? <span className="text-xs text-muted-foreground">{tUi("No tags yet")}</span> : null}{tags.map((tag) => <Badge key={tag} variant="secondary" className="flex items-center gap-1 pr-1 text-xs">{tag}<button type="button" onClick={() => removeTag(tag)} className="ml-0.5 rounded-full p-0.5 transition-colors hover:bg-muted-foreground/20" aria-label={tUi("Remove tag {value0}", { value0: tag })}><IconX className="size-3" /></button></Badge>)}</div><div className="flex gap-2"><Input ref={inputRef} placeholder={tUi("Add a tag...")} value={newTag} maxLength={20} onChange={(event) => setNewTag(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addTag(); } }} className="h-8 text-sm" disabled={adding} /><Button size="sm" variant="outline" onClick={addTag} disabled={adding || !newTag.trim()} className="shrink-0">{adding ? <IconLoader2 className="size-3 animate-spin" /> : <IconPlus className="size-3" />}{tUi("Add")}</Button></div></div>;
}
