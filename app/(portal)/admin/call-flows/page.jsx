"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
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
  IconPencil,
  IconTrash,
  IconCopy,
  IconPlus,
  IconGitBranch,
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
  IconPhone,
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
  const [pageSize] = useState(12);
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
  }, [page, filterName, isAuthorized]);

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

  const totalPages = Math.ceil(total / pageSize);
  const hasNextPage = page < totalPages;
  const hasPrevPage = page > 1;

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

  return (
    <div className="px-4 lg:px-6">
      <Card className="w-full">
        <CardContent className="space-y-4 pt-6">
          <div className="flex items-center justify-between">
            <div className="text-lg font-semibold flex items-center gap-2">
              <IconGitBranch className="size-6 text-telnyx-green" /> Call Flows
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleCreate}>
                <IconPlus className="h-4 w-4 mr-2" />
                Create Flow
              </Button>
            </div>
          </div>

          <div className="mb-4">
            <Input
              placeholder="Filter by name..."
              value={filterName}
              onChange={(e) => setFilterName(e.target.value)}
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
                                  node.data?.nodeType === "form_submit"
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
                              <Badge className="bg-telnyx-green/10 text-telnyx-green border-telnyx-green/20 hover:bg-telnyx-green/20 dark:bg-telnyx-green/20 dark:text-telnyx-green dark:border-telnyx-green/30">
                                Incoming Call
                              </Badge>
                            );
                          }

                          if (initiatorType === "http_request") {
                            return (
                              <Badge className="bg-orange-500/10 text-orange-600 border-orange-500/20 hover:bg-orange-500/20 dark:bg-orange-500/20 dark:text-orange-400 dark:border-orange-500/30">
                                HTTP Request
                              </Badge>
                            );
                          }

                          if (initiatorType === "form_submit") {
                            return (
                              <Badge className="bg-teal-500/10 text-teal-600 border-teal-500/20 hover:bg-teal-500/20 dark:bg-teal-500/20 dark:text-teal-400 dark:border-teal-500/30">
                                Form Submit
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
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() =>
                              router.push(`/admin/call-flows/${flow.id}`)
                            }
                          >
                            <IconPencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDuplicate(flow.id, flow.name)}
                          >
                            <IconCopy className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() =>
                              handleDeleteClick(flow.id, flow.name)
                            }
                          >
                            <IconTrash className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-4">
                  <div className="text-sm text-muted-foreground">
                    Page {page} of {totalPages} ({total} total)
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => setPage(1)}
                      disabled={!hasPrevPage}
                    >
                      <IconChevronsLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={!hasPrevPage}
                    >
                      <IconChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => setPage((p) => p + 1)}
                      disabled={!hasNextPage}
                    >
                      <IconChevronRight className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => setPage(totalPages)}
                      disabled={!hasNextPage}
                    >
                      <IconChevronsRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Flow</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{flowToDelete?.name}"? This will
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
  );
}
