"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { IconArrowLeft, IconCopy, IconLock } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ToastNotify";
import { AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";
import { ConfigurationSectionPage } from "@/components/admin/ConfigurationSectionNav";
import { expandGrants, compactScreenGrants, getResource, SCREEN_TREE, screenLeavesUnder, emptyScopes, isKnownPermission } from "@/lib/authz/permissions.mjs";
import { RoleTypeBadge, EditedBadge } from "./role-badges";
import { ScreenTree } from "./ScreenTree";
import { OperationsMatrix } from "./OperationsMatrix";
import { ScopeEditor } from "./ScopeEditor";
import { RoleAudit } from "./RoleAudit";
import { useCatalogue, useScopeOptions } from "./use-catalogue";

const WORKSPACE_TONE = { agent: "bg-emerald-500", supervisor: "bg-violet-500", admin: "bg-blue-500" };

/** Stored keys → editor state (leaf screen ids and operation keys). */
function stateFromRole(role) {
  const { screens, operations } = expandGrants(role?.permissions || []);
  return { screens, operations };
}

/** Editor state → stored keys: whole groups become `screen:<group>.*`, whole resources `<resource>:*`. */
function keysFromState(screens, operations) {
  const keys = compactScreenGrants([...screens]);
  const byResource = new Map();
  for (const op of operations) {
    const [resource] = op.split(":");
    if (!byResource.has(resource)) byResource.set(resource, []);
    byResource.get(resource).push(op);
  }
  for (const [resource, ops] of byResource) {
    const item = getResource(resource);
    const total = item ? item.crud.length + item.named.length : Infinity;
    if (ops.length === total) keys.push(`${resource}:*`);
    else keys.push(...ops);
  }
  return keys;
}

function visibleMenu(screens) {
  return SCREEN_TREE.map((workspace) => ({
    workspace,
    items: workspace.kids
      .map((item) => {
        const leaves = screenLeavesUnder(item.id);
        const on = leaves.filter((leaf) => screens.has(leaf)).length;
        return { item, on, total: leaves.length };
      })
      .filter((entry) => entry.on > 0),
  })).filter((group) => group.items.length);
}

function scopeChips(scopes, wildcard, anchors) {
  if (wildcard) return [{ id: "all", text: "everything", own: false }];
  const chips = anchors
    .map((anchor) => {
      const value = scopes?.[anchor.id] || { mode: "all" };
      if (value.mode === "all") return null;
      if (value.mode === "own") return { id: anchor.id, text: `${anchor.label}: own`, own: true };
      return { id: anchor.id, text: `${anchor.label}: ${(value.ids || []).join(", ") || "—"}`, own: false };
    })
    .filter(Boolean);
  return chips.length ? chips : [{ id: "all", text: "all objects", own: false }];
}

export function RoleEditor({ roleKey }) {
  const router = useRouter();
  const isNew = roleKey === "new";
  const { loading: catalogueLoading, error: catalogueError, catalogue, actorAccess } = useCatalogue();
  const { options: scopeOptions } = useScopeOptions(true);

  const [role, setRole] = useState(null);
  const [loading, setLoading] = useState(!isNew);
  const [loadError, setLoadError] = useState(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [screens, setScreens] = useState(() => new Set());
  const [operations, setOperations] = useState(() => new Set());
  const [scopes, setScopes] = useState(() => emptyScopes());
  const [dirty, setDirty] = useState(isNew);
  const [saving, setSaving] = useState(false);
  const [serverErrors, setServerErrors] = useState([]);
  const [tab, setTab] = useState("screens");

  useEffect(() => {
    if (isNew) return undefined;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/admin/roles/${encodeURIComponent(roleKey)}`, { cache: "no-store" });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Failed to load role");
        if (cancelled) return;
        const loaded = data.role;
        const derived = stateFromRole(loaded);
        setRole(loaded);
        setName(loaded.name || "");
        setDescription(loaded.description || "");
        setScreens(derived.screens);
        setOperations(derived.operations);
        setScopes({ ...emptyScopes(), ...(loaded.scopes || {}) });
        setDirty(false);
        setLoadError(null);
      } catch (err) {
        if (!cancelled) setLoadError(String(err.message || err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roleKey, isNew]);

  const readOnly = Boolean(role?.isSystem);
  const anchors = useMemo(() => catalogue?.anchors || [], [catalogue]);

  const checks = useMemo(() => {
    const issues = [];
    if (!name.trim()) issues.push({ level: "block", text: "Give the role a name." });
    if (!screens.size && !operations.size) issues.push({ level: "block", text: "Grant at least one screen or operation." });
    for (const anchor of anchors) {
      const value = scopes[anchor.id];
      if (value?.mode === "list" && !(value.ids || []).length) issues.push({ level: "block", text: `${anchor.label}: the selection is empty.` });
    }
    if (actorAccess && !actorAccess.wildcard) {
      const outsideScreens = [...screens].filter((id) => !actorAccess.screens.has(id)).length;
      const outsideOps = [...operations].filter((key) => !actorAccess.operations.has(key)).length;
      if (outsideScreens + outsideOps) issues.push({ level: "block", text: `${outsideScreens + outsideOps} grants are outside your own access. Saving is refused (delegation rule).` });
    }
    const usesQueues = [...operations].some((op) => getResource(op.split(":")[0])?.anchor === "queues");
    if (operations.size && !usesQueues && scopes.queues?.mode !== "all") issues.push({ level: "warn", text: "Queue scope is set but no granted operation is limited by queues." });
    if (screens.has("admin.configuration.users") && ![...operations].some((op) => op.startsWith("users:"))) issues.push({ level: "warn", text: "Users screen granted without any users:* operation — the page will open but every list stays empty." });
    if (screens.has("admin.configuration.permissions") && ![...operations].some((op) => op.startsWith("roles:"))) issues.push({ level: "warn", text: "Permissions screen granted without roles:read — the role list will stay empty." });
    return issues;
  }, [name, screens, operations, scopes, anchors, actorAccess]);

  const blocked = checks.some((issue) => issue.level === "block");
  const canSave = dirty && !blocked && !readOnly && !saving;
  const menu = useMemo(() => visibleMenu(screens), [screens]);
  const chips = useMemo(() => scopeChips(scopes, false, anchors), [scopes, anchors]);

  function touch() {
    setDirty(true);
    setServerErrors([]);
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setServerErrors([]);
    // Keys this version of the editor does not know stay on the role (mixed deployment or rollback).
    const unknownKeys = (role?.permissions || []).filter((key) => !isKnownPermission(key));
    const payload = { name: name.trim(), description: description.trim(), permissions: [...keysFromState(screens, operations), ...unknownKeys], scopes };
    try {
      const res = await fetch(isNew ? "/api/admin/roles" : `/api/admin/roles/${encodeURIComponent(role.key)}`, {
        method: isNew ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setServerErrors(Array.isArray(data?.details) ? data.details : [data?.error || "Save failed"]);
        notify({ title: "Save failed", description: data?.error || "The role was not saved.", variant: "error" });
        return;
      }
      notify({
        title: isNew ? "Role created" : "Role saved",
        description: isNew ? `${data.role.name} is ready to assign.` : `${data.role.name} updated. ${data.role.usersCount} user${data.role.usersCount === 1 ? "" : "s"} receive the change within seconds.`,
        variant: "success",
      });
      if (isNew) {
        router.replace(`/admin/permissions/${encodeURIComponent(data.role.key)}`);
        return;
      }
      setRole(data.role);
      setDirty(false);
    } catch (err) {
      notify({ title: "Save failed", description: String(err.message || err), variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function clone() {
    if (!role) return;
    try {
      const res = await fetch(`/api/admin/roles/${encodeURIComponent(role.key)}/clone`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Clone failed");
      notify({ title: "Role cloned", description: `${data.role.name} is an editable copy.`, variant: "success" });
      router.push(`/admin/permissions/${encodeURIComponent(data.role.key)}`);
    } catch (err) {
      notify({ title: "Clone failed", description: String(err.message || err), variant: "error" });
    }
  }

  function discard() {
    if (isNew) {
      router.push("/admin/permissions");
      return;
    }
    const derived = stateFromRole(role);
    setName(role.name || "");
    setDescription(role.description || "");
    setScreens(derived.screens);
    setOperations(derived.operations);
    setScopes({ ...emptyScopes(), ...(role.scopes || {}) });
    setDirty(false);
    setServerErrors([]);
  }

  const headerActions = (
    <>
      {role && !isNew ? (
        <Button variant="outline" size="sm" onClick={clone}>
          <IconCopy className="size-4" /> Clone
        </Button>
      ) : null}
      <Button size="sm" onClick={save} disabled={!canSave}>
        {saving ? "Saving…" : "Save"}
      </Button>
    </>
  );

  const title = (
    <span className="flex flex-wrap items-center gap-2">
      <Button variant="ghost" size="sm" className="-ml-2 gap-1" onClick={() => router.push("/admin/permissions")}>
        <IconArrowLeft className="size-4" /> Permissions
      </Button>
      <span>{isNew ? "New role" : name || role?.name || roleKey}</span>
    </span>
  );

  const badges = (
    <span className="flex flex-wrap items-center gap-2">
      <RoleTypeBadge origin={isNew ? "custom" : role?.origin} />
      {role?.edited ? <EditedBadge /> : null}
      {dirty && !readOnly ? (
        <Badge variant="outline" className="border-orange-500 text-orange-700 dark:text-orange-300">
          Unsaved
        </Badge>
      ) : null}
      {role?.key ? <code className="text-xs text-muted-foreground">{role.key}</code> : null}
    </span>
  );

  return (
    <AdminPageShell>
      <AdminPageHeader title={title} badges={badges} actions={headerActions} />
      <ConfigurationSectionPage activeId="permissions">
        {loading || catalogueLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-1/2" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : loadError || catalogueError ? (
          <Card>
            <CardContent className="p-6 text-sm text-destructive">{loadError || catalogueError}</CardContent>
          </Card>
        ) : (
          <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
            <Card className="min-w-0">
              <CardContent className="space-y-4 p-4">
                {readOnly ? (
                  <div className="flex items-start gap-2 rounded-md bg-blue-50 p-3 text-sm text-blue-900 dark:bg-blue-900/30 dark:text-blue-200">
                    <IconLock className="mt-0.5 size-4 shrink-0" />
                    <span>
                      <b>System role.</b> Its permissions are defined by the product and cannot be edited. Use <b>Clone</b> to create an editable copy.
                    </span>
                  </div>
                ) : null}
                {actorAccess && !actorAccess.wildcard ? (
                  <div className="flex items-start gap-2 rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
                    <IconLock className="mt-0.5 size-4 shrink-0" />
                    <span>You can grant only the permissions and scopes you hold yourself. Locked rows are outside your own access.</span>
                  </div>
                ) : null}
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="grid gap-1.5">
                    <label htmlFor="role-name" className="text-xs font-medium text-muted-foreground">
                      Name
                    </label>
                    <Input id="role-name" value={name} disabled={readOnly} placeholder="e.g. QA Reviewer · Sales" onChange={(event) => { setName(event.target.value); touch(); }} />
                  </div>
                  <div className="grid gap-1.5">
                    <label htmlFor="role-description" className="text-xs font-medium text-muted-foreground">
                      Description shown in the user sheet
                    </label>
                    <Input id="role-description" value={description} disabled={readOnly} placeholder="What this position does" onChange={(event) => { setDescription(event.target.value); touch(); }} />
                  </div>
                </div>
                <Tabs value={tab} onValueChange={setTab}>
                  <TabsList>
                    <TabsTrigger value="screens">
                      Screens <span className="ml-1 tabular-nums text-muted-foreground">{screens.size}</span>
                    </TabsTrigger>
                    <TabsTrigger value="operations">
                      Operations <span className="ml-1 tabular-nums text-muted-foreground">{operations.size}</span>
                    </TabsTrigger>
                    <TabsTrigger value="scope">Scope</TabsTrigger>
                    {!isNew ? <TabsTrigger value="audit">Audit</TabsTrigger> : null}
                  </TabsList>
                  <TabsContent value="screens" className="pt-3">
                    <ScreenTree tree={catalogue.screens} selected={screens} readOnly={readOnly} actorAccess={actorAccess} onChange={(next) => { setScreens(next); touch(); }} />
                  </TabsContent>
                  <TabsContent value="operations" className="pt-3">
                    <p className="mb-2 text-xs text-muted-foreground">Read / create / update / delete on each managed object, plus named operations. The Scope column names the anchor that limits the grant.</p>
                    <OperationsMatrix areas={catalogue.areas} selected={operations} readOnly={readOnly} actorAccess={actorAccess} onChange={(next) => { setOperations(next); touch(); }} />
                  </TabsContent>
                  <TabsContent value="scope" className="pt-3">
                    <ScopeEditor anchors={anchors} scopes={scopes} options={scopeOptions} readOnly={readOnly} onChange={(next) => { setScopes(next); touch(); }} />
                  </TabsContent>
                  {!isNew ? (
                    <TabsContent value="audit" className="pt-3">
                      <RoleAudit roleKey={role?.key} />
                    </TabsContent>
                  ) : null}
                </Tabs>
                <div className="sticky bottom-0 -mx-4 -mb-4 flex items-center gap-2 border-t bg-card px-4 py-3">
                  <span className="text-xs text-muted-foreground">
                    {readOnly ? "Read-only system role" : dirty ? `Unsaved changes · ${screens.size} screens · ${operations.size} operations` : "No changes"}
                  </span>
                  <span className="flex-1" />
                  <Button variant="outline" size="sm" onClick={discard} disabled={readOnly || (!dirty && !isNew)}>
                    Discard
                  </Button>
                  <Button size="sm" onClick={save} disabled={!canSave}>
                    {saving ? "Saving…" : "Save role"}
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card className="xl:sticky xl:top-3">
              <CardContent className="space-y-3 p-4 text-sm">
                <div className="flex items-baseline justify-between">
                  <span>Screens granted</span>
                  <b className="text-xl tabular-nums">{screens.size}</b>
                </div>
                <div className="flex items-baseline justify-between">
                  <span>Operations granted</span>
                  <b className="text-xl tabular-nums">{operations.size}</b>
                </div>
                <div className="flex items-baseline justify-between">
                  <span>Users with this role</span>
                  <b className="text-xl tabular-nums">{role?.usersCount ?? 0}</b>
                </div>
                <div className="border-t" />
                <div className="text-xs font-medium text-muted-foreground">Menu the user will see</div>
                <div className="rounded-md border bg-muted/40 p-2">
                  {!menu.length ? <div className="px-2 py-1 text-xs text-muted-foreground">No screens yet — the user could sign in but would see only their profile.</div> : null}
                  {menu.map((group) => (
                    <div key={group.workspace.id} className="mb-1">
                      <div className="flex items-center gap-1.5 px-2 pb-0.5 pt-1 text-[10px] uppercase tracking-widest text-muted-foreground">
                        <span className={`size-2 rounded-full ${WORKSPACE_TONE[group.workspace.id] || "bg-foreground"}`} />
                        {group.workspace.label}
                      </div>
                      {group.items.map((entry) => (
                        <div key={entry.item.id} className="my-0.5 flex justify-between rounded bg-card px-2 py-1 text-xs">
                          <span>{entry.item.label}</span>
                          <span className="tabular-nums text-muted-foreground">{entry.total > 1 ? `${entry.on}/${entry.total}` : ""}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
                <div className="text-xs font-medium text-muted-foreground">Scope</div>
                <div className="flex flex-wrap gap-1">
                  {chips.map((chip) => (
                    <span key={chip.id} className={`rounded-full border px-2 py-0.5 text-xs ${chip.own ? "border-telnyx-green" : "bg-muted"}`}>
                      {chip.text}
                    </span>
                  ))}
                </div>
                <div className="border-t" />
                <div className="text-xs font-medium text-muted-foreground">Checks before save</div>
                <div className="space-y-1.5">
                  {serverErrors.map((error) => (
                    <div key={error} className="rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-800 dark:bg-red-900/30 dark:text-red-200">
                      ⛔ {error}
                    </div>
                  ))}
                  {checks.map((issue) => (
                    <div
                      key={issue.text}
                      className={
                        issue.level === "block"
                          ? "rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-800 dark:bg-red-900/30 dark:text-red-200"
                          : "rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:bg-amber-900/30 dark:text-amber-200"
                      }
                    >
                      {issue.level === "block" ? "⛔" : "⚠︎"} {issue.text}
                    </div>
                  ))}
                  {!checks.length && !serverErrors.length ? (
                    <div className="rounded-md bg-green-50 px-2 py-1.5 text-xs text-green-800 dark:bg-green-900/30 dark:text-green-200">✓ Ready to save. Users with this role get the change within seconds.</div>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </ConfigurationSectionPage>
    </AdminPageShell>
  );
}
