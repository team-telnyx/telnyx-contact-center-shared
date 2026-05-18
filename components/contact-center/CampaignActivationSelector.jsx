"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { IconPlayerPause, IconPlayerPlay, IconPlayerStop } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { campaignModeBadgeClass } from "@/lib/outbound-dialer/agent-campaigns-view-model";

const CAMPAIGN_MODE_LABELS = {
  preview: "PREVIEW",
  progressive: "PROGRESSIVE",
};

function CampaignStatusIcon({ status }) {
  const value = String(status || "").toLowerCase();
  if (value === "running") return <IconPlayerPlay className="h-4 w-4 text-emerald-500" aria-label="Running" />;
  if (value === "paused") return <IconPlayerPause className="h-4 w-4 text-amber-500" aria-label="Paused" />;
  return <IconPlayerStop className="h-4 w-4 text-rose-500" aria-label="Stopped" />;
}

function campaignModeLabel(mode) {
  const value = String(mode || "").toLowerCase();
  return CAMPAIGN_MODE_LABELS[value] || value.toUpperCase();
}

export function CampaignActivationSelector({ campaigns = [], onUpdate }) {
  const [saving, setSaving] = useState(false);
  const [localCampaigns, setLocalCampaigns] = useState(campaigns);

  useEffect(() => {
    setLocalCampaigns(campaigns);
  }, [campaigns]);

  useEffect(() => {
    if (!onUpdate) return undefined;
    const events = new EventSource("/api/user/status-stream");
    const handleCampaignChanged = async (event) => {
      try {
        const data = JSON.parse(event.data || "{}");
        if (data.type === "campaign_status_changed" || data.type === "campaign_activation_changed" || data.type === "campaign_updated") {
          await onUpdate();
        }
      } catch (_) {
        // Ignore malformed SSE payloads.
      }
    };
    events.addEventListener("campaign_changed", handleCampaignChanged);
    return () => events.close();
  }, [onUpdate]);

  const activeCampaigns = useMemo(
    () => localCampaigns.filter((campaign) => campaign.activated),
    [localCampaigns],
  );
  const campaignIds = useMemo(() => activeCampaigns.map((campaign) => campaign.id), [activeCampaigns]);
  const label = activeCampaigns.length === 0
    ? "Campaigns"
    : activeCampaigns.length === 1
      ? activeCampaigns[0].name
      : `${activeCampaigns.length} campaigns`;

  const updateCampaignIds = async (nextCampaignIds) => {
    setSaving(true);
    try {
      const res = await fetch("/api/contact-center/agent/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignIds: nextCampaignIds }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to activate campaign");
      setLocalCampaigns(data.campaigns || []);
      if (onUpdate) await onUpdate();
    } catch (err) {
      alert(err.message || "Failed to activate campaign");
      setLocalCampaigns(campaigns);
    } finally {
      setSaving(false);
    }
  };

  const toggleCampaign = (campaignId, checked) => {
    const next = checked
      ? [...new Set([...campaignIds, campaignId])]
      : campaignIds.filter((id) => id !== campaignId);
    updateCampaignIds(next);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 w-[240px] justify-between" disabled={saving}>
          <span className="truncate">{label}</span>
          {saving ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <ChevronDown className="ml-2 h-4 w-4 opacity-60" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[360px] p-0">
        <div className="px-6 pb-3 pt-5 text-xl font-semibold tracking-tight">Campaign Activation</div>
        <div className="max-h-80 overflow-y-auto pb-4">
          {localCampaigns.length === 0 ? (
            <div className="px-6 py-6 text-center text-sm text-muted-foreground">No campaigns available</div>
          ) : (
            <div className="space-y-1">
              {localCampaigns.map((campaign) => (
                <label
                  key={campaign.id}
                  className="flex cursor-pointer items-center gap-3 px-6 py-2.5 hover:bg-accent"
                >
                  <Checkbox
                    checked={campaignIds.includes(campaign.id)}
                    onCheckedChange={(checked) => toggleCampaign(campaign.id, checked === true)}
                    disabled={saving}
                    className="h-6 w-6 rounded-md"
                  />
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-lg font-semibold leading-none">{campaign.name}</span>
                    <CampaignStatusIcon status={campaign.status} />
                    <Badge variant="outline" className={`shrink-0 rounded-xl px-3 py-1 text-sm font-semibold leading-none tracking-wide ${campaignModeBadgeClass(campaign.mode)}`}>
                      {campaignModeLabel(campaign.mode)}
                    </Badge>
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
