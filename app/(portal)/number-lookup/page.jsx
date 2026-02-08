"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import CodeBlock from "@/components/ui/code-block";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { toast } from "sonner";
import { IconSearch } from "@tabler/icons-react";

export default function NumberLookupView() {
  const [phone, setPhone] = useState("");
  const [types, setTypes] = useState(["carrier", "caller_name"]);
  const [looking, setLooking] = useState(false);
  const [result, setResult] = useState(null);
  const [openPayload, setOpenPayload] = useState(false);

  const sections = useMemo(
    () => [
      { key: "carrier", label: "Carrier" },
      { key: "caller_name", label: "Caller Name" },
    ],
    []
  );

  async function onLookup() {
    setLooking(true);
    setResult(null);
    try {
      const res = await fetch(
        `/api/number-lookup/${encodeURIComponent(phone)}?${new URLSearchParams({
          types: (types || []).join(","),
        })}`,
        { cache: "no-store" }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) throw new Error(data?.error || "Lookup failed");
      setResult(data);
      toast.success("Lookup complete");
    } catch (err) {
      toast.error("Lookup failed", {
        description: String(err?.message || err),
      });
    } finally {
      setLooking(false);
    }
  }

  function flattenEntries(obj, prefix = "") {
    const entries = [];
    const isPrimitive = (v) =>
      v === null ||
      v === undefined ||
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean";
    try {
      if (isPrimitive(obj)) {
        const val = obj;
        if (val === null || val === undefined) return entries;
        const s = String(val).trim();
        if (s === "") return entries;
        entries.push({ key: prefix || "value", value: s });
        return entries;
      }
      if (Array.isArray(obj)) {
        obj.forEach((item, idx) => {
          entries.push(...flattenEntries(item, `${prefix}[${idx}]`));
        });
        return entries;
      }
      if (typeof obj === "object") {
        Object.keys(obj).forEach((k) => {
          const child = obj[k];
          const newPrefix = prefix ? `${prefix}.${k}` : k;
          if (isPrimitive(child)) {
            if (child === null || child === undefined) return;
            const s = String(child).trim();
            if (s === "") return;
            entries.push({ key: newPrefix, value: s });
          } else {
            entries.push(...flattenEntries(child, newPrefix));
          }
        });
        return entries;
      }
    } catch (_) {}
    return entries;
  }

  return (
    <div className="px-4 lg:px-6">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <IconSearch className="size-6 text-primary" /> Number Lookup
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Phone (E.164)</label>
            <Input
              placeholder="+14155550123"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Lookup Types</label>
            <div className="flex gap-6">
              {sections.map((s) => (
                <div key={s.key} className="flex items-center space-x-2">
                  <Checkbox
                    id={s.key}
                    checked={types.includes(s.key)}
                    onCheckedChange={(checked) => {
                      if (checked) {
                        setTypes([...types, s.key]);
                      } else {
                        setTypes(types.filter((t) => t !== s.key));
                      }
                    }}
                  />
                  <Label htmlFor={s.key} className="cursor-pointer">
                    {s.label}
                  </Label>
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-3">
            <Button
              disabled={looking || !phone}
              onClick={onLookup}
            >
              {looking ? "Looking up…" : "Lookup"}
            </Button>
            <Button
              variant="outline"
              disabled={!result}
              onClick={() => setOpenPayload(true)}
            >
              View JSON
            </Button>
          </div>
        </CardContent>
        <CardFooter className="flex flex-col items-start gap-4">
          {(() => {
            const d = result?.data || result || null;
            if (!d) return null;
            const items = flattenEntries(d);
            if (items.length === 0) return null;
            return (
              <div className="w-full">
                <div className="text-sm font-medium mb-2">Results</div>
                <div className="flex flex-wrap gap-2">
                  {items.map((it) => (
                    <Badge key={`${it.key}:${it.value}`} variant="secondary">
                      {it.key}: {it.value}
                    </Badge>
                  ))}
                </div>
              </div>
            );
          })()}
        </CardFooter>
        <Sheet
          open={!!openPayload}
          onOpenChange={(o) => !o && setOpenPayload(false)}
        >
          <SheetContent side="right" className="sm:max-w-xl">
            <SheetHeader>
              <SheetTitle>Lookup Response</SheetTitle>
            </SheetHeader>
            <div className="p-4">
              <CodeBlock
                wrap={true}
                language="json"
                data={result ?? { hint: "Run a lookup to see results here." }}
                height="80vh"
              />
            </div>
          </SheetContent>
        </Sheet>
      </Card>
    </div>
  );
}
