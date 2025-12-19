"use client";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEffect, useRef, useState } from "react";
import { notify } from "@/components/ToastNotify";
import { signIn } from "next-auth/react";
import { useAuth } from "@/components/auth-provider";
import { useRouter } from "next/navigation";
import { IconBrandGoogleFilled } from "@tabler/icons-react";

export function LoginForm({ className, ...props }) {
  const [submitting, setSubmitting] = useState(false);
  const [oauthSubmitting, setOauthSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const handledRef = useRef(false);
  const { refresh } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!error) return;
    console.log("[LOGIN] Error:", error);
    notify({
      title: "Login failed",
      description: "Invalid credentials",
      variant: "error",
      autoCloseMs: 2000,
    });
  }, [error]);

  async function onSubmit(e) {
    console.log("[LOGIN] Submitting...");
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const form = new FormData(e.currentTarget);
      const username = (form.get("username") || "").toString();
      const password = (form.get("password") || "").toString();
      const res = await signIn("credentials", {
        username,
        password,
        callbackUrl: "/",
        redirect: false,
      });
      console.log("[LOGIN] Response:", res);
      if (res?.error) {
        handledRef.current = false;
        console.log("[LOGIN] Error:", res.error);
        setError(res.error || "Invalid credentials");
      } else if (res?.ok) {
        handledRef.current = true;
        notify({
          title: "Authentication successful",
          description: "You have been logged in successfully.",
          variant: "success",
          autoCloseMs: 3000,
        });
        try {
          localStorage.removeItem("nav-main.selected");
        } catch (_) {}
        try {
          refresh?.();
        } catch (_) {}
        const target = res?.url || "/";
        console.log("[LOGIN] Navigating to:", target);
        router.replace(target);
      } else {
        setError("Invalid credentials");
      }
    } catch (err) {
      console.error("[LOGIN] Exception:", err);
      setError("Failed to sign in");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className={cn("flex flex-col gap-6", className)}
      onSubmit={onSubmit}
      {...props}
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-bold">Sign in to your account</h1>
        <p className="text-muted-foreground text-sm text-balance">
          Enter your email below to login to your account
        </p>
      </div>
      <div className="grid gap-6">
        <div className="grid gap-3">
          <Label htmlFor="username">Email</Label>
          <Input
            id="username"
            name="username"
            type="text"
            placeholder="your email address"
            required
          />
        </div>
        <div className="grid gap-3">
          <div className="flex items-center">
            <Label htmlFor="password">Password</Label>
            <a
              href="/forgot-password"
              className="ml-auto text-sm underline-offset-4 hover:underline"
            >
              Forgot your password?
            </a>
          </div>
          <Input
            id="password"
            name="password"
            type="password"
            placeholder="your password"
            required
          />
        </div>
        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? "Logging in..." : "Login"}
        </Button>
        <div className="after:border-border relative text-center text-sm after:absolute after:inset-0 after:top-1/2 after:z-0 after:flex after:items-center after:border-t">
          <span className="bg-background text-muted-foreground relative z-10 px-2">
            Or
          </span>
        </div>
        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={submitting || oauthSubmitting}
          onClick={(e) => {
            e.preventDefault();
            if (submitting || oauthSubmitting) return;
            setOauthSubmitting(true);
            try {
              localStorage.removeItem("nav-main.selected");
            } catch (_) {}
            signIn("google", { callbackUrl: "/" });
          }}
        >
          <IconBrandGoogleFilled className="mr-2 h-5 w-5" aria-hidden="true" />
          Continue with Google
        </Button>
      </div>
      <div className="text-center text-sm">
        Don&apos;t have an account?{" "}
        <a href="/signup" className="underline underline-offset-4">
          Sign up
        </a>
      </div>
    </form>
  );
}
