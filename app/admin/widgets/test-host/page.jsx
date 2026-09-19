"use client";

import { useEffect, useRef, useState } from "react";
import { parseWidgetTestContext, storedWidgetTestContext } from "@/lib/widgets/test-page";

// A stand-in customer page for the widget test page. It sits outside the
// portal layout so the widget meets a plain document, and under /admin/widgets
// so the page guard asks for the Web Widgets screen. The published loader is
// used as on a customer site; only the test grant differs. The portal's client
// providers are skipped for this path (lib/portal-providers.js): their status
// stream would hold a socket of this origin for the life of the page.
export default function WidgetTestHostPage() {
  const started = useRef(false);
  const [state, setState] = useState({ status: "loading", message: "Loading widget…" });

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const widgetId = new URLSearchParams(window.location.search).get("widget");
    const { context } = parseWidgetTestContext(storedWidgetTestContext(window.localStorage));
    // The loader reports its failures on the console only; show them on the page
    // as well, and say so when no launcher appears.
    const consoleError = console.error;
    console.error = (...args) => {
      consoleError(...args);
      if (String(args[0] || "").includes("[Telnyx widget]")) {
        setState({ status: "error", message: args.map((part) => part?.message || String(part)).join(" ") });
      }
    };
    Promise.resolve()
      .then(() => {
        if (!widgetId) throw new Error("Choose a widget on the test page.");
        return fetch(`/api/admin/widgets/${encodeURIComponent(widgetId)}/test-grant`, { method: "POST" });
      })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `Test grant refused (${response.status})`);
        return body;
      })
      .then(({ publicId, grant }) => {
        window.TelnyxWidgetContext = { ...(context || {}) };
        const script = document.createElement("script");
        script.src = "/widget/v1/loader.js";
        script.defer = true;
        script.dataset.widgetId = publicId;
        script.dataset.testGrant = grant;
        script.onerror = () => setState({ status: "error", message: "The widget loader could not be loaded." });
        document.body.appendChild(script);
        setState({ status: "ready", message: publicId, keys: Object.keys(context || {}) });
        window.setTimeout(() => {
          if (document.getElementById(`telnyx-widget-${publicId}`)) return;
          setState((current) => current.status === "ready"
            ? { status: "error", message: "The loader did not mount the widget. Check its targeting and decision rules, and the browser console." }
            : current);
        }, 8000);
      })
      .catch((error) => setState({ status: "error", message: error.message }));
  }, []);

  return (
    <div className="min-h-screen bg-white text-slate-900">
      <div className={`px-6 py-2 text-xs ${state.status === "error" ? "bg-red-50 text-red-700" : "bg-slate-100 text-slate-600"}`} data-testid="widget-test-host-status">
        {state.status === "ready"
          ? <>Test page · widget <span className="font-mono">{state.message}</span>{state.keys.length ? <> · context: <span className="font-mono">{state.keys.join(", ")}</span></> : " · no context"}</>
          : state.message}
      </div>
      <header className="flex items-center justify-between border-b px-8 py-5">
        <div className="text-lg font-semibold tracking-tight">Example Company</div>
        <nav className="hidden gap-6 text-sm text-slate-500 sm:flex"><span>Products</span><span>Pricing</span><span>Support</span><span>Contact</span></nav>
      </header>
      <main className="mx-auto max-w-4xl px-8 py-16">
        <h1 className="text-4xl font-semibold tracking-tight">A customer page for testing the web widget</h1>
        <p className="mt-4 max-w-2xl text-slate-600">
          This page loads the published widget through the same loader script a customer site uses. Conversations and calls
          started here are real and reach the queues of this environment.
        </p>
        <div className="mt-12 grid gap-6 sm:grid-cols-3">
          {["Talk to sales", "Get support", "Track an order"].map((title) => (
            <div key={title} className="rounded-xl border p-5">
              <div className="font-medium">{title}</div>
              <div className="mt-2 text-sm text-slate-500">Placeholder content so the widget sits over a realistic layout.</div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
