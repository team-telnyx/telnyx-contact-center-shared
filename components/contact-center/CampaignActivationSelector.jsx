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
  if (value === "running") return <IconPlayerPlay className="h-3.5 w-3.5 text-emerald-500" aria-label="Running" />;
  if (value === "paused") return <IconPlayerPause className="h-3.5 w-3.5 text-amber-500" aria-label="Paused" />;
  return <IconPlayerStop className="h-3.5 w-3.5 text-rose-500" aria-label="Stopped" />;
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
        <Button variant="outline" className="w-[240px] justify-between" disabled={saving}>
          <span className="truncate">{label}</span>
          {saving ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <ChevronDown className="ml-2 h-4 w-4 opacity-60" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="space-y-3">
          <div className="font-semibold">Campaign Activation</div>
          {localCampaigns.length === 0 ? (
            <div className="py-4 text-center text-sm text-muted-foreground">No campaigns available</div>
          ) : (
            localCampaigns.map((campaign) => (
              <div key={campaign.id} className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <Checkbox
                    checked={campaignIds.includes(campaign.id)}
                    onCheckedChange={(checked) => toggleCampaign(campaign.id, checked === true)}
                    disabled={saving}
                  />
                  <label className="text-sm font-medium cursor-pointer flex-1">
                    {campaign.name}
                  </label>
                </div>
                <div className="flex items-center gap-1.5">
                  <CampaignStatusIcon status={campaign.status} />
                  <Badge variant="outline" className={`text-xs uppercase ${campaignModeBadgeClass(campaign.mode)}`}>
                    {campaignModeLabel(campaign.mode)}
                  </Badge>
                </div>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
