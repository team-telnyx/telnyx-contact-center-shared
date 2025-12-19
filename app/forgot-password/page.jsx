"use client";

import { useState } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { notify } from "@/components/ToastNotify";
import { forgotPasswordAction } from "@/app/actions/auth";

export default function ForgotPasswordPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function onSubmit(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const username = form.username.value.trim();
    if (!username) {
      setError("Email is required");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const fd = new FormData();
      fd.set("username", username);
      const result = await forgotPasswordAction(fd);
      if (!result?.ok) throw new Error(result?.error || "Request failed");
      notify({
        title: "Check your email",
        description:
          "If an account exists for that address, we sent a password reset link.",
        variant: "success",
      });
    } catch (err) {
      setError("Failed to request password reset");
      notify({
        title: "Password reset failed",
        description: err.message || "Request failed",
        variant: "error",
      });
    } finally {
      setLoading(false);
    }
  }

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
          <div className="w-full max-w-xs">
            <form onSubmit={onSubmit} className={cn("w-full space-y-4")}>
              <h1 className="text-2xl font-bold">Forgot your password?</h1>
              <p className="text-sm text-muted-foreground">
                Enter your email address and well send you a reset link.
              </p>
              <div className="grid gap-2">
                <Label htmlFor="username">Email address</Label>
                <Input id="username" name="username" type="email" required />
                {error && <p className="text-xs text-red-500">{error}</p>}
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Sending..." : "Send reset link"}
              </Button>
              <p className="text-center text-sm">
                Remembered your password?{" "}
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
