"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import SoftphoneMini from "@/components/softphone-mini";
import { StatusSelector } from "@/components/contact-center/StatusSelector";
import { QueueActivationPanel } from "@/components/contact-center/QueueActivationPanel";
import { CampaignActivationSelector } from "@/components/contact-center/CampaignActivationSelector";
import { DEFAULT_USER_STATUS } from "@/config/user";
import { notify } from "@/components/ToastNotify";
import {
  subscribeStatusStream,
  subscribeStatusStreamState,
} from "@/lib/status-stream-client";
import { IconBook2 } from "@tabler/icons-react";

export function SiteHeader() {
  const [status, setStatus] = useState(DEFAULT_USER_STATUS);
  const [queues, setQueues] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [userRoles, setUserRoles] = useState([]);
  const hasAgentRole = userRoles.includes("agent");
  const loadQueuesRef = useRef(null);
  const loadCampaignsRef = useRef(null);
  const loadStatusRef = useRef(null);

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
        const res = await fetch("/api/user/profile", { cache: "no-store" });
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

    // Store loaders in refs so they can be used in event listeners
    loadStatusRef.current = loadStatus;
    loadQueuesRef.current = loadQueues;
    loadCampaignsRef.current = loadCampaigns;

    if (hasAgentRole) {
      loadStatus();
      loadQueues();
      loadCampaigns();
    }

    // Real-time status/queue/campaign updates come from a SINGLE shared SSE
    // connection (see lib/status-stream-client). All components multiplex over
    // that one stream instead of each opening its own EventSource, which used
    // to exhaust the browser's per-origin connection cap.
    //
    // The /api/user/profile poll is only a fallback safety-net that runs WHILE
    // the shared stream is DOWN, so a missed event cannot leave the header
    // stuck on a stale status. When the stream is healthy we do not poll.
    let statusRefreshInterval = null;

    const startFallbackPolling = () => {
      if (statusRefreshInterval) return; // already polling
      statusRefreshInterval = setInterval(() => {
        if (loadStatusRef.current) {
          loadStatusRef.current();
        }
      }, 5000);
    };

    const stopFallbackPolling = () => {
      if (statusRefreshInterval) {
        clearInterval(statusRefreshInterval);
        statusRefreshInterval = null;
      }
    };

    const unsubscribers = [];

    if (hasAgentRole) {
      // Poll only while the shared SSE stream is down.
      unsubscribers.push(
        subscribeStatusStreamState((connected) => {
          if (connected) {
            stopFallbackPolling();
          } else {
            startFallbackPolling();
          }
        }),
      );

      unsubscribers.push(
        subscribeStatusStream("status_changed", (data) => {
          if (data?.status) {
            setStatus(data.status);
          }
        }),
      );

      unsubscribers.push(
        subscribeStatusStream("queue_changed", (data) => {
          if (data?.type === "queue_created") {
            notify({
              title: "New queue available",
              description: `${
                data.queue?.displayName || data.queue?.name
              } has been added and is now available for activation.`,
              variant: "info",
            });
            loadQueuesRef.current?.();
          } else if (
            data?.type === "queue_updated" ||
            data?.type === "queue_activation_changed"
          ) {
            loadQueuesRef.current?.();
          }
        }),
      );

      unsubscribers.push(
        subscribeStatusStream("campaign_changed", (data) => {
          if (
            data?.type === "campaign_status_changed" ||
            data?.type === "campaign_activation_changed" ||
            data?.type === "campaign_updated"
          ) {
            loadCampaignsRef.current?.();
          }
        }),
      );
    }

    return () => {
      for (const unsub of unsubscribers) {
        try {
          unsub();
        } catch (_) {}
      }
      stopFallbackPolling();
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
        // Do not optimistically force the requested value into the header.
        // Changing from "Agent Not Answering" to "Available" can immediately
        // offer a queued call and persist/broadcast "Busy" before this PUT
        // resolves. If we set newStatus here, the selector briefly flashes
        // Available after the DB has already moved the agent back to Busy.
        if (data.status) {
          setStatus(data.status);
        } else if (loadStatusRef.current) {
          await loadStatusRef.current();
        }
      } else {
        notify({ title: "Status update failed", description: data.error || "Failed to update status", variant: "error" });
      }
    } catch (err) {
      notify({ title: "Status update failed", description: "Failed to update status. Please try again.", variant: "error" });
    }
  };

  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Button asChild variant="ghost" size="sm" title="Open documentation">
          <Link href="/help">
            <IconBook2 aria-hidden="true" className="text-sky-500" />
            <span>Docs</span>
          </Link>
        </Button>
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
