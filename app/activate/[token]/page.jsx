"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ToastNotify";
import { AuthBrandLogo } from "@/components/auth-brand-logo";
import { AuthRightImage } from "@/components/auth-right-image";

export default function ActivateAccountPage() {
  const params = useParams();
  const router = useRouter();
  const token = params.token;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [alreadyActivated, setAlreadyActivated] = useState(false);

  useEffect(() => {
    async function activateAccount() {
      try {
        const response = await fetch("/api/auth/activate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
          throw new Error(data.error || "Failed to activate account");
        }

        if (data.alreadyActivated) {
          setAlreadyActivated(true);
        } else {
          setSuccess(true);
          notify({
            title: "Account activated",
            description: "Your account has been activated successfully!",
            variant: "success",
            autoCloseMs: 3000,
          });
        }
      } catch (err) {
        setError(err.message || "Failed to activate account");
        notify({
          title: "Activation failed",
          description: err.message || "Failed to activate account",
          variant: "error",
        });
      } finally {
        setLoading(false);
      }
    }

    if (token) {
      activateAccount();
    }
  }, [token]);

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
        <div className="flex flex-1 mt-30 justify-center">
          <div className="w-full max-w-xs text-center">
            {loading && (
              <div className="space-y-4">
                <div className="text-6xl animate-pulse">⏳</div>
                <h1 className="text-2xl font-bold">Activating Your Account</h1>
                <p className="text-sm text-muted-foreground">
                  Please wait while we activate your account...
                </p>
              </div>
            )}

            {!loading && success && (
              <div className="space-y-4">
                <div className="text-6xl">🎉</div>
                <h1 className="text-2xl font-bold">Account Activated!</h1>
                <p className="text-sm text-muted-foreground">
                  Your account has been activated successfully.
                  <br />
                  You can now sign in to access the Contact Center.
                </p>
                <Button
                  className="w-full mt-4"
                  onClick={() => router.push("/signin")}
                >
                  Go to Sign In
                </Button>
              </div>
            )}

            {!loading && alreadyActivated && (
              <div className="space-y-4">
                <div className="text-6xl">✅</div>
                <h1 className="text-2xl font-bold">Already Activated</h1>
                <p className="text-sm text-muted-foreground">
                  Your account is already activated.
                  <br />
                  You can sign in to access the Contact Center.
                </p>
                <Button
                  className="w-full mt-4"
                  onClick={() => router.push("/signin")}
                >
                  Go to Sign In
                </Button>
              </div>
            )}

            {!loading && error && (
              <div className="space-y-4">
                <div className="text-6xl">❌</div>
                <h1 className="text-2xl font-bold">Activation Failed</h1>
                <p className="text-sm text-red-500">{error}</p>
                <p className="text-sm text-muted-foreground">
                  The activation link may be invalid or expired.
                </p>
                <div className="space-y-2">
                  <Button
                    className="w-full"
                    variant="outline"
                    onClick={() => router.push("/signin")}
                  >
                    Go to Sign In
                  </Button>
                  <Button
                    className="w-full"
                    variant="outline"
                    onClick={() => router.push("/signup")}
                  >
                    Create New Account
                  </Button>
                </div>
              </div>
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
