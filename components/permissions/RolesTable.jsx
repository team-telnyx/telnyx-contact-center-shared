"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { IconCopy, IconEdit, IconEye, IconRestore, IconTrash } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { notify } from "@/components/ToastNotify";
import { SCOPE_ANCHORS } from "@/lib/authz/permissions.mjs";
import { RoleTypeBadge, EditedBadge } from "./role-badges";

function scopeChips(role) {
  if (role.permissions?.includes("*")) return ["everything"];
  const chips = SCOPE_ANCHORS.map((anchor) => {
    const value = role.scopes?.[anchor.id] || { mode: "all" };
    if (value.mode === "all") return null;
    if (value.mode === "own") return { text: `${anchor.label}: own`, own: true };
    return { text: `${anchor.label}: ${(value.ids || []).join(", ") || "—"}`, own: false };
  }).filter(Boolean);
  return chips.length ? chips : [{ text: "all objects", own: false }];
}

function formatUpdated(role) {
  if (role.origin === "system") return "product";
  if (!role.updatedAt) return role.origin === "preset" ? "shipped" : "";
  try {
    const date = new Date(role.updatedAt);
    const stamp = date.toLocaleDateString();
    return role.origin === "preset" && !role.edited ? "shipped" : stamp;
  } catch (_) {
    return "";
  }
}

export function RolesTable({ roles = [], onChanged, canManage = true }) {
  const router = useRouter();
  const [pendingDelete, setPendingDelete] = useState(null);
  const [busy, setBusy] = useState(null);
  const maxUsers = Math.max(1, ...roles.map((role) => role.usersCount || 0));

  async function clone(role) {
    setBusy(role.key);
    try {
      const res = await fetch(`/api/admin/roles/${encodeURIComponent(role.key)}/clone`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Clone failed");
      notify({ title: "Role cloned", description: `${data.role.name} is an editable copy.`, variant: "success" });
      router.push(`/admin/permissions/${encodeURIComponent(data.role.key)}`);
    } catch (err) {
      notify({ title: "Clone failed", description: String(err.message || err), variant: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function restore(role) {
    setBusy(role.key);
    try {
      const res = await fetch(`/api/admin/roles/${encodeURIComponent(role.key)}/restore`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Restore failed");
      notify({ title: "Shipped defaults restored", description: `${data.role.name} matches the product definition again. Applied to ${data.role.usersCount} users within seconds.`, variant: "success" });
      onChanged?.();
    } catch (err) {
      notify({ title: "Restore failed", description: String(err.message || err), variant: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function remove(role) {
    setBusy(role.key);
    try {
      const url = `/api/admin/roles/${encodeURIComponent(role.key)}${role.usersCount ? "?removeFromUsers=true" : ""}`;
      const res = await fetch(url, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Delete failed");
      notify({
        title: "Role deleted",
        description: data.removedFromUsers ? `Removed from ${data.removedFromUsers} users. Their menus update within seconds.` : `${role.name} was not assigned to anyone.`,
        variant: "success",
      });
      onChanged?.();
    } catch (err) {
      notify({ title: "Delete failed", description: String(err.message || err), variant: "error" });
    } finally {
      setBusy(null);
      setPendingDelete(null);
    }
  }

  return (
    <>
      <div className="overflow-x-auto rounded-md border">
        <Table className="table-fixed">
          <colgroup>
            <col style={{ width: "24%" }} />
            <col style={{ width: "9%" }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "19%" }} />
            <col style={{ width: "10%" }} />
            <col style={{ width: "10%" }} />
            <col style={{ width: "14%" }} />
          </colgroup>
          <TableHeader>
            <TableRow>
              <TableHead className="px-[10px]">Role</TableHead>
              <TableHead className="px-[10px]">Type</TableHead>
              <TableHead className="px-[10px]">Grants</TableHead>
              <TableHead className="px-[10px]">Scope</TableHead>
              <TableHead className="px-[10px]">Users</TableHead>
              <TableHead className="px-[10px]">Updated</TableHead>
              <TableHead className="px-[10px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {roles.map((role) => (
              <TableRow key={role.key}>
                <TableCell className="px-[10px] align-top text-xs">
                  <div className="flex flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-1.5 font-medium">
                      <Link href={`/admin/permissions/${encodeURIComponent(role.key)}`} className="hover:underline">
                        {role.name}
                      </Link>
                      {role.edited ? <EditedBadge /> : null}
                    </span>
                    <code className="text-[11px] text-muted-foreground">{role.key}</code>
                    {role.description ? <span className="truncate text-[11px] text-muted-foreground" title={role.description}>{role.description}</span> : null}
                  </div>
                </TableCell>
                <TableCell className="px-[10px] align-top text-xs">
                  <RoleTypeBadge origin={role.origin} />
                </TableCell>
                <TableCell className="px-[10px] align-top text-xs tabular-nums">
                  {role.summary?.wildcard ? "every screen · every operation" : `${role.summary?.screens ?? 0} screens · ${role.summary?.operations ?? 0} ops`}
                </TableCell>
                <TableCell className="px-[10px] align-top text-xs">
                  <div className="flex flex-wrap gap-1">
                    {scopeChips(role).map((chip) => (
                      <span key={typeof chip === "string" ? chip : chip.text} className={`rounded-full border px-2 py-0.5 text-[11px] ${chip.own ? "border-telnyx-green" : "bg-muted"}`}>
                        {typeof chip === "string" ? chip : chip.text}
                      </span>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="px-[10px] align-top text-xs">
                  <span className="inline-flex items-center gap-2 tabular-nums">
                    <span className="h-1.5 w-14 overflow-hidden rounded-full bg-muted">
                      <span className="block h-full bg-telnyx-green" style={{ width: `${Math.round((100 * (role.usersCount || 0)) / maxUsers)}%` }} />
                    </span>
                    {role.usersCount || 0}
                  </span>
                </TableCell>
                <TableCell className="px-[10px] align-top text-xs text-muted-foreground">{formatUpdated(role)}</TableCell>
                <TableCell className="px-[10px] align-top text-right text-xs">
                  <div className="flex flex-wrap justify-end gap-1">
                    <Button asChild variant="outline" size="sm" className="h-7 px-2 text-xs" title={role.isSystem ? "View role" : "Edit role"}>
                      <Link href={`/admin/permissions/${encodeURIComponent(role.key)}`}>
                        {role.isSystem ? <IconEye className="size-3.5" /> : <IconEdit className="size-3.5" />}
                        {role.isSystem ? "View" : "Edit"}
                      </Link>
                    </Button>
                    {canManage ? (
                      <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={busy === role.key} onClick={() => clone(role)} title="Create an editable copy">
                        <IconCopy className="size-3.5" /> Clone
                      </Button>
                    ) : null}
                    {canManage && role.origin === "preset" && role.edited ? (
                      <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={busy === role.key} onClick={() => restore(role)} title="Restore the shipped permission set">
                        <IconRestore className="size-3.5" /> Restore
                      </Button>
                    ) : null}
                    {canManage ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs text-destructive"
                        disabled={role.isSystem || busy === role.key}
                        title={role.isSystem ? "System roles cannot be deleted" : "Delete role"}
                        onClick={() => setPendingDelete(role)}
                      >
                        <IconTrash className="size-3.5" /> Delete
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {!roles.length ? (
              <TableRow>
                <TableCell colSpan={7} className="px-[10px] py-6 text-center text-xs text-muted-foreground">
                  No roles match the current filters.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>

      <AlertDialog open={Boolean(pendingDelete)} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.usersCount
                ? `${pendingDelete.name} is assigned to ${pendingDelete.usersCount} user${pendingDelete.usersCount === 1 ? "" : "s"}. It will be removed from them and their menus update within seconds.`
                : `${pendingDelete?.name} is not assigned to anyone.`}
              {pendingDelete?.origin === "preset" ? " A deleted shipped role does not come back on the next upgrade." : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => pendingDelete && remove(pendingDelete)}>
              {pendingDelete?.usersCount ? `Remove from ${pendingDelete.usersCount} and delete` : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
