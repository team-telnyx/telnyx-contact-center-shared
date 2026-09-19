"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { IconPlus } from "@tabler/icons-react";
import { AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";
import { ConfigurationSectionPage } from "@/components/admin/ConfigurationSectionNav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ToastNotify";
import { useAuth } from "@/components/auth-provider";
import { RolesTable } from "@/components/permissions/RolesTable";
import { SCOPE_ANCHORS } from "@/lib/authz/permissions.mjs";
import { cn } from "@/lib/utils";

const TYPE_FILTERS = [
  { value: "all", label: "All" },
  { value: "system", label: "System" },
  { value: "preset", label: "Shipped" },
  { value: "custom", label: "Custom" },
];
const SCOPE_FILTERS = [
  { value: "any", label: "Any" },
  { value: "all-objects", label: "All objects" },
  { value: "narrowed", label: "Narrowed" },
];

function Segmented({ value, options, onChange, ariaLabel }) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn("border-r px-3 py-1.5 text-xs font-medium last:border-r-0", value === option.value ? "bg-foreground text-background" : "bg-background text-muted-foreground hover:bg-muted")}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function isNarrowed(role) {
  if (role.permissions?.includes("*")) return false;
  return SCOPE_ANCHORS.some((anchor) => (role.scopes?.[anchor.id]?.mode || "all") !== "all");
}

export default function PermissionsPage() {
  const { can, wildcard } = useAuth();
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [scope, setScope] = useState("any");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/roles", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to load roles");
      setRoles(data.roles || []);
    } catch (err) {
      notify({ title: "Load failed", description: String(err.message || err), variant: "error" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return roles.filter((role) => {
      if (type !== "all" && role.origin !== type) return false;
      if (scope === "narrowed" && !isNarrowed(role)) return false;
      if (scope === "all-objects" && isNarrowed(role)) return false;
      if (needle && !`${role.name} ${role.key} ${role.description || ""}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [roles, query, type, scope]);

  // roles:manage (or users:* as held by the system administrator) unlocks role management.
  const canManage = wildcard || can(["roles:manage", "users:*"]) || can("roles:manage");

  const headerActions = (
    <>
      {canManage ? (
        <Button asChild size="sm" className="gap-2">
          <Link href="/admin/permissions/new">
            <IconPlus className="size-4" /> Create role
          </Link>
        </Button>
      ) : null}
      <Button variant="secondary" onClick={() => { setQuery(""); setType("all"); setScope("any"); }}>
        Clear
      </Button>
      <Button onClick={load} disabled={loading}>
        {loading ? "Loading…" : "Refresh"}
      </Button>
    </>
  );

  return (
    <AdminPageShell>
      <AdminPageHeader title="Permissions" badges={<Badge variant="secondary">{roles.length} roles</Badge>} actions={headerActions} />
      <ConfigurationSectionPage activeId="permissions">
        <div className="space-y-4">
          <Card className="w-full">
            <CardContent className="space-y-4 pt-6">
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-56 flex-1">
                  <label htmlFor="roles-search" className="text-xs">
                    Name or key
                  </label>
                  <Input id="roles-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search roles" className="w-full" />
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs">Type</span>
                  <Segmented value={type} options={TYPE_FILTERS} onChange={setType} ariaLabel="Role type" />
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs">Scope</span>
                  <Segmented value={scope} options={SCOPE_FILTERS} onChange={setScope} ariaLabel="Scope" />
                </div>
              </div>

              {loading ? (
                <div className="space-y-2 rounded-md border p-4">
                  <Skeleton className="h-6 w-40" />
                  <Skeleton className="h-6 w-full" />
                  <Skeleton className="h-6 w-full" />
                </div>
              ) : (
                <RolesTable roles={visible} onChanged={load} canManage={canManage} />
              )}

              <p className="text-xs text-muted-foreground">
                System roles are read-only and always mean the same thing. Shipped roles are editable starting points for common positions; an <b>edited</b> marker shows that a shipped role differs from its defaults and can be restored. Deleting a role that is still assigned asks whether to remove it from those users. Roles add up: a person with several roles holds the union of their permissions.
              </p>
            </CardContent>
          </Card>
        </div>
      </ConfigurationSectionPage>
    </AdminPageShell>
  );
}
