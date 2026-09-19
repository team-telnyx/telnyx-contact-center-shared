"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";

function diffKeys(before = [], after = []) {
  const b = new Set(before || []);
  const a = new Set(after || []);
  return { added: [...a].filter((k) => !b.has(k)), removed: [...b].filter((k) => !a.has(k)) };
}

function formatDate(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString();
  } catch (_) {
    return String(value);
  }
}

function Entry({ entry }) {
  const permissions = diffKeys(entry.before?.permissions, entry.after?.permissions);
  const roles = diffKeys(entry.before?.roles, entry.after?.roles);
  const scopeChanged = entry.before && entry.after && JSON.stringify(entry.before.scopes || null) !== JSON.stringify(entry.after.scopes || null);
  const renamed = entry.before?.name && entry.after?.name && entry.before.name !== entry.after.name;
  return (
    <li className="grid gap-2 border-b py-2 text-xs last:border-b-0 md:grid-cols-[150px_minmax(0,1fr)]">
      <div className="tabular-nums text-muted-foreground">{formatDate(entry.createdAt)}</div>
      <div className="space-y-1">
        <div>
          <b>{entry.actor?.name || entry.actor?.username || "system"}</b> · <code>{entry.action}</code>
          {entry.targetType === "user" ? <span className="text-muted-foreground"> · user {entry.targetId}</span> : null}
        </div>
        <div className="font-mono text-[11px] leading-relaxed">
          {renamed ? <div>name: {entry.before.name} → {entry.after.name}</div> : null}
          {permissions.added.map((k) => (
            <span key={`+${k}`} className="mr-2 text-green-700 dark:text-green-400">+ {k}</span>
          ))}
          {permissions.removed.map((k) => (
            <span key={`-${k}`} className="mr-2 text-red-700 dark:text-red-400">− {k}</span>
          ))}
          {roles.added.map((k) => (
            <span key={`+r${k}`} className="mr-2 text-green-700 dark:text-green-400">+ role {k}</span>
          ))}
          {roles.removed.map((k) => (
            <span key={`-r${k}`} className="mr-2 text-red-700 dark:text-red-400">− role {k}</span>
          ))}
          {scopeChanged ? <div className="text-muted-foreground">scope changed</div> : null}
          {entry.before?.removedFromUsers ? <div className="text-muted-foreground">removed from {entry.before.removedFromUsers} users</div> : null}
          {!renamed && !permissions.added.length && !permissions.removed.length && !roles.added.length && !roles.removed.length && !scopeChanged && !entry.before?.removedFromUsers ? (
            <div className="text-muted-foreground">{entry.action === "role.create" ? "created" : "no permission change"}</div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export function RoleAudit({ roleKey }) {
  const [state, setState] = useState({ loading: true, entries: [], error: null });

  useEffect(() => {
    if (!roleKey) {
      setState({ loading: false, entries: [], error: null });
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/roles/${encodeURIComponent(roleKey)}/audit?limit=30`, { cache: "no-store" });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Failed to load audit");
        if (!cancelled) setState({ loading: false, entries: data.entries || [], error: null });
      } catch (err) {
        if (!cancelled) setState({ loading: false, entries: [], error: String(err.message || err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roleKey]);

  if (state.loading) return <Skeleton className="h-16 w-full" />;
  if (state.error) return <p className="text-xs text-destructive">{state.error}</p>;
  if (!state.entries.length) return <p className="text-xs text-muted-foreground">Nothing yet. Every save records who changed what, with before and after.</p>;
  return (
    <ul className="list-none p-0">
      {state.entries.map((entry) => (
        <Entry key={entry.id} entry={entry} />
      ))}
    </ul>
  );
}
