"use client";
import {useVideoDeviceControl} from "@/hooks/use-video-device-control";

import { useEffect, useState } from "react";
import CobrowseAgentViewer from "./CobrowseAgentViewer";

const liveStates = new Set(["pending_consent", "connecting", "active", "reconnecting"]);

export default function CobrowseInteractionWorkspace({ interaction, autoOpen = false, children }) {
  const [session, setSession] = useState(null);
  const [tab, setTab] = useState("interaction");
  const workItemId = interaction.id;
  const device = useVideoDeviceControl(interaction);
  const live = device.canControl && liveStates.has(session?.state);
  const currentTab = live && tab === "cobrowse" ? "cobrowse" : "interaction";
  const interactionLabel = interaction.channel === "chat" ? "Chat" : interaction.channel === "video" ? "Video call"
    : interaction.channel === "sms" ? "SMS" : interaction.channel === "whatsapp" ? "WhatsApp" : "Interaction";
  const panelPrefix = `interaction-cobrowse-${workItemId}`;

  useEffect(() => { setTab(autoOpen ? "cobrowse" : "interaction"); }, [workItemId, autoOpen]);
  useEffect(() => {
    if (interaction.state !== "active") { setSession(null); return undefined; }
    let cancelled = false;
    let timer;
    let epoch = 0;
    async function refresh() {
      const requestEpoch = ++epoch;
      try {
        const response = await fetch(`/api/contact-center/cobrowse/${workItemId}`, { cache: "no-store" });
        const data = await response.json().catch(() => ({}));
        if (!cancelled && requestEpoch === epoch && response.ok) setSession(data.session ? { ...data.session, canControl: data.canControl === true } : null);
        else if (!cancelled && requestEpoch === epoch && response.status === 403) setSession(null);
      } catch { /* A temporary failure must not hide an ongoing session. */ }
      finally { if (!cancelled && requestEpoch === epoch) timer = setTimeout(refresh, 2000); }
    }
    const changed = (event) => {
      if (String(event.detail?.workItemId) !== String(workItemId)) return;
      if (event.detail?.open) setTab("cobrowse");
      clearTimeout(timer);
      void refresh();
    };
    void refresh();
    window.addEventListener("contact-center:cobrowse-changed", changed);
    return () => { cancelled = true; epoch += 1; clearTimeout(timer); window.removeEventListener("contact-center:cobrowse-changed", changed); };
  }, [workItemId, interaction.state]);

  return <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="cobrowse-interaction-workspace">
    {live && <div role="tablist" aria-label="Interaction details view" className="flex shrink-0 items-center gap-1 border-b bg-background px-3 pt-1" onKeyDown={(event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const next = currentTab === "interaction" ? "cobrowse" : "interaction";
      setTab(next);
      event.currentTarget.querySelector(`[data-cobrowse-tab="${next}"]`)?.focus();
    }}>
      <button type="button" role="tab" data-cobrowse-tab="interaction" id={`${panelPrefix}-tab-interaction`} aria-controls={`${panelPrefix}-panel-interaction`} aria-selected={currentTab === "interaction"} tabIndex={currentTab === "interaction" ? 0 : -1} onClick={() => setTab("interaction")}
        className={`border-b-2 px-3 py-2 text-sm font-medium ${currentTab === "interaction" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>{interactionLabel}</button>
      <button type="button" role="tab" data-cobrowse-tab="cobrowse" id={`${panelPrefix}-tab-cobrowse`} aria-controls={`${panelPrefix}-panel-cobrowse`} aria-selected={currentTab === "cobrowse"} tabIndex={currentTab === "cobrowse" ? 0 : -1} onClick={() => setTab("cobrowse")}
        className={`flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium ${currentTab === "cobrowse" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>Co-browsing<span className={`size-1.5 rounded-full ${session.state === "pending_consent" ? "bg-amber-500" : "bg-emerald-500"}`} aria-hidden="true" /></button>
    </div>}
    <div role={live ? "tabpanel" : undefined} id={`${panelPrefix}-panel-interaction`} aria-labelledby={live ? `${panelPrefix}-tab-interaction` : undefined} hidden={currentTab !== "interaction"} className={currentTab === "interaction" ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"}>{children}</div>
    {live && currentTab === "cobrowse" && <div role="tabpanel" id={`${panelPrefix}-panel-cobrowse`} aria-labelledby={`${panelPrefix}-tab-cobrowse`} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <CobrowseAgentViewer interaction={interaction} session={session} />
    </div>}
  </div>;
}
