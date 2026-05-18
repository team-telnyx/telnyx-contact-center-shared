"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { agentCampaignStatusBadgeClass } from "@/lib/outbound-dialer/agent-campaigns-view-model";

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
      <PopoverContent align="end" className="w-[320px] p-2">
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          Activate one or more preview/progressive campaigns. Status does not block activation.
        </div>
        <div className="max-h-80 overflow-y-auto space-y-1">
          {localCampaigns.length === 0 ? (
            <div className="px-2 py-6 text-center text-sm text-muted-foreground">No campaigns available</div>
          ) : (
            localCampaigns.map((campaign) => (
              <label
                key={campaign.id}
                className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-accent"
              >
                <Checkbox
                  checked={campaignIds.includes(campaign.id)}
                  onCheckedChange={(checked) => toggleCampaign(campaign.id, checked === true)}
                  disabled={saving}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{campaign.name}</span>
                  <span className="mt-1 flex items-center gap-1.5">
                    <Badge variant="outline" className={`text-[10px] uppercase ${agentCampaignStatusBadgeClass(campaign.status)}`}>
                      {campaign.status}
                    </Badge>
                    <Badge variant="outline" className="text-[10px] uppercase">
                      {campaign.mode}
                    </Badge>
                  </span>
                </span>
              </label>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
