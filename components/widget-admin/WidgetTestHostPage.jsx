"use client";

import { useEffect, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { parseWidgetTestContext, storedWidgetTestContext } from "@/lib/widgets/test-page";

const pages = [
  { id: "overview", label: "Overview" },
  { id: "products", label: "Products" },
  { id: "checkout", label: "Checkout" },
  { id: "support", label: "Support" },
  { id: "account", label: "Account" },
];

function pageUrl(page, widgetId) {
  const path = page === "overview" ? "/admin/widgets/test-host" : `/admin/widgets/test-host/${page}`;
  return `${path}?widget=${encodeURIComponent(widgetId)}`;
}

function SectionHeading({ eyebrow, title, children }) {
  return <div className="mb-8 max-w-3xl">
    <p className="text-xs font-semibold uppercase tracking-[.18em] text-emerald-700">{eyebrow}</p>
    <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
    <p className="mt-4 text-base leading-7 text-slate-600">{children}</p>
  </div>;
}

function ShadowFixture() {
  const host = useRef(null);
  useEffect(() => {
    if (!host.current || host.current.shadowRoot) return;
    const root = host.current.attachShadow({ mode: "open" });
    const box = document.createElement("div");
    box.style.cssText = "border:1px solid #a7f3d0;border-radius:14px;padding:16px;background:#ecfdf5;font:14px system-ui;color:#064e3b";
    const title = document.createElement("strong");
    title.textContent = "Open shadow DOM fixture";
    const detail = document.createElement("p");
    detail.textContent = "SHADOW_PUBLIC_MARKER · version 1";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Change shadow content";
    button.style.cssText = "border:1px solid #047857;border-radius:8px;background:white;padding:6px 10px;cursor:pointer";
    let version = 1;
    button.addEventListener("click", () => { version += 1; detail.textContent = `SHADOW_PUBLIC_MARKER · version ${version}`; });
    box.append(title, detail, button);
    root.append(box);
  }, []);
  return <div ref={host} data-testid="cobrowse-shadow-fixture" />;
}

function Overview({ widgetId, navigateSpa }) {
  const [updates, setUpdates] = useState(["Order DEMO-1042 was prepared for dispatch."]);
  return <>
    <SectionHeading eyebrow="Demo storefront" title="A customer journey for co-browsing tests">
      The published widget runs on this stand-in customer site. Open a real interaction, request page sharing, and use the sections below to check navigation, DOM updates and privacy rules. Any conversation or call reaches this environment&apos;s queues.
    </SectionHeading>
    <div className="grid gap-4 md:grid-cols-3">
      {[
        ["Browse products", "Change filters, expand product details and watch the shared page update.", "products"],
        ["Try a form", "Enter synthetic contact and payment values to verify masking.", "checkout"],
        ["Visit support", "Inspect a same-origin iframe and an opaque-origin placeholder.", "support"],
      ].map(([title, description, target]) => <a key={target} href={pageUrl(target, widgetId)} data-cobrowse-control className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-emerald-400 hover:shadow-md">
        <h2 className="font-semibold">{title}</h2><p className="mt-2 text-sm leading-6 text-slate-600">{description}</p>
      </a>)}
    </div>
    <div className="mt-8 grid gap-6 lg:grid-cols-[1.2fr_.8fr]">
      <section className="rounded-2xl border bg-white p-6">
        <h2 className="text-lg font-semibold">Live order activity</h2>
        <p className="mt-1 text-sm text-slate-600">This local-only action produces rrweb DOM mutations without calling an API.</p>
        <ul className="mt-4 space-y-2" aria-live="polite">{updates.map((update, index) => <li key={index} className="rounded-lg bg-slate-50 px-3 py-2 text-sm">{update}</li>)}</ul>
        <button type="button" data-cobrowse-control onClick={() => setUpdates((current) => [...current, `Order DEMO-1042 status update ${current.length}.`])} className="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white">Add status update</button>
      </section>
      <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6">
        <h2 className="text-lg font-semibold">Navigation checks</h2>
        <p className="mt-2 text-sm leading-6 text-slate-700">The buttons below change the route without reloading the document. The cards above perform a full-page navigation. Browser Back, reload and opening another tab exercise separate recovery paths.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" data-cobrowse-control onClick={() => navigateSpa("products")} className="rounded-lg border border-emerald-600 bg-white px-3 py-2 text-sm">SPA to products</button>
          <button type="button" data-cobrowse-control onClick={() => navigateSpa("support")} className="rounded-lg border border-emerald-600 bg-white px-3 py-2 text-sm">SPA to support</button>
        </div>
      </section>
    </div>
  </>;
}

function Products() {
  const [filter, setFilter] = useState("all");
  const [cart, setCart] = useState(0);
  const products = [
    { name: "Desk lamp", category: "office", price: "$39", detail: "Warm light, adjustable arm, charcoal finish." },
    { name: "Travel bottle", category: "travel", price: "$24", detail: "Insulated, reusable and easy to pack." },
    { name: "Notebook set", category: "office", price: "$18", detail: "Three dot-grid notebooks with recycled covers." },
  ];
  return <>
    <SectionHeading eyebrow="Catalog" title="Products and live filters">Change the filter, expand details and add synthetic items to the cart while the agent watches the page.</SectionHeading>
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-white p-4">
      <label className="text-sm font-medium">Category <select value={filter} onChange={(event) => setFilter(event.target.value)} className="ml-2 rounded-lg border px-3 py-2">
        <option value="all">All products</option><option value="office">Office</option><option value="travel">Travel</option>
      </select></label>
      <span className="rounded-full bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-900" aria-live="polite">Cart: {cart} demo items</span>
    </div>
    <div className="grid gap-4 md:grid-cols-3">{products.filter((item) => filter === "all" || item.category === filter).map((item) => <article key={item.name} className="rounded-2xl border bg-white p-5 shadow-sm">
      <div className="mb-4 grid h-28 place-items-center rounded-xl bg-gradient-to-br from-slate-100 to-emerald-100 text-3xl" aria-hidden="true">{item.category === "office" ? "✦" : "◌"}</div>
      <h2 className="font-semibold">{item.name}</h2><p className="mt-1 text-sm text-slate-600">{item.price}</p>
      <details className="mt-4 text-sm"><summary className="cursor-pointer font-medium">Product details</summary><p className="mt-2 text-slate-600">{item.detail}</p></details>
      <button type="button" onClick={() => setCart((count) => count + 1)} className="mt-4 rounded-lg bg-slate-900 px-3 py-2 text-sm text-white">Add demo item</button>
    </article>)}</div>
  </>;
}

function Checkout() {
  const [submitted, setSubmitted] = useState(false);
  return <>
    <SectionHeading eyebrow="Privacy fixture" title="Checkout and sensitive fields">Use only synthetic values here. Nothing is submitted to a server; the form is a local test of automatic input masking, configured text masks and blocked subtrees.</SectionHeading>
    <form onSubmit={(event) => { event.preventDefault(); setSubmitted(true); }} className="grid gap-6 lg:grid-cols-[1fr_.85fr]">
      <section className="space-y-4 rounded-2xl border bg-white p-6">
        <h2 className="text-lg font-semibold">Customer details</h2>
        <label className="block text-sm font-medium">Full name<input name="fullName" data-cobrowse-control autoComplete="name" placeholder="Alex Example" className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
        <label className="block text-sm font-medium">Email<input name="email" type="email" data-cobrowse-control autoComplete="email" placeholder="alex@example.test" className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
        <label className="block text-sm font-medium">Password<input name="password" type="password" autoComplete="current-password" placeholder="Synthetic password only" className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
        <label className="block text-sm font-medium">Delivery instructions<textarea name="notes" data-cobrowse-mask placeholder="Type a synthetic private note" className="mt-1 min-h-20 w-full rounded-lg border px-3 py-2" /></label>
        <label className="block text-sm font-medium">Attachment (never uploaded)<input name="attachment" type="file" data-cobrowse-block className="mt-2 block w-full text-sm" /></label>
      </section>
      <section className="space-y-4 rounded-2xl border bg-white p-6">
        <h2 className="text-lg font-semibold">Payment simulation</h2>
        <p className="text-xs text-slate-500">For automated checks, use test number 4242 4242 4242 4242. No payment is processed.</p>
        <label className="block text-sm font-medium">Card number<input name="cardNumber" data-cobrowse-control inputMode="numeric" autoComplete="cc-number" placeholder="4242 4242 4242 4242" className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm font-medium">Expiry<input name="expiry" autoComplete="cc-exp" placeholder="12 / 30" className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
          <label className="block text-sm font-medium">CVC<input name="cvc" type="password" autoComplete="cc-csc" placeholder="123" className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
        </div>
        <div data-cobrowse-mask className="rounded-lg bg-amber-50 p-3 text-sm">Masked text fixture: DEMO_MASKED_ACCOUNT_7491</div>
        <div className="demo-secret-text rounded-lg bg-amber-50 p-3 text-sm">Custom selector fixture: DEMO_CUSTOM_MASK_6328</div>
        <div data-cobrowse-block className="rounded-lg bg-red-50 p-3 text-sm">Built-in blocked subtree: DEMO_BLOCKED_INTERNAL_NOTE_9182</div>
        <div className="demo-private-panel rounded-lg bg-red-50 p-3 text-sm">Custom blocked subtree: DEMO_CUSTOM_BLOCK_4815</div>
        <button type="submit" className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white">Simulate checkout locally</button>
        {submitted && <p role="status" className="text-sm text-emerald-800">Local form completed. No customer or payment data was sent.</p>}
      </section>
    </form>
    <aside className="mt-6 rounded-2xl border border-sky-200 bg-sky-50 p-5 text-sm text-sky-950">
      <strong>Widget Studio selector check:</strong> add <code>.demo-secret-text</code> to additional text masks and <code>.demo-private-panel</code> to blocked subtrees. Built-in <code>data-cobrowse-mask</code>, <code>data-cobrowse-block</code> and all input values should be protected without those custom rules. For assisted control, only the synthetic name and email fields are writable; the card field stays blocked even though it carries the same opt-in attribute. Publish the widget before retesting this page.
    </aside>
  </>;
}

function Support({ widgetId }) {
  const opaqueFrame = `data:text/html,${encodeURIComponent("<!doctype html><title>Opaque demo</title><p>OPAQUE_FRAME_MARKER</p>")}`;
  return <>
    <SectionHeading eyebrow="Support center" title="FAQ and embedded content">Expand a question, scroll the page and compare the same-origin frame with an opaque-origin frame in the agent replay.</SectionHeading>
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="rounded-2xl border bg-white p-6">
        <h2 className="text-lg font-semibold">Frequently asked questions</h2>
        {["Where is my order?", "Can I change my address?", "How do returns work?"].map((question, index) => <details key={question} className="mt-4 border-b pb-4 text-sm">
          <summary className="cursor-pointer font-medium">{question}</summary><p className="mt-2 text-slate-600">Demo answer {index + 1}: an agent can guide the visitor to the right information while sharing this tab.</p>
        </details>)}
        <a href={pageUrl("account", widgetId)} data-cobrowse-control className="mt-6 inline-block rounded-lg border px-3 py-2 text-sm font-medium">Open account page with full navigation</a>
      </section>
      <section className="space-y-4 rounded-2xl border bg-white p-6">
        <div><h2 className="font-semibold">Same-origin iframe</h2><p className="mt-1 text-xs text-slate-600">Its public content should appear in replay.</p>
          <iframe title="Same-origin co-browse test frame" src="/admin/widgets/test-host/frame" className="mt-3 h-28 w-full rounded-lg border" /></div>
        <div><h2 className="font-semibold">Opaque-origin iframe</h2><p className="mt-1 text-xs text-slate-600">The replay should keep this content opaque.</p>
          <iframe title="Opaque-origin co-browse test frame" src={opaqueFrame} sandbox="" className="mt-3 h-24 w-full rounded-lg border" /></div>
      </section>
    </div>
  </>;
}

function Account() {
  const [visible, setVisible] = useState(false);
  return <>
    <SectionHeading eyebrow="Customer area" title="Account and shadow DOM">This page combines ordinary public details, a blocked panel, a masked text fixture and an interactive open shadow root.</SectionHeading>
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="rounded-2xl border bg-white p-6">
        <h2 className="text-lg font-semibold">Demo profile</h2>
        <p className="mt-3 text-sm">Name: Alex Example</p><p className="mt-1 text-sm">Membership: Demo Plus</p>
        <div data-cobrowse-mask className="mt-4 rounded-lg bg-amber-50 p-3 text-sm">Private profile note: DEMO_PROFILE_SECRET_2704</div>
        <div data-cobrowse-block className="mt-4 rounded-lg bg-red-50 p-3 text-sm">Blocked security panel: DEMO_SECURITY_SECRET_4502</div>
        <button type="button" onClick={() => setVisible((value) => !value)} className="mt-5 rounded-lg border px-3 py-2 text-sm">{visible ? "Hide" : "Show"} public account activity</button>
        {visible && <p className="mt-3 rounded-lg bg-slate-50 p-3 text-sm">Public activity: demo order viewed today.</p>}
      </section>
      <section className="rounded-2xl border bg-white p-6"><h2 className="mb-4 text-lg font-semibold">Shadow DOM fixture</h2><ShadowFixture /></section>
    </div>
  </>;
}

export default function WidgetTestHostPage({ initialSection = "overview", widgetId = "" }) {
  const [section, setSection] = useState(initialSection);
  const [state, setState] = useState({ status: "loading", message: "Loading widget…", keys: [] });

  useEffect(() => {
    const onPopState = () => {
      const last = window.location.pathname.split("/").filter(Boolean).at(-1);
      setSection(pages.some((page) => page.id === last) ? last : "overview");
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let mountTimer;
    const { context } = parseWidgetTestContext(storedWidgetTestContext(window.localStorage));
    const consoleError = console.error;
    console.error = (...args) => {
      consoleError(...args);
      if (!cancelled && String(args[0] || "").includes("[Telnyx widget]"))
        setState({ status: "error", message: args.map((part) => part?.message || String(part)).join(" "), keys: [] });
    };
    function waitForWidget(publicId, startedAt) {
      if (cancelled) return;
      if (document.getElementById(`telnyx-widget-${publicId}`)) {
        setState({ status: "ready", message: publicId, keys: Object.keys(context || {}) });
      } else if (Date.now() - startedAt >= 8000) {
        setState((current) => current.status === "error" ? current : { status: "error", message: "The widget did not mount. Check targeting, decision rules and the browser console.", keys: [] });
      } else mountTimer = window.setTimeout(() => waitForWidget(publicId, startedAt), 100);
    }
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
        if (cancelled) return;
        window.TelnyxWidgetContext = { ...(context || {}) };
        const loaderPresent = Array.from(document.scripts).some((script) => script.dataset.widgetId === publicId
          && script.src && new URL(script.src).pathname === "/widget/v1/loader.js");
        if (!document.getElementById(`telnyx-widget-${publicId}`) && !loaderPresent) {
          const script = document.createElement("script");
          script.src = "/widget/v1/loader.js";
          script.defer = true;
          script.dataset.widgetId = publicId;
          script.dataset.testGrant = grant;
          script.onerror = () => setState({ status: "error", message: "The widget loader could not be loaded.", keys: [] });
          document.body.appendChild(script);
        }
        waitForWidget(publicId, Date.now());
      })
      .catch((error) => { if (!cancelled) setState({ status: "error", message: error.message, keys: [] }); });
    return () => { cancelled = true; clearTimeout(mountTimer); console.error = consoleError; };
  }, [widgetId]);

  function navigateSpa(target) {
    window.history.pushState({}, "", pageUrl(target, widgetId));
    setSection(target);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return <div className="min-h-screen bg-slate-50 text-slate-900">
    <div className={`border-b px-4 py-2 text-xs sm:px-8 ${state.status === "error" ? "border-red-200 bg-red-50 text-red-700" : "border-slate-200 bg-white text-slate-600"}`} data-testid="widget-test-host-status" role="status">
      {state.status === "loading" ? <div className="flex items-center gap-2">Loading published widget <Skeleton className="h-4 w-32" /></div>
        : state.status === "ready" ? <>Test page · widget <span className="font-mono">{state.message}</span>{state.keys.length ? <> · context: <span className="font-mono">{state.keys.join(", ")}</span></> : " · no context"}</>
          : state.message}
    </div>
    <header className="border-b bg-white px-4 py-5 sm:px-8">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
        <div><div className="text-lg font-semibold tracking-tight">Example Company</div><p className="text-xs text-slate-500">Co-browsing customer-site fixture · synthetic data only</p></div>
        <nav aria-label="Test pages" className="flex flex-wrap gap-2">{pages.map((page) => <a key={page.id} href={pageUrl(page.id, widgetId)} data-cobrowse-control aria-current={section === page.id ? "page" : undefined}
          className={`rounded-lg px-3 py-2 text-sm ${section === page.id ? "bg-emerald-100 font-semibold text-emerald-900" : "text-slate-600 hover:bg-slate-100"}`}>{page.label}</a>)}</nav>
      </div>
    </header>
    <main className="mx-auto max-w-6xl px-4 py-10 pb-32 sm:px-8">
      {section === "overview" ? <Overview widgetId={widgetId} navigateSpa={navigateSpa} />
        : section === "products" ? <Products />
          : section === "checkout" ? <Checkout />
            : section === "support" ? <Support widgetId={widgetId} /> : <Account />}
      <div className="mt-12 flex flex-wrap items-center gap-3 border-t pt-6 text-xs text-slate-600">
        <span>Use the widget launcher to start a real conversation; page actions and form submissions stay local.</span>
        <button type="button" onClick={() => window.location.reload()} className="rounded-lg border bg-white px-3 py-2 text-sm text-slate-800">Reload page</button>
        <a href={pageUrl(section, widgetId)} target="_blank" rel="noopener noreferrer" className="rounded-lg border bg-white px-3 py-2 text-sm text-slate-800">Open same page in another tab</a>
      </div>
    </main>
  </div>;
}
