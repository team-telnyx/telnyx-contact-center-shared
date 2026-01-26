"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { notify } from "@/components/ToastNotify";
import ProfileImageEditor from "@/components/profile-image-editor";
import { useRef } from "react";
import { useTheme } from "next-themes";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  IconUser,
  IconCheck,
  IconKey,
  IconShieldCheck,
  IconBrandGoogle,
  IconStar,
  IconStarFilled,
} from "@tabler/icons-react";
import {
  updateProfileAction,
  uploadProfilePictureAction,
  getProfileAction,
} from "@/app/actions/user";

export default function ProfilePage() {
  const { theme } = useTheme();
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    nick: "",
    mobile: "",
    voiceNumber: "",
  });
  const [saving, setSaving] = useState(false);
  const [avatar, setAvatar] = useState("/avatar.jpeg");
  const [profileLoading, setProfileLoading] = useState(true);
  const [authStrategy, setAuthStrategy] = useState("local");
  const [hasPassword, setHasPassword] = useState(false);
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [passwordSaving, setPasswordSaving] = useState(false);
  const editorRef = useRef(null);
  const [userSkills, setUserSkills] = useState({});
  const [allSkills, setAllSkills] = useState([]);
  const [loadingSkills, setLoadingSkills] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const resp = await getProfileAction();
        if (resp?.ok && resp.user) {
          const data = resp.user;
          setForm((prev) => ({ ...prev, ...data }));
          if (data?.profilePictureUri) setAvatar(data.profilePictureUri);

          // Mobile is optional, no warning needed

          // Fetch auth strategy info
          const authResp = await fetch("/api/user/auth-methods");
          if (authResp.ok) {
            const authData = await authResp.json();
            setAuthStrategy(authData.hasGoogle ? "google" : "local");
            setHasPassword(authData.hasPassword || false);
          }

          // Fetch user skills
          const skillsResp = await fetch("/api/user/skills");
          if (skillsResp.ok) {
            const skillsData = await skillsResp.json();
            if (skillsData?.ok && skillsData?.skills) {
              setUserSkills(skillsData.skills || {});
            }
          }
        }
      } catch (_) {}
      setProfileLoading(false);
    })();
  }, []);

  // Load all skills for mapping UUIDs to names
  useEffect(() => {
    (async () => {
      setLoadingSkills(true);
      try {
        const res = await fetch("/api/admin/skills?active=true&pageSize=1000", {
          cache: "no-store",
        });
        if (res.ok) {
          const data = await res.json();
          setAllSkills(data.items || []);
        }
      } catch (err) {
        console.error("Failed to load skills:", err);
      } finally {
        setLoadingSkills(false);
      }
    })();
  }, []);

  function setField(name, value) {
    setForm((p) => ({ ...p, [name]: value }));
  }

  async function onSubmit(e) {
    e.preventDefault();
    setSaving(true);

    // Mobile is optional, no validation needed

    try {
      let uploadedProfilePictureUri = form.profilePictureUri || "";

      // Handle profile picture upload if there's a pending crop
      try {
        const blob = await editorRef.current?.getPendingCroppedBlob?.();
        if (blob) {
          const dataUrl = await new Promise((resolve, reject) => {
            try {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            } catch (err) {
              reject(err);
            }
          });
          const up = await uploadProfilePictureAction(dataUrl);
          if (up?.ok && up?.profilePictureUri) {
            uploadedProfilePictureUri = up.profilePictureUri;
            setAvatar(up.profilePictureUri);
            setForm((p) => ({
              ...p,
              profilePictureUri: up.profilePictureUri,
            }));
            editorRef.current?.cancelEditing?.();
          } else if (up?.error) {
            // Continue with profile update even if picture upload fails
          }
        }
      } catch (err) {
        // Continue with profile update even if picture upload fails
      }

      // Prepare FormData - only nick and mobile can be changed by user
      const fd = new FormData();
      fd.set("nick", (form.nick || "").trim());
      fd.set("mobile", (form.mobile || "").trim());

      const result = await updateProfileAction(fd);
      if (!result?.ok) {
        throw new Error(result?.error || "Failed to save profile");
      }

      // Refresh profile data after successful update
      try {
        const resp = await getProfileAction();
        if (resp?.ok && resp.user) {
          const data = resp.user;
          setForm((prev) => ({ ...prev, ...data }));
          if (data?.profilePictureUri) setAvatar(data.profilePictureUri);
        }
      } catch (refreshErr) {
        // Silently fail refresh
      }

      // Notify other components (like sidebar) that profile was updated
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("profile:updated"));
      }

      notify({
        title: "Profile updated",
        description: "Your profile has been updated successfully",
        variant: "success",
      });
    } catch (err) {
      notify({
        title: "Failed to save",
        description: err.message,
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  async function onPasswordSubmit(e) {
    e.preventDefault();

    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      notify({
        title: "Passwords do not match",
        variant: "error",
      });
      return;
    }

    const strong =
      /[a-z]/.test(passwordForm.newPassword) &&
      /[A-Z]/.test(passwordForm.newPassword) &&
      /[^A-Za-z0-9]/.test(passwordForm.newPassword) &&
      passwordForm.newPassword.length >= 8;

    if (!strong) {
      notify({
        title: "Password too weak",
        description:
          "Password must be 8+ chars with upper, lower and special char",
        variant: "error",
      });
      return;
    }

    setPasswordSaving(true);
    try {
      const response = await fetch("/api/auth/update-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: passwordForm.currentPassword,
          newPassword: passwordForm.newPassword,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || "Failed to update password");
      }

      notify({
        title: "Password updated",
        description: "Your password has been updated successfully",
        variant: "success",
      });

      setPasswordForm({
        currentPassword: "",
        newPassword: "",
        confirmPassword: "",
      });

      // Refresh to update hasPassword state
      if (!hasPassword) {
        setHasPassword(true);
      }
    } catch (err) {
      notify({
        title: "Failed to update password",
        description: err.message,
        variant: "error",
      });
    } finally {
      setPasswordSaving(false);
    }
  }

  return (
    <div className="px-4 lg:px-6">
      <Tabs defaultValue="profile" className="w-full">
        <TabsList className="grid w-full max-w-md grid-cols-2 mb-6">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="space-y-6">
          <Card className="w-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <IconUser className="size-6 text-brand-primary" /> Profile
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              {profileLoading ? (
                <div className="grid grid-cols-[auto_1fr] gap-6 items-start">
                  <div>
                    <Skeleton className="h-44 w-44 rounded-full" />
                  </div>
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="grid gap-2">
                        <Skeleton className="h-4 w-24" />
                        <Skeleton className="h-9 w-full" />
                      </div>
                      <div className="grid gap-2">
                        <Skeleton className="h-4 w-24" />
                        <Skeleton className="h-9 w-full" />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="grid gap-2">
                        <Skeleton className="h-4 w-24" />
                        <Skeleton className="h-9 w-full" />
                      </div>
                      <div className="grid gap-2">
                        <Skeleton className="h-4 w-24" />
                        <Skeleton className="h-9 w-full" />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="grid gap-2">
                        <Skeleton className="h-4 w-24" />
                        <Skeleton className="h-9 w-full" />
                      </div>
                      <div className="grid gap-2">
                        <Skeleton className="h-4 w-36" />
                        <Skeleton className="h-9 w-full" />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="grid gap-2">
                        <Skeleton className="h-4 w-28" />
                        <Skeleton className="h-9 w-full" />
                      </div>
                      <div className="grid gap-2">
                        <Skeleton className="h-4 w-36" />
                        <Skeleton className="h-9 w-full" />
                      </div>
                    </div>
                    <div className="flex justify-end">
                      <Skeleton className="h-9 w-32" />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-[auto_1fr] gap-6 items-start">
                  <div>
                    <ProfileImageEditor
                      ref={editorRef}
                      initialSrc={avatar}
                      onPreviewChange={(src) => setAvatar(src)}
                    />
                  </div>
                  <form onSubmit={onSubmit} className={cn("space-y-4")}>
                    {/* Read-only fields */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="grid gap-2">
                        <Label htmlFor="firstName">First name</Label>
                        <Input
                          id="firstName"
                          value={form.firstName}
                          disabled
                          className="bg-muted"
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="lastName">Last name</Label>
                        <Input
                          id="lastName"
                          value={form.lastName}
                          disabled
                          className="bg-muted"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="grid gap-2">
                        <Label htmlFor="nick">Nick</Label>
                        <Input
                          id="nick"
                          value={form.nick}
                          onChange={(e) => setField("nick", e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="grid gap-2">
                        <Label htmlFor="mobile">Mobile</Label>
                        <Input
                          id="mobile"
                          value={form.mobile}
                          onChange={(e) => setField("mobile", e.target.value)}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="voiceNumber">Voice number</Label>
                        <Input
                          id="voiceNumber"
                          value={form.voiceNumber}
                          disabled
                          className="bg-muted"
                        />
                      </div>
                    </div>
                    <div className="flex justify-end">
                      <Button type="submit" disabled={saving}>
                        {saving ? "Saving..." : "Save changes"}
                      </Button>
                    </div>
                  </form>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Skills Section */}
          <Card className="w-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <IconUser className="size-6 text-brand-primary" /> Skills &
                Proficiency
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              {profileLoading || loadingSkills ? (
                <div className="space-y-3">
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-full" />
                </div>
              ) : (
                (() => {
                  // Convert user skills from UUID keys to skill objects with names
                  const skillEntries = Object.entries(userSkills || {})
                    .map(([skillId, proficiency]) => {
                      const skill = allSkills.find((s) => s.id === skillId);
                      return skill ? { skill, proficiency } : null;
                    })
                    .filter(Boolean)
                    .sort((a, b) => a.skill.name.localeCompare(b.skill.name));

                  if (skillEntries.length === 0) {
                    return (
                      <p className="text-sm text-muted-foreground text-center py-4">
                        No skills assigned. Contact your administrator to assign
                        skills.
                      </p>
                    );
                  }

                  return (
                    <div className="space-y-3">
                      {skillEntries.map(({ skill, proficiency }) => (
                        <div
                          key={skill.id}
                          className="flex items-center justify-between p-3 border rounded-lg"
                        >
                          <div className="flex-1">
                            <div className="text-sm font-medium">
                              {skill.name}
                            </div>
                            {skill.description && (
                              <div className="text-xs text-muted-foreground mt-1">
                                {skill.description}
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-1 ml-4">
                            {[1, 2, 3, 4, 5].map((level) =>
                              proficiency >= level ? (
                                <IconStarFilled
                                  key={level}
                                  className="size-5 text-yellow-500"
                                />
                              ) : (
                                <IconStar
                                  key={level}
                                  className="size-5 text-gray-300"
                                />
                              )
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="security" className="space-y-6">
          {/* Authentication Methods Card */}
          <Card className="w-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <IconShieldCheck className="size-6 text-brand-primary" />{" "}
                Authentication Methods
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              {profileLoading ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Skeleton className="h-24 w-full rounded-lg" />
                  <Skeleton className="h-24 w-full rounded-lg" />
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* Credentials Auth Card */}
                  <div
                    className={cn(
                      "border rounded-lg p-4 flex items-center gap-4",
                      hasPassword
                        ? "border-brand-primary bg-brand-primary/5"
                        : "border-border bg-muted/30"
                    )}
                  >
                    <div
                      className={cn(
                        "size-12 rounded-full flex items-center justify-center",
                        hasPassword ? "bg-brand-primary text-black" : "bg-muted"
                      )}
                    >
                      <IconKey className="size-6" />
                    </div>
                    <div className="flex-1">
                      <div className="font-semibold">Email & Password</div>
                      <div className="text-sm text-muted-foreground">
                        {hasPassword ? "Enabled" : "Not configured"}
                      </div>
                    </div>
                    {hasPassword && (
                      <IconCheck className="size-5 text-brand-primary" />
                    )}
                  </div>

                  {/* Google OAuth Card */}
                  <div
                    className={cn(
                      "border rounded-lg p-4 flex items-center gap-4",
                      authStrategy === "google"
                        ? "border-brand-primary bg-brand-primary/5"
                        : "border-border bg-muted/30"
                    )}
                  >
                    <div
                      className={cn(
                        "size-12 rounded-full flex items-center justify-center",
                        authStrategy === "google"
                          ? "bg-brand-primary text-black"
                          : "bg-muted"
                      )}
                    >
                      <IconBrandGoogle className="size-6" />
                    </div>
                    <div className="flex-1">
                      <div className="font-semibold">Google Account</div>
                      <div className="text-sm text-muted-foreground">
                        {authStrategy === "google"
                          ? "Connected"
                          : "Not connected"}
                      </div>
                    </div>
                    {authStrategy === "google" && (
                      <IconCheck className="size-5 text-brand-primary" />
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Password Update Card */}
          <Card className="w-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <IconKey className="size-6 text-brand-primary" />
                {hasPassword ? "Change Password" : "Set Password"}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              {profileLoading ? (
                <div className="space-y-4">
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-32" />
                </div>
              ) : (
                <>
                  {!hasPassword && authStrategy === "google" && (
                    <div className="mb-4 p-4 border border-blue-500/30 bg-blue-500/10 rounded-lg text-sm">
                      <p className="text-blue-400 font-medium mb-1">
                        Enable Credentials Authentication
                      </p>
                      <p className="text-muted-foreground">
                        You have Google authentication enabled. Set a password
                        to also enable signing in with email and password.
                      </p>
                    </div>
                  )}
                  <form onSubmit={onPasswordSubmit} className="space-y-4">
                    {hasPassword && (
                      <div className="grid gap-2">
                        <Label htmlFor="currentPassword">
                          Current Password
                        </Label>
                        <Input
                          id="currentPassword"
                          type="password"
                          value={passwordForm.currentPassword}
                          onChange={(e) =>
                            setPasswordForm((p) => ({
                              ...p,
                              currentPassword: e.target.value,
                            }))
                          }
                          required={hasPassword}
                        />
                      </div>
                    )}
                    <div className="grid gap-2">
                      <Label htmlFor="newPassword">New Password</Label>
                      <Input
                        id="newPassword"
                        type="password"
                        value={passwordForm.newPassword}
                        onChange={(e) =>
                          setPasswordForm((p) => ({
                            ...p,
                            newPassword: e.target.value,
                          }))
                        }
                        required
                      />
                      <p className="text-xs text-muted-foreground">
                        At least 8 chars, upper, lower, special
                      </p>
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="confirmPassword">
                        Confirm New Password
                      </Label>
                      <Input
                        id="confirmPassword"
                        type="password"
                        value={passwordForm.confirmPassword}
                        onChange={(e) =>
                          setPasswordForm((p) => ({
                            ...p,
                            confirmPassword: e.target.value,
                          }))
                        }
                        required
                      />
                    </div>
                    <div className="flex justify-end">
                      <Button type="submit" disabled={passwordSaving}>
                        {passwordSaving
                          ? "Updating..."
                          : hasPassword
                          ? "Update Password"
                          : "Set Password"}
                      </Button>
                    </div>
                  </form>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
