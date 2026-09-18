"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import WidgetIcon from "@/components/widget/WidgetIcon";
import { Input } from "@/components/ui/input";
import { WIDGET_ICON_CATALOG } from "@/lib/widgets/icon-catalog";

export default function IconPicker({ label = "Icon", hint, value, onChange }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? WIDGET_ICON_CATALOG.filter(([id, name, category]) => `${id} ${name} ${category}`.toLowerCase().includes(needle))
      : WIDGET_ICON_CATALOG;
  }, [query]);

  return (
    <div className="grid gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      <button type="button" className="flex h-10 items-center gap-3 rounded-md border bg-background px-3 text-left text-sm" onClick={() => setOpen((current) => !current)}>
        <WidgetIcon name={value} size={18} />
        <span className="min-w-0 flex-1 truncate">{WIDGET_ICON_CATALOG.find(([id]) => id === value)?.[1] || value}</span>
        <span className="text-xs text-muted-foreground">{open ? "Close" : "Choose"}</span>
      </button>
      {open && (
        <div className="rounded-lg border bg-background p-2 shadow-sm">
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} className="pl-8" placeholder="Search 50+ icons…" />
          </div>
          <div className="grid max-h-64 grid-cols-6 gap-1 overflow-y-auto pr-1">
            {filtered.map(([id, name]) => (
              <button
                key={id}
                type="button"
                title={name}
                aria-label={name}
                className={`grid aspect-square place-items-center rounded-md border transition-colors hover:bg-muted ${id === value ? "border-primary bg-primary/10 text-primary" : "border-transparent"}`}
                onClick={() => { onChange(id); setOpen(false); }}
              >
                <WidgetIcon name={id} size={19} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

