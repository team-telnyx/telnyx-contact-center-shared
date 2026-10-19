"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import {
  IconCheck,
  IconCopy,
  IconDeviceMobile,
  IconExternalLink,
} from "@tabler/icons-react";
import { useUiText } from "@/components/i18n/use-ui-text";
import { notify } from "@/components/ToastNotify";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

async function requestMobileAppSetup() {
  const response = await fetch("/api/user/mobile-app-setup", { cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || "Unable to load the mobile setup code");
  }
  return data;
}

export default function MobileAppSetupCard() {
  const tUi = useUiText();
  const [setup, setSetup] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const loadSetup = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setSetup(await requestMobileAppSetup());
    } catch (loadError) {
      setError(loadError.message || "Unable to load the mobile setup code");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void requestMobileAppSetup()
      .then((data) => {
        if (active) setSetup(data);
      })
      .catch((loadError) => {
        if (active) setError(loadError.message || "Unable to load the mobile setup code");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(setup.setupLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
      notify({ title: "Setup link copied", variant: "success" });
    } catch {
      notify({ title: "Unable to copy the setup link", variant: "error" });
    }
  }

  return (
    <Card data-help-id="profile.devices" className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <IconDeviceMobile className="size-6 text-brand-primary" />
          {tUi("Mobile app")}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-6">
        {loading ? (
          <div className="grid gap-6 md:grid-cols-[224px_minmax(0,1fr)]">
            <Skeleton className="size-[224px] rounded-xl" />
            <div className="space-y-4">
              <Skeleton className="h-5 w-64 max-w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-9 w-28" />
            </div>
          </div>
        ) : error ? (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            <span>{error}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void loadSetup()}>
              {tUi("Try again")}
            </Button>
          </div>
        ) : setup ? (
          <div className="grid items-start gap-6 md:grid-cols-[224px_minmax(0,1fr)]">
            <div className="rounded-xl border bg-white p-3 shadow-sm">
              <Image
                src={setup.qrCodeDataUrl}
                alt={tUi("Mobile setup code")}
                width={400}
                height={400}
                unoptimized
                className="size-[200px] max-w-full"
              />
            </div>
            <div className="min-w-0 space-y-4">
              <div>
                <div className="font-medium">{setup.organizationName}</div>
                <code className="text-sm text-muted-foreground">{setup.address}</code>
              </div>
              <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
                {tUi("Scan this code with NovumCX for Telnyx or with the iPhone's camera to connect the app to this Contact Center. You then sign in with your usual account.")}
              </p>
              <div className="space-y-2">
                <div className="text-sm font-medium">{tUi("Setup link")}</div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <code className="min-w-0 flex-1 select-all overflow-x-auto rounded-md border bg-muted/50 px-3 py-2 text-xs leading-5">
                    {setup.setupLink}
                  </code>
                  <Button type="button" variant="outline" onClick={copyLink}>
                    {copied ? <IconCheck className="size-4" /> : <IconCopy className="size-4" />}
                    {copied ? tUi("Copied") : tUi("Copy link")}
                  </Button>
                </div>
              </div>
              {setup.installUrl ? (
                <Button type="button" variant="link" className="h-auto px-0" asChild>
                  <a href={setup.installUrl} target="_blank" rel="noreferrer">
                    {tUi("Install the app")}
                    <IconExternalLink className="size-4" />
                  </a>
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
