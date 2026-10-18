"use client";
import { useUiText } from "@/components/i18n/use-ui-text";


import { useState } from "react";
import Link from "next/link";
import { BookOpen, Check, Copy } from "lucide-react";
import { APP_BUILD, versionInfoText } from "@/lib/app-version.mjs";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function ApplicationVersionLabel() {
  const tUi = useUiText();
  return <span className="text-muted-foreground truncate text-[11px]" title={APP_BUILD?.buildId}>
    {APP_BUILD ? tUi("v{value0}", { value0: APP_BUILD.displayVersion }) : tUi("Version unavailable")}
  </span>;
}

export function ApplicationVersionDialog({ open, onOpenChange }) {
  const tUi = useUiText();
  const [copyState, setCopyState] = useState("idle");
  async function copyVersion() {
    try {
      await navigator.clipboard.writeText(versionInfoText());
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }
  const info = APP_BUILD;
  const channelLabel = { stable: "Stable release", prerelease: "Pre-release", development: "Development build" };
  return <Dialog open={open} onOpenChange={(value) => { setCopyState("idle"); onOpenChange(value); }}>
    <DialogContent className="z-[121] max-h-[calc(100dvh-2rem)] overflow-y-auto" overlayClassName="z-[120]">
      <DialogHeader>
        <DialogTitle>{tUi("About Contact Center")}</DialogTitle>
        <DialogDescription>{tUi("Version information for the application you are using.")}</DialogDescription>
      </DialogHeader>
      {info ? <>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-2xl font-semibold tracking-tight">{tUi("v")}{info.displayVersion}</span>
          <span className="rounded-md border px-2 py-1 text-xs text-muted-foreground">{tUi(channelLabel[info.channel])}</span>
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-3 text-sm">
          <dt className="text-muted-foreground">{tUi("Build")}</dt>
          <dd className="break-all font-mono text-xs leading-5">{info.buildId}</dd>
          <dt className="text-muted-foreground">{tUi("Commit")}</dt>
          <dd className="font-mono text-xs leading-5">{info.shortCommit || tUi("Unavailable")}{info.dirty ? tUi(" (modified)") : ""}</dd>
          <dt className="text-muted-foreground">{tUi("Built at")}</dt>
          <dd><time dateTime={info.builtAt}>{info.builtAt.replace("T", " ").replace(/\.\d{3}Z$/, " UTC")}</time></dd>
        </dl>
      </> : <p className="text-sm text-muted-foreground">{tUi("Version information is unavailable for this build.")}</p>}
      <div className="flex flex-wrap gap-2 border-t pt-4">
        <Button variant="outline" asChild><Link href="/help/changelog" onClick={() => onOpenChange(false)}><BookOpen />{tUi("Release notes")}</Link></Button>
        <Button variant="outline" onClick={copyVersion} disabled={!info}>
          {copyState === "copied" ? <Check /> : <Copy />}{copyState === "copied" ? tUi("Copied") : tUi("Copy version info")}
        </Button>
      </div>
      <p className="sr-only" role="status">{copyState === "copied" ? tUi("Version information copied to clipboard.") : ""}</p>
      {copyState === "error" ? <div role="alert" className="space-y-2 text-sm">
        <p>{tUi("Clipboard access is unavailable. Select and copy the information below.")}</p>
        <pre tabIndex={0} className="select-text whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">{versionInfoText()}</pre>
      </div> : null}
    </DialogContent>
  </Dialog>;
}
