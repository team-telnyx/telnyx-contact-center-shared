"use client";

import { Fragment, useState, useEffect } from "react";
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
  IconSearch,
  IconPhone,
  IconMessageCircle,
  IconShieldCheck,
  IconWifi,
  IconVideo,
  IconPrinter,
  IconAlertCircle,
  IconWorld,
  IconShoppingCart,
  IconCheck,
  IconClock,
  IconX,
  IconSelector,
  IconChevronDown,
  IconChevronUp,
} from "@tabler/icons-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

// Helper function to get location (city) from region_information
function getLocationFromRegionInfo(regionInfo) {
  if (!regionInfo || !Array.isArray(regionInfo)) return null;
  const locationRegion = regionInfo.find((r) => r.region_type === "location");
  return locationRegion?.region_name || null;
}

// Helper function to get state from region_information
function getStateFromRegionInfo(regionInfo) {
  if (!regionInfo || !Array.isArray(regionInfo)) return null;
  const stateRegion = regionInfo.find((r) => r.region_type === "state");
  return stateRegion?.region_name || null;
}

export default function NumbersSearchTab() {
  const [searchParams, setSearchParams] = useState({
    country_code: "US",
    search_by: "area_code", // area_code or city_region
    area_code: "",
    region: "",
    phone_number_contains: "",
    phone_number_starts_with: "",
    phone_number_ends_with: "",
    phone_number_type: "local",
    features: [],
    limit: 20,
    // Advanced search options
    best_effort: false,
    quickship: false,
    reservable: false,
    exclude_held_numbers: false,
    exclude_prev_owned_numbers: false,
    telnyx_bundle: false,
    consecutive: "",
  });
  const [searchResults, setSearchResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedNumbers, setSelectedNumbers] = useState([]);
  const [ordering, setOrdering] = useState(false);
  const [orderStatus, setOrderStatus] = useState(null);
  const [showOrderStatus, setShowOrderStatus] = useState(false);
  const [showOrderConfirmation, setShowOrderConfirmation] = useState(false);
  const [areaCodePopoverOpen, setAreaCodePopoverOpen] = useState(false);
  const [regionPopoverOpen, setRegionPopoverOpen] = useState(false);
  const [showAdvancedSearch, setShowAdvancedSearch] = useState(false);

  // Area codes and regions data
  const [areaCodes, setAreaCodes] = useState([]);
  const [loadingAreaCodes, setLoadingAreaCodes] = useState(false);
  const [areaCodeSearchQuery, setAreaCodeSearchQuery] = useState("");
  const [regions, setRegions] = useState([]);
  const [loadingRegions, setLoadingRegions] = useState(false);
  const [regionSearchQuery, setRegionSearchQuery] = useState("");

  // Load area codes when search_by changes to area_code
  useEffect(() => {
    if (searchParams.search_by === "area_code") {
      loadAreaCodes();
    }
  }, [searchParams.search_by]);

  // Load regions with debounce when user types
  useEffect(() => {
    const timer = setTimeout(() => {
      if (
        searchParams.search_by === "city_region" &&
        regionSearchQuery.length >= 3
      ) {
        loadRegions(regionSearchQuery);
      } else if (regionSearchQuery.length < 3) {
        setRegions([]);
      }
    }, 300); // Debounce

    return () => clearTimeout(timer);
  }, [regionSearchQuery, searchParams.search_by]);

  // Load area codes from new endpoint
  async function loadAreaCodes() {
    setLoadingAreaCodes(true);
    try {
      const res = await fetch("/api/numbers/area-codes?country=US");
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to load area codes");
      setAreaCodes(data);
    } catch (err) {
      console.error("Failed to load area codes:", err);
      toast.error("Failed to load area codes");
    } finally {
      setLoadingAreaCodes(false);
    }
  }

  // Load regions via typeahead
  async function loadRegions(query) {
    if (!query || query.length < 3) {
      setRegions([]);
      return;
    }

    setLoadingRegions(true);
    try {
      const res = await fetch(
        `/api/admin/numbers/lerg-typeahead?query=${encodeURIComponent(
          query
        )}&country_iso=US`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to load regions");

      // Format regions based on type
      const formattedRegions =
        data.data
          ?.map((item) => {
            if (item.type === "location") {
              const city = item.city || "";
              const state = item.state ? `, ${item.state}` : "";
              return {
                value: item.city,
                label: `${city}${state}`,
                raw: item,
              };
            } else if (item.type === "rate_center") {
              const rcName = item.rc_name || "";
              const state = item.state ? `, ${item.state}` : "";
              return {
                value: item.rc_name,
                label: `${rcName}${state} [Rate Center]`,
                raw: item,
              };
            }
            return null;
          })
          .filter(Boolean) || [];

      setRegions(formattedRegions);
    } catch (err) {
      console.error("Failed to load regions:", err);
    } finally {
      setLoadingRegions(false);
    }
  }

  async function handleSearch() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (searchParams.country_code)
        params.set("country_code", searchParams.country_code);

      // Handle area code or region search
      if (searchParams.search_by === "area_code" && searchParams.area_code) {
        params.set("national_destination_code", searchParams.area_code);
      } else if (
        searchParams.search_by === "city_region" &&
        searchParams.region
      ) {
        // Try to determine if it's a city or rate center based on the stored value
        const selectedRegion = regions.find(
          (r) => r.value === searchParams.region
        );
        if (selectedRegion) {
          if (selectedRegion.raw.type === "location") {
            params.set("locality", selectedRegion.raw.city);
            if (selectedRegion.raw.state) {
              params.set("administrative_area", selectedRegion.raw.state);
            }
          } else if (selectedRegion.raw.type === "rate_center") {
            params.set("rate_center", selectedRegion.raw.rc_name);
            if (selectedRegion.raw.state) {
              params.set("administrative_area", selectedRegion.raw.state);
            }
          }
        }
      }

      if (searchParams.phone_number_contains)
        params.set("phone_number_contains", searchParams.phone_number_contains);
      if (searchParams.phone_number_starts_with)
        params.set(
          "phone_number_starts_with",
          searchParams.phone_number_starts_with
        );
      if (searchParams.phone_number_ends_with)
        params.set(
          "phone_number_ends_with",
          searchParams.phone_number_ends_with
        );
      if (searchParams.phone_number_type)
        params.set("phone_number_type", searchParams.phone_number_type);
      if (searchParams.features.length > 0)
        params.set("features", searchParams.features.join(","));
      params.set("limit", String(searchParams.limit));

      // Advanced search options
      if (searchParams.best_effort)
        params.set("best_effort", String(searchParams.best_effort));
      if (searchParams.quickship)
        params.set("quickship", String(searchParams.quickship));
      if (searchParams.reservable)
        params.set("reservable", String(searchParams.reservable));
      if (searchParams.exclude_held_numbers)
        params.set(
          "exclude_held_numbers",
          String(searchParams.exclude_held_numbers)
        );
      if (searchParams.exclude_prev_owned_numbers)
        params.set(
          "exclude_prev_owned_numbers",
          String(searchParams.exclude_prev_owned_numbers)
        );
      if (searchParams.telnyx_bundle)
        params.set("telnyx_bundle", String(searchParams.telnyx_bundle));
      if (searchParams.consecutive)
        params.set("consecutive", String(searchParams.consecutive));

      const res = await fetch(`/api/admin/numbers/search?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Search failed");
      setSearchResults(data.data || []);
      setSelectedNumbers([]);
      toast.success(`Found ${data.data?.length || 0} available numbers`);
    } catch (err) {
      toast.error("Search failed", {
        description: String(err.message || err),
      });
    } finally {
      setLoading(false);
    }
  }

  function handleOrderClick() {
    if (selectedNumbers.length === 0) {
      toast.error("Please select at least one number");
      return;
    }
    setShowOrderConfirmation(true);
  }

  async function handleOrderConfirm() {
    setShowOrderConfirmation(false);
    setOrdering(true);
    try {
      const res = await fetch("/api/admin/numbers/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone_numbers: selectedNumbers }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Order failed");
      setOrderStatus(data.data);
      setShowOrderStatus(true);
      toast.success("Order placed successfully!");
    } catch (err) {
      toast.error("Order failed", {
        description: String(err.message || err),
      });
    } finally {
      setOrdering(false);
    }
  }

  function toggleNumberSelection(phoneNumber) {
    setSelectedNumbers((prev) =>
      prev.includes(phoneNumber)
        ? prev.filter((n) => n !== phoneNumber)
        : [...prev, phoneNumber]
    );
  }

  function toggleFeature(feature) {
    setSearchParams((prev) => ({
      ...prev,
      features: prev.features.includes(feature)
        ? prev.features.filter((f) => f !== feature)
        : [...prev.features, feature],
    }));
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
      default:
        return "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200";
    }
  }

  function renderFeatures(features) {
    if (!features || features.length === 0)
      return <span className="text-muted-foreground">—</span>;

    const featureIcons = {
      voice: { icon: IconPhone, color: "text-blue-500", label: "Voice" },
      sms: { icon: IconMessageCircle, color: "text-green-500", label: "SMS" },
      mms: { icon: IconMessageCircle, color: "text-purple-500", label: "MMS" },
      fax: { icon: IconPrinter, color: "text-orange-500", label: "Fax" },
      emergency: {
        icon: IconAlertCircle,
        color: "text-red-500",
        label: "Emergency",
      },
      hd_voice: { icon: IconVideo, color: "text-teal-500", label: "HD Voice" },
      international_sms: {
        icon: IconWorld,
        color: "text-indigo-500",
        label: "International SMS",
      },
    };

    return (
      <TooltipProvider>
        <div className="flex gap-1 flex-wrap">
          {features.map((feature, idx) => {
            const featureName =
              typeof feature === "string" ? feature : feature?.name || "";
            const featureKey = featureName.toLowerCase();
            const featureData = featureIcons[featureKey];
            if (!featureData) return null;
            const Icon = featureData.icon;
            return (
              <Tooltip key={`${featureName}-${idx}`}>
                <TooltipTrigger asChild>
                  <div className={`${featureData.color}`}>
                    <Icon className="size-4" />
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{featureData.label}</p>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </TooltipProvider>
    );
  }

  function orderStatusBadge(status) {
    switch (String(status || "").toLowerCase()) {
      case "success":
      case "completed":
        return (
          <Badge className="bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">
            <IconCheck className="size-3 mr-1" /> Success
          </Badge>
        );
      case "pending":
        return (
          <Badge className="bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300">
            <IconClock className="size-3 mr-1" /> Pending
          </Badge>
        );
      case "failed":
        return (
          <Badge className="bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">
            <IconX className="size-3 mr-1" /> Failed
          </Badge>
        );
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  }

  return (
    <div className="space-y-6">
      <div className="border rounded-lg p-4 space-y-4">
        <h3 className="text-sm font-semibold">Search Criteria</h3>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <label className="text-xs font-medium">Country</label>
            <div className="flex items-center gap-2 h-9 px-3 border rounded-md bg-muted/50">
              <span className="text-base leading-none">🇺🇸</span>
              <span className="text-sm">United States</span>
            </div>
          </div>

          <div>
            <label className="text-xs font-medium">Search By</label>
            <Select
              value={searchParams.search_by}
              onValueChange={(value) => {
                setSearchParams((p) => ({
                  ...p,
                  search_by: value,
                  area_code: "",
                  region: "",
                }));
                setRegionSearchQuery("");
                setRegions([]);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="area_code">Area Code</SelectItem>
                <SelectItem value="city_region">State / Region</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="text-xs font-medium">
              {searchParams.search_by === "area_code"
                ? "Area Code"
                : "State / Region"}
            </label>
            {searchParams.search_by === "area_code" ? (
              <Popover
                open={areaCodePopoverOpen}
                onOpenChange={(open) => {
                  setAreaCodePopoverOpen(open);
                  if (!open) setAreaCodeSearchQuery("");
                }}
              >
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    disabled={loadingAreaCodes}
                    className="w-full h-9 justify-between text-xs font-normal"
                  >
                    {searchParams.area_code
                      ? areaCodes.find(
                          (c) => c.value === searchParams.area_code
                        )?.label || searchParams.area_code
                      : "Select area code"}
                    <IconSelector className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[300px] p-0">
                  <Command shouldFilter={false}>
                    <CommandInput
                      placeholder="Filter area codes..."
                      className="h-9"
                      value={areaCodeSearchQuery}
                      onValueChange={setAreaCodeSearchQuery}
                    />
                    <CommandEmpty>
                      {loadingAreaCodes ? "Loading..." : "No area code found."}
                    </CommandEmpty>
                    <CommandGroup className="max-h-[300px] overflow-auto">
                      {areaCodes
                        .filter((code) =>
                          code.value
                            .toLowerCase()
                            .startsWith(areaCodeSearchQuery.toLowerCase())
                        )
                        .map((code) => (
                          <CommandItem
                            key={code.value}
                            value={code.value}
                            onSelect={() => {
                              setSearchParams((p) => ({
                                ...p,
                                area_code: code.value,
                              }));
                              setAreaCodePopoverOpen(false);
                              setAreaCodeSearchQuery("");
                            }}
                          >
                            <IconCheck
                              className={`mr-2 h-4 w-4 shrink-0 ${
                                searchParams.area_code === code.value
                                  ? "opacity-100"
                                  : "opacity-0"
                              }`}
                            />
                            <span className="text-xs">{code.label}</span>
                          </CommandItem>
                        ))}
                    </CommandGroup>
                  </Command>
                </PopoverContent>
              </Popover>
            ) : (
              <Popover
                open={regionPopoverOpen}
                onOpenChange={setRegionPopoverOpen}
              >
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    className="w-full h-9 justify-between text-xs font-normal"
                  >
                    {searchParams.region
                      ? regions.find((r) => r.value === searchParams.region)
                          ?.label || searchParams.region
                      : "Type at least 3 characters..."}
                    <IconSelector className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[400px] p-0">
                  <Command shouldFilter={false}>
                    <CommandInput
                      placeholder="Type city or region name..."
                      className="h-9"
                      value={regionSearchQuery}
                      onValueChange={setRegionSearchQuery}
                    />
                    <CommandEmpty>
                      {loadingRegions
                        ? "Searching..."
                        : regionSearchQuery.length < 3
                        ? "Type at least 3 characters to search"
                        : "No regions found."}
                    </CommandEmpty>
                    <CommandGroup className="max-h-[300px] overflow-auto">
                      {regions.map((region, idx) => (
                        <CommandItem
                          key={`${region.value}-${idx}`}
                          value={region.value}
                          onSelect={() => {
                            setSearchParams((p) => ({
                              ...p,
                              region: region.value,
                            }));
                            setRegionPopoverOpen(false);
                          }}
                        >
                          <IconCheck
                            className={`mr-2 h-4 w-4 shrink-0 ${
                              searchParams.region === region.value
                                ? "opacity-100"
                                : "opacity-0"
                            }`}
                          />
                          <span className="text-xs">{region.label}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </Command>
                </PopoverContent>
              </Popover>
            )}
          </div>

          <div>
            <label className="text-xs font-medium">Number Type</label>
            <Select
              value={searchParams.phone_number_type}
              onValueChange={(value) =>
                setSearchParams((p) => ({ ...p, phone_number_type: value }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">Local</SelectItem>
                <SelectItem value="toll_free">Toll Free</SelectItem>
                <SelectItem value="mobile">Mobile</SelectItem>
                <SelectItem value="national">National</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div>
          <label className="text-xs font-medium mb-2 block">Features</label>
          <div className="flex flex-wrap gap-2">
            {[
              "voice",
              "sms",
              "mms",
              "fax",
              "emergency",
              "hd_voice",
              "international_sms",
            ].map((feature) => (
              <div key={feature} className="flex items-center space-x-2">
                <Checkbox
                  id={feature}
                  checked={searchParams.features.includes(feature)}
                  onCheckedChange={() => toggleFeature(feature)}
                />
                <label
                  htmlFor={feature}
                  className="text-xs font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                >
                  {feature.replace("_", " ").toUpperCase()}
                </label>
              </div>
            ))}
          </div>
        </div>

        {/* Advanced Search Section */}
        <div className="border-t pt-4">
          <button
            type="button"
            onClick={() => setShowAdvancedSearch(!showAdvancedSearch)}
            className="flex items-center gap-2 text-sm font-semibold hover:text-primary transition-colors"
          >
            {showAdvancedSearch ? (
              <IconChevronUp className="size-4" />
            ) : (
              <IconChevronDown className="size-4" />
            )}
            Advanced Search
          </button>

          {showAdvancedSearch && (
            <div className="mt-4 space-y-4">
              {/* Number Pattern Filters */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div>
                  <label className="text-xs font-medium">Starts With</label>
                  <Input
                    value={searchParams.phone_number_starts_with}
                    onChange={(e) =>
                      setSearchParams((p) => ({
                        ...p,
                        phone_number_starts_with: e.target.value,
                      }))
                    }
                    placeholder="e.g., 212"
                  />
                </div>

                <div>
                  <label className="text-xs font-medium">Contains</label>
                  <Input
                    value={searchParams.phone_number_contains}
                    onChange={(e) =>
                      setSearchParams((p) => ({
                        ...p,
                        phone_number_contains: e.target.value,
                      }))
                    }
                    placeholder="e.g., 555"
                  />
                </div>

                <div>
                  <label className="text-xs font-medium">Ends With</label>
                  <Input
                    value={searchParams.phone_number_ends_with}
                    onChange={(e) =>
                      setSearchParams((p) => ({
                        ...p,
                        phone_number_ends_with: e.target.value,
                      }))
                    }
                    placeholder="e.g., 1234"
                  />
                </div>

                <div>
                  <label className="text-xs font-medium">Limit</label>
                  <Select
                    value={String(searchParams.limit)}
                    onValueChange={(value) =>
                      setSearchParams((p) => ({ ...p, limit: Number(value) }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="10">10</SelectItem>
                      <SelectItem value="20">20</SelectItem>
                      <SelectItem value="50">50</SelectItem>
                      <SelectItem value="100">100</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Search Options Switches */}
              <div>
                <label className="text-xs font-medium mb-2 block">
                  Search Options
                </label>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="flex items-center space-x-2">
                    <Switch
                      id="best_effort"
                      checked={searchParams.best_effort}
                      onCheckedChange={(checked) =>
                        setSearchParams((p) => ({ ...p, best_effort: checked }))
                      }
                    />
                    <Label
                      htmlFor="best_effort"
                      className="text-xs cursor-pointer"
                    >
                      Best Effort
                    </Label>
                  </div>

                  <div className="flex items-center space-x-2">
                    <Switch
                      id="quickship"
                      checked={searchParams.quickship}
                      onCheckedChange={(checked) =>
                        setSearchParams((p) => ({ ...p, quickship: checked }))
                      }
                    />
                    <Label
                      htmlFor="quickship"
                      className="text-xs cursor-pointer"
                    >
                      Quickship
                    </Label>
                  </div>

                  <div className="flex items-center space-x-2">
                    <Switch
                      id="reservable"
                      checked={searchParams.reservable}
                      onCheckedChange={(checked) =>
                        setSearchParams((p) => ({ ...p, reservable: checked }))
                      }
                    />
                    <Label
                      htmlFor="reservable"
                      className="text-xs cursor-pointer"
                    >
                      Reservable Numbers
                    </Label>
                  </div>

                  <div className="flex items-center space-x-2">
                    <Switch
                      id="exclude_held_numbers"
                      checked={searchParams.exclude_held_numbers}
                      onCheckedChange={(checked) =>
                        setSearchParams((p) => ({
                          ...p,
                          exclude_held_numbers: checked,
                        }))
                      }
                    />
                    <Label
                      htmlFor="exclude_held_numbers"
                      className="text-xs cursor-pointer"
                    >
                      Exclude Held Numbers
                    </Label>
                  </div>

                  <div className="flex items-center space-x-2">
                    <Switch
                      id="exclude_prev_owned_numbers"
                      checked={searchParams.exclude_prev_owned_numbers}
                      onCheckedChange={(checked) =>
                        setSearchParams((p) => ({
                          ...p,
                          exclude_prev_owned_numbers: checked,
                        }))
                      }
                    />
                    <Label
                      htmlFor="exclude_prev_owned_numbers"
                      className="text-xs cursor-pointer"
                    >
                      Exclude Previously Owned Numbers
                    </Label>
                  </div>

                  <div className="flex items-center space-x-2">
                    <Switch
                      id="telnyx_bundle"
                      checked={searchParams.telnyx_bundle}
                      onCheckedChange={(checked) =>
                        setSearchParams((p) => ({
                          ...p,
                          telnyx_bundle: checked,
                        }))
                      }
                    />
                    <Label
                      htmlFor="telnyx_bundle"
                      className="text-xs cursor-pointer"
                    >
                      Telnyx Bundle
                    </Label>
                  </div>
                </div>
              </div>

              {/* Consecutive Numbers */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div>
                  <label className="text-xs font-medium">
                    Consecutive Numbers
                  </label>
                  <Input
                    type="number"
                    min="1"
                    value={searchParams.consecutive}
                    onChange={(e) =>
                      setSearchParams((p) => ({
                        ...p,
                        consecutive: e.target.value,
                      }))
                    }
                    placeholder="e.g., 5"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex gap-2">
          <Button
            onClick={handleSearch}
            disabled={loading}
            className="flex items-center gap-2"
          >
            <IconSearch className="size-4" />
            {loading ? "Searching…" : "Search Numbers"}
          </Button>
          {selectedNumbers.length > 0 && (
            <Button
              onClick={handleOrderClick}
              disabled={ordering}
              variant="default"
              className="flex items-center gap-2 bg-telnyx-green hover:bg-telnyx-green/90 text-white"
            >
              <IconShoppingCart className="size-4" />
              {ordering
                ? "Ordering…"
                : `Order ${selectedNumbers.length} Number(s)`}
            </Button>
          )}
        </div>
      </div>

      {searchResults.length > 0 && (
        <div className="border rounded-md overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12"></TableHead>
                <TableHead className="px-[10px]">Phone Number</TableHead>
                <TableHead className="px-[10px]">Type</TableHead>
                <TableHead className="px-[10px]">Features</TableHead>
                <TableHead className="px-[10px]">City</TableHead>
                <TableHead className="px-[10px]">State/Region</TableHead>
                <TableHead className="px-[10px]">Upfront Cost</TableHead>
                <TableHead className="px-[10px]">Monthly Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {searchResults.map((number) => (
                <TableRow key={number.phone_number}>
                  <TableCell>
                    <Checkbox
                      checked={selectedNumbers.includes(number.phone_number)}
                      onCheckedChange={() =>
                        toggleNumberSelection(number.phone_number)
                      }
                    />
                  </TableCell>
                  <TableCell className="px-[10px] text-xs font-mono">
                    {number.phone_number}
                  </TableCell>
                  <TableCell className="px-[10px] text-xs">
                    <Badge
                      className={numberTypeBadgeColor(number.phone_number_type)}
                      variant="outline"
                    >
                      {String(number.phone_number_type || "local")
                        .replace("_", " ")
                        .toUpperCase()}
                    </Badge>
                  </TableCell>
                  <TableCell className="px-[10px] text-xs">
                    {renderFeatures(number.features)}
                  </TableCell>
                  <TableCell className="px-[10px] text-xs">
                    {getLocationFromRegionInfo(number.region_information) ||
                      "—"}
                  </TableCell>
                  <TableCell className="px-[10px] text-xs">
                    {getStateFromRegionInfo(number.region_information) || "—"}
                  </TableCell>
                  <TableCell className="px-[10px] text-xs">
                    {number.cost_information ? (
                      <span className="font-medium">
                        {number.cost_information.currency}{" "}
                        {parseFloat(
                          number.cost_information.upfront_cost
                        ).toFixed(2)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="px-[10px] text-xs">
                    {number.cost_information ? (
                      <span className="font-medium">
                        {number.cost_information.currency}{" "}
                        {parseFloat(
                          number.cost_information.monthly_cost
                        ).toFixed(2)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {!loading && searchResults.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <IconSearch className="size-12 mx-auto mb-4 opacity-50" />
          <p>
            No search results yet. Use the search form above to find available
            numbers.
          </p>
        </div>
      )}

      {/* Order Confirmation Dialog */}
      <Dialog
        open={showOrderConfirmation}
        onOpenChange={setShowOrderConfirmation}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Order</DialogTitle>
            <DialogDescription>
              Are you sure you want to order the selected number(s)?
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="border rounded p-4 bg-muted/30">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">Selected Numbers:</span>
                <Badge variant="outline">{selectedNumbers.length}</Badge>
              </div>
              <div className="border rounded p-2 max-h-48 overflow-y-auto bg-background">
                <div className="space-y-1">
                  {selectedNumbers.map((num) => (
                    <div
                      key={num}
                      className="text-xs font-mono flex items-center gap-2"
                    >
                      <IconPhone className="size-3" />
                      {num}
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                onClick={() => setShowOrderConfirmation(false)}
                variant="outline"
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                onClick={handleOrderConfirm}
                disabled={ordering}
                className="flex-1 bg-telnyx-green hover:bg-telnyx-green/90 text-white"
              >
                <IconShoppingCart className="size-4 mr-2" />
                {ordering ? "Ordering…" : "Confirm Order"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Order Status Dialog */}
      <Dialog open={showOrderStatus} onOpenChange={setShowOrderStatus}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Order Status</DialogTitle>
            <DialogDescription>
              Your number order has been placed.
            </DialogDescription>
          </DialogHeader>
          {orderStatus && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Order ID:</span>
                <span className="text-sm font-mono">{orderStatus.id}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Status:</span>
                {orderStatusBadge(orderStatus.status)}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Numbers:</span>
                <span className="text-sm">
                  {orderStatus.phone_numbers?.length || 0}
                </span>
              </div>
              {orderStatus.phone_numbers &&
                orderStatus.phone_numbers.length > 0 && (
                  <div className="border rounded p-2 max-h-48 overflow-y-auto">
                    <div className="space-y-1">
                      {orderStatus.phone_numbers.map((num) => (
                        <div
                          key={num.phone_number}
                          className="text-xs font-mono flex items-center gap-2"
                        >
                          <IconPhone className="size-3" />
                          {num.phone_number}
                          {num.status && (
                            <span className="text-muted-foreground">
                              ({num.status})
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              <Button
                onClick={() => setShowOrderStatus(false)}
                className="w-full"
              >
                Close
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
