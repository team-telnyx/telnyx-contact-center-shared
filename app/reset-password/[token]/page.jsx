"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import Image from "next/image";
import { notify } from "@/components/ToastNotify";

export default function ResetPasswordPage() {
  const params = useParams();
  const router = useRouter();
  const token = params.token;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const password = form.password.value;
    const confirmPassword = form.confirmPassword.value;

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    const strong =
      /[a-z]/.test(password) &&
      /[A-Z]/.test(password) &&
      /[^A-Za-z0-9]/.test(password) &&
      password.length >= 8;

    if (!strong) {
      setError(
        "Password must be 8+ chars with upper, lower and special character"
      );
      return;
    }

    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || "Failed to reset password");
      }

      setSuccess(true);
      notify({
        title: "Password reset successful",
        description:
          "Your password has been updated. Redirecting to sign in...",
        variant: "success",
        autoCloseMs: 3000,
      });

      setTimeout(() => {
        router.push("/signin");
      }, 3000);
    } catch (err) {
      setError(err.message || "Failed to reset password");
      notify({
        title: "Password reset failed",
        description: err.message || "Failed to reset password",
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div className="dark grid min-h-svh lg:grid-cols-[1fr_1.8fr] bg-background text-foreground">
        <div className="flex flex-col gap-4 p-6 md:p-10">
          <div className="flex justify-center gap-2 md:justify-start">
            <div className="flex justify-center w-full">
              <div className="flex flex-col items-center w-full justify-center">
                <Image
                  src="/telnyx_green_transparent.png"
                  alt="Telnyx LLC"
                  width={400}
                  height={50}
                  style={{ width: "auto", height: "auto" }}
                  priority
                  className="brightness-0 dark:invert"
                />
                <span className="text-6xl font-bold mt-10 text-brand-primary dark:text-brand-primary">
                  Contact Center
                </span>
              </div>
            </div>
          </div>
          <div className="flex flex-1 mt-30 justify-center">
            <div className="w-full max-w-xs text-center">
              <div className="space-y-4">
                <div className="text-6xl">✅</div>
                <h1 className="text-2xl font-bold">
                  Password Reset Successful
                </h1>
                <p className="text-sm text-muted-foreground">
                  Your password has been updated successfully.
                  <br />
                  Redirecting you to sign in...
                </p>
              </div>
            </div>
          </div>
        </div>
        <div className="bg-muted relative hidden lg:block m-5 rounded-xl overflow-hidden">
          <Image
            src="/cc_space.jpg"
            alt="Contact Center"
            className="absolute inset-0 h-full w-full object-cover grayscale"
            width={1000}
            height={1000}
            style={{ width: "100%", height: "100%" }}
            priority
          />
        </div>
      </div>
    );
  }

  return (
    <div className="dark grid min-h-svh lg:grid-cols-2 bg-background text-foreground">
      <div className="flex flex-col gap-4 p-6 md:p-10">
        <div className="flex justify-center gap-2 md:justify-start">
          <div className="flex justify-center w-full">
            <div className="flex flex-col items-center w-full justify-center">
              <Image
                src="/telnyx_green_transparent.png"
                alt="Telnyx LLC"
                width={400}
                height={50}
                style={{ width: "auto", height: "auto" }}
                priority
                className="brightness-0 dark:invert"
              />
              <span className="text-6xl font-bold mt-10 text-brand-primary dark:text-brand-primary">
                Contact Center
              </span>
            </div>
          </div>
        </div>
        <div className="flex flex-1 mt-30 justify-center">
          <div className="w-full max-w-xs">
            <form onSubmit={onSubmit} className={cn("w-full space-y-4")}>
              <h1 className="text-2xl font-bold">Reset Your Password</h1>
              <p className="text-sm text-muted-foreground">
                Enter your new password below
              </p>
              <div className="grid gap-2">
                <Label htmlFor="password">New Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  required
                  disabled={loading}
                />
                <p className="text-xs text-muted-foreground">
                  At least 8 chars, upper, lower, special
                </p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="confirmPassword">Confirm Password</Label>
                <Input
                  id="confirmPassword"
                  name="confirmPassword"
                  type="password"
                  required
                  disabled={loading}
                />
              </div>
              {error && <p className="text-xs text-red-500">{error}</p>}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Resetting..." : "Reset Password"}
              </Button>
              <p className="text-center text-sm">
                <a href="/signin" className="underline underline-offset-4">
                  Back to sign in
                </a>
              </p>
            </form>
          </div>
        </div>
      </div>
      <div className="bg-muted relative hidden lg:block m-5 rounded-xl overflow-hidden">
        <Image
          src="/telnyx_main.png"
          alt="Image"
          className="absolute inset-0 h-full w-full object-cover grayscale brightness-[0.8]"
          width={1000}
          height={1000}
          style={{ width: "100%", height: "100%" }}
        />
      </div>
    </div>
  );
}
