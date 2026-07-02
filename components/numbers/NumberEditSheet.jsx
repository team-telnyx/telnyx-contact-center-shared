"use client";

import { useState, useEffect } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  IconPhone,
  IconInfoCircle,
  IconPlugConnected,
  IconMicrophone,
  IconTag,
  IconShieldLock,
  IconX,
  IconCheck,
  IconSelector,
  IconMessageCircle,
  IconCalendar,
} from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import { countries } from "@/lib/countries";

export default function NumberEditSheet({
  open,
  onOpenChange,
  number,
  connections = [],
  messagingProfiles = [],
  onUpdate,
}) {
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    messaging_profile_id: "",
    connection_id: "",
    inbound_call_recording_enabled: false,
    inbound_call_recording_format: "mp3",
    inbound_call_recording_channels: "single",
    tags: [],
    deletion_lock_enabled: false,
  });
  const [newTag, setNewTag] = useState("");
  const [connectionPopoverOpen, setConnectionPopoverOpen] = useState(false);
  const [messagingPopoverOpen, setMessagingPopoverOpen] = useState(false);

  // Initialize form data when number changes
  useEffect(() => {
    if (number) {
      setFormData({
        messaging_profile_id: number.messaging_profile_id || "",
        connection_id: number.connection_id || "",
        inbound_call_recording_enabled:
          number.inbound_call_recording_enabled || false,
        inbound_call_recording_format:
          number.inbound_call_recording_format || "mp3",
        inbound_call_recording_channels:
          number.inbound_call_recording_channels || "single",
        tags: number.tags || [],
        deletion_lock_enabled: number.deletion_lock_enabled || false,
      });
    }
  }, [number]);

  if (!number) return null;

  const handleSave = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/numbers/${number.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_profile_id: formData.messaging_profile_id || null,
          connection_id: formData.connection_id || null,
          inbound_call_recording_enabled:
            formData.inbound_call_recording_enabled,
          inbound_call_recording_format: formData.inbound_call_recording_format,
          inbound_call_recording_channels:
            formData.inbound_call_recording_channels,
          tags: formData.tags,
          deletion_lock_enabled: formData.deletion_lock_enabled,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data?.error || "Failed to update number");
      }

      notify({ title: "Number updated successfully", variant: "success" });
      onUpdate?.();
      onOpenChange(false);
    } catch (err) {
      notify({ title: "Update failed", description: String(err.message || err), variant: "error" });
    } finally {
      setLoading(false);
    }
  };

  const addTag = () => {
    if (newTag.trim() && !formData.tags.includes(newTag.trim())) {
      setFormData({
        ...formData,
        tags: [...formData.tags, newTag.trim()],
      });
      setNewTag("");
    }
  };

  const removeTag = (tagToRemove) => {
    setFormData({
      ...formData,
      tags: formData.tags.filter((tag) => tag !== tagToRemove),
    });
  };

  const statusBadgeColor = (status) => {
    switch (String(status || "").toLowerCase()) {
      case "active":
        return "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300";
      case "purchase-pending":
      case "port-pending":
        return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300";
      case "purchase-failed":
      case "port-failed":
        return "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300";
      case "emergency-only":
        return "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300";
      case "deleted":
      case "ported-out":
        return "bg-gray-100 text-gray-700 dark:bg-gray-900/40 dark:text-gray-300";
      default:
        return "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200";
    }
  };

  const numberTypeBadgeColor = (type) => {
    switch (String(type || "").toLowerCase()) {
      case "local":
        return "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300";
      case "toll_free":
        return "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300";
      case "mobile":
        return "bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300";
      case "national":
        return "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300";
      case "shared_cost":
        return "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300";
      default:
        return "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200";
    }
  };

  const formatDate = (dateString) => {
    if (!dateString) return "—";
    try {
      return new Date(dateString).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    } catch {
      return dateString;
    }
  };

  const selectedConnection = connections.find(
    (c) => c.id === formData.connection_id
  );
  const selectedMessagingProfile = messagingProfiles.find(
    (p) => p.id === formData.messaging_profile_id
  );

  const countryInfo = countries.find(
    (c) => c.code === number.country_iso_alpha2
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-[#00C08B]/10">
              <IconPhone className="size-5 text-[#00C08B]" />
            </div>
            <div>
              <SheetTitle className="text-xl">Edit Phone Number</SheetTitle>
              <SheetDescription className="text-sm font-mono">
                {number.phone_number}
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="space-y-3 py-4 px-2">
          {/* Details Section */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <IconInfoCircle className="size-4 text-[#00C08B]" />
                Details
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-0">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground">
                    Phone Number
                  </Label>
                  <div className="text-sm font-mono pt-1">
                    {number.phone_number}
                  </div>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">
                    Status
                  </Label>
                  <div className="pt-1">
                    <Badge
                      className={statusBadgeColor(number.status)}
                      variant="outline"
                    >
                      {String(number.status || "unknown")
                        .replace("-", " ")
                        .toUpperCase()}
                    </Badge>
                  </div>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Type</Label>
                  <div className="pt-1">
                    <Badge
                      className={numberTypeBadgeColor(number.phone_number_type)}
                      variant="outline"
                    >
                      {String(number.phone_number_type || "local")
                        .replace("_", " ")
                        .toUpperCase()}
                    </Badge>
                  </div>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">
                    Purchased Date
                  </Label>
                  <div className="text-sm pt-1 flex items-center gap-1.5">
                    <IconCalendar className="size-3.5 text-muted-foreground" />
                    {formatDate(number.purchased_at || number.created_at)}
                  </div>
                </div>
              </div>
              {countryInfo && (
                <div>
                  <Label className="text-xs text-muted-foreground">
                    Country
                  </Label>
                  <div className="text-sm pt-1 flex items-center gap-2">
                    <span className="text-base leading-none">
                      {countryInfo.flag}
                    </span>
                    <span>{countryInfo.name}</span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Assignment Section */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <IconPlugConnected className="size-4 text-[#00C08B]" />
                Assignment
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-0">
              {/* Voice Connection */}
              <div className="space-y-2">
                <Label className="text-sm flex items-center gap-1.5">
                  <IconPhone className="size-3.5 text-muted-foreground" />
                  Voice Connection
                </Label>
                <Popover
                  open={connectionPopoverOpen}
                  onOpenChange={setConnectionPopoverOpen}
                >
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      className="w-full justify-between font-normal"
                    >
                      <span className="truncate">
                        {selectedConnection
                          ? selectedConnection.connection_name ||
                            selectedConnection.friendly_name ||
                            selectedConnection.id
                          : "Select connection..."}
                      </span>
                      <IconSelector className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[400px] p-0">
                    <Command>
                      <CommandInput
                        placeholder="Search connection..."
                        className="h-9"
                      />
                      <CommandEmpty>No connection found.</CommandEmpty>
                      <CommandGroup className="max-h-[300px] overflow-y-auto">
                        <CommandItem
                          value="none"
                          onSelect={() => {
                            setFormData({ ...formData, connection_id: "" });
                            setConnectionPopoverOpen(false);
                          }}
                        >
                          <IconCheck
                            className={`mr-2 h-4 w-4 shrink-0 ${
                              !formData.connection_id
                                ? "opacity-100"
                                : "opacity-0"
                            }`}
                          />
                          None
                        </CommandItem>
                        {connections.map((conn) => (
                          <CommandItem
                            key={conn.id}
                            value={`${
                              conn.connection_name ||
                              conn.friendly_name ||
                              conn.id
                            }-${conn.id}`}
                            onSelect={() => {
                              setFormData({
                                ...formData,
                                connection_id: conn.id,
                              });
                              setConnectionPopoverOpen(false);
                            }}
                          >
                            <IconCheck
                              className={`mr-2 h-4 w-4 shrink-0 ${
                                formData.connection_id === conn.id
                                  ? "opacity-100"
                                  : "opacity-0"
                              }`}
                            />
                            <div className="flex flex-col flex-1 min-w-0">
                              <span className="truncate">
                                {conn.connection_name ||
                                  conn.friendly_name ||
                                  conn.id}
                              </span>
                              {conn.connection_type && (
                                <span className="text-xs text-muted-foreground">
                                  {conn.connection_type}
                                </span>
                              )}
                            </div>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>

              {/* Messaging Profile */}
              <div className="space-y-2">
                <Label className="text-sm flex items-center gap-1.5">
                  <IconMessageCircle className="size-3.5 text-muted-foreground" />
                  Messaging Profile
                </Label>
                <Popover
                  open={messagingPopoverOpen}
                  onOpenChange={setMessagingPopoverOpen}
                >
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      className="w-full justify-between font-normal"
                    >
                      <span className="truncate">
                        {selectedMessagingProfile
                          ? selectedMessagingProfile.name ||
                            selectedMessagingProfile.friendly_name ||
                            selectedMessagingProfile.id
                          : "Select profile..."}
                      </span>
                      <IconSelector className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[400px] p-0">
                    <Command>
                      <CommandInput
                        placeholder="Search profile..."
                        className="h-9"
                      />
                      <CommandEmpty>No profile found.</CommandEmpty>
                      <CommandGroup className="max-h-[300px] overflow-y-auto">
                        <CommandItem
                          value="none"
                          onSelect={() => {
                            setFormData({
                              ...formData,
                              messaging_profile_id: "",
                            });
                            setMessagingPopoverOpen(false);
                          }}
                        >
                          <IconCheck
                            className={`mr-2 h-4 w-4 shrink-0 ${
                              !formData.messaging_profile_id
                                ? "opacity-100"
                                : "opacity-0"
                            }`}
                          />
                          None
                        </CommandItem>
                        {messagingProfiles.map((profile) => (
                          <CommandItem
                            key={profile.id}
                            value={`${
                              profile.name ||
                              profile.friendly_name ||
                              profile.id
                            }-${profile.id}`}
                            onSelect={() => {
                              setFormData({
                                ...formData,
                                messaging_profile_id: profile.id,
                              });
                              setMessagingPopoverOpen(false);
                            }}
                          >
                            <IconCheck
                              className={`mr-2 h-4 w-4 shrink-0 ${
                                formData.messaging_profile_id === profile.id
                                  ? "opacity-100"
                                  : "opacity-0"
                              }`}
                            />
                            {profile.name ||
                              profile.friendly_name ||
                              profile.id}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>
            </CardContent>
          </Card>

          {/* Recording Options */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <IconMicrophone className="size-4 text-[#00C08B]" />
                Inbound Call Recording
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-0">
              <div className="flex items-center justify-between">
                <Label htmlFor="recording-enabled" className="text-sm">
                  Enable Recording
                </Label>
                <Switch
                  id="recording-enabled"
                  checked={formData.inbound_call_recording_enabled}
                  onCheckedChange={(checked) =>
                    setFormData({
                      ...formData,
                      inbound_call_recording_enabled: checked,
                    })
                  }
                />
              </div>

              {formData.inbound_call_recording_enabled && (
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-sm">Format</Label>
                    <div className="space-y-2">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="recording-format"
                          value="mp3"
                          checked={
                            formData.inbound_call_recording_format === "mp3"
                          }
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              inbound_call_recording_format: e.target.value,
                            })
                          }
                          className="size-4 text-[#00C08B] focus:ring-[#00C08B]"
                        />
                        <span className="text-sm">MP3</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="recording-format"
                          value="wav"
                          checked={
                            formData.inbound_call_recording_format === "wav"
                          }
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              inbound_call_recording_format: e.target.value,
                            })
                          }
                          className="size-4 text-[#00C08B] focus:ring-[#00C08B]"
                        />
                        <span className="text-sm">WAV</span>
                      </label>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-sm">Channels</Label>
                    <div className="space-y-2">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="recording-channels"
                          value="single"
                          checked={
                            formData.inbound_call_recording_channels ===
                            "single"
                          }
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              inbound_call_recording_channels: e.target.value,
                            })
                          }
                          className="size-4 text-[#00C08B] focus:ring-[#00C08B]"
                        />
                        <span className="text-sm">Single</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="recording-channels"
                          value="dual"
                          checked={
                            formData.inbound_call_recording_channels === "dual"
                          }
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              inbound_call_recording_channels: e.target.value,
                            })
                          }
                          className="size-4 text-[#00C08B] focus:ring-[#00C08B]"
                        />
                        <span className="text-sm">Dual</span>
                      </label>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Tags Management */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <IconTag className="size-4 text-[#00C08B]" />
                Tags
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-0">
              <div className="flex gap-2">
                <Input
                  placeholder="Add tag..."
                  value={newTag}
                  onChange={(e) => setNewTag(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addTag();
                    }
                  }}
                />
                <Button onClick={addTag} size="sm" variant="secondary">
                  Add
                </Button>
              </div>
              {formData.tags.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {formData.tags.map((tag, index) => (
                    <Badge
                      key={index}
                      variant="secondary"
                      className="flex items-center gap-1 pr-1"
                    >
                      <span>{tag}</span>
                      <button
                        onClick={() => removeTag(tag)}
                        className="ml-1 rounded-sm hover:bg-muted-foreground/20 transition-colors"
                      >
                        <IconX className="size-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
              {formData.tags.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No tags added yet
                </p>
              )}
            </CardContent>
          </Card>

          {/* Deletion Lock */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <IconShieldLock className="size-4 text-[#00C08B]" />
                Protection
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="deletion-lock" className="text-sm">
                    Prevent Deletion
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    When enabled, this number cannot be deleted
                  </p>
                </div>
                <Switch
                  id="deletion-lock"
                  checked={formData.deletion_lock_enabled}
                  onCheckedChange={(checked) =>
                    setFormData({
                      ...formData,
                      deletion_lock_enabled: checked,
                    })
                  }
                />
              </div>
            </CardContent>
          </Card>
        </div>

        <SheetFooter className="px-6 py-4 border-t flex flex-row justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={loading}>
            {loading ? "Saving..." : "Save Changes"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
