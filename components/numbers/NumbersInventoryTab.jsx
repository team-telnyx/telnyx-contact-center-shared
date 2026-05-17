"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { countries } from "@/lib/countries";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
  IconEdit,
  IconTrash,
  IconPhone,
  IconMessageCircle,
  IconShieldCheck,
  IconWifi,
  IconVideo,
  IconPrinter,
  IconAlertCircle,
  IconWorld,
  IconMail,
  IconCheck,
  IconSelector,
  IconPhoneCall,
  IconUserCheck,
  IconMicrophone,
  IconHdr,
  IconPhoneCalling,
  IconAmbulance,
} from "@tabler/icons-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { notify } from "@/components/ToastNotify";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
import NumberEditSheet from "@/components/numbers/NumberEditSheet";

export default function NumbersInventoryTab() {
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({
    status: "all",
    phone_number: "",
    number_type: "all",
    country: "all",
  });
  const [loading, setLoading] = useState(false);
  const [connections, setConnections] = useState([]);
  const [messagingProfiles, setMessagingProfiles] = useState([]);
  const [updating, setUpdating] = useState({});
  const [numberFeatures, setNumberFeatures] = useState({});
  const [openConnectionPopovers, setOpenConnectionPopovers] = useState({});
  const [openMessagingPopovers, setOpenMessagingPopovers] = useState({});
  const [confirmDialog, setConfirmDialog] = useState({
    open: false,
    type: null, // 'connection' or 'messaging'
    numberId: null,
    oldValue: null,
    newValue: null,
    oldName: null,
    newName: null,
  });
  const [countryPopoverOpen, setCountryPopoverOpen] = useState(false);
  const [editSheetOpen, setEditSheetOpen] = useState(false);
  const [selectedNumber, setSelectedNumber] = useState(null);

  const query = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));
    if (filters.status && filters.status !== "all")
      sp.set("status", filters.status);
    if (filters.phone_number) sp.set("phone_number", filters.phone_number);
    if (filters.number_type && filters.number_type !== "all")
      sp.set("number_type", filters.number_type);
    if (filters.country && filters.country !== "all")
      sp.set("country", filters.country);
    return sp.toString();
  }, [page, pageSize, filters]);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/numbers?${query}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok)
        throw new Error(data?.error || "Failed to fetch phone numbers");
      const numbers = data.data || [];
      setItems(numbers);
      // Telnyx returns total_results in meta
      const totalCount = Number(
        data.meta?.total_results ||
          data.meta?.total_count ||
          data.meta?.total ||
          0
      );
      setTotal(totalCount);

      // Fetch features for all numbers on this page
      if (numbers.length > 0) {
        loadNumberFeatures(numbers.map((n) => n.phone_number));
      }
    } catch (err) {
      notify({ title: "Load failed", description: String(err.message || err), variant: "error" });
    } finally {
      setLoading(false);
    }
  }

  async function loadNumberFeatures(phoneNumbers) {
    try {
      const res = await fetch("/api/admin/numbers/features", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone_numbers: phoneNumbers }),
      });
      const data = await res.json();
      if (res.ok && data.data) {
        // Convert array to map for easy lookup
        const featuresMap = {};
        data.data.forEach((item) => {
          featuresMap[item.phone_number] = item.features || [];
        });
        setNumberFeatures(featuresMap);
      }
    } catch (err) {
      console.error("Failed to load number features:", err);
    }
  }

  async function loadConnections() {
    try {
      const res = await fetch("/api/admin/connections");
      const data = await res.json();
      if (res.ok) {
        setConnections(data.data || []);
      }
    } catch (err) {
      console.error("Failed to load connections:", err);
    }
  }

  async function loadMessagingProfiles() {
    try {
      const res = await fetch("/api/admin/messaging-profiles");
      const data = await res.json();
      if (res.ok) {
        setMessagingProfiles(data.data || []);
      }
    } catch (err) {
      console.error("Failed to load messaging profiles:", err);
    }
  }

  useEffect(() => {
    load();
  }, [query]);

  useEffect(() => {
    loadConnections();
    loadMessagingProfiles();
  }, []);

  function requestConnectionChange(number, newConnectionId) {
    const oldConnection = connections.find(
      (c) => c.id === number.connection_id
    );
    const newConnection = connections.find((c) => c.id === newConnectionId);

    setConfirmDialog({
      open: true,
      type: "connection",
      numberId: number.id,
      phoneNumber: number.phone_number,
      oldValue: number.connection_id,
      newValue: newConnectionId,
      oldName:
        number.connection_name ||
        oldConnection?.connection_name ||
        oldConnection?.friendly_name ||
        number.connection_id ||
        "None",
      newName:
        newConnection?.connection_name ||
        newConnection?.friendly_name ||
        newConnectionId ||
        "None",
    });
  }

  async function handleConnectionChange(phoneNumberId, connectionId) {
    setUpdating((prev) => ({ ...prev, [`conn_${phoneNumberId}`]: true }));
    try {
      const res = await fetch(`/api/admin/numbers/${phoneNumberId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connection_id: connectionId || null }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data?.error || "Failed to update connection");
      }
      notify({ title: "Connection updated", variant: "success" });
      load();
    } catch (err) {
      notify({ title: "Update failed", description: String(err.message || err), variant: "error" });
    } finally {
      setUpdating((prev) => ({ ...prev, [`conn_${phoneNumberId}`]: false }));
    }
  }

  function requestMessagingProfileChange(number, newProfileId) {
    const oldProfile = messagingProfiles.find(
      (p) => p.id === number.messaging_profile_id
    );
    const newProfile = messagingProfiles.find((p) => p.id === newProfileId);

    setConfirmDialog({
      open: true,
      type: "messaging",
      numberId: number.id,
      phoneNumber: number.phone_number,
      oldValue: number.messaging_profile_id,
      newValue: newProfileId,
      oldName:
        number.messaging_profile_name ||
        oldProfile?.name ||
        oldProfile?.friendly_name ||
        number.messaging_profile_id ||
        "None",
      newName:
        newProfile?.name || newProfile?.friendly_name || newProfileId || "None",
    });
  }

  async function handleMessagingProfileChange(
    phoneNumberId,
    messagingProfileId
  ) {
    setUpdating((prev) => ({ ...prev, [`msg_${phoneNumberId}`]: true }));
    try {
      const res = await fetch(`/api/admin/numbers/${phoneNumberId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_profile_id: messagingProfileId || null,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data?.error || "Failed to update messaging profile");
      }
      notify({ title: "Messaging profile updated", variant: "success" });
      load();
    } catch (err) {
      notify({ title: "Update failed", description: String(err.message || err), variant: "error" });
    } finally {
      setUpdating((prev) => ({ ...prev, [`msg_${phoneNumberId}`]: false }));
    }
  }

  function handleConfirmChange() {
    if (confirmDialog.type === "connection") {
      handleConnectionChange(confirmDialog.numberId, confirmDialog.newValue);
    } else if (confirmDialog.type === "messaging") {
      handleMessagingProfileChange(
        confirmDialog.numberId,
        confirmDialog.newValue
      );
    }
    setConfirmDialog({ ...confirmDialog, open: false });
  }

  async function onDelete(id) {
    if (!id) return;
    try {
      const r = await fetch(`/api/admin/numbers/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (r.ok) {
        notify({ title: "Number deleted", variant: "success" });
        load();
      } else {
        const d = await r.json().catch(() => ({}));
        notify({ title: "Delete failed", description: d?.error || "", variant: "error" });
      }
    } catch (err) {
      notify({ title: "Delete failed", description: String(err.message || err), variant: "error" });
    }
  }

  function statusBadgeColor(status) {
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
  }

  function numberTypeBadgeColor(type) {
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
  }

  function renderNumberFeatures(phoneNumber) {
    const features = numberFeatures[phoneNumber] || [];

    if (features.length === 0) {
      return <span className="text-muted-foreground text-xs">Loading...</span>;
    }

    const featureIcons = {
      voice: { icon: IconPhone, color: "text-[#00C08B]", label: "Voice" },
      sms: { icon: IconMessageCircle, color: "text-[#00C08B]", label: "SMS" },
      mms: { icon: IconMessageCircle, color: "text-[#00C08B]", label: "MMS" },
      fax: { icon: IconPrinter, color: "text-[#00C08B]", label: "Fax" },
      emergency: {
        icon: IconAmbulance,
        color: "text-[#00C08B]",
        label: "Emergency",
      },
      hd_voice: { icon: IconHdr, color: "text-[#00C08B]", label: "HD Voice" },
      international_sms: {
        icon: IconWorld,
        color: "text-[#00C08B]",
        label: "International SMS",
      },
    };

    return (
      <TooltipProvider>
        <div className="flex gap-1.5 flex-wrap">
          {features.map((feature) => {
            const featureLower = feature.toLowerCase();
            const featureData = featureIcons[featureLower];
            if (!featureData) return null;
            const Icon = featureData.icon;

            return (
              <Tooltip key={feature}>
                <TooltipTrigger asChild>
                  <div className={`${featureData.color} cursor-help`}>
                    <Icon className="size-4" />
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="font-medium">{featureData.label}</p>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </TooltipProvider>
    );
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
        <div>
          <label className="text-xs">Phone Number</label>
          <Input
            value={filters.phone_number}
            onChange={(e) =>
              setFilters((f) => ({ ...f, phone_number: e.target.value }))
            }
            placeholder="Search number…"
            className="h-9"
          />
        </div>
        <div>
          <label className="text-xs">Type</label>
          <Select
            value={filters.number_type || "all"}
            onValueChange={(value) =>
              setFilters((f) => ({ ...f, number_type: value }))
            }
          >
            <SelectTrigger className="w-full h-9">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="local">Local</SelectItem>
              <SelectItem value="toll_free">Toll Free</SelectItem>
              <SelectItem value="mobile">Mobile</SelectItem>
              <SelectItem value="national">National</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-xs">Status</label>
          <Select
            value={filters.status || "all"}
            onValueChange={(value) =>
              setFilters((f) => ({ ...f, status: value }))
            }
          >
            <SelectTrigger className="w-full h-9">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="purchase-pending">Purchase Pending</SelectItem>
              <SelectItem value="port-pending">Port Pending</SelectItem>
              <SelectItem value="emergency-only">Emergency Only</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-xs">Country</label>
          <Popover
            open={countryPopoverOpen}
            onOpenChange={setCountryPopoverOpen}
          >
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                className="w-full h-9 justify-between text-xs font-normal"
              >
                {filters.country && filters.country !== "all" ? (
                  <span className="flex items-center gap-2">
                    <span className="text-base leading-none">
                      {countries.find((c) => c.code === filters.country)?.flag}
                    </span>
                    <span>
                      {countries.find((c) => c.code === filters.country)
                        ?.name || filters.country}
                    </span>
                  </span>
                ) : (
                  "All Countries"
                )}
                <IconSelector className="ml-2 h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[300px] p-0">
              <Command>
                <CommandInput placeholder="Search country..." className="h-9" />
                <CommandEmpty>No country found.</CommandEmpty>
                <CommandGroup className="max-h-[300px] overflow-auto">
                  <CommandItem
                    value="all-countries"
                    onSelect={() => {
                      setFilters((f) => ({ ...f, country: "all" }));
                      setCountryPopoverOpen(false);
                    }}
                  >
                    <IconCheck
                      className={`mr-2 h-4 w-4 shrink-0 ${
                        !filters.country || filters.country === "all"
                          ? "opacity-100"
                          : "opacity-0"
                      }`}
                    />
                    <span>All Countries</span>
                  </CommandItem>
                  {countries.map((country) => (
                    <CommandItem
                      key={country.code}
                      value={`${country.name}-${country.code}`}
                      onSelect={() => {
                        setFilters((f) => ({ ...f, country: country.code }));
                        setCountryPopoverOpen(false);
                      }}
                    >
                      <IconCheck
                        className={`mr-2 h-4 w-4 shrink-0 ${
                          filters.country === country.code
                            ? "opacity-100"
                            : "opacity-0"
                        }`}
                      />
                      <span className="text-base leading-none mr-2">
                        {country.flag}
                      </span>
                      <span>{country.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
        <div className="md:col-span-2 flex gap-2 justify-end">
          <Button
            variant="secondary"
            onClick={() =>
              setFilters({
                status: "all",
                phone_number: "",
                number_type: "all",
                country: "all",
              })
            }
            className="h-9"
          >
            Clear
          </Button>
          <Button onClick={() => load()} disabled={loading} className="h-9">
            {loading ? "Loading…" : "Refresh"}
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="border rounded-md overflow-hidden p-4 space-y-2">
          <Skeleton className="h-6 w-40" />
          {[...Array(8)].map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : (
        <div className="border rounded-md overflow-hidden">
          <div className="overflow-x-auto">
            <Table className="table-fixed min-w-[1200px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="px-[10px] w-[100px]">Number</TableHead>
                  <TableHead className="px-[10px] w-[80px]">Type</TableHead>
                  <TableHead className="px-[10px] w-[80px]">Status</TableHead>
                  <TableHead className="px-[10px] w-[140px]">
                    Services
                  </TableHead>
                  <TableHead className="px-[10px] w-[180px]">
                    Voice Connection
                  </TableHead>
                  <TableHead className="px-[10px] w-[180px]">
                    Messaging Profile
                  </TableHead>
                  <TableHead className="px-[10px] w-[100px]">Country</TableHead>
                  <TableHead className="px-[10px] w-[100px] text-right">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((number) => {
                  const rowId = number.id;
                  // Get actual features from API
                  const actualFeatures =
                    numberFeatures[number.phone_number] || [];
                  const hasVoice = actualFeatures.includes("voice");
                  const hasSMS =
                    actualFeatures.includes("sms") ||
                    actualFeatures.includes("mms");
                  return (
                    <Fragment key={rowId}>
                      <TableRow>
                        <TableCell className="px-[10px] text-xs font-mono">
                          {number.phone_number}
                        </TableCell>
                        <TableCell className="px-[10px] text-xs">
                          <Badge
                            className={numberTypeBadgeColor(
                              number.phone_number_type
                            )}
                            variant="outline"
                          >
                            {String(number.phone_number_type || "local")
                              .replace("_", " ")
                              .toUpperCase()}
                          </Badge>
                        </TableCell>
                        <TableCell className="px-[10px] text-xs">
                          <Badge
                            className={statusBadgeColor(number.status)}
                            variant="outline"
                          >
                            {String(number.status || "unknown")
                              .replace("-", " ")
                              .toUpperCase()}
                          </Badge>
                        </TableCell>
                        <TableCell className="px-[10px] text-xs">
                          {renderNumberFeatures(number.phone_number)}
                        </TableCell>
                        <TableCell className="px-[10px] text-xs">
                          {hasVoice ? (
                            <Popover
                              open={openConnectionPopovers[rowId] || false}
                              onOpenChange={(open) =>
                                setOpenConnectionPopovers((prev) => ({
                                  ...prev,
                                  [rowId]: open,
                                }))
                              }
                            >
                              <PopoverTrigger asChild>
                                <Button
                                  variant="outline"
                                  role="combobox"
                                  className="w-full h-8 justify-between text-xs font-normal overflow-hidden"
                                  disabled={updating[`conn_${rowId}`]}
                                >
                                  <span className="truncate block overflow-hidden text-ellipsis whitespace-nowrap">
                                    {number.connection_id
                                      ? number.connection_name ||
                                        connections.find(
                                          (c) => c.id === number.connection_id
                                        )?.connection_name ||
                                        connections.find(
                                          (c) => c.id === number.connection_id
                                        )?.friendly_name ||
                                        number.connection_id
                                      : "None"}
                                  </span>
                                  <IconSelector className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent className="w-[320px] p-0">
                                <Command>
                                  <CommandInput
                                    placeholder="Search connection..."
                                    className="h-9"
                                  />
                                  <CommandEmpty>
                                    No connection found.
                                  </CommandEmpty>
                                  <CommandGroup className="max-h-[250px] overflow-auto">
                                    <CommandItem
                                      value="none"
                                      onSelect={() => {
                                        requestConnectionChange(number, null);
                                        setOpenConnectionPopovers((prev) => ({
                                          ...prev,
                                          [rowId]: false,
                                        }));
                                      }}
                                    >
                                      <IconCheck
                                        className={`mr-2 h-4 w-4 shrink-0 ${
                                          !number.connection_id
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
                                        }-${conn.connection_type || ""}-${
                                          conn.id
                                        }`}
                                        onSelect={() => {
                                          requestConnectionChange(
                                            number,
                                            conn.id
                                          );
                                          setOpenConnectionPopovers((prev) => ({
                                            ...prev,
                                            [rowId]: false,
                                          }));
                                        }}
                                      >
                                        <IconCheck
                                          className={`mr-2 h-4 w-4 shrink-0 ${
                                            number.connection_id === conn.id
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
                          ) : (
                            <span className="text-muted-foreground text-xs">
                              N/A
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="px-[10px] text-xs whitespace-nowrap overflow-hidden">
                          {hasSMS ? (
                            <Popover
                              open={openMessagingPopovers[rowId] || false}
                              onOpenChange={(open) =>
                                setOpenMessagingPopovers((prev) => ({
                                  ...prev,
                                  [rowId]: open,
                                }))
                              }
                            >
                              <PopoverTrigger asChild>
                                <Button
                                  variant="outline"
                                  role="combobox"
                                  className="w-full h-8 justify-between text-xs font-normal overflow-hidden"
                                  disabled={updating[`msg_${rowId}`]}
                                >
                                  <span className="truncate block overflow-hidden text-ellipsis whitespace-nowrap">
                                    {number.messaging_profile_id
                                      ? number.messaging_profile_name ||
                                        messagingProfiles.find(
                                          (p) =>
                                            p.id === number.messaging_profile_id
                                        )?.name ||
                                        messagingProfiles.find(
                                          (p) =>
                                            p.id === number.messaging_profile_id
                                        )?.friendly_name ||
                                        number.messaging_profile_id
                                      : "None"}
                                  </span>
                                  <IconSelector className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent className="w-[320px] p-0">
                                <Command>
                                  <CommandInput
                                    placeholder="Search profile..."
                                    className="h-9"
                                  />
                                  <CommandEmpty>No profile found.</CommandEmpty>
                                  <CommandGroup className="max-h-[250px] overflow-auto">
                                    <CommandItem
                                      value="none"
                                      onSelect={() => {
                                        requestMessagingProfileChange(
                                          number,
                                          null
                                        );
                                        setOpenMessagingPopovers((prev) => ({
                                          ...prev,
                                          [rowId]: false,
                                        }));
                                      }}
                                    >
                                      <IconCheck
                                        className={`mr-2 h-4 w-4 shrink-0 ${
                                          !number.messaging_profile_id
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
                                          requestMessagingProfileChange(
                                            number,
                                            profile.id
                                          );
                                          setOpenMessagingPopovers((prev) => ({
                                            ...prev,
                                            [rowId]: false,
                                          }));
                                        }}
                                      >
                                        <IconCheck
                                          className={`mr-2 h-4 w-4 shrink-0 ${
                                            number.messaging_profile_id ===
                                            profile.id
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
                          ) : (
                            <span className="text-muted-foreground text-xs">
                              N/A
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="px-[10px] text-xs whitespace-nowrap">
                          {number.country_iso_alpha2 ? (
                            <span className="flex items-center gap-1.5">
                              <span className="text-base leading-none">
                                {
                                  countries.find(
                                    (c) => c.code === number.country_iso_alpha2
                                  )?.flag
                                }
                              </span>
                              <span>
                                {countries.find(
                                  (c) => c.code === number.country_iso_alpha2
                                )?.name || number.country_iso_alpha2}
                              </span>
                            </span>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell className="px-[10px] text-xs whitespace-nowrap text-right">
                          <div className="inline-flex items-center gap-2 justify-end">
                            <button
                              className="text-[#00C08B] hover:text-[#00A074] transition-colors"
                              title="Edit number"
                              onClick={() => {
                                setSelectedNumber(number);
                                setEditSheetOpen(true);
                              }}
                            >
                              <IconEdit className="size-4" />
                            </button>
                            {number.deletion_lock_enabled ? (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <button
                                      className="text-gray-400 opacity-50 cursor-not-allowed"
                                      disabled
                                      title="Deletion lock enabled"
                                    >
                                      <IconTrash className="size-4" />
                                    </button>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p>
                                      Deletion lock is enabled for this number
                                    </p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            ) : (
                              <Dialog>
                                <DialogTrigger asChild>
                                  <button
                                    className="text-red-500 hover:text-red-700 transition-colors"
                                    title="Delete number"
                                  >
                                    <IconTrash className="size-4" />
                                  </button>
                                </DialogTrigger>
                                <DialogContent>
                                  <DialogHeader>
                                    <DialogTitle>Delete number?</DialogTitle>
                                    <DialogDescription>
                                      This action cannot be undone. This will
                                      permanently delete the number "
                                      {number.phone_number}".
                                    </DialogDescription>
                                  </DialogHeader>
                                  <div className="flex justify-end gap-2 pt-2">
                                    <DialogClose asChild>
                                      <Button variant="outline">Cancel</Button>
                                    </DialogClose>
                                    <DialogClose asChild>
                                      <Button
                                        variant="destructive"
                                        onClick={() => onDelete(number.id)}
                                      >
                                        Delete
                                      </Button>
                                    </DialogClose>
                                  </div>
                                </DialogContent>
                              </Dialog>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    </Fragment>
                  );
                })}
                {items.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="text-center py-8 text-sm text-muted-foreground"
                    >
                      No phone numbers found
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">Total: {total}</div>
        <div className="flex w-full items-center gap-8 lg:w-fit">
          <div className="hidden items-center gap-2 lg:flex">
            <Label htmlFor="rows-per-page" className="text-sm font-medium">
              Rows per page
            </Label>
            <Select
              value={`${pageSize}`}
              onValueChange={(value) => {
                setPageSize(Number(value));
                setPage(1);
              }}
            >
              <SelectTrigger size="sm" className="w-20" id="rows-per-page">
                <SelectValue placeholder={pageSize} />
              </SelectTrigger>
              <SelectContent side="top">
                {[10, 20, 30, 40, 50].map((size) => (
                  <SelectItem key={size} value={`${size}`}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex w-fit items-center justify-center text-sm font-medium">
            Page {page} of {pageCount}
          </div>
          <div className="ml-auto flex items-center gap-2 lg:ml-0">
            <Button
              variant="outline"
              className="hidden h-8 w-8 p-0 lg:flex"
              onClick={() => setPage(1)}
              disabled={page <= 1}
            >
              <span className="sr-only">Go to first page</span>
              <IconChevronsLeft />
            </Button>
            <Button
              variant="outline"
              className="size-8"
              size="icon"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              <span className="sr-only">Go to previous page</span>
              <IconChevronLeft />
            </Button>
            <Button
              variant="outline"
              className="size-8"
              size="icon"
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              disabled={page >= pageCount}
            >
              <span className="sr-only">Go to next page</span>
              <IconChevronRight />
            </Button>
            <Button
              variant="outline"
              className="hidden size-8 lg:flex"
              size="icon"
              onClick={() => setPage(pageCount)}
              disabled={page >= pageCount}
            >
              <span className="sr-only">Go to last page</span>
              <IconChevronsRight />
            </Button>
          </div>
        </div>
      </div>

      {/* Confirmation Dialog */}
      <Dialog
        open={confirmDialog.open}
        onOpenChange={(open) => setConfirmDialog({ ...confirmDialog, open })}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmDialog.type === "connection"
                ? "Update Voice Connection"
                : "Update Messaging Profile"}
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to update this setting for{" "}
              {confirmDialog.phoneNumber}?
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium min-w-[80px]">From:</span>
                <Badge variant="outline" className="max-w-full">
                  <span className="truncate">{confirmDialog.oldName}</span>
                </Badge>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium min-w-[80px]">To:</span>
                <Badge variant="default" className="max-w-full">
                  <span className="truncate">{confirmDialog.newName}</span>
                </Badge>
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <DialogClose asChild>
              <Button onClick={handleConfirmChange}>Confirm Update</Button>
            </DialogClose>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Sheet */}
      <NumberEditSheet
        open={editSheetOpen}
        onOpenChange={setEditSheetOpen}
        number={selectedNumber}
        connections={connections}
        messagingProfiles={messagingProfiles}
        onUpdate={load}
      />
    </div>
  );
}
