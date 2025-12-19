"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { notify } from "@/components/ToastNotify";
import { AuthBrandLogo } from "@/components/auth-brand-logo";
import { AuthRightImage } from "@/components/auth-right-image";
import { signupAction } from "@/app/actions/auth";
import { signIn } from "next-auth/react";
import {
  IconBrandGoogleFilled,
  IconMailCheck,
  IconCircleCheck,
} from "@tabler/icons-react";
import { Card, CardContent } from "@/components/ui/card";

export default function SignupPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState({});
  const [registrationSuccess, setRegistrationSuccess] = useState(false);
  const [userEmail, setUserEmail] = useState("");
  const [recaptchaLoaded, setRecaptchaLoaded] = useState(false);

  // Load reCAPTCHA v3 script
  useEffect(() => {
    const siteKey = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY;
    if (!siteKey) {
      console.warn("[reCAPTCHA] Site key not configured");
      setRecaptchaLoaded(false);
      return;
    }

    // Check if script is already loaded
    if (window.grecaptcha) {
      setRecaptchaLoaded(true);
      return;
    }

    const script = document.createElement("script");
    script.src = `https://www.google.com/recaptcha/api.js?render=${siteKey}`;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      console.log("[reCAPTCHA] Script loaded successfully");
      setRecaptchaLoaded(true);
    };
    script.onerror = () => {
      console.error("[reCAPTCHA] Failed to load script");
      setRecaptchaLoaded(false);
    };

    document.head.appendChild(script);

    return () => {
      // Cleanup if needed
      const existingScript = document.querySelector(
        `script[src^="https://www.google.com/recaptcha/api.js"]`
      );
      if (existingScript) {
        existingScript.remove();
      }
    };
  }, []);

  async function onSubmit(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const username = form.username.value.trim();
    const password = form.password.value;
    const firstName = form.firstName.value.trim();
    const lastName = form.lastName.value.trim();
    const mobile = form.mobile.value.trim();

    const strong =
      /[a-z]/.test(password) &&
      /[A-Z]/.test(password) &&
      /[^A-Za-z0-9]/.test(password) &&
      password.length >= 8;
    const nextErrors = {};
    if (!strong) {
      nextErrors.password =
        "Password must be 8+ chars with upper, lower and special char.";
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(username)) {
      nextErrors.email = "Enter a valid email address.";
    }
    if (!firstName) nextErrors.firstName = "First name is required.";
    if (!lastName) nextErrors.lastName = "Last name is required.";
    if (!mobile) nextErrors.mobile = "Mobile phone is required.";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;

    setLoading(true);
    try {
      // Execute reCAPTCHA v3
      let recaptchaToken = null;
      const siteKey = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY;

      console.log("[reCAPTCHA] Attempting to execute:", {
        siteKey: siteKey ? "configured" : "missing",
        grecaptcha: !!window.grecaptcha,
        recaptchaLoaded,
      });

      if (siteKey && window.grecaptcha && recaptchaLoaded) {
        try {
          // Wait for reCAPTCHA to be ready and execute
          recaptchaToken = await new Promise((resolve, reject) => {
            window.grecaptcha.ready(async () => {
              try {
                const token = await window.grecaptcha.execute(siteKey, {
                  action: "signup",
                });
                console.log("[reCAPTCHA] Token generated successfully");
                resolve(token);
              } catch (error) {
                reject(error);
              }
            });
          });
        } catch (captchaError) {
          console.error("[reCAPTCHA] Failed to execute:", captchaError);
          notify({
            title: "Verification failed",
            description: "Please refresh the page and try again.",
            variant: "error",
          });
          setLoading(false);
          return;
        }
      } else {
        console.warn(
          "[reCAPTCHA] Not loaded or configured, proceeding without verification"
        );
      }

      console.log(
        "[reCAPTCHA] Token being sent:",
        recaptchaToken ? "present" : "missing"
      );

      const fd = new FormData();
      fd.set("username", username);
      fd.set("password", password);
      fd.set("firstName", firstName);
      fd.set("lastName", lastName);
      fd.set("mobile", mobile);
      if (recaptchaToken) {
        fd.set("recaptchaToken", recaptchaToken);
      }

      const result = await signupAction(fd);
      if (!result?.ok) {
        const msg = result?.error || "Registration failed";
        if (msg.toLowerCase().includes("password")) {
          setErrors((prev) => ({ ...prev, password: msg }));
        } else if (msg.toLowerCase().includes("email")) {
          setErrors((prev) => ({ ...prev, email: msg }));
        } else {
          setErrors((prev) => ({ ...prev, form: msg }));
        }
        notify({
          title: "Account registration failed",
          description: msg,
          variant: "error",
          autoCloseMs: 0,
        });
        return;
      }

      // Success - clear the form and show activation instructions
      setUserEmail(username);
      setRegistrationSuccess(true);
      form.reset();
    } catch (err) {
      setErrors((prev) => ({
        ...prev,
        form: err.message || "Registration failed",
      }));
      notify({
        title: "Sign up failed",
        description: err.message || "Registration failed",
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
              <AuthBrandLogo />
              <span className="text-6xl font-bold mt-10 text-brand-primary dark:text-brand-primary">
                Contact Center
              </span>
            </div>
          </div>
        </div>
        <div className="flex flex-1 mt-20 justify-center">
          <div className="w-full max-w-md">
            {registrationSuccess ? (
              <Card className="border-brand-primary">
                <CardContent className="pt-6">
                  <div className="flex flex-col items-center space-y-6 text-center">
                    <div className="size-16 rounded-full bg-brand-primary/10 flex items-center justify-center">
                      <IconMailCheck className="size-10 text-brand-primary" />
                    </div>

                    <div className="space-y-2">
                      <h2 className="text-2xl font-bold text-brand-primary">
                        Registration Submitted!
                      </h2>
                      <p className="text-muted-foreground">
                        We've sent a verification link to
                      </p>
                      <p className="font-semibold text-foreground">
                        {userEmail}
                      </p>
                    </div>

                    <div className="space-y-3 w-full text-left">
                      <p className="text-sm font-semibold">
                        Next steps to activate your contact center:
                      </p>
                      <div className="space-y-3">
                        <div className="flex gap-3 items-start">
                          <IconCircleCheck className="size-5 text-brand-primary flex-shrink-0 mt-0.5" />
                          <div className="text-sm">
                            <span className="font-medium">
                              Check your email
                            </span>
                            <p className="text-muted-foreground">
                              Look for an email from Telnyx Contact Center
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-3 items-start">
                          <IconCircleCheck className="size-5 text-brand-primary flex-shrink-0 mt-0.5" />
                          <div className="text-sm">
                            <span className="font-medium">
                              Click the verification link
                            </span>
                            <p className="text-muted-foreground">
                              This will verify your email address
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-3 items-start">
                          <IconCircleCheck className="size-5 text-brand-primary flex-shrink-0 mt-0.5" />
                          <div className="text-sm">
                            <span className="font-medium">
                              Access your contact center
                            </span>
                            <p className="text-muted-foreground">
                              You'll be able to access your contact center
                              account
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="pt-4 border-t w-full space-y-2">
                      <p className="text-xs text-muted-foreground">
                        Didn't receive the email? Check your spam folder.
                      </p>
                      <p className="text-xs text-muted-foreground">
                        The verification link will expire in 24 hours.
                      </p>
                    </div>

                    <div className="pt-4">
                      <Button
                        onClick={() => router.push("/signin")}
                        className="w-full"
                        variant="default"
                      >
                        Go to Sign In
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ) : (
              <form onSubmit={onSubmit} className={cn("w-full space-y-4")}>
                <h1 className="text-2xl font-bold">
                  Sign up to Contact Center
                </h1>
                <div className="grid gap-2">
                  <Label htmlFor="username">Email address</Label>
                  <Input
                    id="username"
                    name="username"
                    aria-invalid={!!errors.email}
                  />
                  {errors.email && (
                    <p className="text-xs text-red-500">{errors.email}</p>
                  )}
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    name="password"
                    type="password"
                    aria-invalid={!!errors.password}
                  />
                  <p className="text-xs text-muted-foreground">
                    At least 8 chars, upper, lower, special
                  </p>
                  {errors.password && (
                    <p className="text-xs text-red-500">{errors.password}</p>
                  )}
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="firstName">First name</Label>
                  <Input
                    id="firstName"
                    name="firstName"
                    aria-invalid={!!errors.firstName}
                  />
                  {errors.firstName && (
                    <p className="text-xs text-red-500">{errors.firstName}</p>
                  )}
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="lastName">Last name</Label>
                  <Input
                    id="lastName"
                    name="lastName"
                    aria-invalid={!!errors.lastName}
                  />
                  {errors.lastName && (
                    <p className="text-xs text-red-500">{errors.lastName}</p>
                  )}
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="mobile">Mobile phone</Label>
                  <Input
                    id="mobile"
                    name="mobile"
                    type="tel"
                    aria-invalid={!!errors.mobile}
                  />
                  {errors.mobile && (
                    <p className="text-xs text-red-500">{errors.mobile}</p>
                  )}
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? "Creating..." : "Create account"}
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
                  onClick={() => signIn("google", { callbackUrl: "/" })}
                >
                  <IconBrandGoogleFilled
                    className="mr-2 h-5 w-5"
                    aria-hidden="true"
                  />
                  Sign up with Google
                </Button>
                {errors.form && (
                  <p className="text-xs text-red-500 text-center">
                    {errors.form}
                  </p>
                )}
                <p className="text-center text-sm">
                  Already have an account?{" "}
                  <a href="/signin" className="underline underline-offset-4">
                    Sign in
                  </a>
                </p>
                {/* reCAPTCHA notice (required by Google ToS) */}
                {process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY && (
                  <p className="text-xs text-muted-foreground text-center mt-4">
                    This site is protected by reCAPTCHA and the Google{" "}
                    <a
                      href="https://policies.google.com/privacy"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline"
                    >
                      Privacy Policy
                    </a>{" "}
                    and{" "}
                    <a
                      href="https://policies.google.com/terms"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline"
                    >
                      Terms of Service
                    </a>{" "}
                    apply.
                  </p>
                )}
              </form>
            )}
          </div>
        </div>
      </div>
      <div className="bg-muted relative hidden lg:block m-5 rounded-xl overflow-hidden">
        <AuthRightImage />
      </div>
    </div>
  );
}
