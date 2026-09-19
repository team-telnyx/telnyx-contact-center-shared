"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { WIDGET_TEST_CONTEXT_KEY, parseWidgetTestContext, storedWidgetTestContext } from "@/lib/widgets/test-page";

const CONTEXT_PLACEHOLDER = `{
  "customer.segment": "vip",
  "routing.queue": "Premium Support"
}`;

// State of the Test page section: the context being edited and the run shown
// in the stage. A run is one load of the host page; the nonce gives every
// reload its own document URL.
export function useWidgetTestPage(widget, active) {
  const [contextText, setContextText] = useState("");
  const [run, setRun] = useState(null);
  const testable = Boolean(widget?.published && widget?.enabled);
  const parsed = useMemo(() => parseWidgetTestContext(contextText), [contextText]);
  const hostUrl = widget ? `/admin/widgets/test-host?widget=${encodeURIComponent(widget.id)}` : null;

  const saveContext = useCallback(() => {
    try { window.localStorage.setItem(WIDGET_TEST_CONTEXT_KEY, contextText.trim()); } catch {}
  }, [contextText]);
  const reload = useCallback(() => {
    if (!hostUrl || !testable || parsed.error) return;
    saveContext();
    const nonce = Date.now();
    setRun({ widgetId: widget.id, nonce, url: `${hostUrl}&r=${nonce}` });
  }, [hostUrl, testable, parsed.error, saveContext, widget?.id]);

  // Opening the section, or switching the widget while it is open, loads the
  // widget with the context stored by the previous visit.
  useEffect(() => {
    if (!active || !widget?.id || !testable) return undefined;
    const timer = window.setTimeout(() => {
      const context = storedWidgetTestContext(window.localStorage);
      setContextText(context);
      // The host page reads the context from storage, so the defaults are stored with the first run.
      try { window.localStorage.setItem(WIDGET_TEST_CONTEXT_KEY, context.trim()); } catch {}
      const nonce = Date.now();
      setRun({ widgetId: widget.id, nonce, url: `/admin/widgets/test-host?widget=${encodeURIComponent(widget.id)}&r=${nonce}` });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [active, widget?.id, testable]);

  return { contextText, setContextText, saveContext, parsed, hostUrl, testable, reload, run: run?.widgetId === widget?.id ? run : null };
}

export function WidgetTestStage({ widget, test }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-muted/30 p-4">
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border bg-background shadow-sm">
        {!test.testable
          ? <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
              {widget?.published ? "Enable the widget to test it." : "Publish the widget to test it. The test page runs the published revision, not the draft."}
            </div>
          : test.run
            ? <iframe key={test.run.nonce} src={test.run.url} title="Widget test page" className="block h-full w-full border-0" allow="microphone; camera; display-capture; autoplay; fullscreen" />
            : <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading the test page…</div>}
      </div>
    </div>
  );
}

export function WidgetTestPanel({ widget, test }) {
  const blocked = !test.testable || Boolean(test.parsed.error);
  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-background">
      <div className="border-b px-4 py-4">
        <h2 className="font-semibold">Test page</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Run the published widget on a stand-in customer page through the public loader script.</p>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        <section className="space-y-1 text-xs">
          <p className="font-medium text-foreground">{widget?.name}{widget?.published ? ` · revision ${widget.published.version}` : ""}</p>
          <p className="break-all font-mono text-muted-foreground">{widget?.publicId}</p>
          <p className="text-muted-foreground">The published revision runs here, not the draft. Publish to test a change.</p>
        </section>
        <section className="space-y-2">
          <Label htmlFor="widget-test-context">Context (JSON, optional)</Label>
          <Textarea id="widget-test-context" value={test.contextText} onChange={(event) => test.setContextText(event.target.value)} onBlur={test.saveContext}
            placeholder={CONTEXT_PLACEHOLDER} spellCheck={false} className="min-h-40 font-mono text-xs" />
          <p className={`text-xs leading-relaxed ${test.parsed.error ? "text-destructive" : "text-muted-foreground"}`}>
            {test.parsed.error || "Published to the widget like window.TelnyxWidget.setContext() on a customer page. Reload the widget to apply a change."}
          </p>
        </section>
        <section className="grid gap-2">
          <Button onClick={test.reload} disabled={blocked}><RotateCw className="size-4" />Reload widget</Button>
          {blocked
            ? <Button variant="outline" disabled><ExternalLink className="size-4" />Open in a new tab</Button>
            : <Button asChild variant="outline"><a href={test.hostUrl} target="_blank" rel="opener" onClick={test.saveContext}><ExternalLink className="size-4" />Open in a new tab</a></Button>}
        </section>
        <p className="border-t pt-4 text-xs leading-relaxed text-muted-foreground">
          Conversations and calls started here are real, reach this environment&apos;s queues and are marked with a <span className="font-mono">cc-test:</span> origin.
          The origin of Contact Center does not have to be on the widget&apos;s allowlist.
        </p>
      </div>
    </aside>
  );
}
