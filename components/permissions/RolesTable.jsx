"use client";
import { useUiText } from "@/components/i18n/use-ui-text";


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
import { roleDisplayText } from "@/lib/i18n/role-labels.mjs";
import { RoleTypeBadge, EditedBadge } from "./role-badges";

function scopeChips(role, tUi) {
  if (role.permissions?.includes("*")) return [tUi("everything")];
  const chips = SCOPE_ANCHORS.map((anchor) => {
    const value = role.scopes?.[anchor.id] || { mode: "all" };
    if (value.mode === "all") return null;
    if (value.mode === "own") return { text: tUi("{value0}: own", { value0: tUi(anchor.label) }), own: true };
    return { text: `${tUi(anchor.label)}: ${(value.ids || []).join(", ") || "—"}`, own: false };
  }).filter(Boolean);
  return chips.length ? chips : [{ text: tUi("all objects"), own: false }];
}

function formatUpdated(role, tUi) {
  if (role.origin === "system") return tUi("product");
  if (!role.updatedAt) return role.origin === "preset" ? tUi("shipped") : "";
  try {
    const date = new Date(role.updatedAt);
    const stamp = date.toLocaleDateString(tUi.locale);
    return role.origin === "preset" && !role.edited ? tUi("shipped") : stamp;
  } catch (_) {
    return "";
  }
}

export function RolesTable({ roles = [], onChanged, canManage = true }) {
  const tUi = useUiText();
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
      notify({ title: "Role cloned", description: tUi("{value0} is an editable copy.", {value0: data.role.name}), variant: "success" });
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
      notify({ title: "Shipped defaults restored", description: tUi("{value0} matches the product definition again. Applied to {value1} users within seconds.", {value0: data.role.name, value1: data.role.usersCount}), variant: "success" });
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
        description: data.removedFromUsers ? tUi("Removed from {value0} users. Their menus update within seconds.", {value0: data.removedFromUsers}) : tUi("{value0} was not assigned to anyone.", {value0: role.name}),
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
              <TableHead className="px-[10px]">{tUi("Role")}</TableHead>
              <TableHead className="px-[10px]">{tUi("Type")}</TableHead>
              <TableHead className="px-[10px]">{tUi("Grants")}</TableHead>
              <TableHead className="px-[10px]">{tUi("Scope")}</TableHead>
              <TableHead className="px-[10px]">{tUi("Users")}</TableHead>
              <TableHead className="px-[10px]">{tUi("Updated")}</TableHead>
              <TableHead className="px-[10px] text-right">{tUi("Actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {roles.map((role) => (
              <TableRow key={role.key}>
                <TableCell className="px-[10px] align-top text-xs">
                  <div className="flex flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-1.5 font-medium">
                      <Link href={`/admin/permissions/${encodeURIComponent(role.key)}`} className="hover:underline">
                        {roleDisplayText(tUi, role)}
                      </Link>
                      {role.edited ? <EditedBadge /> : null}
                    </span>
                    <code className="text-[11px] text-muted-foreground">{role.key}</code>
                    {role.description ? <span className="truncate text-[11px] text-muted-foreground" title={roleDisplayText(tUi, role, "description")}>{roleDisplayText(tUi, role, "description")}</span> : null}
                  </div>
                </TableCell>
                <TableCell className="px-[10px] align-top text-xs">
                  <RoleTypeBadge origin={role.origin} />
                </TableCell>
                <TableCell className="px-[10px] align-top text-xs tabular-nums">
                  {role.summary?.wildcard ? tUi("every screen · every operation") : tUi("{value0} screens · {value1} ops", { value0: role.summary?.screens ?? 0, value1: role.summary?.operations ?? 0 })}
                </TableCell>
                <TableCell className="px-[10px] align-top text-xs">
                  <div className="flex flex-wrap gap-1">
                    {scopeChips(role, tUi).map((chip) => (
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
                <TableCell className="px-[10px] align-top text-xs text-muted-foreground">{formatUpdated(role, tUi)}</TableCell>
                <TableCell className="px-[10px] align-top text-right text-xs">
                  <div className="flex flex-wrap justify-end gap-1">
                    <Button asChild variant="outline" size="sm" className="h-7 px-2 text-xs" title={role.isSystem ? tUi("View role") : tUi("Edit role")}>
                      <Link href={`/admin/permissions/${encodeURIComponent(role.key)}`}>
                        {role.isSystem ? <IconEye className="size-3.5" /> : <IconEdit className="size-3.5" />}
                        {role.isSystem ? tUi("View") : tUi("Edit")}
                      </Link>
                    </Button>
                    {canManage ? (
                      <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={busy === role.key} onClick={() => clone(role)} title={tUi("Create an editable copy")}>
                        <IconCopy className="size-3.5" />{tUi(" Clone")}</Button>
                    ) : null}
                    {canManage && role.origin === "preset" && role.edited ? (
                      <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={busy === role.key} onClick={() => restore(role)} title={tUi("Restore the shipped permission set")}>
                        <IconRestore className="size-3.5" />{tUi(" Restore")}</Button>
                    ) : null}
                    {canManage ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs text-destructive"
                        disabled={role.isSystem || busy === role.key}
                        title={role.isSystem ? tUi("System roles cannot be deleted") : tUi("Delete role")}
                        onClick={() => setPendingDelete(role)}
                      >
                        <IconTrash className="size-3.5" />{tUi(" Delete")}</Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {!roles.length ? (
              <TableRow>
                <TableCell colSpan={7} className="px-[10px] py-6 text-center text-xs text-muted-foreground">{tUi("No roles match the current filters.")}</TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>

      <AlertDialog open={Boolean(pendingDelete)} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tUi("Delete ")}{pendingDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.usersCount
                ? tUi("Users assigned to {value0}: {value1}. This role will be removed from them and their menus update within seconds.", { value0: pendingDelete.name, value1: pendingDelete.usersCount })
                : tUi("{value0} is not assigned to anyone.", { value0: pendingDelete?.name })}
              {pendingDelete?.origin === "preset" ? tUi(" A deleted shipped role does not come back on the next upgrade.") : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tUi("Cancel")}</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => pendingDelete && remove(pendingDelete)}>
              {pendingDelete?.usersCount ? tUi("Remove from {value0} and delete", { value0: pendingDelete.usersCount }) : tUi("Delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
