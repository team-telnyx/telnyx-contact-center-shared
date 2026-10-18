"use client";
import { useUiText } from "@/components/i18n/use-ui-text";


import { AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";
import { ConfigurationSectionPage } from "@/components/admin/ConfigurationSectionNav";
import { Fragment, useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { notify } from "@/components/ToastNotify";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import {
  IconEdit,
  IconTrash,
  IconPlus,
} from "@tabler/icons-react";
import SecretEditSheet from "@/components/secrets/EditSheet";
import { Can } from "@/components/auth-provider";

export default function AdminSecretsPage() {
  const tUi = useUiText();
  const [secrets, setSecrets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editingSecretId, setEditingSecretId] = useState(null);
  const [showEditSheet, setShowEditSheet] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/secrets", {
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "Failed to fetch secrets");
      setSecrets(data.secrets || []);
    } catch (err) {
      notify({
        title: "Load failed",
        description: String(err.message || err),
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function openCreateSheet() {
    setEditingSecretId(null);
    setShowEditSheet(true);
  }

  function openEditSheet(secretId) {
    setEditingSecretId(secretId);
    setShowEditSheet(true);
  }

  async function handleDelete(id) {
    try {
      const response = await fetch(`/api/admin/secrets/${id}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data?.error || "Failed to delete");
      }

      notify({
        title: "Success",
        description: "Secret deleted successfully",
        variant: "success",
      });

      load();
    } catch (err) {
      notify({
        title: "Delete failed",
        description: String(err.message || err),
        variant: "error",
      });
    }
  }

  function formatDate(dateString) {
    if (!dateString) return tUi("Never");
    try {
      return new Date(dateString).toLocaleString(tUi.locale);
    } catch {
      return dateString;
    }
  }

  function isExpired(expiresAt) {
    if (!expiresAt) return false;
    return new Date(expiresAt) < new Date();
  }

  const headerActions = <>
    <Button onClick={() => load()} disabled={loading}>
      {loading ? tUi("Loading…") : tUi("Refresh")}
    </Button>
    <Can permission="secrets:create"><Button onClick={openCreateSheet}>
      <IconPlus className="size-4 mr-2" />{tUi("Add Secret")}</Button></Can>
  </>;

  return (
    <AdminPageShell>
      <AdminPageHeader title={tUi("Secrets")} badges={<Badge variant="secondary">{secrets.length}{tUi(" secrets")}</Badge>} actions={headerActions} />
      <ConfigurationSectionPage activeId="secrets">
        <div className="space-y-4">
      <Card className="w-full">
        <CardContent className="space-y-4 pt-6">

          {loading ? (
            <div className="border rounded-md overflow-hidden p-4 space-y-2">
              <Skeleton className="h-6 w-40" />
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            <div className="border rounded-md overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="px-[10px]">{tUi("Name")}</TableHead>
                    <TableHead className="px-[10px]">{tUi("Description")}</TableHead>
                    <TableHead className="px-[10px]">{tUi("Expires")}</TableHead>
                    <TableHead className="px-[10px]">{tUi("Status")}</TableHead>
                    <TableHead className="px-[10px] text-right">{tUi("Actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {secrets.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">{tUi("No secrets found. Click \"Add Secret\" to create one.")}</TableCell>
                    </TableRow>
                  ) : (
                    secrets.map((secret) => (
                      <TableRow key={secret.id}>
                        <TableCell className="px-[10px] text-xs font-medium">
                          {secret.name}
                        </TableCell>
                        <TableCell className="px-[10px] text-xs">
                          {secret.description || "—"}
                        </TableCell>
                        <TableCell className="px-[10px] text-xs">
                          {formatDate(secret.expires_at)}
                        </TableCell>
                        <TableCell className="px-[10px] text-xs">
                          {isExpired(secret.expires_at) ? (
                            <span className="text-red-600 dark:text-red-400">{tUi("Expired")}</span>
                          ) : (
                            <span className="text-green-600 dark:text-green-400">{tUi("Active")}</span>
                          )}
                        </TableCell>
                        <TableCell className="px-[10px] text-xs text-right">
                          <div className="inline-flex items-center gap-2 justify-end">
                            <button
                              type="button"
                              onClick={() => openEditSheet(secret.id)}
                              className="inline-flex items-center text-telnyx-green"
                              title={tUi("Edit secret")}
                            >
                              <IconEdit className="size-4" />
                            </button>
                            <Dialog>
                              <DialogTrigger asChild>
                                <Can permission="secrets:delete"><button
                                  type="button"
                                  className="inline-flex items-center text-red-500"
                                  title={tUi("Delete secret")}
                                >
                                  <IconTrash className="size-4" />
                                </button></Can>
                              </DialogTrigger>
                              <DialogContent>
                                <DialogHeader>
                                  <DialogTitle>{tUi("Delete secret?")}</DialogTitle>
                                  <DialogDescription>{tUi("This action cannot be undone. This will permanently delete the secret \"")}{secret.name}&quot;.
                                  </DialogDescription>
                                </DialogHeader>
                                <div className="flex justify-end gap-2 pt-2">
                                  <DialogClose asChild>
                                    <Button variant="outline">{tUi("Cancel")}</Button>
                                  </DialogClose>
                                  <DialogClose asChild>
                                    <Button
                                      variant="destructive"
                                      onClick={() => handleDelete(secret.id)}
                                    >{tUi("Delete")}</Button>
                                  </DialogClose>
                                </div>
                              </DialogContent>
                            </Dialog>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Edit Sheet */}
      <SecretEditSheet
        open={showEditSheet}
        onOpenChange={setShowEditSheet}
        secretId={editingSecretId}
        onSaveComplete={load}
      />
        </div>
      </ConfigurationSectionPage>
    </AdminPageShell>
  );
}
