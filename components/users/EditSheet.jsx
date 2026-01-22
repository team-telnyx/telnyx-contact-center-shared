"use client";

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
import { Combobox } from "@/components/ui/combobox";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { IconEdit, IconCheck } from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import { Card, CardContent } from "@/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  USER_STATUS_OPTIONS,
  DEFAULT_USER_STATUS,
  USER_ROLES,
} from "@/config/user";
import { Moon, Sun, Monitor } from "lucide-react";
import { listLanguagesAction } from "@/app/actions/user";

/**
 * Multi-select component for roles
 */
function RolesMultiSelect({ value = [], onChange, options = [] }) {
  const [open, setOpen] = React.useState(false);

  const toggleRole = (roleValue) => {
    const newRoles = value.includes(roleValue)
      ? value.filter((r) => r !== roleValue)
      : [...value, roleValue];
    onChange(newRoles);
  };

  const selectedLabels = value
    .map((v) => options.find((o) => o.value === v)?.label)
    .filter(Boolean)
    .join(", ");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="w-full justify-between">
          <span className="truncate">
            {selectedLabels || "Select roles..."}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width]">
        <div className="space-y-2">
          {options.map((option) => {
            const Icon = option.Icon;
            const isSelected = value.includes(option.value);
            return (
              <div
                key={option.value}
                className="flex items-center gap-2 p-2 rounded hover:bg-accent cursor-pointer"
                onClick={() => toggleRole(option.value)}
              >
                <Checkbox checked={isSelected} />
                {Icon && <Icon className="h-4 w-4" />}
                <span className="flex-1">{option.label}</span>
                {isSelected && <IconCheck className="h-4 w-4 text-primary" />}
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
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
}) {
  const [username, setUsername] = React.useState("");
  const [firstName, setFirstName] = React.useState("");
  const [lastName, setLastName] = React.useState("");
  const [nick, setNick] = React.useState("");
  const [roles, setRoles] = React.useState(["agent"]);
  const [verified, setVerified] = React.useState(false);
  const [active, setActive] = React.useState(true);
  const [status, setStatus] = React.useState(DEFAULT_USER_STATUS);
  const [mobile, setMobile] = React.useState("");
  const [smsNumber, setSmsNumber] = React.useState("");
  const [voiceNumber, setVoiceNumber] = React.useState("");
  const [language, setLanguage] = React.useState("en-US");
  const [theme, setTheme] = React.useState("system");
  const [langs, setLangs] = React.useState([]);
  const [langsLoading, setLangsLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [loading, setLoading] = React.useState(false);

  // Load user data when userId changes
  React.useEffect(() => {
    async function loadUser() {
      if (!userId || !open) return;

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
          setStatus(d.status || DEFAULT_USER_STATUS);
          setMobile(d.mobile || "");
          setSmsNumber(d.sms_number || "");
          setVoiceNumber(d.voice_number || "");
          setLanguage(d.language || "en-US");
          setTheme(d.theme || "system");
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

    if (open && userId) {
      loadUser();
    }
  }, [userId, open]);

  // Load languages
  React.useEffect(() => {
    async function loadLanguages() {
      setLangsLoading(true);
      try {
        const out = await listLanguagesAction();
        if (out?.ok) setLangs(out.languages || []);
      } catch (err) {
        console.error("Failed to load languages:", err);
      } finally {
        setLangsLoading(false);
      }
    }

    if (open) {
      loadLanguages();
    }
  }, [open]);

  function countryCodeToFlagEmoji(code) {
    try {
      if (!code) return "";
      const cc = String(code).trim().toUpperCase();
      if (cc.length !== 2 || /[^A-Z]/.test(cc)) return "";
      const codePoints = [...cc].map((c) => 127397 + c.charCodeAt(0));
      return String.fromCodePoint(...codePoints);
    } catch (_) {
      return "";
    }
  }

  async function onSave() {
    if (!userId) {
      notify({
        title: "User ID is required",
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
        status,
        mobile,
        language,
        smsNumber,
        voiceNumber,
        theme,
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
        side="right"
        className="w-full sm:max-w-xl overflow-hidden flex flex-col p-0"
      >
        <SheetHeader className="px-6 py-4 border-b">
          <SheetTitle className="text-xl font-bold text-telnyx-green flex items-center gap-2">
            <IconEdit className="size-5" />
            Edit User
          </SheetTitle>
        </SheetHeader>

        {/* Scrollable Content Section */}
        <div className="flex-1 overflow-y-auto">
          <Card className="mx-5 my-4">
            <CardContent className="p-6 space-y-4">
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

                  {/* Name Section */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      Personal Information
                    </h3>
                    <div className="space-y-3">
                      <div className="grid gap-2">
                        <Label className="text-sm">Username (email)</Label>
                        <Input value={username} disabled />
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
                      <div className="grid gap-3 grid-cols-2">
                        <div className="grid gap-2 min-w-0">
                          <Label className="text-sm">Voice number</Label>
                          <Input
                            value={voiceNumber}
                            onChange={(e) => setVoiceNumber(e.target.value)}
                          />
                        </div>
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
                      <div className="grid gap-3 grid-cols-2">
                        <div className="grid gap-2 min-w-0">
                          <Label className="text-sm">Roles</Label>
                          <RolesMultiSelect
                            value={roles}
                            onChange={setRoles}
                            options={USER_ROLES}
                          />
                        </div>
                        <div className="grid gap-2 min-w-0">
                          <Label className="text-sm">Status</Label>
                          <Combobox
                            value={status}
                            onChange={(v) => setStatus(v)}
                            options={USER_STATUS_OPTIONS.map(
                              ({ value, Icon }) => ({
                                value,
                                label: value,
                                Icon,
                              })
                            )}
                            placeholder="Select status"
                            searchable={false}
                            contentClassName="w-[--radix-dropdown-menu-trigger-width]"
                          />
                        </div>
                      </div>
                      <div className="grid gap-3 grid-cols-2">
                        <div className="grid gap-2 min-w-0">
                          <Label className="text-sm">Language</Label>
                          <Combobox
                            value={language}
                            onChange={(v) => setLanguage(v)}
                            options={(Array.isArray(langs) ? langs : []).map(
                              (l) => ({
                                value: l.value,
                                label: `${countryCodeToFlagEmoji(l.flag)} ${
                                  l.language
                                }`,
                              })
                            )}
                            placeholder="Select language"
                            searchable={false}
                            contentClassName="w-[--radix-dropdown-menu-trigger-width]"
                          />
                        </div>
                        <div className="grid gap-2 min-w-0">
                          <Label className="text-sm">Theme</Label>
                          <Combobox
                            value={theme}
                            onChange={(v) => setTheme(v)}
                            options={[
                              { value: "light", label: "Light", Icon: Sun },
                              { value: "dark", label: "Dark", Icon: Moon },
                              {
                                value: "system",
                                label: "System",
                                Icon: Monitor,
                              },
                            ]}
                            placeholder="Select theme"
                            searchable={false}
                            contentClassName="w-[--radix-dropdown-menu-trigger-width]"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
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
          <Button onClick={onSave} disabled={saving || loading}>
            {saving ? "Saving..." : "Save Changes"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
