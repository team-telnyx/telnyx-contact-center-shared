"use client";

import { useEffect, useState, useRef } from "react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import SoftphoneMini from "@/components/softphone-mini";
import { StatusSelector } from "@/components/contact-center/StatusSelector";
import { QueueActivationPanel } from "@/components/contact-center/QueueActivationPanel";
import { CampaignActivationSelector } from "@/components/contact-center/CampaignActivationSelector";
import { DEFAULT_USER_STATUS } from "@/config/user";
import { notify } from "@/components/ToastNotify";

export function SiteHeader() {
  const [status, setStatus] = useState(DEFAULT_USER_STATUS);
  const [queues, setQueues] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
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

    const loadCampaigns = async () => {
      try {
        const res = await fetch("/api/contact-center/agent/campaigns");
        const data = await res.json();
        if (data.ok) {
          setCampaigns(data.campaigns || []);
        }
      } catch (err) {
        console.error("Failed to load campaigns:", err);
      }
    };

    // Store loadQueues in a ref so it can be used in event listeners
    loadQueuesRef.current = loadQueues;

    if (hasAgentRole) {
      loadStatus();
      loadQueues();
      loadCampaigns();
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
            console.log("[SiteHeader] Received status_changed event:", data);
            if (data.status) {
              console.log(
                `[SiteHeader] Updating status from "${status}" to "${data.status}"`,
              );
              setStatus(data.status);
            }
          } catch (err) {
            console.error(
              "[SiteHeader] Failed to parse status SSE message:",
              err,
            );
          }
        });

        statusEventSource.addEventListener("queue_changed", async (event) => {
          try {
            const data = JSON.parse(event.data);
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
              // Reload queues to update activation status (no toast notification)
              if (loadQueuesRef.current) {
                loadQueuesRef.current();
              }
            }
          } catch (err) {
            // Failed to parse queue SSE message
          }
        });

        statusEventSource.addEventListener("connected", () => {
          // Connected to status stream
        });

        statusEventSource.onerror = (error) => {
          if (statusEventSource) {
            statusEventSource.close();
            statusEventSource = null;
          }
          setTimeout(connectStatusStream, 5000);
        };
      } catch (err) {
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
      const res = await fetch("/api/user/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      const data = await res.json();
      if (data.ok) {
        setStatus(newStatus);
      } else {
        alert(data.error || "Failed to update status");
      }
    } catch (err) {
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
              <CampaignActivationSelector
                campaigns={campaigns}
                onUpdate={async () => {
                  try {
                    const res = await fetch("/api/contact-center/agent/campaigns");
                    const data = await res.json();
                    if (data.ok) {
                      setCampaigns(data.campaigns || []);
                    }
                  } catch (err) {
                    // Error reloading campaigns
                  }
                }}
              />
              <QueueActivationPanel
                queues={queues}
                onUpdate={async () => {
                  try {
                    const res = await fetch("/api/contact-center/agent/queues");
                    const data = await res.json();
                    if (data.ok) {
                      setQueues(data.queues || []);
                    }
                  } catch (err) {
                    // Error reloading queues
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
