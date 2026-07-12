"use client";

import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import Combobox from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";

export default function RetrievalToolEditor({ value, onChange }) {
  const rt = value?.retrieval || {};
  const selectedIds = useMemo(
    () => (Array.isArray(rt.bucket_ids) ? rt.bucket_ids : []),
    [rt]
  );
  const [buckets, setBuckets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [maxResults, setMaxResults] = useState(Number(rt.max_num_results || 3));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch("/api/storage/embeddings/buckets", {
          cache: "no-store",
        });
        const data = await res.json();

        if (cancelled) return;

        if (!res.ok) {
          const errorMsg = data?.error || data?.detail || `Failed to load buckets (${res.status})`;
          console.error("[RetrievalToolEditor] API error:", errorMsg, data);
          setError(errorMsg);
          setBuckets([]);
          setLoading(false);
          return;
        }

        if (data?.ok) {
          // Handle various response structures (prioritize normalized structure):
          // 1. { ok: true, data: { buckets: [...] } } - Normalized (preferred)
          // 2. { ok: true, data: { data: { buckets: [...] } } } - Telnyx wrapped response
          // 3. { ok: true, data: [...] } - Direct array
          let items = [];

          if (Array.isArray(data?.data?.buckets)) {
            // Case 1: Normalized structure (preferred)
            items = data.data.buckets;
          } else if (Array.isArray(data?.data?.data?.buckets)) {
            // Case 2: Telnyx response wrapped: { ok: true, data: { data: { buckets: [...] } } }
            items = data.data.data.buckets;
          } else if (Array.isArray(data?.data)) {
            // Case 3: Direct array: { ok: true, data: [...] }
            items = data.data;
          } else if (data?.data?.data && typeof data.data.data === 'object') {
            // Try to extract buckets from nested structure
            const nested = data.data.data;
            if (Array.isArray(nested.buckets)) {
              items = nested.buckets;
            } else if (Array.isArray(nested)) {
              items = nested;
            }
          }

          const list = items
            .map((b) => {
              const name =
                typeof b === "string"
                  ? b
                  : b?.name || b?.bucket_name || b?.id || "";
              const id = String(name || "").trim();
              return id ? { value: id, label: id } : null;
            })
            .filter(Boolean);

          if (list.length === 0 && items.length === 0) {
            console.warn("[RetrievalToolEditor] No buckets found in response:", data);
          } else {
            console.log(`[RetrievalToolEditor] Loaded ${list.length} buckets`);
          }

          setBuckets(list);
        } else {
          const errorMsg = data?.error || data?.detail || "Failed to load buckets";
          console.error("[RetrievalToolEditor] Response not ok:", errorMsg, data);
          setError(errorMsg);
          setBuckets([]);
        }
      } catch (err) {
        if (!cancelled) {
          console.error("[RetrievalToolEditor] Fetch error:", err);
          setError(err.message || "Failed to load buckets");
          setBuckets([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function update(nextIds, nextMax) {
    onChange?.({
      ...(value || { type: "retrieval" }),
      retrieval: { bucket_ids: nextIds, max_num_results: Number(nextMax || 0) },
    });
  }

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  return (
    <div className="space-y-3 mt-2">
      <div>
        <label className="text-xs">Selected Buckets</label>
        <div className="space-y-2 p-2 ">
          <div className="flex flex-wrap gap-2">
            {Array.from(selectedSet).map((id) => (
              <span
                key={id}
                className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs border-telnyx-green"
              >
                <span className="truncate max-w-[200px]">{id}</span>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    const next = new Set(selectedSet);
                    next.delete(id);
                    update(Array.from(next), maxResults);
                  }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className="space-y-1">
            {error && <div className="text-xs text-red-500 mb-2">{error}</div>}
            {!loading && !error && buckets.length === 0 && (
              <div className="text-xs text-muted-foreground mb-2">
                No embedding buckets available. Create buckets in Telnyx Storage
                to use with retrieval.
              </div>
            )}
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <label className="text-xs mb-1.5 block">Buckets</label>
                <Combobox
                  value=""
                  disabled={loading || buckets.length === 0}
                  onChange={(val) => {
                    const next = new Set(selectedSet);
                    next.add(val);
                    update(Array.from(next), maxResults);
                  }}
                  options={buckets}
                  placeholder={
                    loading
                      ? "Loading buckets..."
                      : buckets.length === 0
                      ? "No buckets available"
                      : "Search buckets…"
                  }
                  emptyLabel="No buckets found"
                  triggerClassName="w-full"
                  contentClassName="w-[400px]"
                  searchable={true}
                />
              </div>
              <div className="w-[220px]">
                <label className="text-xs mb-1.5 block">Max Number of Results</label>
                <Input
                  type="number"
                  min={0}
                  className="w-full"
                  value={maxResults}
                  onChange={(e) => {
                    const v = Number(e.target.value || 0);
                    setMaxResults(v);
                    update(Array.from(selectedSet), v);
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
