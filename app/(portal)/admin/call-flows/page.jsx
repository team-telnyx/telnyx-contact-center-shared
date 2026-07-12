"use client";

import { AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";
import { AutomationsSectionPage } from "@/components/admin/AutomationsSectionNav";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import {
  IconEdit,
  IconTrash,
  IconCopy,
  IconPlus,
  IconGitBranch,
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
  IconPhone,
  IconDownload,
  IconUpload,
} from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export default function CallFlowsPage() {
  const router = useRouter();
  const [flows, setFlows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [filterName, setFilterName] = useState("");
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [flowToDelete, setFlowToDelete] = useState(null);
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);

  // Check if user is admin/owner
  useEffect(() => {
    async function checkAuth() {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store" });
        const data = await res.json();

        if (!data?.isAuth || !data?.user) {
          router.push("/signin");
          return;
        }

        // Check if user has admin or owner role
        const userRoles =
          data.user.roles &&
          Array.isArray(data.user.roles) &&
          data.user.roles.length > 0
            ? data.user.roles.map((r) => String(r).toLowerCase())
            : ["agent"];

        const hasAdminAccess = userRoles.some(
          (role) => role === "admin" || role === "owner"
        );

        if (!hasAdminAccess) {
          notify({
            title: "Access Denied",
            description: "You do not have permission to access this page.",
            variant: "error",
          });
          router.push("/");
          return;
        }

        setIsAuthorized(true);
      } catch (error) {
        console.error("Error checking authorization:", error);
        router.push("/signin");
      } finally {
        setCheckingAuth(false);
      }
    }

    checkAuth();
  }, [router]);

  async function loadFlows() {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      });
      if (filterName) params.set("name", filterName);

      const res = await fetch(`/api/voice/flows?${params}`);
      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Failed to load flows");
      }

      setFlows(data.items || []);
      setTotal(data.total || 0);
    } catch (error) {
      console.error("Error loading flows:", error);
      notify({
        title: "Error",
        description: "Failed to load flows",
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (isAuthorized) {
      loadFlows();
    }
  }, [page, pageSize, filterName, isAuthorized]);

  async function handleCreate() {
    try {
      const res = await fetch("/api/voice/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "New Flow",
          description: "",
          nodes: [],
          edges: [],
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Failed to create flow");
      }

      notify({
        title: "Success",
        description: "Flow created successfully",
        variant: "success",
      });
      router.push(`/admin/call-flows/${data.flow.id}`);
    } catch (error) {
      console.error("Error creating flow:", error);
      notify({
        title: "Error",
        description: error.message || "Failed to create flow",
        variant: "error",
      });
    }
  }

  function handleDeleteClick(id, name) {
    setFlowToDelete({ id, name });
    setShowDeleteDialog(true);
  }

  async function handleConfirmDelete() {
    if (!flowToDelete) return;

    try {
      const res = await fetch(`/api/voice/flows/${flowToDelete.id}`, {
        method: "DELETE",
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Failed to delete flow");
      }

      notify({
        title: "Success",
        description: "Flow deleted successfully",
        variant: "success",
      });
      setShowDeleteDialog(false);
      setFlowToDelete(null);
      loadFlows();
    } catch (error) {
      console.error("Error deleting flow:", error);
      notify({
        title: "Error",
        description: error.message || "Failed to delete flow",
        variant: "error",
      });
      setShowDeleteDialog(false);
      setFlowToDelete(null);
    }
  }

  function handleCancelDelete() {
    setShowDeleteDialog(false);
    setFlowToDelete(null);
  }

  async function handleDuplicate(id, name) {
    try {
      // Get the flow first
      const getRes = await fetch(`/api/voice/flows/${id}`);
      const getData = await getRes.json();

      if (!getRes.ok || !getData.ok) {
        throw new Error("Failed to get flow");
      }

      // Create duplicate (without voice app - user needs to create new one)
      const res = await fetch("/api/voice/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${name} (Copy)`,
          description: getData.flow.description,
          nodes: getData.flow.nodes,
          edges: getData.flow.edges,
          variables: getData.flow.variables || getData.flow.globalVariables,
          metadata: getData.flow.metadata,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Failed to duplicate flow");
      }

      notify({
        title: "Success",
        description: "Flow duplicated successfully",
        variant: "success",
      });
      loadFlows();
    } catch (error) {
      console.error("Error duplicating flow:", error);
      notify({
        title: "Error",
        description: error.message || "Failed to duplicate flow",
        variant: "error",
      });
    }
  }

  async function handleExport(id, name) {
    try {
      const res = await fetch(`/api/voice/flows/${id}/export`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to export flow");
      }

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${String(name || "call_flow")
        .replace(/[^a-z0-9]/gi, "_")
        .toLowerCase()}_flow.json`;
      document.body.appendChild(link);
      link.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(link);

      notify({
        title: "Success",
        description: "Flow exported successfully",
        variant: "success",
      });
    } catch (error) {
      console.error("Error exporting flow:", error);
      notify({
        title: "Error",
        description: error.message || "Failed to export flow",
        variant: "error",
      });
    }
  }

  async function handleImport() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";

    input.onchange = async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;

      try {
        const data = JSON.parse(await file.text());
        const res = await fetch("/api/voice/flows/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        const result = await res.json();

        if (!res.ok || !result.ok) {
          throw new Error(result.error || "Failed to import flow");
        }

        notify({
          title: "Success",
          description: "Flow imported successfully",
          variant: "success",
        });
        loadFlows();
      } catch (error) {
        console.error("Error importing flow:", error);
        notify({
          title: "Error",
          description: error.message || "Failed to import flow",
          variant: "error",
        });
      }
    };

    input.click();
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Show loading state while checking authorization
  if (checkingAuth || !isAuthorized) {
    return (
      <div className="px-4 lg:px-6">
        <Card className="w-full">
          <CardContent className="space-y-4 pt-6">
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const headerActions = <>
    <Button variant="outline" size="sm" onClick={handleImport}>
      <IconUpload className="h-4 w-4 mr-2" />
      Import
    </Button>
    <Button size="sm" onClick={handleCreate}>
      <IconPlus className="h-4 w-4 mr-2" />
      Create Flow
    </Button>
  </>;

  return (
    <AdminPageShell>
      <AdminPageHeader title="Call & App Flows" badges={<Badge variant="secondary">{total} flows</Badge>} actions={headerActions} />
      <AutomationsSectionPage activeId="call-app-flows">
        <div className="space-y-4">
      <Card className="w-full">
        <CardContent className="space-y-4 pt-6">

          <div className="mb-4">
            <Input
              placeholder="Filter by name..."
              value={filterName}
              onChange={(e) => {
                setFilterName(e.target.value);
                setPage(1);
              }}
              className="max-w-sm"
            />
          </div>

          {loading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : flows.length === 0 ? (
            <div className="text-center py-12">
              <IconGitBranch className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <p className="text-muted-foreground mb-4">
                {filterName
                  ? "No flows found matching your filter"
                  : "No flows yet. Create your first call flow!"}
              </p>
              {!filterName && (
                <Button onClick={handleCreate}>
                  <IconPlus className="h-4 w-4 mr-2" />
                  Create Flow
                </Button>
              )}
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Initiator</TableHead>
                    <TableHead className="text-center">Phone Numbers</TableHead>
                    <TableHead className="text-center">Nodes</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {flows.map((flow) => (
                    <TableRow key={flow.id}>
                      <TableCell className="font-medium">{flow.name}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {flow.description || "-"}
                      </TableCell>
                      <TableCell>
                        {(() => {
                          // Determine initiator type
                          const initiatorNode = Array.isArray(flow.nodes)
                            ? flow.nodes.find(
                                (node) =>
                                  node.data?.nodeType === "incoming_call" ||
                                  node.data?.nodeType === "http_request" ||
                                  node.data?.nodeType === "form_submit" ||
                                  node.data?.nodeType === "outbound_campaign"
                              )
                            : null;

                          if (!initiatorNode) {
                            return (
                              <Badge
                                variant="outline"
                                className="text-muted-foreground"
                              >
                                None
                              </Badge>
                            );
                          }

                          const initiatorType = initiatorNode.data?.nodeType;

                          if (initiatorType === "incoming_call") {
                            return (
                              <Badge className="border-sky-500/20 bg-sky-500/10 text-sky-700 hover:bg-sky-500/20 dark:border-sky-500/30 dark:bg-sky-500/20 dark:text-sky-300">
                                Incoming Call
                              </Badge>
                            );
                          }

                          if (initiatorType === "http_request") {
                            return (
                              <Badge className="border-orange-500/20 bg-orange-500/10 text-orange-600 hover:bg-orange-500/20 dark:border-orange-500/30 dark:bg-orange-500/20 dark:text-orange-400">
                                HTTP Request
                              </Badge>
                            );
                          }

                          if (initiatorType === "form_submit") {
                            return (
                              <Badge className="border-violet-500/20 bg-violet-500/10 text-violet-600 hover:bg-violet-500/20 dark:border-violet-500/30 dark:bg-violet-500/20 dark:text-violet-300">
                                Form Submit
                              </Badge>
                            );
                          }

                          if (initiatorType === "outbound_campaign") {
                            return (
                              <Badge className="border-emerald-500/20 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 dark:border-emerald-500/30 dark:bg-emerald-500/20 dark:text-emerald-300">
                                Outbound Campaign
                              </Badge>
                            );
                          }

                          return (
                            <Badge
                              variant="outline"
                              className="text-muted-foreground"
                            >
                              Unknown
                            </Badge>
                          );
                        })()}
                      </TableCell>
                      <TableCell className="text-center">
                        {(() => {
                          const phoneNumbers = Array.isArray(flow.phone_numbers)
                            ? flow.phone_numbers
                            : [];
                          const count =
                            flow.phone_numbers_count ||
                            phoneNumbers.length ||
                            0;

                          if (count > 0 && phoneNumbers.length > 0) {
                            return (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <div className="flex items-center justify-center gap-1 cursor-help">
                                      <IconPhone className="h-4 w-4 text-muted-foreground" />
                                      <span>{count}</span>
                                    </div>
                                  </TooltipTrigger>
                                  <TooltipContent className="max-w-md">
                                    <div className="space-y-1">
                                      <p className="font-semibold text-sm mb-2">
                                        Assigned Phone Numbers:
                                      </p>
                                      <div className="space-y-1 max-h-60 overflow-y-auto">
                                        {phoneNumbers.map(
                                          (phoneNumber, idx) => (
                                            <div
                                              key={idx}
                                              className="text-xs font-mono text-left"
                                            >
                                              {phoneNumber}
                                            </div>
                                          )
                                        )}
                                      </div>
                                    </div>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            );
                          }

                          return (
                            <div className="flex items-center justify-center gap-1">
                              <IconPhone className="h-4 w-4 text-muted-foreground" />
                              <span>{count}</span>
                            </div>
                          );
                        })()}
                      </TableCell>
                      <TableCell className="text-center">
                        {Array.isArray(flow.nodes) ? flow.nodes.length : 0}
                      </TableCell>
                      <TableCell>
                        {new Date(flow.created_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right">
                        <div className="inline-flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              router.push(`/admin/call-flows/${flow.id}`)
                            }
                            className="inline-flex items-center text-telnyx-green"
                            title="Edit flow"
                          >
                            <IconEdit className="size-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDuplicate(flow.id, flow.name)}
                            className="inline-flex items-center text-blue-500"
                            title="Duplicate flow"
                          >
                            <IconCopy className="size-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleExport(flow.id, flow.name)}
                            className="inline-flex items-center text-violet-500"
                            title="Export flow"
                          >
                            <IconDownload className="size-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              handleDeleteClick(flow.id, flow.name)
                            }
                            className="inline-flex items-center text-red-500"
                            title="Delete flow"
                          >
                            <IconTrash className="size-4" />
                          </button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

            </>
          )}
        </CardContent>
        <div className="px-6 pb-6">
          <div className="flex items-center justify-between">
            <div className="text-xs text-muted-foreground">Total: {total}</div>
            <div className="flex w-full items-center gap-8 lg:w-fit">
              <div className="hidden items-center gap-2 lg:flex">
                <Label htmlFor="call-flows-rows-per-page" className="text-sm font-medium">
                  Rows per page
                </Label>
                <Select
                  value={`${pageSize}`}
                  onValueChange={(value) => {
                    setPageSize(Number(value));
                    setPage(1);
                  }}
                >
                  <SelectTrigger id="call-flows-rows-per-page" className="w-[70px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="10">10</SelectItem>
                    <SelectItem value="25">25</SelectItem>
                    <SelectItem value="50">50</SelectItem>
                    <SelectItem value="100">100</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(1)}
                  disabled={page === 1}
                >
                  <IconChevronsLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(page - 1)}
                  disabled={page === 1}
                >
                  <IconChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm">
                  Page {page} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(page + 1)}
                  disabled={page >= totalPages}
                >
                  <IconChevronRight className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(totalPages)}
                  disabled={page >= totalPages}
                >
                  <IconChevronsRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Flow</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{flowToDelete?.name}&quot;? This will
              also delete the associated voice application and unassign all
              phone numbers. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleCancelDelete}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
        </div>
      </AutomationsSectionPage>
    </AdminPageShell>
  );
}
