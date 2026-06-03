"use client";

import * as React from "react";
import { AdminPageContent, AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ToastNotify";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  IconChevronDown,
  IconChevronUp,
  IconEdit,
  IconPlus,
  IconServer,
  IconTools,
  IconTrash,
} from "@tabler/icons-react";
import MCPServerEditorSheet from "@/components/admin/MCPServerEditorSheet";

function ServerTypeBadge({ type }) {
  const classes = {
    sse: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 border-transparent",
    http: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 border-transparent",
  }[type] || "bg-gray-100 text-gray-700 dark:bg-gray-900/40 dark:text-gray-300 border-transparent";

  return (
    <Badge variant="outline" className={classes}>
      <IconServer className="size-3 mr-1" />
      {String(type || "mcp").toUpperCase()}
    </Badge>
  );
}

export default function AdminMCPServersPage() {
  const [loading, setLoading] = React.useState(true);
  const [rows, setRows] = React.useState([]);
  const [expandedServers, setExpandedServers] = React.useState(new Set());
  const [sheetServerId, setSheetServerId] = React.useState(null);
  const [oauthStatus, setOauthStatus] = React.useState(null);

  async function load() {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/mcp-servers?page=1&pageSize=100", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "Failed to fetch MCP servers");
      setRows(Array.isArray(data.rows) ? data.rows : []);
    } catch (err) {
      setRows([]);
      notify({ title: "Load failed", description: String(err.message || err), variant: "error" });
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    load();
  }, []);

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthResult = params.get("mcp_oauth");
    const serverId = params.get("server_id");
    const oauthError = params.get("mcp_oauth_error");
    if (!oauthResult && !oauthError) return;

    const status = oauthResult === "connected" && !oauthError ? "connected" : "error";
    const message = status === "connected"
      ? "Telnyx Portal authentication completed successfully."
      : `Telnyx Portal authentication failed: ${oauthError || "unknown error"}`;

    setOauthStatus({ status, serverId, message });
    if (serverId) setSheetServerId(serverId);
    notify({
      title: status === "connected" ? "MCP OAuth connected" : "MCP OAuth failed",
      description: message,
      variant: status === "connected" ? "success" : "error",
    });

    params.delete("mcp_oauth");
    params.delete("mcp_oauth_error");
    params.delete("server_id");
    const nextUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`;
    window.history.replaceState({}, "", nextUrl);
  }, []);

  async function onDelete(id) {
    try {
      const response = await fetch(`/api/admin/mcp-servers/${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || "Failed to delete MCP server");
      notify({ title: "Deleted", description: "MCP server deleted successfully", variant: "success" });
      load();
    } catch (err) {
      notify({ title: "Delete failed", description: String(err.message || err), variant: "error" });
    }
  }

  const toggleServerExpanded = (serverId) => {
    setExpandedServers((prev) => {
      const next = new Set(prev);
      if (next.has(serverId)) next.delete(serverId);
      else next.add(serverId);
      return next;
    });
  };

  const headerActions = (
    <>
      <Button onClick={load} disabled={loading}>{loading ? "Loading…" : "Refresh"}</Button>
      <Button onClick={() => setSheetServerId("new")}>
        <IconPlus className="size-4 mr-2" />
        Add MCP Server
      </Button>
    </>
  );

  return (
    <AdminPageShell>
      <AdminPageHeader
        title="MCP Servers"
        icon={IconTools}
        badges={<Badge variant="secondary">{rows.length} servers</Badge>}
        actions={headerActions}
      />
      <AdminPageContent>
        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-3 pt-6">
              {loading && [...Array(3)].map((_, index) => <Skeleton key={index} className="h-24 w-full" />)}
              {!loading && rows.length === 0 && (
                <div className="text-sm text-muted-foreground border rounded-lg p-6 text-center">
                  No MCP servers configured yet.
                </div>
              )}
              {!loading && rows.map((server) => {
                const isExpanded = expandedServers.has(server.id);
                const allowedTools = Array.isArray(server.allowed_tools) ? server.allowed_tools : [];
                return (
                  <div key={server.id} className="border rounded-xl p-4 flex items-start justify-between gap-4 bg-card/50">
                    <div className="space-y-2 min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0 flex-wrap">
                        <div className="text-base font-semibold truncate">{server.name}</div>
                        <ServerTypeBadge type={server.type} />
                        {allowedTools.length > 0 && (
                          <Button type="button" variant="ghost" size="icon" className="h-6 w-6" onClick={() => toggleServerExpanded(server.id)}>
                            {isExpanded ? <IconChevronUp className="h-4 w-4" /> : <IconChevronDown className="h-4 w-4" />}
                          </Button>
                        )}
                        {!isExpanded && allowedTools.length > 0 && (
                          <Badge variant="outline" className="text-xs bg-telnyx-green/10 text-telnyx-green border-telnyx-green/30">
                            {allowedTools.length} {allowedTools.length === 1 ? "tool" : "tools"}
                          </Badge>
                        )}
                      </div>
                      <div className="text-sm text-muted-foreground truncate max-w-[70ch]">{server.url}</div>
                      {server.api_key_ref && <div className="text-xs text-muted-foreground">API Key Ref: {server.api_key_ref}</div>}
                      {isExpanded && (
                        <div className="flex items-center flex-wrap gap-2 mt-2 pt-2 border-t">
                          {allowedTools.map((tool) => (
                            <Badge key={tool} variant="outline" className="bg-telnyx-green/10 text-telnyx-green border-telnyx-green/30">
                              {tool}
                            </Badge>
                          ))}
                        </div>
                      )}
                      {allowedTools.length === 0 && <Badge variant="outline" className="text-xs">No allowed tools</Badge>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button type="button" variant="ghost" size="icon" onClick={() => setSheetServerId(server.id)} title="Edit MCP server">
                        <IconEdit className="size-4" />
                      </Button>
                      <Dialog>
                        <DialogTrigger asChild>
                          <Button type="button" variant="ghost" size="icon" title="Delete MCP server">
                            <IconTrash className="size-4 text-red-500" />
                          </Button>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>Delete MCP server?</DialogTitle>
                            <DialogDescription>
                              This removes "{server.name}" from the configured MCP servers list.
                            </DialogDescription>
                          </DialogHeader>
                          <div className="flex justify-end gap-2 pt-2">
                            <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
                            <DialogClose asChild><Button variant="destructive" onClick={() => onDelete(server.id)}>Delete</Button></DialogClose>
                          </div>
                        </DialogContent>
                      </Dialog>
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </div>
      </AdminPageContent>
      <MCPServerEditorSheet
        open={Boolean(sheetServerId)}
        serverId={sheetServerId}
        oauthStatus={oauthStatus}
        onOpenChange={(open) => !open && setSheetServerId(null)}
        onSaved={() => {
          setSheetServerId(null);
          load();
        }}
      />
    </AdminPageShell>
  );
}
