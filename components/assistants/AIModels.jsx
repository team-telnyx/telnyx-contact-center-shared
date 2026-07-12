"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { Info, Search } from "lucide-react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const PROVIDER_ICONS = {
  openai: "openai",
  anthropic: "anthropic",
  "meta-llama": "meta-llama",
  qwen: "qwen",
  moonshotai: "moonshotai",
  mistral: "mistral",
  mistralai: "mistralai",
  google: "google",
  groq: "groq",
  xai: "xai-org",
  "xai-org": "xai-org",
  deepseek: "deepseek-ai",
  "deepseek-ai": "deepseek-ai",
  minimaxai: "minimaxai",
  "zai-org": "zai-org",
};

function providerIcon(provider) {
  const slug = String(provider || "").toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `/brands/${PROVIDER_ICONS[slug] || slug}.svg`;
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
}

function ModelDetails({ model, provider, modelName }) {
  const raw = model.raw;
  if (!raw) return null;
  return <HoverCard openDelay={150} closeDelay={100}><HoverCardTrigger asChild><span className="inline-flex cursor-default items-center gap-1 rounded px-1 py-0.5 text-[10px] text-muted-foreground/70 hover:text-foreground" onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}><Info className="size-3" />Details</span></HoverCardTrigger><HoverCardContent align="end" sideOffset={6} className="w-80"><div className="mb-2 flex items-center gap-2"><Image alt="" src={providerIcon(provider)} width={24} height={24} className="size-6" /><div className="text-xs font-medium lowercase">{modelName}</div></div><div className="grid grid-cols-2 gap-y-2 text-xs"><span className="text-muted-foreground">Provider</span><span className="font-medium">{provider}</span><span className="text-muted-foreground">Org</span><span className="font-medium">{raw.organization || "-"}</span><span className="text-muted-foreground">Task</span><span className="font-medium">{raw.task || "-"}</span><span className="text-muted-foreground">Context</span><span className="font-medium">{raw.context_length || "-"}</span><span className="text-muted-foreground">Parameters</span><span className="font-medium">{raw.parameters_str || raw.parameters || "-"}</span><span className="text-muted-foreground">Tier</span><span className="font-medium">{raw.tier || "-"}</span><span className="text-muted-foreground">Languages</span><span className="truncate font-medium">{Array.isArray(raw.languages) && raw.languages.length ? raw.languages.join(", ") : "-"}</span><span className="text-muted-foreground">License</span><span className="font-medium">{raw.license || "-"}</span><span className="text-muted-foreground">Owned by</span><span className="font-medium">{raw.owned_by || "-"}</span><span className="text-muted-foreground">Created</span><span className="font-medium">{formatDate(raw.created)}</span><span className="text-muted-foreground">Fine tunable</span><span className="font-medium">{String(raw.is_fine_tunable ?? "-")}</span><span className="text-muted-foreground">For assistants</span><span className="font-medium">{String(raw.recommended_for_assistants ?? "-")}</span></div></HoverCardContent></HoverCard>;
}

export default function AIModels({ value, onValueChange, models, placeholder = "Select a model", searchable = true, triggerClassName, contentClassName }) {
  const [query, setQuery] = useState("");
  const inputRef = useRef(null);
  const filtered = useMemo(() => { const list = Array.isArray(models) ? models : []; const needle = query.trim().toLowerCase(); return needle ? list.filter((model) => String(model.id).toLowerCase().includes(needle) || String(model.name).toLowerCase().includes(needle)) : list; }, [models, query]);
  const groups = useMemo(() => { const map = new Map(); for (const model of filtered) { const provider = String(model.id || "").split("/")[0].toUpperCase(); if (!map.has(provider)) map.set(provider, []); map.get(provider).push(model); } return [...map.entries()]; }, [filtered]);
  useEffect(() => { if (!searchable || !inputRef.current) return; const timeout = window.setTimeout(() => inputRef.current?.focus(), 0); return () => window.clearTimeout(timeout); }, [query, searchable]);
  return <Select value={value} onValueChange={onValueChange}><SelectTrigger className={cn("w-full border-none bg-transparent font-medium text-muted-foreground shadow-none transition-colors hover:bg-accent hover:text-foreground", triggerClassName)}><SelectValue placeholder={placeholder} /></SelectTrigger><SelectContent side="top" className={contentClassName} onCloseAutoFocus={(event) => event.preventDefault()}>{searchable ? <div className="sticky top-0 z-10 border-b bg-popover p-2"><div className="flex h-8 items-center gap-2 rounded-md border px-2"><Search className="size-3.5 text-muted-foreground" /><input ref={inputRef} type="text" placeholder="Search models..." className="h-full min-w-0 flex-1 bg-transparent text-xs outline-none" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus onKeyDown={(event) => event.stopPropagation()} /></div></div> : null}<div className="max-h-[50vh] overflow-y-auto">{groups.map(([provider, items], groupIndex) => <Fragment key={provider}>{groupIndex > 0 ? <SelectSeparator /> : null}<SelectGroup><SelectLabel className="text-xs font-bold uppercase text-muted-foreground"><span className="inline-flex items-center gap-2"><Image alt="" src={providerIcon(provider)} width={20} height={20} className="size-5" />{provider}</span></SelectLabel>{items.map((model) => { const [providerName, name = providerName] = String(model.id).split("/"); return <SelectItem key={model.id} value={model.id} textValue={model.id} className="py-2 pl-3 pr-8"><div className="flex w-full items-center justify-between gap-3 pr-1"><span className="text-[12px] lowercase text-foreground/90">{name.toLowerCase()}</span><ModelDetails model={model} provider={providerName} modelName={name.toLowerCase()} /></div></SelectItem>; })}</SelectGroup></Fragment>)}{!groups.length ? <div className="p-6 text-center text-xs text-muted-foreground">No recommended assistant models found.</div> : null}</div></SelectContent></Select>;
}
