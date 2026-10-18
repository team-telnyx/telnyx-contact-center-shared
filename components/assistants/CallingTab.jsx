"use client";
import AssistantCallingSettings from "./AssistantCallingSettings";
import { useUiText } from "@/components/i18n/use-ui-text";


import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  IconLayoutGrid,
  IconListDetails,
  IconChevronsLeft,
  IconChevronsRight,
  IconChevronLeft,
  IconChevronRight,
  IconLink,
  IconPhone,
  IconUnlink,
  IconCheck,
} from "@tabler/icons-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export default function CallingTab({ values, setValues, connectionOnly = false }) {
  const tUi = useUiText();
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(12);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [view, setView] = useState("list");
  const [filters, setFilters] = useState({ q: "", tag: "", numberType: "any", assigned: undefined });
  const [texmlApps, setTexmlApps] = useState([]);
  const [assignedNumbers, setAssignedNumbers] = useState([]);
  const [loadingAssigned, setLoadingAssigned] = useState(true);
  const [assignedError, setAssignedError] = useState("");
  const [assignedFor, setAssignedFor] = useState(null);
  const [showNumbersList, setShowNumbersList] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState({
    open: false,
    title: "",
    description: "",
    onConfirm: null,
  });

  const defaultTexmlAppId = values?.telephony?.default_texml_app_id || "";

  // Get the name of the default TeXML app
  const defaultTexmlAppName = useMemo(() => {
    const app = texmlApps.find(
      (a) => String(a.id) === String(defaultTexmlAppId)
    );
    return app?.friendly_name || app?.name || defaultTexmlAppId;
  }, [texmlApps, defaultTexmlAppId]);

  // Check if telephony is enabled in enabled_features
  const voiceEnabled = Array.isArray(values?.enabled_features)
    ? values.enabled_features.includes("telephony")
    : false;
  const handleVoiceToggle = (checked) => {
    const currentFeatures = Array.isArray(values?.enabled_features)
      ? [...values.enabled_features]
      : [];

    let newFeatures;
    if (checked) {
      // Add telephony if not present
      newFeatures = currentFeatures.includes("telephony")
        ? currentFeatures
        : [...currentFeatures, "telephony"];
    } else {
      // Remove telephony
      newFeatures = currentFeatures.filter((f) => f !== "telephony");
    }

    setValues((v) => ({
      ...v,
      enabled_features: newFeatures,
    }));
  };

  function typeLabel(type) {
    if (!type) return "";
    if (type === "toll_free") return "Toll Free";
    if (type === "shared_cost") return "Shared Cost";
    return String(type || "")
      .split("_")
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join(" ");
  }

  function typeBadgeStyle(type) {
    const t = String(type || "");
    if (t === "mobile") return { backgroundColor: "#DCFCE7", color: "#111827" };
    if (t === "local") return { backgroundColor: "#E0E7FF", color: "#111827" };
    if (t === "toll_free")
      return { backgroundColor: "#FFE4E6", color: "#111827" };
    if (t === "national")
      return { backgroundColor: "#FEF9C3", color: "#111827" };
    if (t === "shared_cost")
      return { backgroundColor: "#F3E8FF", color: "#111827" };
    return { backgroundColor: "#E5E7EB", color: "#111827" };
  }

  // Generate consistent color for tags based on tag name
  function getTagColor(tag) {
    const colors = [
      { bg: "#DCFCE7", text: "#111827" }, // green
      { bg: "#E0E7FF", text: "#111827" }, // blue
      { bg: "#FFE4E6", text: "#111827" }, // red
      { bg: "#FEF9C3", text: "#111827" }, // yellow
      { bg: "#F3E8FF", text: "#111827" }, // purple
      { bg: "#FCE7F3", text: "#111827" }, // pink
      { bg: "#E0F2FE", text: "#111827" }, // cyan
      { bg: "#FEF3C7", text: "#111827" }, // amber
    ];
    // Simple hash function to get consistent color for same tag
    let hash = 0;
    for (let i = 0; i < tag.length; i++) {
      hash = tag.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  }

  const query = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));
    if (filters.q) sp.set("q", filters.q);
    if (filters.tag) sp.set("tag", filters.tag);
    if (filters.numberType && filters.numberType !== "any")
      sp.set("numberType", filters.numberType);
    if (filters.assigned === "unassigned") {
      sp.set("assigned", "unassigned");
      sp.set("assignedType", "voice"); // For Calling tab, check voice endpoint assignment
    }
    return sp.toString();
  }, [page, pageSize, filters]);

  async function load() {
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch(`/api/phone-numbers?${query}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok || data?.ok === false)
        throw new Error(data?.error || "Failed to fetch numbers");
      setItems(Array.isArray(data.items) ? data.items : []);
      const totalResults = Number(
        data?.meta?.total_results || data?.meta?.total || 0
      );
      setTotal(totalResults);
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (showNumbersList) {
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, showNumbersList]);

  useEffect(() => {
    async function loadApps() {
      try {
        const res = await fetch("/api/texml-applications?pageSize=250", {
          cache: "no-store",
        });
        const data = await res.json();
        if (res.ok && data?.ok) setTexmlApps(data.apps || []);
      } catch (_) {}
    }
    loadApps();
  }, []);

  // Check if number is assigned to this assistant
  function isAssignedToAssistant(number) {
    if (!defaultTexmlAppId) return false;
    const current =
      number?.connection_id || number?.voice?.connection_id || null;
    return current && String(current) === String(defaultTexmlAppId);
  }

  // Load all assigned numbers (not just current page)
  async function loadAssignedNumbers() {
    if (!defaultTexmlAppId) {
      setAssignedNumbers([]);
      setAssignedFor("");
      setLoadingAssigned(false);
      return;
    }

    setLoadingAssigned(true);
    setAssignedError("");
    try {
      // Fetch numbers assigned to this TeXML app with a large page size
      const res = await fetch(
        `/api/phone-numbers?connectionId=${encodeURIComponent(
          defaultTexmlAppId
        )}&pageSize=100`,
        { cache: "no-store" }
      );
      const data = await res.json();
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || "Failed to fetch assigned numbers");
      }
      setAssignedNumbers(Array.isArray(data.items) ? data.items : []);
    } catch (err) {
      setAssignedError(err.message);
    } finally {
      setAssignedFor(defaultTexmlAppId);
      setLoadingAssigned(false);
    }
  }

  // Load assigned numbers when TeXML app ID changes
  useEffect(() => {
    if (voiceEnabled) {
      loadAssignedNumbers();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultTexmlAppId, voiceEnabled]);

  async function assignToAssistantApp(number) {
    const target = defaultTexmlAppId || null;
    if (!target) {
      setConfirmDialog({
        open: true,
        title: "Configuration Required",
        description:
          "Please set a Default TeXML App ID for this assistant first in the Integrations tab.",
        onConfirm: null,
      });
      return;
    }
    const id = number?.id;
    if (!id) return;
    const current =
      number?.connection_id || number?.voice?.connection_id || null;
    const currentAppName =
      number?.connection_name || number?.voice?.connection_name || current;

    const doAssign = async () => {
      try {
        const res = await fetch(
          `/api/phone-numbers/${encodeURIComponent(id)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ connection_id: target }),
          }
        );
        if (!res.ok) throw new Error("Failed to assign");
        load();
        loadAssignedNumbers(); // Reload assigned numbers
      } catch (err) {
        console.error(err);
      }
    };

    if (current && String(current) !== String(target)) {
      setConfirmDialog({
        open: true,
        title: "Reassign Number",
        description: `This number is currently assigned to "${currentAppName}". Do you want to reassign it to "${defaultTexmlAppName}"?`,
        onConfirm: doAssign,
      });
    } else {
      await doAssign();
    }
  }

  async function unassignFromAssistant(number) {
    const id = number?.id;
    if (!id) return;

    setConfirmDialog({
      open: true,
      title: "Unassign Number",
      description: `Are you sure you want to unassign ${number?.phone_number} from this assistant?`,
      onConfirm: async () => {
        try {
          const res = await fetch(
            `/api/phone-numbers/${encodeURIComponent(id)}`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ connection_id: null }),
            }
          );
          if (!res.ok) throw new Error("Failed to unassign");
          load();
          loadAssignedNumbers(); // Reload assigned numbers
        } catch (err) {
          console.error(err);
        }
      },
    });
  }

  return (
    <div className="h-full min-h-0 w-full overflow-y-auto pr-1">
      <Card className="w-full">
        <CardContent className="space-y-4 pt-6">
          <div className="flex items-center justify-between">
            <div className="text-lg font-semibold flex items-center gap-2">
              <IconPhone className="size-6 text-telnyx-green" />{tUi(" Voice Numbers")}</div>
          </div>

          <div className="flex items-center gap-2 pb-2">
            <Switch
              id="enable-voice"
              checked={voiceEnabled}
              onCheckedChange={handleVoiceToggle}
            />
            <Label
              htmlFor="enable-voice"
              className="text-sm font-medium cursor-pointer"
            >{tUi("Enable Voice")}</Label>
          </div>

          {!voiceEnabled && (
            <div className="text-sm text-muted-foreground py-8 text-center border rounded-md">{tUi("Enable Voice to assign phone numbers for voice calls")}</div>
          )}

          {voiceEnabled && (
            <>
              {/* Assigned Numbers Section */}
              {loadingAssigned || assignedFor !== defaultTexmlAppId ? <div className="rounded-md border p-4 space-y-3"><Skeleton className="h-5 w-48"/><Skeleton className="h-9 w-full"/></div> : assignedError ? <p role="alert" className="text-sm text-destructive">{assignedError}</p> : assignedNumbers.length > 0 ? (
                <div className="border rounded-md p-4 bg-muted/30">
                  <div className="text-sm font-semibold mb-2 flex items-center gap-2">
                    <IconCheck className="size-4 text-telnyx-green" />{tUi("Assigned Voice Numbers (")}{assignedNumbers.length})
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {assignedNumbers.map((n) => (
                      <div
                        key={n.id}
                        className="inline-flex items-center gap-2 px-3 py-1.5 bg-background border border-telnyx-green/50 rounded-md text-sm"
                      >
                        <span className="font-medium">{n.phone_number}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-5 w-5 p-0 hover:bg-destructive/10"
                          onClick={() => unassignFromAssistant(n)}
                          title={tUi("Unassign from assistant")}
                        >
                          <IconUnlink className="size-3 text-destructive" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="border rounded-md p-4 bg-muted/10 text-center">
                  <p className="text-sm text-muted-foreground">{tUi("No numbers assigned yet. Click \"Assign Number\" below to assign phone numbers to this assistant.")}</p>
                </div>
              )}

              {!showNumbersList && (
                <div className="flex justify-center py-4">
                  <Button
                    onClick={() => {
                      setShowNumbersList(true);
                    }}
                    variant="default"
                    className="gap-2"
                  >
                    <IconLink className="size-4" />{tUi("Assign Number")}</Button>
                </div>
              )}

              {showNumbersList && (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
                    <div>
                      <label className="text-xs">{tUi("Digits")}</label>
                      <Input
                        value={filters.q}
                        onChange={(e) =>
                          setFilters((f) => ({ ...f, q: e.target.value }))
                        }
                        placeholder={tUi("e.g. 312")}
                      />
                    </div>
                    <div>
                      <label className="text-xs">{tUi("Tag")}</label>
                      <Input
                        value={filters.tag}
                        onChange={(e) =>
                          setFilters((f) => ({ ...f, tag: e.target.value }))
                        }
                        placeholder={tUi("tag")}
                      />
                    </div>
                    <div className="md:col-span-3 flex items-end gap-3 flex-wrap">
                      <div>
                        <label className="text-xs">{tUi("Number type")}</label>
                        <Select
                          value={filters.numberType}
                          onValueChange={(value) =>
                            setFilters((f) => ({ ...f, numberType: value }))
                          }
                        >
                          <SelectTrigger className="w-28">
                            <SelectValue placeholder={tUi("Any")} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="any">{tUi("Any")}</SelectItem>
                            <SelectItem value="local">{tUi("local")}</SelectItem>
                            <SelectItem value="mobile">{tUi("mobile")}</SelectItem>
                            <SelectItem value="national">{tUi("national")}</SelectItem>
                            <SelectItem value="toll_free">{tUi("toll_free")}</SelectItem>
                            <SelectItem value="shared_cost">{tUi("shared_cost")}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-center gap-2 pb-1">
                        <Switch
                          id="unassigned-switch-voice"
                          checked={filters.assigned === "unassigned"}
                          onCheckedChange={(val) =>
                            setFilters((f) => ({
                              ...f,
                              assigned: val ? "unassigned" : undefined,
                            }))
                          }
                        />
                        <label
                          htmlFor="unassigned-switch-voice"
                          className="text-xs"
                        >{tUi("Unassigned")}</label>
                      </div>
                      <div className="flex items-end gap-2">
                        <Button
                          variant="secondary"
                          onClick={() =>
                            setFilters({ q: "", tag: "", numberType: "any", assigned: undefined })
                          }
                        >{tUi("Clear")}</Button>
                        <Button onClick={() => load()} disabled={loading}>
                          {loading ? tUi("Loading…") : tUi("Refresh")}
                        </Button>
                      </div>
                    </div>
                    <div className="flex items-center justify-end gap-2 md:col-span-1 col-span-2">
                      <Button
                        type="button"
                        variant={view === "list" ? "default" : "secondary"}
                        onClick={() => setView("list")}
                        title={tUi("List view")}
                      >
                        <IconListDetails className="size-5" />
                      </Button>
                      <Button
                        type="button"
                        variant={view === "cards" ? "default" : "secondary"}
                        onClick={() => setView("cards")}
                        title={tUi("Cards view")}
                      >
                        <IconLayoutGrid className="size-5" />
                      </Button>
                    </div>
                  </div>

                  {loading ? (
                    <div className="border rounded-md overflow-hidden">
                      <div className="p-4 space-y-3">
                        <Skeleton className="h-6 w-40" />
                        <div className="space-y-2">
                          {[...Array(5)].map((_, i) => (
                            <Skeleton key={i} className="h-10 w-full" />
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : loadError ? <p role="alert" className="text-sm text-destructive">{loadError}</p> : view === "list" ? (
                    <div className="border rounded-md overflow-x-auto">
                      <Table className="table-fixed min-w-[1100px]">
                        <TableHeader>
                          <TableRow className="bg-muted">
                            <TableHead className="px-[10px] w-[20%]">{tUi("Number")}</TableHead>
                            <TableHead className="px-[10px] w-[20%]">{tUi("ID")}</TableHead>
                            <TableHead className="px-[10px] w-[15%]">{tUi("Type")}</TableHead>
                            <TableHead className="px-[10px] w-[15%]">{tUi("Tags")}</TableHead>
                            <TableHead className="px-[10px] w-[15%]">{tUi("Assigned To")}</TableHead>
                            <TableHead className="px-[10px] text-right w-[15%]">{tUi("Actions")}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {items.map((n) => {
                            const id = n?.id;
                            const phone = n?.phone_number;
                            const type =
                              n?.phone_number_type || n?.number_type || "";
                            const tags = Array.isArray(n?.tags) ? n.tags : [];
                            const currentConn =
                              n?.connection_id ||
                              n?.voice?.connection_id ||
                              null;
                            const currentConnName =
                              n?.connection_name ||
                              n?.voice?.connection_name ||
                              null;
                            const assigned = isAssignedToAssistant(n);
                            return (
                              <TableRow
                                key={id}
                                className={assigned ? "bg-telnyx-green/5" : ""}
                              >
                                <TableCell className="px-[10px] text-xs w-[20%] overflow-hidden">
                                  <span className="truncate flex items-center gap-2">
                                    {assigned && (
                                      <IconCheck className="size-3 text-telnyx-green flex-shrink-0" />
                                    )}
                                    {phone}
                                  </span>
                                </TableCell>
                                <TableCell
                                  className="px-[10px] text-xs w-[20%] overflow-hidden"
                                  title={id}
                                >
                                  <span className="truncate block">{id}</span>
                                </TableCell>
                                <TableCell className="px-[10px] text-xs w-[15%] overflow-hidden">
                                  <span
                                    className="truncate inline-flex items-center px-2 py-0.5 rounded-full text-[11px] capitalize"
                                    style={typeBadgeStyle(type)}
                                  >
                                    {tUi(typeLabel(type))}
                                  </span>
                                </TableCell>
                                <TableCell className="px-[10px] text-xs w-[15%]">
                                  <div className="flex flex-wrap gap-1">
                                    {tags.length > 0 ? (
                                      tags.map((tag, idx) => {
                                        const tagColor = getTagColor(String(tag));
                                        return (
                                          <Badge
                                            key={idx}
                                            variant="secondary"
                                            className="text-[10px] px-1.5 py-0.5"
                                            style={{
                                              backgroundColor: tagColor.bg,
                                              color: tagColor.text,
                                            }}
                                          >
                                            {String(tag)}
                                          </Badge>
                                        );
                                      })
                                    ) : (
                                      <span className="text-muted-foreground">—</span>
                                    )}
                                  </div>
                                </TableCell>
                                <TableCell className="px-[10px] text-xs w-[15%] overflow-hidden">
                                  <span className="truncate block">
                                    {currentConnName || currentConn || "—"}
                                  </span>
                                </TableCell>
                                <TableCell className="px-[10px] text-xs whitespace-nowrap text-right">
                                  <div className="inline-flex items-center gap-2 justify-end">
                                    {assigned ? (
                                      <Button
                                        size="sm"
                                        variant="destructive"
                                        title={tUi("Unassign from this assistant")}
                                        onClick={() => unassignFromAssistant(n)}
                                      >
                                        <IconUnlink className="size-4" />
                                      </Button>
                                    ) : (
                                      <Button
                                        size="sm"
                                        variant="secondary"
                                        title={
                                          defaultTexmlAppId
                                            ? tUi("Assign to TeXML App {value0}", { value0: defaultTexmlAppId })
                                            : tUi("Set Default TeXML App ID first")
                                        }
                                        disabled={!defaultTexmlAppId}
                                        onClick={() => assignToAssistantApp(n)}
                                      >
                                        <IconLink className="size-4" />
                                      </Button>
                                    )}
                                  </div>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                          {items.length === 0 && (
                            <TableRow>
                              <TableCell
                                colSpan={6}
                                className="text-center py-8 text-sm text-muted-foreground"
                              >{tUi("No numbers")}</TableCell>
                            </TableRow>
                          )}
                        </TableBody>
                      </Table>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      {items.slice(0, 12).map((n) => {
                        const id = n?.id;
                        const phone = n?.phone_number;
                        const type =
                          n?.phone_number_type || n?.number_type || "";
                        const tags = Array.isArray(n?.tags) ? n.tags : [];
                        const currentConn =
                          n?.connection_id || n?.voice?.connection_id || null;
                        const currentConnName =
                          n?.connection_name ||
                          n?.voice?.connection_name ||
                          null;
                        const assigned = isAssignedToAssistant(n);
                        return (
                          <Card
                            key={id}
                            className={`border-1 ${
                              assigned
                                ? "border-telnyx-green border-2 bg-telnyx-green/5"
                                : "border-telnyx-green dark:border-telnyx-green/60"
                            }`}
                          >
                            <CardContent className="px-4 py-2">
                              <div className="flex items-start justify-between">
                                <div>
                                  <div className="font-medium text-sm flex items-center gap-2">
                                    {assigned && (
                                      <IconCheck className="size-4 text-telnyx-green" />
                                    )}
                                    {phone}
                                  </div>
                                  <div className="text-xs text-muted-foreground flex items-center gap-2 mt-1">
                                    <span
                                      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] capitalize"
                                      style={typeBadgeStyle(type)}
                                    >
                                      {tUi(typeLabel(type))}
                                    </span>
                                    {tags.length > 0 && (
                                      <div className="flex flex-wrap gap-1">
                                        {tags.map((tag, idx) => {
                                          const tagColor = getTagColor(String(tag));
                                          return (
                                            <Badge
                                              key={idx}
                                              variant="secondary"
                                              className="text-[10px] px-1.5 py-0.5"
                                              style={{
                                                backgroundColor: tagColor.bg,
                                                color: tagColor.text,
                                              }}
                                            >
                                              {String(tag)}
                                            </Badge>
                                          );
                                        })}
                                      </div>
                                    )}
                                  </div>
                                </div>
                                <div className="inline-flex items-center gap-2 text-telnyx-green">
                                  {assigned ? (
                                    <Button
                                      size="sm"
                                      variant="destructive"
                                      title={tUi("Unassign from this assistant")}
                                      onClick={() => unassignFromAssistant(n)}
                                    >
                                      <IconUnlink className="size-4" />
                                    </Button>
                                  ) : (
                                    <Button
                                      size="sm"
                                      variant="secondary"
                                      title={
                                        defaultTexmlAppId
                                          ? tUi("Assign to TeXML App {value0}", { value0: defaultTexmlAppId })
                                          : tUi("Set Default TeXML App ID first")
                                      }
                                      disabled={!defaultTexmlAppId}
                                      onClick={() => assignToAssistantApp(n)}
                                    >
                                      <IconLink className="size-4" />
                                    </Button>
                                  )}
                                </div>
                              </div>
                              <div
                                className="mt-1 text-[11px] text-muted-foreground"
                                title={id}
                              >{tUi("ID: ")}{id}
                              </div>
                              <div
                                className="text-[11px] text-muted-foreground"
                                title={currentConnName || currentConn || "—"}
                              >{tUi("Assigned To:")}{" "}
                                {currentConnName || currentConn || "—"}
                              </div>
                            </CardContent>
                          </Card>
                        );
                      })}
                      {items.length === 0 && (
                        <div className="text-center text-sm text-muted-foreground py-8">{tUi("No numbers")}</div>
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </CardContent>
        {voiceEnabled && showNumbersList && !loading && !loadError && (
          <div className="px-6 pb-6">
            <div className="flex items-center justify-between">
              <div className="text-xs text-muted-foreground">{tUi("Total: ")}{total}
              </div>
              <div className="flex w-full items-center gap-8 lg:w-fit">
                <div className="hidden items-center gap-2 lg:flex">
                  <Label
                    htmlFor="rows-per-page"
                    className="text-sm font-medium"
                  >{tUi("Rows per page")}</Label>
                  <Select
                    value={`${pageSize}`}
                    onValueChange={(value) => {
                      setPageSize(Number(value));
                      setPage(1);
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      className="w-20"
                      id="rows-per-page"
                    >
                      <SelectValue placeholder={pageSize} />
                    </SelectTrigger>
                    <SelectContent side="top">
                      {[6, 12, 24, 36, 48].map((size) => (
                        <SelectItem key={size} value={`${size}`}>
                          {size}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex w-fit items-center justify-center text-sm font-medium">{tUi("Page ")}{page}{tUi(" of ")}{Math.max(1, Math.ceil(total / pageSize))}
                </div>
                <div className="ml-auto flex items-center gap-2 lg:ml-0">
                  <Button
                    variant="outline"
                    className="hidden h-8 w-8 p-0 lg:flex"
                    onClick={() => setPage(1)}
                    disabled={page <= 1}
                  >
                    <span className="sr-only">{tUi("Go to first page")}</span>
                    <IconChevronsLeft />
                  </Button>
                  <Button
                    variant="outline"
                    className="size-8"
                    size="icon"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                  >
                    <span className="sr-only">{tUi("Go to previous page")}</span>
                    <IconChevronLeft />
                  </Button>
                  <Button
                    variant="outline"
                    className="size-8"
                    size="icon"
                    onClick={() =>
                      setPage((p) =>
                        Math.min(
                          Math.max(1, Math.ceil(total / pageSize)),
                          p + 1
                        )
                      )
                    }
                    disabled={page >= Math.max(1, Math.ceil(total / pageSize))}
                  >
                    <span className="sr-only">{tUi("Go to next page")}</span>
                    <IconChevronRight />
                  </Button>
                  <Button
                    variant="outline"
                    className="hidden size-8 lg:flex"
                    size="icon"
                    onClick={() =>
                      setPage(Math.max(1, Math.ceil(total / pageSize)))
                    }
                    disabled={page >= Math.max(1, Math.ceil(total / pageSize))}
                  >
                    <span className="sr-only">{tUi("Go to last page")}</span>
                    <IconChevronsRight />
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}
      </Card>

      {!connectionOnly ? <AssistantCallingSettings values={values} setValues={setValues}/> : null}

      {/* Confirmation Dialog */}
      <Dialog
        open={confirmDialog.open}
        onOpenChange={(open) => setConfirmDialog((prev) => ({ ...prev, open }))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmDialog.title}</DialogTitle>
            <DialogDescription>{confirmDialog.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() =>
                setConfirmDialog((prev) => ({ ...prev, open: false }))
              }
            >{tUi("Cancel")}</Button>
            {confirmDialog.onConfirm && (
              <Button
                onClick={() => {
                  confirmDialog.onConfirm();
                  setConfirmDialog((prev) => ({ ...prev, open: false }));
                }}
              >{tUi("Confirm")}</Button>
            )}
            {!confirmDialog.onConfirm && (
              <Button
                onClick={() =>
                  setConfirmDialog((prev) => ({ ...prev, open: false }))
                }
              >{tUi("OK")}</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
