"use client";

import { AdminPageContent, AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";
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
  IconKey,
  IconEdit,
  IconTrash,
  IconPlus,
} from "@tabler/icons-react";
import SecretEditSheet from "@/components/secrets/EditSheet";

export default function AdminSecretsPage() {
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
    if (!dateString) return "Never";
    try {
      return new Date(dateString).toLocaleString();
    } catch {
      return dateString;
    }
  }

  function isExpired(expiresAt) {
    if (!expiresAt) return false;
    return new Date(expiresAt) < new Date();
  }

  return (
    <AdminPageShell>
      <AdminPageHeader title="Secrets" badges={<Badge variant="secondary">{secrets.length} secrets</Badge>} />
      <AdminPageContent>
        <div className="space-y-4">
      <Card className="w-full">
        <CardContent className="space-y-4 pt-6">
          <div className="flex items-center justify-between">
            <div className="text-lg font-semibold flex items-center gap-2">
              <IconKey className="size-6 text-telnyx-green" /> Secrets
            </div>
            <div className="flex gap-2">
              <Button onClick={() => load()} disabled={loading}>
                {loading ? "Loading…" : "Refresh"}
              </Button>
              <Button onClick={openCreateSheet}>
                <IconPlus className="size-4 mr-2" />
                Add Secret
              </Button>
            </div>
          </div>

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
                    <TableHead className="px-[10px]">Name</TableHead>
                    <TableHead className="px-[10px]">Description</TableHead>
                    <TableHead className="px-[10px]">Expires</TableHead>
                    <TableHead className="px-[10px]">Status</TableHead>
                    <TableHead className="px-[10px] text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {secrets.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                        No secrets found. Click "Add Secret" to create one.
                      </TableCell>
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
                            <span className="text-red-600 dark:text-red-400">
                              Expired
                            </span>
                          ) : (
                            <span className="text-green-600 dark:text-green-400">
                              Active
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="px-[10px] text-xs text-right">
                          <div className="inline-flex items-center gap-2 justify-end">
                            <button
                              type="button"
                              onClick={() => openEditSheet(secret.id)}
                              className="inline-flex items-center text-telnyx-green"
                              title="Edit secret"
                            >
                              <IconEdit className="size-4" />
                            </button>
                            <Dialog>
                              <DialogTrigger asChild>
                                <button
                                  type="button"
                                  className="inline-flex items-center text-red-500"
                                  title="Delete secret"
                                >
                                  <IconTrash className="size-4" />
                                </button>
                              </DialogTrigger>
                              <DialogContent>
                                <DialogHeader>
                                  <DialogTitle>Delete secret?</DialogTitle>
                                  <DialogDescription>
                                    This action cannot be undone. This will
                                    permanently delete the secret "{secret.name}".
                                  </DialogDescription>
                                </DialogHeader>
                                <div className="flex justify-end gap-2 pt-2">
                                  <DialogClose asChild>
                                    <Button variant="outline">Cancel</Button>
                                  </DialogClose>
                                  <DialogClose asChild>
                                    <Button
                                      variant="destructive"
                                      onClick={() => handleDelete(secret.id)}
                                    >
                                      Delete
                                    </Button>
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
      </AdminPageContent>
    </AdminPageShell>
  );
}
