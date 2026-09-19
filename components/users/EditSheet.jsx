"use client";
import ChannelUtilization, { useChannelUtilization } from "@/components/admin/ChannelUtilization";

import React from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { IconEdit, IconCheck, IconLock, IconStar, IconStarFilled, IconInfoCircle, IconPlus, IconTrash, IconMail, IconPhone, IconSelector, IconHelpCircle } from "@tabler/icons-react";
import { useAuth } from "@/components/auth-provider";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem,
} from "@/components/ui/command";
import { notify } from "@/components/ToastNotify";
import { Card, CardContent } from "@/components/ui/card";
import { useHelp } from "@/components/help/HelpProvider";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  USER_STATUS_OPTIONS,
  DEFAULT_USER_STATUS,
  USER_ROLES,
} from "@/config/user";
import { notifyExperimentalFeaturesChanged } from "@/lib/experimental-features-client";

/**
 * Multi-select component for roles
 */
const ROLE_GROUPS = [
  ["system", "System"],
  ["preset", "Shipped"],
  ["custom", "Custom"],
];

function RolesMultiSelect({ value = [], onChange, options = [], lockedValues = [], lockedHint = "" }) {
  const [open, setOpen] = React.useState(false);

  const toggleRole = (roleValue) => {
    if (lockedValues.includes(roleValue)) return;
    const newRoles = value.includes(roleValue)
      ? value.filter((r) => r !== roleValue)
      : [...value, roleValue];
    onChange(newRoles);
  };

  const byValue = new Map(options.map((option) => [option.value, option]));
  const selectedLabels = value
    .map((v) => byValue.get(v)?.label || v)
    .filter(Boolean)
    .join(", ");
  const groups = ROLE_GROUPS.map(([origin, label]) => ({
    origin,
    label,
    items: options.filter((option) => (option.origin || "system") === origin),
  })).filter((group) => group.items.length > 0);

  return (
    // `modal` lets the wheel scroll the list while the sheet's scroll lock is
    // active; the Radix Dialog behind it otherwise swallows wheel events on
    // portaled content.
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <Button variant="outline" className="w-full justify-between">
          <span className="truncate">
            {selectedLabels || "Select roles..."}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={12}
        className="w-[--radix-popover-trigger-width] max-h-[min(22rem,var(--radix-popover-content-available-height))] overflow-y-auto overscroll-contain p-2"
      >
        <div className="space-y-1">
          {groups.map((group) => (
            <div key={group.origin}>
              <div className="px-2 pb-1 pt-2 text-[10px] uppercase tracking-widest text-muted-foreground">{group.label}</div>
              {group.items.map((option) => {
                const Icon = option.Icon;
                const isSelected = value.includes(option.value);
                const locked = lockedValues.includes(option.value);
                return (
                  <div
                    key={option.value}
                    title={locked ? lockedHint : option.description || undefined}
                    className={`flex items-start gap-2 rounded p-2 ${locked ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-accent"}`}
                    onClick={() => toggleRole(option.value)}
                  >
                    <Checkbox checked={isSelected} disabled={locked} className="mt-0.5" />
                    {Icon && <Icon className="mt-0.5 h-4 w-4" />}
                    <span className="min-w-0 flex-1">
                      <span className="block">{option.label}</span>
                      {option.description ? <span className="block truncate text-[11px] text-muted-foreground">{option.description}</span> : null}
                    </span>
                    {locked ? <IconLock className="mt-0.5 h-4 w-4 text-muted-foreground" /> : isSelected ? <IconCheck className="mt-0.5 h-4 w-4 text-primary" /> : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <p className="px-2 pb-1 pt-2 text-[11px] text-muted-foreground">Roles add up. Assign Agent when this person also handles interactions; position roles contain no agent desktop by themselves.</p>
      </PopoverContent>
    </Popover>
  );
}

/** Fallback when the roles table cannot be read: the four system roles. */
function fallbackRoleOptions() {
  return USER_ROLES.map((role) => ({ value: role.value, label: role.label, Icon: role.Icon, origin: "system", description: "" }));
}

/**
 * Edit sheet component for Users
 * @param {object} props
 * @param {boolean} props.open - Whether the sheet is open
 * @param {function} props.onOpenChange - Callback when sheet open state changes
 * @param {string} props.userId - User ID to edit
 * @param {function} props.onSaveComplete - Callback when save is complete
 */
export default function EditSheet({
  open,
  onOpenChange,
  userId,
  onSaveComplete,
  onSaved,
  createMode = false,
}) {
  const { openHelp, registerHelpPortalContainer } = useHelp();
  const { wildcard: actorIsOwner } = useAuth();
  const [roleOptions, setRoleOptions] = React.useState(fallbackRoleOptions);
  const [username, setUsername] = React.useState("");
  const [firstName, setFirstName] = React.useState("");
  const [lastName, setLastName] = React.useState("");
  const [nick, setNick] = React.useState("");
  const [roles, setRoles] = React.useState(["agent"]);
  const [verified, setVerified] = React.useState(false);
  const [active, setActive] = React.useState(true);
  const [experimentalFeatures, setExperimentalFeatures] = React.useState(false);
  const [status, setStatus] = React.useState(DEFAULT_USER_STATUS);
  const [mobile, setMobile] = React.useState("");
  const [smsNumber, setSmsNumber] = React.useState("");
  const [voiceNumber, setVoiceNumber] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [availableSkills, setAvailableSkills] = React.useState([]);
  const [userSkills, setUserSkills] = React.useState({}); // { skillId: proficiency (1-5) }
  const [userSkillsArray, setUserSkillsArray] = React.useState([]); // [{ skillId: string, proficiency: number }] for UI
  const [skillsLoading, setSkillsLoading] = React.useState(false);
  const [availableQueues, setAvailableQueues] = React.useState([]);
  const [userQueueIds, setUserQueueIds] = React.useState([]); // Array of queue IDs
  const [queuesLoading, setQueuesLoading] = React.useState(false);

  // Invite status
  const [inviteStatus, setInviteStatus] = React.useState("none");
  const [inviteSentAt, setInviteSentAt] = React.useState(null);
  const [inviteAcceptedAt, setInviteAcceptedAt] = React.useState(null);
  const [inviteExpires, setInviteExpires] = React.useState(null);
  const [sendingInvite, setSendingInvite] = React.useState(false);

  // Voice number picker
  const [voiceNumberTab, setVoiceNumberTab] = React.useState("telnyx");
  const [telnyxNumbers, setTelnyxNumbers] = React.useState([]);
  const [numbersLoading, setNumbersLoading] = React.useState(false);
  const [allUserVoiceNumbers, setAllUserVoiceNumbers] = React.useState([]);
  const [numberSearchOpen, setNumberSearchOpen] = React.useState(false);
  const [numberSearch, setNumberSearch] = React.useState("");

  // Create mode - send invite checkbox
  const [sendInvite, setSendInvite] = React.useState(true);

  // Reset state when opening in create mode
  React.useEffect(() => {
    if (open && createMode) {
      setUsername("");
      setFirstName("");
      setLastName("");
      setNick("");
      setRoles(["agent"]);
      setVerified(false);
      setActive(true);
      setExperimentalFeatures(false);
      setStatus(DEFAULT_USER_STATUS);
      setMobile("");
      setSmsNumber("");
      setVoiceNumber("");
      setSendInvite(true);
      setUserSkillsArray([]);
      setUserQueueIds([]);
      setInviteStatus("none");
      setInviteSentAt(null);
      setInviteAcceptedAt(null);
      setInviteExpires(null);
      setNumberSearch("");
      setNumberSearchOpen(false);
    }
  }, [open, createMode]);

  // Load user data when userId changes
  React.useEffect(() => {
    async function loadUser() {
      if (!userId || !open || createMode) return;

      setLoading(true);
      try {
        const r = await fetch(
          `/api/admin/users/${encodeURIComponent(userId)}`,
          {
            cache: "no-store",
          }
        );
        const d = await r.json();
        if (r.ok) {
          setUsername(d.username || "");
          setFirstName(d.first_name || "");
          setLastName(d.last_name || "");
          setNick(d.nick || "");
          // Support both roles array and legacy role field
          const userRoles =
            d.roles && Array.isArray(d.roles) && d.roles.length > 0
              ? d.roles
              : d.role
              ? [d.role]
              : ["agent"];
          setRoles(userRoles);
          setVerified(Boolean(d.verified));
          setActive(d.active !== undefined ? Boolean(d.active) : true);
          setExperimentalFeatures(d.experimental_features === true);
          setStatus(d.status || DEFAULT_USER_STATUS);
          setMobile(d.mobile || "");
          setSmsNumber(d.sms_number || "");
          setVoiceNumber(d.voice_number || "");
          // Load invite status
          setInviteStatus(d.invite_status || "none");
          setInviteSentAt(d.invite_sent_at || null);
          setInviteAcceptedAt(d.invite_accepted_at || null);
          setInviteExpires(d.invite_token_expires || null);
          // Set voice number tab based on current value
          if (d.voice_number) {
            setVoiceNumberTab("telnyx"); // default to telnyx tab
          }
          // Load user skills - skills is stored as JSONB object { skillId: proficiency }
          const skills = d.skills || {};
          const skillsObj = typeof skills === 'string' ? JSON.parse(skills) : skills;
          setUserSkills(skillsObj);
          // Convert to array format for UI: [{ skillId, proficiency }]
          setUserSkillsArray(
            Object.entries(skillsObj).map(([skillId, proficiency]) => ({
              skillId,
              proficiency: typeof proficiency === 'number' ? proficiency : parseInt(proficiency, 10) || 1,
            }))
          );
          // Load user queue assignments
          if (d.queue_assignments && Array.isArray(d.queue_assignments)) {
            setUserQueueIds(d.queue_assignments.filter(qa => qa.enabled && !qa.deactivated_at).map((qa) => qa.queue_id).filter(Boolean));
          } else {
            setUserQueueIds([]);
          }
        } else {
          notify({
            title: "Failed to load user",
            description: d?.error || "",
            variant: "error",
          });
        }
      } catch (err) {
        notify({
          title: "Failed to load user",
          description: String(err.message || err),
          variant: "error",
        });
      } finally {
        setLoading(false);
      }
    }

    if (open && userId && !createMode) {
      loadUser();
    }
  }, [userId, open, createMode]);


  // Load available skills
  React.useEffect(() => {
    async function loadSkills() {
      setSkillsLoading(true);
      try {
        const res = await fetch("/api/admin/skills?active=true&pageSize=1000", {
          cache: "no-store",
        });
        if (res.ok) {
          const data = await res.json();
          setAvailableSkills(data.items || []);
        }
      } catch (err) {
        console.error("Failed to load skills:", err);
      } finally {
        setSkillsLoading(false);
      }
    }

    if (open) {
      loadSkills();
    }
  }, [open]);

  // Load available queues
  React.useEffect(() => {
    async function loadQueues() {
      setQueuesLoading(true);
      try {
        const res = await fetch("/api/admin/queues?enabled=true&pageSize=1000", {
          cache: "no-store",
        });
        if (res.ok) {
          const data = await res.json();
          setAvailableQueues(data.rows || []);
        }
      } catch (err) {
        console.error("Failed to load queues:", err);
      } finally {
        setQueuesLoading(false);
      }
    }

    if (open) {
      loadQueues();
    }
  }, [open]);

  // Load the roles table (system, shipped and custom roles) for the role picker
  React.useEffect(() => {
    let cancelled = false;
    async function loadRoles() {
      try {
        const res = await fetch("/api/admin/roles", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled || !Array.isArray(data.roles)) return;
        const icons = new Map(USER_ROLES.map((role) => [role.value, role.Icon]));
        setRoleOptions(
          data.roles.map((role) => ({
            value: role.key,
            label: role.name,
            Icon: icons.get(role.key) || null,
            origin: role.origin,
            description: role.description || "",
          })),
        );
      } catch (err) {
        console.error("Failed to load roles:", err);
      }
    }
    if (open) loadRoles();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Load Telnyx numbers for voice number picker
  React.useEffect(() => {
    async function loadNumbers() {
      setNumbersLoading(true);
      try {
        const [numbersRes, usersRes] = await Promise.all([
          fetch("/api/admin/numbers?pageSize=200", { cache: "no-store" }),
          fetch("/api/admin/users?pageSize=1000", { cache: "no-store" }),
        ]);
        if (numbersRes.ok) {
          const data = await numbersRes.json();
          setTelnyxNumbers(data.data || []);
        }
        if (usersRes.ok) {
          const data = await usersRes.json();
          // Collect voice numbers from all users (to show "assigned" indicator)
          const voiceNums = (data.rows || [])
            .filter((u) => u.voice_number && u.id !== userId)
            .map((u) => u.voice_number);
          setAllUserVoiceNumbers(voiceNums);
        }
      } catch (err) {
        console.error("Failed to load numbers:", err);
      } finally {
        setNumbersLoading(false);
      }
    }

    if (open) {
      loadNumbers();
    }
  }, [open, userId]);


  async function onSendInvite() {
    if (!userId) return;
    setSendingInvite(true);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/invite`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to send invite");
      setInviteStatus("pending");
      setInviteSentAt(data.sentAt);
      setInviteExpires(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString());
      notify({
        title: inviteStatus === "none" ? "Invite sent!" : "Invite resent!",
        description: "The user will receive an invite email shortly.",
        variant: "success",
      });
    } catch (err) {
      notify({
        title: "Failed to send invite",
        description: String(err.message || err),
        variant: "error",
      });
    } finally {
      setSendingInvite(false);
    }
  }

  const utilization = useChannelUtilization("agent", createMode ? null : userId, open);

  async function onSave() {
    if (!utilization.ready) return;
    if (createMode) {
      // Validate required fields
      if (!firstName.trim() || !lastName.trim() || !username.trim()) {
        notify({
          title: "Required fields missing",
          description: "First name, last name, and email are required.",
          variant: "error",
        });
        return;
      }

      // Validate skills
      const skillIds = userSkillsArray.map((s) => s.skillId).filter(Boolean);
      const duplicateSkillIds = skillIds.filter((id, index) => skillIds.indexOf(id) !== index);
      if (duplicateSkillIds.length > 0) {
        notify({ title: "Duplicate skills detected", description: "Each skill can only be assigned once.", variant: "error" });
        return;
      }
      const incompleteSkills = userSkillsArray.filter((s) => !s.skillId || s.skillId.trim() === "");
      if (incompleteSkills.length > 0) {
        notify({ title: "Incomplete skill selections", description: "Please select a skill for all entries or remove incomplete ones.", variant: "error" });
        return;
      }

      setSaving(true);
      try {
        const skills = userSkillsArray.reduce((acc, skill) => {
          if (skill.skillId && skill.proficiency >= 1 && skill.proficiency <= 5) {
            acc[skill.skillId] = skill.proficiency;
          }
          return acc;
        }, {});

        const res = await fetch("/api/admin/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            username: username.trim(),
            roles,
            nick: nick.trim() || null,
            mobile: mobile.trim() || null,
            voiceNumber: voiceNumber || null,
            skills,
            sendInvite,
            experimentalFeatures,
            active, verified, smsNumber, queueIds: userQueueIds, utilization: utilization.payload,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Failed to create user");
        notify({
          title: "User created",
          description: sendInvite ? "Invite email sent." : "User created without invite.",
          variant: "success",
        });
        onOpenChange(false);
        onSaved && onSaved();
        onSaveComplete && onSaveComplete();
      } catch (err) {
        notify({
          title: "Failed to create user",
          description: String(err.message || err),
          variant: "error",
        });
      } finally {
        setSaving(false);
      }
      return;
    }

    if (!userId) {
      notify({
        title: "User ID is required",
        variant: "error",
      });
      return;
    }

    // Validate skills: check for duplicates and empty selections
    const skillIds = userSkillsArray
      .map((s) => s.skillId)
      .filter(Boolean);
    const duplicateSkillIds = skillIds.filter(
      (id, index) => skillIds.indexOf(id) !== index
    );
    if (duplicateSkillIds.length > 0) {
      notify({
        title: "Duplicate skills detected",
        description: "Each skill can only be assigned once. Please remove duplicates.",
        variant: "error",
      });
      return;
    }

    // Check for skills with empty skillId but in the array (incomplete selections)
    const incompleteSkills = userSkillsArray.filter(
      (s) => !s.skillId || s.skillId.trim() === ""
    );
    if (incompleteSkills.length > 0) {
      notify({
        title: "Incomplete skill selections",
        description: "Please select a skill for all entries or remove incomplete ones.",
        variant: "error",
      });
      return;
    }

    setSaving(true);
    try {
      const payload = {
        username,
        firstName,
        lastName,
        nick,
        roles, // Send roles array
        verified,
        active,
        experimentalFeatures,
        mobile,
        smsNumber,
        voiceNumber,
        // Convert array format back to object format { skillId: proficiency }
        skills: userSkillsArray.reduce((acc, skill) => {
          if (skill.skillId && skill.proficiency >= 1 && skill.proficiency <= 5) {
            acc[skill.skillId] = skill.proficiency;
          }
          return acc;
        }, {}),
        queueIds: userQueueIds, // Send array of queue IDs
        utilization: utilization.payload,
      };

      const r = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (r.ok) {
        notify({
          title: "User updated",
          description: "The user has been updated successfully",
          variant: "success",
        });
        onOpenChange(false);
        notifyExperimentalFeaturesChanged(userId);
        onSaveComplete && onSaveComplete();
      } else {
        const d = await r.json().catch(() => ({}));
        notify({
          title: "Failed to update user",
          description: d?.error || "",
          variant: "error",
        });
      }
    } catch (err) {
      notify({
        title: "Failed to update user",
        description: String(err.message || err),
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        ref={registerHelpPortalContainer}
        side="right"
        data-context-help-host="true"
        className="w-full sm:max-w-xl overflow-hidden flex flex-col p-0"
      >
        <SheetHeader className="px-6 py-4 pr-12 border-b">
          <div className="flex items-center justify-between gap-3">
            <SheetTitle className="text-xl font-bold text-telnyx-green flex items-center gap-2">
              <IconEdit className="size-5" />
              {createMode ? "Add New User" : "Edit User"}
            </SheetTitle>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-controls="context-help-sheet"
              aria-keyshortcuts="F1"
              title="Help for users (F1)"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => openHelp()}
            >
              <IconHelpCircle aria-hidden="true" />
              Help
            </Button>
          </div>
        </SheetHeader>

        {/* Scrollable Content Section */}
        <div className="flex-1 overflow-y-auto">
          <div className="space-y-4">
              {loading ? (
                <>
                  {/* Verified Switch Skeleton */}
                  <div className="flex items-center justify-between pb-4 border-b">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-6 w-11 rounded-full" />
                  </div>

                  {/* Personal Information Skeleton */}
                  <div>
                    <Skeleton className="h-4 w-40 mb-3" />
                    <div className="space-y-3">
                      <div className="grid gap-2">
                        <Skeleton className="h-4 w-32" />
                        <Skeleton className="h-9 w-full" />
                      </div>
                      <div className="grid gap-3 grid-cols-2">
                        <div className="grid gap-2">
                          <Skeleton className="h-4 w-20" />
                          <Skeleton className="h-9 w-full" />
                        </div>
                        <div className="grid gap-2">
                          <Skeleton className="h-4 w-20" />
                          <Skeleton className="h-9 w-full" />
                        </div>
                      </div>
                      <div className="grid gap-2">
                        <Skeleton className="h-4 w-20" />
                        <Skeleton className="h-9 w-full" />
                      </div>
                    </div>
                  </div>

                  <div className="border-t" />

                  {/* Phone Numbers Skeleton */}
                  <div>
                    <Skeleton className="h-4 w-32 mb-3" />
                    <div className="space-y-3">
                      <div className="grid gap-3 grid-cols-2">
                        <div className="grid gap-2">
                          <Skeleton className="h-4 w-20" />
                          <Skeleton className="h-9 w-full" />
                        </div>
                        <div className="grid gap-2">
                          <Skeleton className="h-4 w-24" />
                          <Skeleton className="h-9 w-full" />
                        </div>
                      </div>
                      <div className="grid gap-3 grid-cols-2">
                        <div className="grid gap-2">
                          <Skeleton className="h-4 w-24" />
                          <Skeleton className="h-9 w-full" />
                        </div>
                        <div className="grid gap-2">
                          <Skeleton className="h-4 w-28" />
                          <Skeleton className="h-9 w-full" />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="border-t" />

                  {/* Settings Skeleton */}
                  <div>
                    <Skeleton className="h-4 w-24 mb-3" />
                    <div className="space-y-3">
                      <div className="grid gap-3 grid-cols-2">
                        <div className="grid gap-2">
                          <Skeleton className="h-4 w-16" />
                          <Skeleton className="h-9 w-full" />
                        </div>
                        <div className="grid gap-2">
                          <Skeleton className="h-4 w-16" />
                          <Skeleton className="h-9 w-full" />
                        </div>
                      </div>
                      <div className="grid gap-3 grid-cols-2">
                        <div className="grid gap-2">
                          <Skeleton className="h-4 w-20" />
                          <Skeleton className="h-9 w-full" />
                        </div>
                        <div className="grid gap-2">
                          <Skeleton className="h-4 w-16" />
                          <Skeleton className="h-9 w-full" />
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <Card className="mx-5 my-4"><CardContent className="space-y-4 p-6">
                    <h3 className="text-sm font-semibold">Account Settings</h3>
                  {/* Invite Status Section */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3 flex items-center gap-1">
                      <IconMail className="size-3.5" />
                      {createMode ? "Invite" : "Invite Status"}
                    </h3>
                    {createMode ? (
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="edit-sheet-send-invite"
                          checked={sendInvite}
                          onCheckedChange={(v) => setSendInvite(Boolean(v))}
                        />
                        <Label htmlFor="edit-sheet-send-invite" className="cursor-pointer text-sm font-normal">
                          Send invite email after creation
                        </Label>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <div className="space-y-1">
                            {inviteStatus === "none" && (
                              <Badge variant="outline" className="text-gray-500 border-gray-300 bg-gray-50 dark:bg-gray-800/40">
                                Not invited
                              </Badge>
                            )}
                            {inviteStatus === "pending" && (
                              <div className="space-y-1">
                                <Badge variant="outline" className="text-amber-600 border-amber-400 bg-amber-50 dark:bg-amber-900/20">
                                  Pending
                                </Badge>
                                {inviteSentAt && (
                                  <p className="text-xs text-muted-foreground">
                                    Sent: {new Date(inviteSentAt).toLocaleString()}
                                  </p>
                                )}
                                {inviteExpires && (
                                  <p className="text-xs text-muted-foreground">
                                    Expires: {new Date(inviteExpires).toLocaleString()}
                                  </p>
                                )}
                              </div>
                            )}
                            {inviteStatus === "accepted" && (
                              <div className="space-y-1">
                                <Badge variant="outline" className="text-green-600 border-green-400 bg-green-50 dark:bg-green-900/20">
                                  Accepted
                                </Badge>
                                {inviteAcceptedAt && (
                                  <p className="text-xs text-muted-foreground">
                                    Accepted: {new Date(inviteAcceptedAt).toLocaleString()}
                                  </p>
                                )}
                              </div>
                            )}
                            {inviteStatus === "expired" && (
                              <Badge variant="outline" className="text-red-600 border-red-400 bg-red-50 dark:bg-red-900/20">
                                Expired
                              </Badge>
                            )}
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={onSendInvite}
                            disabled={sendingInvite || inviteStatus === "accepted"}
                            className="gap-1"
                          >
                            <IconMail className="size-3.5" />
                            {sendingInvite
                              ? "Sending..."
                              : inviteStatus === "none" || inviteStatus === "expired"
                              ? "Send Invite"
                              : inviteStatus === "pending"
                              ? "Resend Invite"
                              : "Invited"}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="border-t" />

                  {/* Verified Switch at the top */}
                  <div className="flex items-center justify-between pb-4 border-b">
                    <Label className="text-sm font-medium">
                      Account Verified
                    </Label>
                    <Switch
                      checked={verified}
                      onCheckedChange={(v) => setVerified(Boolean(v))}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label htmlFor="active" className="text-sm font-medium">
                      Active
                    </Label>
                    <Switch
                      checked={active}
                      onCheckedChange={(v) => setActive(Boolean(v))}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-4 border-t pt-4">
                    <div className="space-y-1">
                      <Label htmlFor="experimental-features" className="text-sm font-medium">
                        Experimental features
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        Translation/TTS, Phones Provisioning, and headset integrations
                      </p>
                    </div>
                    <Switch
                      id="experimental-features"
                      checked={experimentalFeatures}
                      onCheckedChange={(value) => setExperimentalFeatures(Boolean(value))}
                    />
                  </div>

                  {/* Name Section */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      Personal Information
                    </h3>
                    <div className="space-y-3">
                      <div className="grid gap-2">
                        <Label className="text-sm">Username (email){createMode && " *"}</Label>
                        <Input
                          value={username}
                          disabled={!createMode}
                          onChange={createMode ? (e) => setUsername(e.target.value) : undefined}
                          placeholder={createMode ? "john.doe@company.com" : undefined}
                          type={createMode ? "email" : undefined}
                        />
                      </div>
                      <div className="grid gap-3 grid-cols-2">
                        <div className="grid gap-2 min-w-0">
                          <Label className="text-sm">First name</Label>
                          <Input
                            value={firstName}
                            onChange={(e) => setFirstName(e.target.value)}
                          />
                        </div>
                        <div className="grid gap-2 min-w-0">
                          <Label className="text-sm">Last name</Label>
                          <Input
                            value={lastName}
                            onChange={(e) => setLastName(e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-sm">Nickname</Label>
                        <Input
                          value={nick}
                          onChange={(e) => setNick(e.target.value)}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="border-t" />

                  {/* Phone Numbers Section */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      Phone Numbers
                    </h3>
                    <div className="space-y-3">
                      <div className="grid gap-3 grid-cols-2">
                        <div className="grid gap-2 min-w-0">
                          <Label className="text-sm">Mobile</Label>
                          <Input
                            value={mobile}
                            onChange={(e) => setMobile(e.target.value)}
                          />
                        </div>
                        <div className="grid gap-2 min-w-0">
                          <Label className="text-sm">SMS number</Label>
                          <Input
                            value={smsNumber}
                            onChange={(e) => setSmsNumber(e.target.value)}
                          />
                        </div>
                      </div>
                      {/* Voice Number - enhanced picker */}
                      <div className="grid gap-2">
                        <Label className="text-sm flex items-center gap-1">
                          <IconPhone className="size-3.5" />
                          Voice Number
                        </Label>
                        <Tabs value={voiceNumberTab} onValueChange={setVoiceNumberTab}>
                          <TabsList className="h-8 w-full grid grid-cols-2">
                            <TabsTrigger value="telnyx" className="text-xs">From Telnyx</TabsTrigger>
                            <TabsTrigger value="custom" className="text-xs">Custom</TabsTrigger>
                          </TabsList>
                          <TabsContent value="telnyx" className="mt-2">
                            {numbersLoading ? (
                              <Skeleton className="h-9 w-full" />
                            ) : (() => {
                              const filteredNumbers = telnyxNumbers.filter((n) =>
                                n.phone_number.includes(numberSearch) ||
                                (n.friendly_name || "").toLowerCase().includes(numberSearch.toLowerCase())
                              );
                              return (
                                <Popover open={numberSearchOpen} onOpenChange={setNumberSearchOpen}>
                                  <PopoverTrigger asChild>
                                    <Button
                                      variant="outline"
                                      role="combobox"
                                      className="w-full justify-between font-normal"
                                    >
                                      <span className="truncate">
                                        {voiceNumber || "Select a number..."}
                                      </span>
                                      <IconSelector className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                                    </Button>
                                  </PopoverTrigger>
                                  <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                                    <Command>
                                      <CommandInput
                                        placeholder="Search number..."
                                        value={numberSearch}
                                        onValueChange={setNumberSearch}
                                      />
                                      <CommandList>
                                        <CommandEmpty>No numbers found.</CommandEmpty>
                                        <CommandItem
                                          value="__none__"
                                          onSelect={() => {
                                            setVoiceNumber("");
                                            setNumberSearchOpen(false);
                                            setNumberSearch("");
                                          }}
                                        >
                                          <span className="text-muted-foreground">— None —</span>
                                        </CommandItem>
                                        {filteredNumbers.map((num) => {
                                          const isAssigned = allUserVoiceNumbers.includes(num.phone_number);
                                          return (
                                            <CommandItem
                                              key={num.phone_number}
                                              value={num.phone_number}
                                              onSelect={() => {
                                                setVoiceNumber(num.phone_number);
                                                setNumberSearchOpen(false);
                                                setNumberSearch("");
                                              }}
                                            >
                                              <span className="flex items-center gap-2 flex-1">
                                                <span>{num.phone_number}</span>
                                                {num.friendly_name && (
                                                  <span className="text-muted-foreground text-xs">
                                                    ({num.friendly_name})
                                                  </span>
                                                )}
                                                {isAssigned && (
                                                  <span className="text-amber-500 text-xs ml-auto">
                                                    (assigned)
                                                  </span>
                                                )}
                                              </span>
                                              {voiceNumber === num.phone_number && (
                                                <IconCheck className="ml-2 h-4 w-4 shrink-0" />
                                              )}
                                            </CommandItem>
                                          );
                                        })}
                                        {telnyxNumbers.length === 0 && (
                                          <div className="py-6 text-center text-sm text-muted-foreground">
                                            No numbers available
                                          </div>
                                        )}
                                      </CommandList>
                                    </Command>
                                  </PopoverContent>
                                </Popover>
                              );
                            })()}
                          </TabsContent>
                          <TabsContent value="custom" className="mt-2">
                            <div className="flex gap-2">
                              <Input
                                value={voiceNumber}
                                onChange={(e) => setVoiceNumber(e.target.value)}
                                placeholder="+1234567890"
                                className="flex-1"
                              />
                              {voiceNumber && (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setVoiceNumber("")}
                                >
                                  Clear
                                </Button>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground mt-1">
                              Enter any E.164 number (e.g. +12025551234)
                            </p>
                          </TabsContent>
                        </Tabs>
                        {voiceNumber && (
                          <p className="text-xs text-muted-foreground">
                            Current: <span className="font-mono font-medium">{voiceNumber}</span>
                          </p>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="border-t" />

                  {/* Settings Section */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      Settings
                    </h3>
                    <div className="space-y-3">
                      <div className="grid gap-2">
                        <Label className="text-sm">Roles</Label>
                        <RolesMultiSelect
                          value={roles}
                          onChange={setRoles}
                          options={roleOptions}
                          lockedValues={actorIsOwner ? [] : ["owner"]}
                          lockedHint="Only an owner can grant or revoke the Owner role"
                        />
                      </div>
                    </div>
                  </div>

                  </CardContent></Card>
                  <ChannelUtilization scope="agent" form={utilization} disabled={saving} />
                  <Card className="mx-5 my-4"><CardContent className="space-y-4 p-6">
                  {/* Queue Assignments Section */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      Queue Assignments
                    </h3>
                    {queuesLoading ? (
                      <div className="space-y-2">
                        <Skeleton className="h-9 w-full" />
                        <Skeleton className="h-9 w-full" />
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {availableQueues.length === 0 ? (
                          <p className="text-sm text-muted-foreground">
                            No queues available. Create queues in the Queues management page.
                          </p>
                        ) : (
                          <div className="rounded border overflow-hidden">
                            <div className="p-3 space-y-2 max-h-[300px] overflow-y-auto">
                              {availableQueues.map((queue) => {
                                const isAssigned = userQueueIds.includes(queue.id);
                                return (
                                  <label
                                    key={queue.id}
                                    className="flex items-start gap-2 text-sm cursor-pointer hover:bg-muted/50 rounded-md p-2 -m-2 transition-colors"
                                  >
                                    <Checkbox
                                      checked={isAssigned}
                                      onCheckedChange={(checked) => {
                                        if (checked) {
                                          setUserQueueIds([...userQueueIds, queue.id]);
                                        } else {
                                          setUserQueueIds(
                                            userQueueIds.filter((id) => id !== queue.id)
                                          );
                                        }
                                      }}
                                      className="mt-0.5 shrink-0"
                                    />
                                    <div className="flex-1 min-w-0">
                                      <div className="font-medium">
                                        {queue.display_name || queue.name}
                                      </div>
                                      {queue.description && (
                                        <div className="text-xs text-muted-foreground mt-1">
                                          {queue.description}
                                        </div>
                                      )}
                                    </div>
                                  </label>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  </CardContent></Card>
                  <Card className="mx-5 my-4"><CardContent className="space-y-4 p-6">
                  {/* Skills Section */}
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-semibold text-muted-foreground">
                        Skills & Proficiency
                      </h3>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setUserSkillsArray([...userSkillsArray, { skillId: "", proficiency: 1 }]);
                        }}
                        disabled={
                          skillsLoading ||
                          availableSkills.length === 0 ||
                          userSkillsArray.length >= availableSkills.length
                        }
                        title={
                          userSkillsArray.length >= availableSkills.length
                            ? "All available skills have been assigned"
                            : "Add a skill"
                        }
                      >
                        <IconPlus className="w-4 h-4 mr-1" />
                        Add Skill
                      </Button>
                    </div>
                    {skillsLoading ? (
                      <div className="space-y-2">
                        <Skeleton className="h-9 w-full" />
                        <Skeleton className="h-9 w-full" />
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {availableSkills.length === 0 ? (
                          <p className="text-sm text-muted-foreground">
                            No skills available. Create skills in the Skills management page.
                          </p>
                        ) : userSkillsArray.length === 0 ? (
                          <p className="text-sm text-muted-foreground">
                            No skills assigned. Click &quot;Add Skill&quot; to assign skills to this agent.
                          </p>
                        ) : (
                          userSkillsArray.map((skill, index) => {
                            return (
                              <div
                                key={index}
                                className="flex items-center gap-3 p-3 border rounded-md"
                              >
                                <Select
                                  value={skill.skillId || undefined}
                                  onValueChange={(value) => {
                                    // Prevent selecting a skill that's already assigned to another row
                                    const isDuplicate = userSkillsArray.some(
                                      (sk, idx) => sk.skillId === value && idx !== index
                                    );
                                    if (isDuplicate) {
                                      notify({
                                        title: "Skill already assigned",
                                        description: "This skill is already assigned. Please select a different skill.",
                                        variant: "error",
                                      });
                                      return;
                                    }
                                    const updated = [...userSkillsArray];
                                    updated[index] = { ...updated[index], skillId: value };
                                    setUserSkillsArray(updated);
                                  }}
                                >
                                  <SelectTrigger className="flex-1">
                                    <SelectValue placeholder="Select a skill" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {availableSkills
                                      .filter(
                                        (s) =>
                                          !skill.skillId ||
                                          s.id === skill.skillId ||
                                          !userSkillsArray.some(
                                            (sk, idx) => sk.skillId === s.id && idx !== index
                                          )
                                      )
                                      .map((skillOption) => (
                                        <SelectItem key={skillOption.id} value={skillOption.id}>
                                          {skillOption.name}
                                        </SelectItem>
                                      ))}
                                  </SelectContent>
                                </Select>
                                <div className="flex items-center gap-1">
                                  {[1, 2, 3, 4, 5].map((level) => (
                                    <button
                                      key={level}
                                      type="button"
                                      onClick={() => {
                                        const updated = [...userSkillsArray];
                                        updated[index] = { ...updated[index], proficiency: level };
                                        setUserSkillsArray(updated);
                                      }}
                                      className="focus:outline-none"
                                      title={`Proficiency level ${level}`}
                                    >
                                      {(skill.proficiency || 1) >= level ? (
                                        <IconStarFilled
                                          className="size-5 text-yellow-500"
                                        />
                                      ) : (
                                        <IconStar className="size-5 text-gray-300" />
                                      )}
                                    </button>
                                  ))}
                                </div>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    setUserSkillsArray(userSkillsArray.filter((_, i) => i !== index));
                                  }}
                                >
                                  <IconTrash className="w-4 h-4" />
                                </Button>
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                  </CardContent></Card>
                </>
              )}
          </div>
        </div>

        {/* Fixed Footer */}
        <SheetFooter className="px-6 py-4 border-t flex flex-row justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={onSave} disabled={saving || (!createMode && loading) || !utilization.ready}>
            {saving
              ? createMode ? "Creating..." : "Saving..."
              : createMode ? "Create User" : "Save Changes"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
