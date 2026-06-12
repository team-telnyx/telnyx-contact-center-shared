"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { notify } from "@/components/ToastNotify";
import { AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";
import { SectionRail, SECTION_RAIL_PAGE_GRID_CLASS, SECTION_RAIL_WIDTH } from "@/components/ui/section-rail";
import {
  IconActivity,
  IconClockHour4,
  IconDashboard,
  IconDeviceFloppy,
  IconDeviceLandlinePhone,
  IconDownload,
  IconEye,
  IconEyeOff,
  IconExternalLink,
  IconLoader2,
  IconPhoneCall,
  IconRefresh,
  IconRouteAltLeft,
  IconServer,
  IconSettings,
  IconShieldCheck,
  IconTrash,
  IconWand,
} from "@tabler/icons-react";

const API = "/api/admin/phones-provisioning";

const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: IconDashboard, description: "Fleet status and provisioning activity" },
  { id: "phones", label: "Phones", icon: IconDeviceLandlinePhone, description: "Hard phone inventory and per-device config" },
  { id: "settings", label: "Settings", icon: IconSettings, description: "Provisioning endpoint and vendor setup" },
];

const SECTION_STORAGE_KEY = "admin.phones-provisioning.activeSection";

const VENDORS = [
  { value: "polycom", label: "Polycom / Poly" },
  { value: "yealink", label: "Yealink" },
  { value: "audiocodes", label: "AudioCodes" },
];

const VENDOR_MODELS = {
  polycom: ["VVX 150", "VVX 250", "VVX 350", "VVX 450", "Edge E220", "Edge E350", "Edge E450", "CCX 400", "CCX 500"],
  yealink: ["T31P", "T33G", "T43U", "T46U", "T48U", "T53W", "T54W", "T57W", "T58W"],
  audiocodes: ["405HD", "445HD", "450HD"],
};

const PHONE_MODEL_CATALOG = {
  polycom: {
    "VVX 150": { image: "/images/hardphones/poly-vvx-150.jpg", docs: "https://docs.poly.com/category/vvx" },
    "VVX 250": { image: "/images/hardphones/poly-vvx-250.jpg", docs: "https://docs.poly.com/category/vvx" },
    "VVX 350": { image: "/images/hardphones/poly-vvx-350.jpg", docs: "https://docs.poly.com/category/vvx" },
    "VVX 450": { image: "/images/hardphones/poly-vvx-450.jpg", docs: "https://docs.poly.com/category/vvx" },
    "Edge E220": { image: "/images/hardphones/poly-edge-e220.jpg", docs: "https://docs.poly.com/category/edge-e" },
    "Edge E350": { image: "/images/hardphones/poly-edge-e350.jpg", docs: "https://docs.poly.com/category/edge-e" },
    "Edge E450": { image: "/images/hardphones/poly-edge-e450.jpg", docs: "https://docs.poly.com/category/edge-e" },
    "CCX 400": { image: "/images/hardphones/poly-ccx-400.jpg", docs: "https://docs.poly.com/category/ccx" },
    "CCX 500": { image: "/images/hardphones/poly-ccx-500.jpg", docs: "https://docs.poly.com/category/ccx" },
  },
  yealink: {
    T31P: { image: "/images/hardphones/yealink-t31p.png", docs: "https://www.yealink.com/en/product-detail/ip-phone-t31p" },
    T33G: { image: "/images/hardphones/yealink-t33g.png", docs: "https://www.yealink.com/en/product-detail/ip-phone-t33g" },
    T43U: { image: "/images/hardphones/yealink-t43u.jpg", docs: "https://www.yealink.com/en/product-detail/ip-phone-t43u" },
    T46U: { image: "/images/hardphones/yealink-t46u.png", docs: "https://www.yealink.com/en/product-detail/ip-phone-t46u" },
    T48U: { image: "/images/hardphones/yealink-t48u.png", docs: "https://www.yealink.com/en/product-detail/ip-phone-t48u" },
    T53W: { image: "/images/hardphones/yealink-t53w.jpg", docs: "https://www.yealink.com/en/product-detail/ip-phone-t53w" },
    T54W: { image: "/images/hardphones/yealink-t54w.jpg", docs: "https://www.yealink.com/en/product-detail/ip-phone-t54w" },
    T57W: { image: "/images/hardphones/yealink-t57w.jpg", docs: "https://www.yealink.com/en/product-detail/ip-phone-t57w" },
    T58W: { image: "/images/hardphones/yealink-t58w.png", docs: "https://www.yealink.com/en/product-detail/ip-phone-t58w" },
  },
  audiocodes: {
    "405HD": { image: "/images/hardphones/audiocodes-405hd.png", docs: "https://www.audiocodes.com/products/ip-phones/405hd-ip-phone" },
    "445HD": { image: "/images/hardphones/audiocodes-445hd.png", docs: "https://www.audiocodes.com/products/ip-phones/445hd-ip-phone" },
    "450HD": { image: "/images/hardphones/audiocodes-450hd.png", docs: "https://www.audiocodes.com/products/ip-phones/450hd-ip-phone" },
  },
};

function modelCatalogEntry(vendor, model) {
  const vendorCatalog = PHONE_MODEL_CATALOG[String(vendor || "").toLowerCase()] || {};
  return vendorCatalog[model] || null;
}

const toneClasses = { emerald: "from-emerald-500/18 to-teal-500/5 text-emerald-600 dark:text-emerald-300", blue: "from-sky-500/18 to-blue-500/5 text-sky-600 dark:text-sky-300", violet: "from-violet-500/18 to-fuchsia-500/5 text-violet-600 dark:text-violet-300", amber: "from-amber-500/20 to-orange-500/5 text-amber-600 dark:text-amber-300", rose: "from-rose-500/18 to-red-500/5 text-rose-600 dark:text-rose-300" };
const neutralActionClass = "bg-zinc-950 text-white shadow-sm hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200";

const stateBadgeClass = (state) => {
  const value = String(state || "").toLowerCase();
  if (value === "provisioned") return "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (value === "pending") return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (value === "disabled") return "border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300";
  return "border-slate-400/40 bg-slate-500/10 text-slate-600 dark:text-slate-300";
};

const vendorBadgeClass = (vendor) => {
  const value = String(vendor || "").toLowerCase();
  if (value === "polycom") return "border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (value === "yealink") return "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (value === "audiocodes") return "border-violet-500/35 bg-violet-500/10 text-violet-700 dark:text-violet-300";
  return "border-slate-400/40 bg-slate-500/10 text-slate-600 dark:text-slate-300";
};

function formatMacDisplay(mac) {
  const value = String(mac || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  if (value.length !== 12) return mac || "—";
  return value.match(/.{2}/g).join(":");
}

function formatTime(value) {
  if (!value) return "—";
  try { return new Date(value).toLocaleString(); } catch { return "—"; }
}

function PanelHeader({ title, description }) {
  return (
    <div className="h-16 shrink-0 border-b px-4 flex flex-col justify-center">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

function SettingCard({ icon: Icon, title, subtitle, children }) {
  return (
    <div className="rounded-2xl border bg-background/85 p-4 shadow-sm">
      <div className="mb-4 flex items-start gap-3">
        <span className="rounded-xl bg-gradient-to-br from-sky-500/15 to-violet-500/15 p-2 text-sky-600">
          <Icon className="h-4 w-4" />
        </span>
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

function MiniStat({ label, value, icon: Icon, tone = "blue" }) {
  return (
    <div className="rounded-lg border bg-muted/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
          <div className="mt-1 truncate text-sm font-semibold">{value}</div>
        </div>
        {Icon ? (
          <span className={`shrink-0 rounded-lg bg-gradient-to-br p-1.5 ${toneClasses[tone] || toneClasses.blue}`}>
            <Icon className="h-3.5 w-3.5" />
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Empty({ title, description }) {
  return (
    <div className="rounded-xl border border-dashed p-6 text-center">
      <h4 className="font-semibold">{title}</h4>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

const emptyPhoneDraft = () => ({ mac: "", vendor: "polycom", model: "", label: "", admin_password: "", ip_address: "" });

function phoneDraftValid(draft) {
  const mac = String(draft.mac || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  return mac.length === 12 && VENDORS.some((v) => v.value === draft.vendor);
}

export default function PhonesProvisioningPage() {
  const [active, setActive] = useState("dashboard");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [phones, setPhones] = useState([]);
  const [dashboard, setDashboard] = useState(null);
  const [selectedPhoneId, setSelectedPhoneId] = useState(null);
  const [phoneDraft, setPhoneDraft] = useState(emptyPhoneDraft());

  const activeMeta = useMemo(() => NAV_ITEMS.find((i) => i.id === active) || NAV_ITEMS[0], [active]);
  const selectedPhone = useMemo(() => phones.find((p) => p.id === selectedPhoneId) || null, [phones, selectedPhoneId]);

  useEffect(() => {
    try {
      const requested = new URLSearchParams(window.location.search).get("section");
      if (requested && NAV_ITEMS.some((i) => i.id === requested)) { setActive(requested); return; }
      const saved = localStorage.getItem(SECTION_STORAGE_KEY);
      if (saved && NAV_ITEMS.some((i) => i.id === saved)) setActive(saved);
    } catch {}
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SECTION_STORAGE_KEY, active);
      const url = new URL(window.location.href);
      if (url.searchParams.get("section") !== active) {
        url.searchParams.set("section", active);
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      }
    } catch {}
  }, [active]);

  const refresh = useCallback(async (toast = false) => {
    setLoading(true);
    try {
      const [phonesRes, dashboardRes] = await Promise.all([
        fetch(`${API}/phones`),
        fetch(`${API}/dashboard`),
      ]);
      const phonesData = phonesRes.ok ? await phonesRes.json() : { phones: [] };
      const dashboardData = dashboardRes.ok ? await dashboardRes.json() : null;
      setPhones(phonesData.phones || []);
      setDashboard(dashboardData);
      if (toast) notify({ title: "Phones provisioning refreshed", description: "Data reloaded.", variant: "success" });
    } catch (err) {
      notify({ title: "Failed to load phones provisioning", description: err.message, variant: "error" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (selectedPhone) {
      setPhoneDraft({
        mac: selectedPhone.mac || "",
        vendor: selectedPhone.vendor || "polycom",
        model: selectedPhone.model || "",
        label: selectedPhone.label || "",
        admin_password: selectedPhone.admin_password || "",
        ip_address: selectedPhone.ip_address || "",
      });
    } else {
      setPhoneDraft(emptyPhoneDraft());
    }
  }, [selectedPhone]);

  const draftValid = phoneDraftValid(phoneDraft);

  async function savePhone() {
    if (!draftValid) return;
    setSaving(true);
    try {
      const payload = {
        mac: phoneDraft.mac,
        vendor: phoneDraft.vendor,
        model: phoneDraft.model.trim(),
        label: phoneDraft.label.trim(),
        admin_password: phoneDraft.admin_password.trim(),
        ip_address: phoneDraft.ip_address.trim(),
      };
      const url = selectedPhone ? `${API}/phones/${selectedPhone.id}` : `${API}/phones`;
      const res = await fetch(url, {
        method: selectedPhone ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Save failed");
      }
      const data = await res.json();
      notify({ title: selectedPhone ? "Phone updated" : "Phone added", description: formatMacDisplay(data.phone?.mac), variant: "success" });
      setPhones((prev) => (selectedPhone ? prev.map((p) => (p.id === selectedPhone.id ? data.phone : p)) : [data.phone, ...prev]));
      if (!selectedPhone && data.phone?.id) setSelectedPhoneId(data.phone.id);
    } catch (err) {
      notify({ title: "Save failed", description: err.message, variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function deletePhone(item) {
    if (!window.confirm(`Delete phone ${formatMacDisplay(item.mac)} and its Telnyx credential?`)) return;
    try {
      const res = await fetch(`${API}/phones/${item.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      notify({ title: "Phone deleted", variant: "success" });
      setPhones((prev) => prev.filter((p) => p.id !== item.id));
      if (selectedPhoneId === item.id) setSelectedPhoneId(null);
    } catch (err) {
      notify({ title: "Delete failed", description: err.message, variant: "error" });
    }
  }

  async function togglePhoneState(item) {
    const next = item.provisioning_state === "disabled" ? "pending" : "disabled";
    try {
      const res = await fetch(`${API}/phones/${item.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provisioning_state: next }),
      });
      if (!res.ok) throw new Error("Update failed");
      const data = await res.json();
      setPhones((prev) => prev.map((p) => (p.id === item.id ? data.phone : p)));
      notify({ title: next === "disabled" ? "Provisioning disabled" : "Provisioning re-enabled", description: formatMacDisplay(item.mac), variant: "success" });
    } catch (err) {
      notify({ title: "Update failed", description: err.message, variant: "error" });
    }
  }

  const headerCreate = active === "phones" ? { label: "New phone", onClick: () => setSelectedPhoneId(null) } : null;
  const totals = dashboard?.totals || { total: 0, provisioned: 0, pending: 0, disabled: 0, recently_seen: 0 };

  return (
    <AdminPageShell>
      <AdminPageHeader
        title="Phones Provisioning"
        badges={(
          <Badge variant="outline" className="border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300">
            {totals.total} phones
          </Badge>
        )}
        actions={(
          <>
            <Button variant="outline" size="sm" onClick={() => refresh(true)} disabled={loading}>
              <IconRefresh className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            {headerCreate ? (
              <Button size="sm" className={neutralActionClass} onClick={headerCreate.onClick} disabled={saving}>
                <IconWand className="mr-2 h-4 w-4" />
                {headerCreate.label}
              </Button>
            ) : null}
          </>
        )}
      />
      <main className={SECTION_RAIL_PAGE_GRID_CLASS} style={{ gridTemplateColumns: `${SECTION_RAIL_WIDTH} minmax(0,1fr) 380px` }}>
        <SectionRail items={NAV_ITEMS} activeId={active} onSelect={setActive} ariaLabel="Phones provisioning sections" />

        {/* Main panel */}
        <section className="min-h-0 overflow-hidden rounded-2xl border bg-card/95 shadow-sm backdrop-blur flex flex-col">
          <div className="h-16 shrink-0 border-b bg-card/95 px-5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">{activeMeta.label}</h2>
              <p className="text-xs text-muted-foreground">{activeMeta.description}</p>
            </div>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-5">
            {active === "dashboard" ? (
              <DashboardView dashboard={dashboard} phones={phones} />
            ) : active === "phones" ? (
              <PhonesListView
                phones={phones}
                selectedPhoneId={selectedPhone?.id || null}
                setSelectedPhoneId={setSelectedPhoneId}
                deletePhone={deletePhone}
                togglePhoneState={togglePhoneState}
              />
            ) : (
              <SettingsSummaryView />
            )}
          </div>
        </section>

        {/* Right panel — Context Settings */}
        <aside className="min-h-0 overflow-hidden rounded-2xl border bg-card/92 shadow-sm backdrop-blur flex flex-col">
          <PanelHeader
            title={active === "dashboard" ? "Fleet monitor" : "Context settings"}
            description={active === "dashboard" ? "Provisioning activity overview" : `${activeMeta.label} configuration`}
          />
          <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
            {active === "dashboard" ? (
              <div className="rounded-xl border bg-muted/30 p-4 text-sm text-muted-foreground">
                Phones report in when they fetch config files from the provisioning endpoint. Use Refresh to reload fleet status and the event log.
              </div>
            ) : active === "phones" ? (
              <PhoneEditor
                draft={phoneDraft}
                setDraft={setPhoneDraft}
                editing={Boolean(selectedPhone)}
                phone={selectedPhone}
                valid={draftValid}
                saving={saving}
                save={savePhone}
              />
            ) : (
              <SettingsEditor />
            )}
          </div>
        </aside>
      </main>
    </AdminPageShell>
  );
}

function DashboardView({ dashboard, phones }) {
  const totals = dashboard?.totals || { total: 0, provisioned: 0, pending: 0, disabled: 0, recently_seen: 0 };
  const byVendor = dashboard?.byVendor || [];
  const events = dashboard?.events || [];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <MiniStat label="Total phones" value={totals.total} icon={IconDeviceLandlinePhone} tone="blue" />
        <MiniStat label="Provisioned" value={totals.provisioned} icon={IconShieldCheck} tone="emerald" />
        <MiniStat label="Pending" value={totals.pending} icon={IconClockHour4} tone="amber" />
        <MiniStat label="Disabled" value={totals.disabled} icon={IconActivity} tone="rose" />
        <MiniStat label="Seen last 2h" value={totals.recently_seen} icon={IconActivity} tone="violet" />
      </div>

      <SettingCard icon={IconDeviceLandlinePhone} title="Fleet by vendor" subtitle="Inventory split across supported manufacturers">
        {byVendor.length ? (
          <div className="flex flex-wrap gap-2">
            {byVendor.map((v) => (
              <Badge key={v.vendor} variant="outline" className={vendorBadgeClass(v.vendor)}>
                {VENDORS.find((x) => x.value === v.vendor)?.label || v.vendor}: {v.count}
              </Badge>
            ))}
          </div>
        ) : <p className="text-sm text-muted-foreground">No phones in inventory yet — add one in the Phones section.</p>}
      </SettingCard>

      <SettingCard icon={IconActivity} title="Phone status" subtitle="Registration identity and last contact per device">
        {phones.length ? (
          <div className="overflow-hidden rounded-xl border">
            <div className="grid bg-muted/45 px-3 py-2 text-xs font-semibold text-muted-foreground" style={{ gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.2fr)" }}>
              <span>Phone</span><span>Vendor</span><span>State</span><span>SIP user</span><span>Last seen</span>
            </div>
            {phones.slice(0, 12).map((p) => (
              <div key={p.id} className="grid items-center border-t px-3 py-2 text-sm" style={{ gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.2fr)" }}>
                <span className="min-w-0">
                  <span className="block truncate font-medium">{p.label || formatMacDisplay(p.mac)}</span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">{formatMacDisplay(p.mac)}</span>
                </span>
                <span><Badge variant="outline" className={vendorBadgeClass(p.vendor)}>{p.vendor}</Badge></span>
                <span><Badge variant="outline" className={stateBadgeClass(p.provisioning_state)}>{p.provisioning_state}</Badge></span>
                <span className="truncate font-mono text-xs">{p.sip_username || "—"}</span>
                <span className="truncate text-xs text-muted-foreground">{p.last_seen_at ? formatTime(p.last_seen_at) : "never"}</span>
              </div>
            ))}
          </div>
        ) : <Empty title="No phones yet" description="Add hard phones in the Phones section to see fleet status here." />}
      </SettingCard>

      <SettingCard icon={IconDownload} title="Provisioning activity" subtitle="Latest config fetches and phone events">
        {events.length ? (
          <div className="space-y-1.5">
            {events.slice(0, 20).map((e) => (
              <div key={e.id} className="flex items-center justify-between gap-3 rounded-lg border bg-background/70 px-3 py-1.5 text-xs">
                <span className="flex min-w-0 items-center gap-2">
                  <Badge variant="outline" className="bg-card font-mono text-[10px]">{e.event_type}</Badge>
                  <span className="truncate font-mono">{e.mac ? formatMacDisplay(e.mac) : "—"}</span>
                  {e.label ? <span className="truncate text-muted-foreground">{e.label}</span> : null}
                </span>
                <span className="shrink-0 text-muted-foreground">{formatTime(e.created_at)}</span>
              </div>
            ))}
          </div>
        ) : <p className="text-sm text-muted-foreground">No provisioning events yet. Point a phone at the provisioning URL to see activity.</p>}
      </SettingCard>
    </div>
  );
}

function PhonesListView({ phones, selectedPhoneId, setSelectedPhoneId, deletePhone, togglePhoneState }) {
  if (!phones.length) {
    return <Empty title="No phones yet" description="Use New phone in the header, fill in the MAC and vendor in Context Settings on the right, then save. A Telnyx SIP credential is created automatically." />;
  }
  return (
    <div className="rounded-2xl border bg-background/85 p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Phone inventory</h3>
          <p className="text-sm text-muted-foreground">Rows select configuration in the right Context Settings panel.</p>
        </div>
        <Badge variant="outline" className="bg-card">{phones.length} total</Badge>
      </div>
      <div className="mt-5 overflow-hidden rounded-xl border">
        <div className="grid bg-muted/45 px-3 py-2 text-xs font-semibold text-muted-foreground" style={{ gridTemplateColumns: "minmax(0,1.6fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.1fr) 96px" }}>
          <span>Phone</span><span>Vendor</span><span>Model</span><span>State</span><span>Last seen</span><span className="text-right">Actions</span>
        </div>
        {phones.map((p) => {
          const selected = selectedPhoneId === p.id;
          return (
            <div
              key={p.id}
              onClick={() => setSelectedPhoneId(p.id)}
              className={`grid cursor-pointer items-center border-t px-3 py-2.5 text-sm transition hover:bg-muted/40 ${selected ? "bg-sky-500/10" : ""}`}
              style={{ gridTemplateColumns: "minmax(0,1.6fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.1fr) 96px" }}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{p.label || formatMacDisplay(p.mac)}</span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">{formatMacDisplay(p.mac)}</span>
              </span>
              <span><Badge variant="outline" className={vendorBadgeClass(p.vendor)}>{p.vendor}</Badge></span>
              <span className="truncate text-xs">{p.model || "—"}</span>
              <span><Badge variant="outline" className={stateBadgeClass(p.provisioning_state)}>{p.provisioning_state}</Badge></span>
              <span className="truncate text-xs text-muted-foreground">{p.last_seen_at ? formatTime(p.last_seen_at) : "never"}</span>
              <span className="flex items-center justify-end gap-1">
                <Button size="icon" variant="ghost" className="h-7 w-7" title={p.provisioning_state === "disabled" ? "Enable provisioning" : "Disable provisioning"} onClick={(e) => { e.stopPropagation(); togglePhoneState(p); }}>
                  {p.provisioning_state === "disabled" ? <IconEye className="h-3.5 w-3.5" /> : <IconEyeOff className="h-3.5 w-3.5" />}
                </Button>
                <Button size="icon" variant="ghost" className="h-7 w-7" title="Delete" onClick={(e) => { e.stopPropagation(); deletePhone(p); }}>
                  <IconTrash className="h-3.5 w-3.5" />
                </Button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PhoneEditor({ draft, setDraft, editing, phone, valid, saving, save }) {
  const update = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const models = VENDOR_MODELS[draft.vendor] || [];
  const catalogEntry = modelCatalogEntry(draft.vendor, draft.model);

  return (
    <>
      <SettingCard icon={IconDeviceLandlinePhone} title={editing ? "Edit phone" : "New phone"} subtitle="Identity used to match boot provisioning requests">
        <div className="space-y-3">
          <div>
            <Label>MAC address<span aria-hidden="true" className="ml-1 text-red-500">*</span></Label>
            <Input className="mt-1 font-mono" value={draft.mac} onChange={(e) => update({ mac: e.target.value })} placeholder="00:04:f2:ab:cd:ef" disabled={editing} />
            {editing ? <p className="mt-1 text-xs text-muted-foreground">MAC cannot change — delete and re-add the phone instead.</p> : null}
          </div>
          <div>
            <Label>Vendor<span aria-hidden="true" className="ml-1 text-red-500">*</span></Label>
            <Select value={draft.vendor} onValueChange={(v) => update({ vendor: v, model: "" })}>
              <SelectTrigger className="mt-1 w-full"><SelectValue placeholder="Vendor" /></SelectTrigger>
              <SelectContent>
                {VENDORS.map((v) => <SelectItem key={v.value} value={v.value}>{v.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Model</Label>
            <Select value={draft.model || ""} onValueChange={(v) => update({ model: v })}>
              <SelectTrigger className="mt-1 w-full"><SelectValue placeholder="Select model" /></SelectTrigger>
              <SelectContent>
                {models.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {catalogEntry ? <PhoneModelPreview vendor={draft.vendor} model={draft.model} catalogEntry={catalogEntry} /> : null}
          <div>
            <Label>Label</Label>
            <Input className="mt-1" value={draft.label} onChange={(e) => update({ label: e.target.value })} placeholder="Desk 12 / Agent name" />
          </div>
          <div>
            <Label>Admin password</Label>
            <Input className="mt-1 font-mono" value={draft.admin_password} onChange={(e) => update({ admin_password: e.target.value })} placeholder="Generated automatically when empty" />
            <p className="mt-1 text-xs text-muted-foreground">Replaces the factory default (456 / admin / 1234) during provisioning.</p>
          </div>
          <div>
            <Label>Phone IP address</Label>
            <Input className="mt-1 font-mono" value={draft.ip_address} onChange={(e) => update({ ip_address: e.target.value })} placeholder="Auto-detected from provisioning when empty" />
            <p className="mt-1 text-xs text-muted-foreground">Used for CTI control (Polycom REST / Yealink Action URI). Leave empty to use the last provisioning IP.</p>
          </div>
        </div>
      </SettingCard>

      {editing && phone ? (
        <SettingCard icon={IconPhoneCall} title="SIP registration" subtitle="Telnyx telephony credential injected into the config">
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">SIP username</span>
              <span className="truncate font-mono text-xs">{phone.sip_username || "—"}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">Credential ID</span>
              <span className="truncate font-mono text-xs">{phone.telnyx_credential_id || "—"}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">SIP server</span>
              <span className="font-mono text-xs">sip.telnyx.com</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">State</span>
              <Badge variant="outline" className={stateBadgeClass(phone.provisioning_state)}>{phone.provisioning_state}</Badge>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">Last user agent</span>
              <span className="truncate text-xs">{phone.last_user_agent || "—"}</span>
            </div>
          </div>
        </SettingCard>
      ) : null}

      {editing && phone ? <PhoneCtiCard phone={phone} /> : null}

      <Button className="w-full" onClick={save} disabled={!valid || saving} data-testid="hp-save-phone">
        {saving ? <IconLoader2 className="mr-2 h-4 w-4 animate-spin" /> : <IconDeviceFloppy className="mr-2 h-4 w-4" />}
        {editing ? "Save phone" : "Add phone"}
      </Button>
      {!valid ? (
        <p className="text-xs text-amber-600 dark:text-amber-300">Required: a valid 12-hex-digit MAC address and a vendor.</p>
      ) : null}
      {!editing ? (
        <p className="text-xs text-muted-foreground">Saving creates a dedicated Telnyx telephony credential for this phone automatically.</p>
      ) : null}
    </>
  );
}

function PhoneModelPreview({ vendor, model, catalogEntry }) {
  const vendorLabel = VENDORS.find((v) => v.value === vendor)?.label || vendor;
  return (
    <div className="overflow-hidden rounded-xl border bg-muted/20">
      <div className="aspect-[4/3] bg-white p-3 dark:bg-zinc-950">
        <img src={catalogEntry.image} alt={`${vendorLabel} ${model}`} className="h-full w-full object-contain" loading="lazy" />
      </div>
      <div className="border-t px-3 py-2">
        <div className="text-sm font-medium">{model}</div>
        <a className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-sky-600 hover:underline dark:text-sky-300" href={catalogEntry.docs} target="_blank" rel="noreferrer">
          Full manufacturer documentation <IconExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  );
}

// CTI control card — drives the phone through the vendor driver (Polycom
// REST, Yealink Action URI, Telnyx fallback for AudioCodes/NAT-ed phones).
function PhoneCtiCard({ phone }) {
  const [busy, setBusy] = useState(null);
  const [dialNumber, setDialNumber] = useState("");
  const [lastStatus, setLastStatus] = useState(null);

  const ctiMode = phone.vendor === "audiocodes" || phone?.settings?.cti_mode === "telnyx" ? "Telnyx Call Control" : phone.vendor === "polycom" ? "Polycom REST API" : "Yealink Action URI";
  const reachableIp = phone.ip_address || phone.last_ip;

  async function runCti(action, params = {}) {
    setBusy(action);
    try {
      const res = await fetch(`${API}/phones/${phone.id}/cti`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...params }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `${action} failed`);
      if (action === "status") setLastStatus(data.result || null);
      notify({ title: `CTI: ${action}`, description: action === "dial" ? params.number : "OK", variant: "success" });
    } catch (err) {
      notify({ title: `CTI ${action} failed`, description: err.message, variant: "error" });
    } finally {
      setBusy(null);
    }
  }

  const ctlBtn = (action, label, params = {}) => (
    <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => runCti(action, params)} data-testid={`hp-cti-${action}`}>
      {busy === action ? <IconLoader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
      {label}
    </Button>
  );

  return (
    <SettingCard icon={IconActivity} title="CTI control" subtitle={`Driver: ${ctiMode}`}>
      <div className="space-y-3">
        {phone?.settings?.cti_mode === "telnyx" ? (
          <p className="rounded-lg border border-sky-500/35 bg-sky-500/10 px-3 py-2 text-xs text-sky-700 dark:text-sky-300">
            NAT-safe mode is enabled: the phone registers outbound to Telnyx and CTI uses Telnyx Call Control, so no inbound firewall rule to the phone is required.
          </p>
        ) : null}
        {!reachableIp && phone.vendor !== "audiocodes" ? (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            No known phone IP yet — set it above or wait for the phone to fetch its config.
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <Input className="font-mono" value={dialNumber} onChange={(e) => setDialNumber(e.target.value)} placeholder="+48123456789" />
          </div>
          <Button size="sm" disabled={Boolean(busy) || !dialNumber.trim()} onClick={() => runCti("dial", { number: dialNumber.trim() })} data-testid="hp-cti-dial">
            {busy === "dial" ? <IconLoader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <IconPhoneCall className="mr-1 h-3.5 w-3.5" />}
            Dial
          </Button>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {ctlBtn("answer", "Answer")}
          {ctlBtn("hold", "Hold")}
          {ctlBtn("resume", "Resume")}
          {ctlBtn("mute", "Mute")}
          {ctlBtn("unmute", "Unmute")}
          {ctlBtn("hangup", "Hang up")}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {ctlBtn("status", "Check status")}
          {ctlBtn("reprovision", "Re-provision")}
        </div>
        {lastStatus ? (
          <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs">
            <div>Reachable: <span className="font-medium">{lastStatus.result?.reachable === null ? "n/a" : String(lastStatus.result?.reachable ?? lastStatus.reachable ?? "unknown")}</span></div>
            {lastStatus.result?.call || lastStatus.call ? (
              <div className="mt-1 truncate font-mono">{JSON.stringify(lastStatus.result?.call || lastStatus.call).slice(0, 160)}</div>
            ) : <div className="mt-1 text-muted-foreground">No active call</div>}
          </div>
        ) : null}
      </div>
    </SettingCard>
  );
}

function SettingsSummaryView() {
  const [origin, setOrigin] = useState("");
  useEffect(() => { try { setOrigin(window.location.origin); } catch {} }, []);
  const provisioningUrl = `${origin || "https://<your-host>"}/api/provisioning/`;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border bg-background/85 p-5 shadow-sm">
        <h3 className="text-lg font-semibold">Provisioning endpoint</h3>
        <p className="text-sm text-muted-foreground">Phones download generated config files from this URL at boot and on their polling schedule.</p>
        <div className="mt-3 rounded-lg border bg-muted/30 px-3 py-2 font-mono text-sm">{provisioningUrl}</div>
      </div>

      <SettingCard icon={IconServer} title="Zero-touch setup" subtitle="Point factory phones at the provisioning endpoint">
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
          <li><span className="font-medium text-foreground">DHCP option 66 / 160</span> — set the value to the provisioning URL above; phones pick it up at boot.</li>
          <li><span className="font-medium text-foreground">Vendor redirect services</span> — Poly ZTP / Poly Lens, Yealink RPS, AudioCodes Redirect can map phone MACs to this URL for drop-ship deployments.</li>
          <li><span className="font-medium text-foreground">Manual</span> — enter the URL in the phone menu or web UI (Provisioning Server / Auto Provision).</li>
        </ul>
      </SettingCard>

      <SettingCard icon={IconRouteAltLeft} title="NAT and local-network CTI" subtitle="Genesys-style managed phones without inbound firewall holes">
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>
            Direct Poly REST and Yealink Action URI need server-to-phone reachability. For phones behind customer NAT, prefer <span className="font-medium text-foreground">Telnyx Call Control fallback</span>: the phone registers outbound to Telnyx, auto-answers the CTI leg, and the Contact Center controls that Telnyx leg instead of opening inbound firewall access to the handset.
          </p>
          <p>
            Genesys Cloud takes the same managed-telephony pattern: phone provisioning and supported model management live in the cloud, while edge/SBC-style components handle private-network telephony reachability. If we need true local key-level control for NAT-ed Poly/Yealink phones, the safer design is a small LAN bridge that opens an outbound WebSocket to CC and proxies local phone REST/Action URI calls; a browser plugin is possible but worse for credentials, CORS and enterprise rollout.
          </p>
          <div className="flex flex-wrap gap-2">
            <a className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium text-sky-600 hover:bg-sky-500/10 dark:text-sky-300" href="https://help.genesys.cloud/articles/managed-phones-models-and-features-matrix/" target="_blank" rel="noreferrer">Genesys managed phone matrix <IconExternalLink className="h-3 w-3" /></a>
            <a className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium text-sky-600 hover:bg-sky-500/10 dark:text-sky-300" href="https://help.genesys.cloud/articles/provisioning-phones-genesys-cloud-voice/" target="_blank" rel="noreferrer">Genesys phone provisioning <IconExternalLink className="h-3 w-3" /></a>
            <a className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium text-sky-600 hover:bg-sky-500/10 dark:text-sky-300" href="https://help.genesys.cloud/articles/about-managed-phone-configuration/" target="_blank" rel="noreferrer">Managed phone configuration <IconExternalLink className="h-3 w-3" /></a>
          </div>
        </div>
      </SettingCard>

      <SettingCard icon={IconDeviceLandlinePhone} title="Served file conventions" subtitle="Files generated per request from the phone inventory">
        <div className="space-y-2 text-sm">
          <div className="rounded-lg border bg-muted/30 px-3 py-2">
            <div className="font-medium">Polycom / Poly</div>
            <div className="font-mono text-xs text-muted-foreground">&lt;mac&gt;.cfg → master config · &lt;mac&gt;-reg.cfg → registration (XML)</div>
          </div>
          <div className="rounded-lg border bg-muted/30 px-3 py-2">
            <div className="font-medium">Yealink</div>
            <div className="font-mono text-xs text-muted-foreground">y000000000000.cfg → common defaults · &lt;mac&gt;.cfg → account config</div>
          </div>
          <div className="rounded-lg border bg-muted/30 px-3 py-2">
            <div className="font-medium">AudioCodes</div>
            <div className="font-mono text-xs text-muted-foreground">&lt;mac&gt;.cfg → INI config (405HD / 445HD / 450HD, UC firmware)</div>
          </div>
        </div>
      </SettingCard>

      <SettingCard icon={IconShieldCheck} title="Security model" subtitle="How credentials are protected">
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
          <li>Only phones present in the inventory are served config files — unknown MACs get 404 and are logged.</li>
          <li>Each phone gets its own Telnyx telephony credential; deleting the phone deletes the credential.</li>
          <li>Factory admin passwords are replaced during provisioning.</li>
          <li>Run the endpoint behind HTTPS — config files carry SIP secrets.</li>
        </ul>
      </SettingCard>
    </div>
  );
}

function SettingsEditor() {
  return (
    <SettingCard icon={IconSettings} title="Provisioning defaults" subtitle="Phase 1 serves Telnyx defaults">
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>Config files are generated with <span className="font-mono text-foreground">sip.telnyx.com</span>, UDP transport and hourly re-provisioning polling.</p>
        <p>Per-phone IP override controls direct Poly REST / Yealink Action URI. For phones behind NAT, set <span className="font-mono text-foreground">settings.cti_mode = &quot;telnyx&quot;</span> to force the outbound-only Telnyx Call Control fallback.</p>
      </div>
    </SettingCard>
  );
}
