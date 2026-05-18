"use client";

import { useEffect, useMemo, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

export function CampaignActivationSelector({ campaigns = [], onUpdate }) {
  const [saving, setSaving] = useState(false);
  const [localCampaigns, setLocalCampaigns] = useState(campaigns);

  useEffect(() => {
    setLocalCampaigns(campaigns);
  }, [campaigns]);

  const activeCampaign = useMemo(
    () => localCampaigns.find((campaign) => campaign.activated),
    [localCampaigns],
  );

  const handleChange = async (campaignId) => {
    setSaving(true);
    try {
      const res = await fetch("/api/contact-center/agent/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId: campaignId === "none" ? null : campaignId }),
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

  return (
    <Select value={activeCampaign?.id || "none"} onValueChange={handleChange} disabled={saving}>
      <SelectTrigger className="h-9 w-[240px]">
        <SelectValue placeholder="Campaign" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">No campaign</SelectItem>
        {localCampaigns.map((campaign) => (
          <SelectItem key={campaign.id} value={campaign.id} disabled={campaign.status !== "running"}>
            <span className="flex items-center gap-2">
              <span>{campaign.name}</span>
              <Badge variant="outline" className="text-[10px] uppercase">
                {campaign.mode}
              </Badge>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
