"use client";

import { useEffect, useMemo, useState } from "react";
import { SCOPE_ANCHORS } from "@/lib/authz/permissions.mjs";

/**
 * Loads the permission catalogue and the caller's own access from
 * /api/admin/permissions. The editor uses the actor's access to lock grants
 * outside it (delegation rule).
 */
export function useCatalogue() {
  const [state, setState] = useState({ loading: true, error: null, catalogue: null, actor: null, mode: "legacy" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/permissions", { cache: "no-store" });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Failed to load the permission catalogue");
        if (!cancelled) setState({ loading: false, error: null, catalogue: data.catalogue, actor: data.actor, mode: data.mode || "enforce" });
      } catch (err) {
        if (!cancelled) setState({ loading: false, error: String(err.message || err), catalogue: null, actor: null, mode: "legacy" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const actorAccess = useMemo(() => {
    const actor = state.actor;
    if (!actor) return null;
    return {
      wildcard: Boolean(actor.wildcard),
      screens: new Set(actor.screens || []),
      operations: new Set(actor.operations || []),
      scopes: actor.scopes || null,
    };
  }, [state.actor]);

  return { ...state, actorAccess };
}

/** Options for the scope pickers: queues and campaigns from their APIs, channels from the catalogue. */
export function useScopeOptions(enabled = true) {
  const [options, setOptions] = useState({ queues: [], teams: [], campaigns: [], channels: SCOPE_ANCHORS.find((a) => a.id === "channels")?.options?.map((id) => ({ id, label: id })) || [] });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const next = { ...options };
      try {
        const res = await fetch("/api/admin/queues?pageSize=1000", { cache: "no-store" });
        const data = await res.json();
        if (res.ok) next.queues = (data.items || data.queues || data.rows || []).map((q) => ({ id: q.id, label: q.display_name || q.name || q.id }));
      } catch (_) {
        // queue list is optional for the editor
      }
      try {
        const teamsRes = await fetch("/api/admin/teams?pageSize=1000", { cache: "no-store" });
        const teamsData = await teamsRes.json().catch(() => ({}));
        if (teamsRes.ok) next.teams = (teamsData.items || []).map((t) => ({ id: t.id, label: t.name || t.id }));
      } catch {
        // teams stay empty
      }
      try {
        const res = await fetch("/api/contact-center/outbound-dialer/campaigns", { cache: "no-store" });
        const data = await res.json();
        if (res.ok) next.campaigns = (data.campaigns || data.items || []).map((c) => ({ id: c.id, label: c.name || c.id }));
      } catch (_) {
        // campaign list is optional for the editor
      }
      if (!cancelled) {
        setOptions(next);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return { options, loading };
}
