"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { notify } from "@/components/ToastNotify";
import { cn } from "@/lib/utils";
import { AuthBrandLogo } from "@/components/auth-brand-logo";
import { AuthRightImage } from "@/components/auth-right-image";

function PasswordRequirement({ met, label }) {
  return (
    <div className={cn("flex items-center gap-1.5 text-xs", met ? "text-green-500" : "text-muted-foreground")}>
      <span>{met ? "✓" : "○"}</span>
      <span>{label}</span>
    </div>
  );
}

export default function SetPasswordPage() {
  const params = useParams();
  const router = useRouter();
  const token = params.token;

  const [verifying, setVerifying] = useState(true);
  const [valid, setValid] = useState(false);
  const [invalidReason, setInvalidReason] = useState("");
  const [inviteUser, setInviteUser] = useState(null);

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  // Password strength checks
  const checks = {
    length: password.length >= 8,
    upper: /[A-Z]/.test(password),
    lower: /[a-z]/.test(password),
    number: /[0-9]/.test(password),
    special: /[^A-Za-z0-9]/.test(password),
  };
  const allChecksPass = Object.values(checks).every(Boolean);

  // Verify token on mount
  useEffect(() => {
    async function verifyToken() {
      if (!token) {
        setVerifying(false);
        setValid(false);
        setInvalidReason("no_token");
        return;
      }
      try {
        const res = await fetch(`/api/auth/invite/${token}`);
        const data = await res.json();
        if (data.valid) {
          setValid(true);
          setInviteUser(data.user);
        } else {
          setValid(false);
          setInvalidReason(data.reason || "not_found");
        }
      } catch (err) {
        setValid(false);
        setInvalidReason("server_error");
      } finally {
        setVerifying(false);
      }
    }
    verifyToken();
  }, [token]);

  async function onSubmit(e) {
    e.preventDefault();
    setError("");

    if (!allChecksPass) {
      setError("Please meet all password requirements.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`/api/auth/invite/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Failed to set password");
      }

      setSuccess(true);
      notify({
        title: "Password set!",
        description: "You can now sign in.",
        variant: "success",
        autoCloseMs: 3000,
      });

      setTimeout(() => {
        router.push("/signin?message=Password+set!+You+can+now+sign+in.");
      }, 2000);
    } catch (err) {
      setError(err.message || "Failed to set password");
      notify({
        title: "Error",
        description: err.message || "Failed to set password",
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  }

  const invalidMessages = {
    expired: {
      icon: "⏰",
      title: "Invitation Expired",
      desc: "This invitation link has expired. Please contact your administrator to send a new invite.",
    },
    already_accepted: {
      icon: "✅",
      title: "Already Used",
      desc: "This invitation has already been used. You can sign in with your existing credentials.",
    },
    not_found: {
      icon: "❌",
      title: "Invalid Link",
      desc: "This invitation link is invalid. Please check your email or contact your administrator.",
    },
    server_error: {
      icon: "⚠️",
      title: "Server Error",
      desc: "Something went wrong. Please try again or contact your administrator.",
    },
  };

  const invalidInfo = invalidMessages[invalidReason] || invalidMessages.not_found;

  return (
    <div className="dark grid min-h-svh lg:grid-cols-[1fr_1.8fr] bg-background text-foreground">
      <div className="flex flex-col gap-4 p-6 md:p-10">
        {/* Logo */}
        <div className="flex justify-center w-full">
          <div className="flex flex-col items-center w-full justify-center">
            <AuthBrandLogo />
            <span className="text-6xl font-bold mt-10 text-brand-primary dark:text-brand-primary">
              Contact Center
            </span>
          </div>
        </div>

        <div className="flex flex-1 mt-8 justify-center">
          <div className="w-full max-w-xs">
            {/* Loading state */}
            {verifying && (
              <div className="text-center space-y-4">
                <div className="text-5xl animate-pulse">⏳</div>
                <h1 className="text-2xl font-bold">Verifying invitation...</h1>
                <p className="text-sm text-muted-foreground">Please wait.</p>
              </div>
            )}

            {/* Invalid token */}
            {!verifying && !valid && (
              <div className="text-center space-y-4">
                <div className="text-5xl">{invalidInfo.icon}</div>
                <h1 className="text-2xl font-bold">{invalidInfo.title}</h1>
                <p className="text-sm text-muted-foreground">{invalidInfo.desc}</p>
                <Button
                  className="w-full mt-4"
                  onClick={() => router.push("/signin")}
                >
                  Go to Sign In
                </Button>
              </div>
            )}

            {/* Success state */}
            {success && (
              <div className="text-center space-y-4">
                <div className="text-5xl">🎉</div>
                <h1 className="text-2xl font-bold">Password Set!</h1>
                <p className="text-sm text-muted-foreground">
                  Your password has been set successfully.
                  <br />
                  Redirecting you to sign in...
                </p>
              </div>
            )}

            {/* Set password form */}
            {!verifying && valid && !success && (
              <form onSubmit={onSubmit} className="space-y-5">
                <div className="space-y-1">
                  <h1 className="text-2xl font-bold">Welcome,{" "}
                    {inviteUser?.firstName || ""}!
                  </h1>
                  <p className="text-sm text-muted-foreground">
                    Set a password for <span className="font-medium text-foreground">{inviteUser?.email}</span> to get started.
                  </p>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    disabled={loading}
                    autoComplete="new-password"
                  />
                  {/* Password requirements */}
                  <div className="space-y-1 mt-1">
                    <PasswordRequirement met={checks.length} label="At least 8 characters" />
                    <PasswordRequirement met={checks.upper} label="One uppercase letter (A-Z)" />
                    <PasswordRequirement met={checks.lower} label="One lowercase letter (a-z)" />
                    <PasswordRequirement met={checks.number} label="One number (0-9)" />
                    <PasswordRequirement met={checks.special} label="One special character (!@#$...)" />
                  </div>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="confirmPassword">Confirm Password</Label>
                  <Input
                    id="confirmPassword"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    disabled={loading}
                    autoComplete="new-password"
                  />
                  {confirmPassword && password !== confirmPassword && (
                    <p className="text-xs text-red-500">Passwords do not match</p>
                  )}
                  {confirmPassword && password === confirmPassword && confirmPassword.length > 0 && (
                    <p className="text-xs text-green-500">✓ Passwords match</p>
                  )}
                </div>

                {error && <p className="text-xs text-red-500">{error}</p>}

                <Button
                  type="submit"
                  className="w-full"
                  disabled={loading || !allChecksPass || password !== confirmPassword}
                >
                  {loading ? "Setting password..." : "Set Password & Sign In"}
                </Button>

                <p className="text-center text-sm">
                  <a href="/signin" className="underline underline-offset-4 text-muted-foreground hover:text-foreground">
                    Back to sign in
                  </a>
                </p>
              </form>
            )}
          </div>
        </div>
      </div>

      {/* Right side image */}
      <div className="bg-muted relative hidden lg:block m-5 rounded-xl overflow-hidden">
        <AuthRightImage />
      </div>
    </div>
  );
}
