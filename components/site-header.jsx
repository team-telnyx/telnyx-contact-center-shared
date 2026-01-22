"use client";

import { useEffect, useState, useRef } from "react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import SoftphoneMini from "@/components/softphone-mini";
import { StatusSelector } from "@/components/contact-center/StatusSelector";
import { QueueActivationPanel } from "@/components/contact-center/QueueActivationPanel";
import { DEFAULT_USER_STATUS } from "@/config/user";
import { notify } from "@/components/ToastNotify";

export function SiteHeader() {
  const [status, setStatus] = useState(DEFAULT_USER_STATUS);
  const [queues, setQueues] = useState([]);
  const [userRoles, setUserRoles] = useState([]);
  const hasAgentRole = userRoles.includes("agent");
  const loadQueuesRef = useRef(null);

  // Load user roles and status/queues if agent
  useEffect(() => {
    const loadUserData = async () => {
      try {
        const res = await fetch("/api/auth/me");
        const data = await res.json();
        if (data?.isAuth && data?.user) {
          // Get roles from user object
          const roles =
            data.user.roles &&
            Array.isArray(data.user.roles) &&
            data.user.roles.length > 0
              ? data.user.roles.map((r) => String(r).toLowerCase())
              : ["user"];
          setUserRoles(roles);
        }
      } catch (err) {
        console.error("Failed to load user data:", err);
      }
    };

    loadUserData();
  }, []);

  // Load status and queues if user has agent role
  useEffect(() => {
    const loadStatus = async () => {
      try {
        const res = await fetch("/api/user/profile");
        const data = await res.json();
        if (data.ok && data.data?.status) {
          setStatus(data.data.status);
        } else {
          setStatus(DEFAULT_USER_STATUS);
        }
      } catch (err) {
        console.error("Failed to load status:", err);
      }
    };

    const loadQueues = async () => {
      try {
        const res = await fetch("/api/contact-center/agent/queues");
        const data = await res.json();
        if (data.ok) {
          setQueues(data.queues || []);
        }
      } catch (err) {
        console.error("Failed to load queues:", err);
      }
    };

    // Store loadQueues in a ref so it can be used in event listeners
    loadQueuesRef.current = loadQueues;

    if (hasAgentRole) {
      loadStatus();
      loadQueues();
    }

    // Set up SSE connection for real-time status updates
    let statusEventSource = null;
    const connectStatusStream = () => {
      try {
        if (statusEventSource) {
          statusEventSource.close();
        }

        statusEventSource = new EventSource("/api/user/status-stream");
        statusEventSource.addEventListener("status_changed", (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.status) {
              console.log("[SiteHeader] Status updated via SSE:", data.status);
              setStatus(data.status);
            }
          } catch (err) {
            console.error(
              "[SiteHeader] Failed to parse status SSE message:",
              err
            );
          }
        });

        statusEventSource.addEventListener("queue_changed", async (event) => {
          try {
            const data = JSON.parse(event.data);
            console.log("[SiteHeader] Queue changed via SSE:", data);
            if (data.type === "queue_created") {
              // Notify user about new queue
              notify({
                title: "New queue available",
                description: `${
                  data.queue.displayName || data.queue.name
                } has been added and is now available for activation.`,
                variant: "info",
              });
              // Reload queues
              if (loadQueuesRef.current) {
                loadQueuesRef.current();
              }
            } else if (data.type === "queue_updated") {
              // Reload queues when a queue is updated
              if (loadQueuesRef.current) {
                loadQueuesRef.current();
              }
            } else if (data.type === "queue_activation_changed") {
              // Notify about activation change (only if it's not the current user)
              try {
                const currentUserRes = await fetch("/api/auth/me");
                const currentUserData = await currentUserRes.json();
                if (
                  currentUserData?.isAuth &&
                  currentUserData?.user?.id !== data.userId
                ) {
                  const queueNames = data.queues
                    .map((q) => q.displayName || q.name)
                    .join(", ");
                  // Use first + last name if available, fallback to username
                  const userName =
                    data.firstName || data.lastName
                      ? `${data.firstName || ""} ${data.lastName || ""}`.trim()
                      : data.username;
                  notify({
                    title: data.activated
                      ? "User activated in queues"
                      : "User deactivated from queues",
                    description: `${userName} ${
                      data.activated ? "activated" : "deactivated"
                    } in ${queueNames}.`,
                    variant: "info",
                  });
                }
              } catch (fetchErr) {
                console.error(
                  "[SiteHeader] Failed to fetch current user:",
                  fetchErr
                );
              }
              // Reload queues to update activation status
              if (loadQueuesRef.current) {
                loadQueuesRef.current();
              }
            }
          } catch (err) {
            console.error(
              "[SiteHeader] Failed to parse queue SSE message:",
              err
            );
          }
        });

        statusEventSource.addEventListener("connected", () => {
          console.log("[SiteHeader] Connected to status stream");
        });

        statusEventSource.onerror = (error) => {
          console.warn("[SiteHeader] Status stream error:", error);
          if (statusEventSource) {
            statusEventSource.close();
            statusEventSource = null;
          }
          setTimeout(connectStatusStream, 5000);
        };
      } catch (err) {
        console.error("[SiteHeader] Failed to connect to status stream:", err);
        setTimeout(connectStatusStream, 5000);
      }
    };

    if (hasAgentRole) {
      connectStatusStream();
    }

    return () => {
      if (statusEventSource) {
        statusEventSource.close();
        statusEventSource = null;
      }
    };
  }, [hasAgentRole]);

  const handleStatusChange = async (newStatus) => {
    try {
      console.log("[SiteHeader] Updating status to:", newStatus);
      const res = await fetch("/api/user/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      const data = await res.json();
      console.log("[SiteHeader] Status update response:", data);
      if (data.ok) {
        setStatus(newStatus);
      } else {
        console.error("[SiteHeader] Status update failed:", data.error);
        alert(data.error || "Failed to update status");
      }
    } catch (err) {
      console.error("[SiteHeader] Failed to update status:", err);
      alert("Failed to update status. Please try again.");
    }
  };

  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator
          orientation="vertical"
          className="mx-2 data-[orientation=vertical]:h-4"
        />
        <div className="ml-auto flex items-center gap-2">
          {/* Contact Center Controls - Show for users with agent role */}
          {hasAgentRole && (
            <>
              <StatusSelector value={status} onChange={handleStatusChange} />
              <QueueActivationPanel
                queues={queues}
                onUpdate={async () => {
                  try {
                    const res = await fetch("/api/contact-center/agent/queues");
                    const data = await res.json();
                    if (data.ok) {
                      setQueues(data.queues || []);
                    } else {
                      console.error(
                        "[SiteHeader] Failed to reload queues:",
                        data.error
                      );
                    }
                  } catch (err) {
                    console.error("[SiteHeader] Error reloading queues:", err);
                  }
                }}
              />
              <Separator orientation="vertical" className="h-6" />
            </>
          )}
          <SoftphoneMini />
        </div>
      </div>
    </header>
  );
}
