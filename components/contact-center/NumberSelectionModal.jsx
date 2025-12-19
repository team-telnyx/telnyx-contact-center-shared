"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Phone,
  Users,
  UserCircle,
  CheckCircle2,
  UserCheck,
  Smartphone,
  Building2,
  Home,
  Network,
  Bot,
} from "lucide-react";
import { cn } from "@/lib/utils";

// Prevent hydration mismatch by only rendering Select components after mount
// Radix UI generates random IDs that differ between server and client renders
function ClientOnlySelect({ children, ...props }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    // Return a placeholder that matches SelectTrigger styling
    return (
      <div className="border-input data-[placeholder]:text-muted-foreground flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs">
        <span className="text-muted-foreground">Loading...</span>
      </div>
    );
  }

  return <Select {...props}>{children}</Select>;
}

/**
 * Extract all available phone numbers from a customer or patient record
 */
function extractPhoneNumbers(record, recordType) {
  const numbers = [];
  const phoneFields = [
    { key: "phone", label: "Phone", icon: Phone, color: "text-blue-500" },
    {
      key: "mobile",
      label: "Mobile",
      icon: Smartphone,
      color: "text-green-500",
    },
    {
      key: "business_phone_1",
      label: "Business Phone 1",
      icon: Building2,
      color: "text-purple-500",
    },
    {
      key: "business_phone_2",
      label: "Business Phone 2",
      icon: Building2,
      color: "text-purple-500",
    },
    {
      key: "home_phone_1",
      label: "Home Phone 1",
      icon: Home,
      color: "text-orange-500",
    },
    {
      key: "home_phone_2",
      label: "Home Phone 2",
      icon: Home,
      color: "text-orange-500",
    },
    { key: "sip_uri", label: "SIP URI", icon: Network, color: "text-cyan-500" },
  ];

  for (const field of phoneFields) {
    const value = record[field.key];
    if (value && String(value).trim() !== "") {
      numbers.push({
        value: String(value).trim(),
        label: field.label,
        type: field.key === "sip_uri" ? "sip" : "phone",
        icon: field.icon,
        iconColor: field.color,
      });
    }
  }

  return numbers;
}

export function NumberSelectionModal({
  open,
  onOpenChange,
  onSelect,
  mode = "dial", // "dial" or "transfer"
  title,
  description,
}) {
  const [mounted, setMounted] = useState(false);
  const [selectionType, setSelectionType] = useState("contact"); // "contact", "users", "assistants", or "manual"
  const [selectedRecordId, setSelectedRecordId] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedAssistantId, setSelectedAssistantId] = useState("");
  const [selectedNumber, setSelectedNumber] = useState("");
  const [manualNumber, setManualNumber] = useState("");
  const [customers, setCustomers] = useState([]);
  const [patients, setPatients] = useState([]);
  const [registeredUsers, setRegisteredUsers] = useState([]);
  const [assistants, setAssistants] = useState([]);
  const [loading, setLoading] = useState(false);
  const [user, setUser] = useState(null);

  // Ensure component is mounted before rendering to prevent hydration mismatch
  useEffect(() => {
    setMounted(true);
  }, []);

  // Default title and description based on mode
  const defaultTitle =
    mode === "transfer" ? "Transfer Call" : "Select Number to Call";
  const defaultDescription =
    mode === "transfer"
      ? "Choose where to transfer this call"
      : "Choose a number from contacts, users, AI assistants, or enter manually";

  const modalTitle = title || defaultTitle;
  const modalDescription = description || defaultDescription;

  // Load user info and records
  useEffect(() => {
    if (open) {
      loadUserAndRecords();
      // Reset selections when modal opens
      setSelectedRecordId("");
      setSelectedUserId("");
      setSelectedAssistantId("");
      setSelectedNumber("");
      setManualNumber("");
      setSelectionType("contact");
    }
  }, [open]);

  const loadUserAndRecords = async () => {
    setLoading(true);
    try {
      // Get current user
      const userRes = await fetch("/api/auth/me", { cache: "no-store" });
      const userData = await userRes.json();
      if (userData.isAuth && userData.user) {
        setUser(userData.user);

        // Fetch customers and patients for this user via server-side endpoint
        const contactsRes = await fetch("/api/user/contacts", {
          cache: "no-store",
        });
        const contactsData = await contactsRes.json();

        if (contactsData.ok) {
          setCustomers(contactsData.customers || []);
          setPatients(contactsData.patients || []);
          setRegisteredUsers(contactsData.users || []);
          setAssistants(contactsData.assistants || []);
        }
      }
    } catch (err) {
      console.error("Failed to load records:", err);
    } finally {
      setLoading(false);
    }
  };

  // Get all records with their available numbers
  const recordsWithNumbers = [
    ...customers.map((c) => ({
      ...c,
      recordType: "customer",
      numbers: extractPhoneNumbers(c, "customer"),
      displayName:
        `${c.first_name || ""} ${c.last_name || ""}`.trim() ||
        c.customer_id ||
        "Unknown Customer",
    })),
    ...patients.map((p) => ({
      ...p,
      recordType: "patient",
      numbers: extractPhoneNumbers(p, "patient"),
      displayName:
        `${p.first_name || ""} ${p.last_name || ""}`.trim() ||
        p.patient_id ||
        "Unknown Patient",
    })),
  ].filter((r) => r.numbers.length > 0); // Only show records with at least one number

  // Get numbers for selected record
  const selectedRecord = recordsWithNumbers.find(
    (r) => r.id === selectedRecordId
  );
  const availableNumbers = selectedRecord?.numbers || [];

  // Get numbers for selected user
  const selectedUser = registeredUsers.find((u) => u.id === selectedUserId);
  const userNumbers = [];
  if (selectedUser) {
    if (
      selectedUser.voice_number &&
      String(selectedUser.voice_number).trim() !== ""
    ) {
      userNumbers.push({
        value: String(selectedUser.voice_number).trim(),
        label: "Voice Number",
        type: "phone",
        icon: Phone,
        iconColor: "text-blue-500",
      });
    }
    if (selectedUser.mobile && String(selectedUser.mobile).trim() !== "") {
      userNumbers.push({
        value: String(selectedUser.mobile).trim(),
        label: "Mobile",
        type: "phone",
        icon: Smartphone,
        iconColor: "text-green-500",
      });
    }
  }

  const handleConfirm = () => {
    let numberToSelect = "";

    if (selectionType === "contact" && selectedRecordId && selectedNumber) {
      numberToSelect = selectedNumber;
    } else if (selectionType === "users" && selectedUserId && selectedNumber) {
      numberToSelect = selectedNumber;
    } else if (selectionType === "assistants" && selectedAssistantId) {
      // Generate SIP URI for assistant: sip:user@{assistantId}.sip.telnyx.com
      numberToSelect = `sip:user@${selectedAssistantId}.sip.telnyx.com`;
    } else if (selectionType === "manual" && manualNumber.trim()) {
      numberToSelect = manualNumber.trim();
    }

    if (numberToSelect) {
      onSelect?.(numberToSelect);
      // Close modal after selection
      onOpenChange(false);
    }
  };

  const isValid = () => {
    if (selectionType === "contact") {
      return selectedRecordId && selectedNumber;
    } else if (selectionType === "users") {
      return selectedUserId && selectedNumber;
    } else if (selectionType === "assistants") {
      return selectedAssistantId;
    } else if (selectionType === "manual") {
      const v = manualNumber.trim();
      return v && (v.startsWith("+") || v.startsWith("sip:"));
    }
    return false;
  };

  // Don't render modal content until mounted to prevent hydration mismatch
  if (!mounted) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] dark:bg-zinc-900">
        <DialogHeader>
          <DialogTitle>{modalTitle}</DialogTitle>
          <DialogDescription>{modalDescription}</DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Selection Type */}
          <div className="grid grid-cols-4 gap-3">
            <button
              type="button"
              onClick={() => setSelectionType("contact")}
              className={cn(
                "flex flex-col items-center gap-2 p-4 rounded-lg border-2 transition-all",
                selectionType === "contact"
                  ? "bg-blue-500 text-white border-blue-600"
                  : "bg-blue-500/10 text-blue-600 border-blue-500/20 hover:bg-blue-500/20"
              )}
            >
              <Users className="h-6 w-6" />
              <div className="font-semibold text-sm">Contacts</div>
              {selectionType === "contact" && (
                <CheckCircle2 className="h-4 w-4" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setSelectionType("users")}
              className={cn(
                "flex flex-col items-center gap-2 p-4 rounded-lg border-2 transition-all",
                selectionType === "users"
                  ? "bg-purple-500 text-white border-purple-600"
                  : "bg-purple-500/10 text-purple-600 border-purple-500/20 hover:bg-purple-500/20"
              )}
            >
              <UserCheck className="h-6 w-6" />
              <div className="font-semibold text-sm">Users</div>
              {selectionType === "users" && (
                <CheckCircle2 className="h-4 w-4" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setSelectionType("assistants")}
              className={cn(
                "flex flex-col items-center gap-2 p-4 rounded-lg border-2 transition-all",
                selectionType === "assistants"
                  ? "bg-indigo-500 text-white border-indigo-600"
                  : "bg-indigo-500/10 text-indigo-600 border-indigo-500/20 hover:bg-indigo-500/20"
              )}
            >
              <Bot className="h-6 w-6" />
              <div className="font-semibold text-sm">AI Assistants</div>
              {selectionType === "assistants" && (
                <CheckCircle2 className="h-4 w-4" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setSelectionType("manual")}
              className={cn(
                "flex flex-col items-center gap-2 p-4 rounded-lg border-2 transition-all",
                selectionType === "manual"
                  ? "bg-green-500 text-white border-green-600"
                  : "bg-green-500/10 text-green-600 border-green-500/20 hover:bg-green-500/20"
              )}
            >
              <Phone className="h-6 w-6" />
              <div className="font-semibold text-sm">Manual Entry</div>
              {selectionType === "manual" && (
                <CheckCircle2 className="h-4 w-4" />
              )}
            </button>
          </div>

          {/* Contact Selection */}
          {selectionType === "contact" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-sm font-semibold flex items-center gap-2">
                  <Users className="h-4 w-4 text-blue-600" />
                  Select Contact
                </Label>
                {loading ? (
                  <div className="text-sm text-muted-foreground">
                    Loading contacts...
                  </div>
                ) : recordsWithNumbers.length === 0 ? (
                  <div className="text-sm text-muted-foreground">
                    No contacts with phone numbers found
                  </div>
                ) : (
                  <ClientOnlySelect
                    value={selectedRecordId}
                    onValueChange={setSelectedRecordId}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Choose a contact" />
                    </SelectTrigger>
                    <SelectContent>
                      {recordsWithNumbers.map((record) => (
                        <SelectItem key={record.id} value={record.id}>
                          <div className="flex items-center gap-2">
                            {record.recordType === "customer" ? (
                              <UserCircle className="h-4 w-4 text-blue-500" />
                            ) : (
                              <UserCircle className="h-4 w-4 text-purple-500" />
                            )}
                            <span className="font-medium">
                              {record.displayName}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              (
                              {record.recordType === "customer"
                                ? "Customer"
                                : "Patient"}
                              )
                            </span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </ClientOnlySelect>
                )}
              </div>

              {selectedRecord && availableNumbers.length > 0 && (
                <div className="space-y-2">
                  <Label className="text-sm font-semibold flex items-center gap-2">
                    <Phone className="h-4 w-4 text-green-600" />
                    Select Number
                  </Label>
                  <ClientOnlySelect
                    value={selectedNumber}
                    onValueChange={setSelectedNumber}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Choose a number" />
                    </SelectTrigger>
                    <SelectContent>
                      {availableNumbers.map((num, idx) => {
                        const IconComponent = num.icon || Phone;
                        return (
                          <SelectItem key={idx} value={num.value}>
                            <div className="flex items-center gap-2">
                              <IconComponent
                                className={cn(
                                  "h-4 w-4",
                                  num.iconColor || "text-gray-500"
                                )}
                              />
                              <span className="font-medium">{num.value}</span>
                              <span className="text-xs text-muted-foreground">
                                ({num.label})
                              </span>
                            </div>
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </ClientOnlySelect>
                </div>
              )}
            </div>
          )}

          {/* Registered Users Selection */}
          {selectionType === "users" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-sm font-semibold flex items-center gap-2">
                  <UserCheck className="h-4 w-4 text-purple-600" />
                  Select User
                </Label>
                {loading ? (
                  <div className="text-sm text-muted-foreground">
                    Loading users...
                  </div>
                ) : registeredUsers.length === 0 ? (
                  <div className="text-sm text-muted-foreground">
                    No users with phone numbers found
                  </div>
                ) : (
                  <ClientOnlySelect
                    value={selectedUserId}
                    onValueChange={setSelectedUserId}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Choose a user" />
                    </SelectTrigger>
                    <SelectContent>
                      {registeredUsers.map((u) => {
                        const displayName =
                          `${u.first_name || ""} ${u.last_name || ""}`.trim() ||
                          u.nick ||
                          u.username ||
                          "Unknown User";
                        return (
                          <SelectItem key={u.id} value={u.id}>
                            <div className="flex items-center gap-2">
                              <UserCheck className="h-4 w-4 text-purple-500" />
                              <span className="font-medium">{displayName}</span>
                              <span className="text-xs text-muted-foreground">
                                ({u.username})
                              </span>
                            </div>
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </ClientOnlySelect>
                )}
              </div>

              {selectedUser && userNumbers.length > 0 && (
                <div className="space-y-2">
                  <Label className="text-sm font-semibold flex items-center gap-2">
                    <Phone className="h-4 w-4 text-green-600" />
                    Select Number
                  </Label>
                  <ClientOnlySelect
                    value={selectedNumber}
                    onValueChange={setSelectedNumber}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Choose a number" />
                    </SelectTrigger>
                    <SelectContent>
                      {userNumbers.map((num, idx) => {
                        const IconComponent = num.icon || Phone;
                        return (
                          <SelectItem key={idx} value={num.value}>
                            <div className="flex items-center gap-2">
                              <IconComponent
                                className={cn(
                                  "h-4 w-4",
                                  num.iconColor || "text-gray-500"
                                )}
                              />
                              <span className="font-medium">{num.value}</span>
                              <span className="text-xs text-muted-foreground">
                                ({num.label})
                              </span>
                            </div>
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </ClientOnlySelect>
                </div>
              )}
            </div>
          )}

          {/* AI Assistants Selection */}
          {selectionType === "assistants" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-sm font-semibold flex items-center gap-2">
                  <Bot className="h-4 w-4 text-indigo-600" />
                  Select AI Assistant
                </Label>
                {loading ? (
                  <div className="text-sm text-muted-foreground">
                    Loading assistants...
                  </div>
                ) : assistants.length === 0 ? (
                  <div className="text-sm text-muted-foreground">
                    No AI assistants found
                  </div>
                ) : (
                  <ClientOnlySelect
                    value={selectedAssistantId}
                    onValueChange={setSelectedAssistantId}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Choose an AI assistant" />
                    </SelectTrigger>
                    <SelectContent>
                      {assistants.map((assistant) => (
                        <SelectItem key={assistant.id} value={assistant.id}>
                          <div className="flex items-center gap-2">
                            <Bot className="h-4 w-4 text-indigo-500" />
                            <span className="font-medium">
                              {assistant.name || assistant.id}
                            </span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </ClientOnlySelect>
                )}
                {selectedAssistantId && (
                  <p className="text-xs text-muted-foreground">
                    {mode === "transfer" ? "Will transfer to" : "Will call"}:
                    sip:user@{selectedAssistantId}.sip.telnyx.com
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Manual Entry */}
          {selectionType === "manual" && (
            <div className="space-y-2">
              <Label className="text-sm font-semibold flex items-center gap-2">
                <Phone className="h-4 w-4 text-green-600" />
                Phone Number or SIP URI
              </Label>
              <Input
                type="tel"
                placeholder="+1234567890 or sip:user@domain.com"
                value={manualNumber}
                onChange={(e) => setManualNumber(e.target.value)}
                className="w-full"
              />
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex justify-end gap-2 pt-4 border-t">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={!isValid() || loading}
              className="min-w-[120px]"
            >
              {mode === "transfer" ? "Transfer" : "Select"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
