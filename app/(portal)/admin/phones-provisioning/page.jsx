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
  IconCopy,
  IconDashboard,
  IconDeviceFloppy,
  IconDeviceLandlinePhone,
  IconDownload,
  IconEye,
  IconEyeOff,
  IconExternalLink,
  IconLoader2,
  IconPhoneCall,
  IconPower,
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
  { id: "bridges", label: "Bridges", icon: IconRouteAltLeft, description: "Local LAN bridge agents and connection status" },
  { id: "settings", label: "Settings", icon: IconSettings, description: "Provisioning endpoint and vendor setup" },
];

const SECTION_STORAGE_KEY = "admin.phones-provisioning.activeSection";

const VENDORS = [
  { value: "polycom", label: "Polycom / Poly" },
  { value: "yealink", label: "Yealink" },
  { value: "audiocodes", label: "AudioCodes" },
];

const POLY_UCS_DOCS = "https://docs.poly.com/bundle/poly-ucs-ag-6-4-5/page/r-ucs-supported-phone-models.html";
const POLY_EDGE_DOCS = "https://docs.poly.com/bundle/poly-edge-e-ag-current/page/r-poly-edge-e-supported-features.html";
const AUDIOCODES_DOCS = "https://www.audiocodes.com/library/technical-documents?productFamilyGroup=1639";

const VENDOR_MODELS = {
  polycom: [
    "VVX 101", "VVX 150", "VVX 201", "VVX 250", "VVX 300", "VVX 301", "VVX 310", "VVX 311", "VVX 350",
    "VVX 400", "VVX 401", "VVX 410", "VVX 411", "VVX 450", "VVX 500", "VVX 501", "VVX 600", "VVX 601",
    "CCX 350", "CCX 400", "CCX 500", "CCX 505", "CCX 600", "CCX 700",
    "Edge E100", "Edge E220", "Edge E300", "Edge E320", "Edge E350", "Edge E400", "Edge E450", "Edge E500", "Edge E550",
    "Edge B10", "Edge B20", "Edge B30", "Rove 20", "Rove 30", "Rove 40",
  ],
  yealink: ["T31P", "T33G", "T43U", "T46U", "T48U", "T53W", "T54W", "T57W", "T58W"],
  audiocodes: ["405", "405HD", "420HD", "430HD", "440HD", "445HD", "450HD"],
};

function polyImage(model) {
  if (model.startsWith("CCX")) return model === "CCX 500" || model === "CCX 505" ? "/images/hardphones/poly-ccx-500.jpg" : "/images/hardphones/poly-ccx-400.jpg";
  if (model.startsWith("Edge E")) {
    if (["Edge E100", "Edge E220", "Edge E300", "Edge E320"].includes(model)) return "/images/hardphones/poly-edge-e220.jpg";
    if (["Edge E350", "Edge E400"].includes(model)) return "/images/hardphones/poly-edge-e350.jpg";
    return "/images/hardphones/poly-edge-e450.jpg";
  }
  if (model.startsWith("Edge B") || model.startsWith("Rove")) return "/images/hardphones/poly-edge-e220.jpg";
  if (["VVX 101", "VVX 150", "VVX 201"].includes(model)) return "/images/hardphones/poly-vvx-150.jpg";
  if (["VVX 250", "VVX 300", "VVX 301", "VVX 310", "VVX 311"].includes(model)) return "/images/hardphones/poly-vvx-250.jpg";
  if (["VVX 350", "VVX 400", "VVX 401", "VVX 410", "VVX 411"].includes(model)) return "/images/hardphones/poly-vvx-350.jpg";
  return "/images/hardphones/poly-vvx-450.jpg";
}

function polyDocs(model) {
  return model.startsWith("Edge") ? POLY_EDGE_DOCS : POLY_UCS_DOCS;
}

const PHONE_MODEL_CATALOG = {
  polycom: Object.fromEntries(VENDOR_MODELS.polycom.map((model) => [model, { image: polyImage(model), docs: polyDocs(model) }])),
  yealink: {
    T31P: { image: "/images/hardphones/yealink-t31p.png", docs: "https://www.yealink.com/en/product-detail/ip-phone-t31p" },
    T33G: { image: "/images/hardphones/yealink-t33g.png", docs: "https://www.yealink.com/en/product-detail/ip-phone-t33g" },
    T43U: { image: "/images/hardphones/yealink-t43u.png", docs: "https://www.yealink.com/en/product-detail/ip-phone-t43u" },
    T46U: { image: "/images/hardphones/yealink-t46u.png", docs: "https://www.yealink.com/en/product-detail/ip-phone-t46u" },
    T48U: { image: "/images/hardphones/yealink-t48u.png", docs: "https://www.yealink.com/en/product-detail/ip-phone-t48u" },
    T53W: { image: "/images/hardphones/yealink-t53w.png", docs: "https://www.yealink.com/en/product-detail/ip-phone-t53w" },
    T54W: { image: "/images/hardphones/yealink-t54w.png", docs: "https://www.yealink.com/en/product-detail/ip-phone-t54w" },
    T57W: { image: "/images/hardphones/yealink-t57w.png", docs: "https://www.yealink.com/en/product-detail/ip-phone-t57w" },
    T58W: { image: "/images/hardphones/yealink-t58w.png", docs: "https://www.yealink.com/en/product-detail/ip-phone-t58w" },
  },
  audiocodes: {
    "405": { image: "/images/hardphones/audiocodes-405.png", docs: AUDIOCODES_DOCS },
    "405HD": { image: "/images/hardphones/audiocodes-405hd.png", docs: AUDIOCODES_DOCS },
    "420HD": { image: "/images/hardphones/audiocodes-420hd.png", docs: AUDIOCODES_DOCS },
    "430HD": { image: "/images/hardphones/audiocodes-430hd.png", docs: AUDIOCODES_DOCS },
    "440HD": { image: "/images/hardphones/audiocodes-440hd.png", docs: AUDIOCODES_DOCS },
    "445HD": { image: "/images/hardphones/audiocodes-445hd.png", docs: AUDIOCODES_DOCS },
    "450HD": { image: "/images/hardphones/audiocodes-450hd.png", docs: AUDIOCODES_DOCS },
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

const registrationBadgeClass = (state) => {
  const value = String(state || "unknown").toLowerCase();
  if (value === "registered") return "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (value === "not_registered" || value === "unregistered") return "border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300";
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

const emptyPhoneDraft = () => ({
  mac: "",
  vendor: "polycom",
  model: "",
  label: "",
  admin_password: "",
  ip_address: "",
  local_bridge_id: "",
  settings: {
    cti_mode: "direct",
    line_keys: "1",
    timezone_discovery: true,
    sntp_server: "pool.ntp.org",
    dynamic_reload: true,
    automatic_firmware_updates: true,
    firmware_source: "vendor-default",
    custom_config_url: "",
    syslog_server: "",
  },
});

function normalizePhoneSettings(raw = {}) {
  return {
    ...emptyPhoneDraft().settings,
    ...(raw && typeof raw === "object" ? raw : {}),
    timezone_discovery: raw?.timezone_discovery !== false,
    dynamic_reload: raw?.dynamic_reload !== false,
    automatic_firmware_updates: raw?.automatic_firmware_updates !== false,
  };
}

function phoneDraftValid(draft) {
  const mac = String(draft.mac || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  return mac.length === 12 && VENDORS.some((v) => v.value === draft.vendor);
}

export default function PhonesProvisioningPage() {
  const [active, setActive] = useState("dashboard");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [phones, setPhones] = useState([]);
  const [bridges, setBridges] = useState([]);
  const [dashboard, setDashboard] = useState(null);
  const [selectedPhoneId, setSelectedPhoneId] = useState(null);
  const [selectedBridgeId, setSelectedBridgeId] = useState(null);
  const [selectedRebootIds, setSelectedRebootIds] = useState([]);
  const [rebooting, setRebooting] = useState(false);
  const [phoneDraft, setPhoneDraft] = useState(emptyPhoneDraft());

  const activeMeta = useMemo(() => NAV_ITEMS.find((i) => i.id === active) || NAV_ITEMS[0], [active]);
  const selectedPhone = useMemo(() => phones.find((p) => p.id === selectedPhoneId) || null, [phones, selectedPhoneId]);
  const selectedBridge = useMemo(() => bridges.find((b) => b.bridge_id === selectedBridgeId) || bridges[0] || null, [bridges, selectedBridgeId]);

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

  const refresh = useCallback(async (toast = false, options = {}) => {
    if (!options.silent) setLoading(true);
    try {
      const [phonesRes, dashboardRes, bridgesRes] = await Promise.all([
        fetch(`${API}/phones`),
        fetch(`${API}/dashboard`),
        fetch(`${API}/bridges`),
      ]);
      const phonesData = phonesRes.ok ? await phonesRes.json() : { phones: [] };
      const dashboardData = dashboardRes.ok ? await dashboardRes.json() : null;
      const bridgesData = bridgesRes.ok ? await bridgesRes.json() : { bridges: [] };
      setPhones(phonesData.phones || []);
      setDashboard(dashboardData);
      setBridges(bridgesData.bridges || []);
      if (toast) notify({ title: "Phones provisioning refreshed", description: "Data reloaded.", variant: "success" });
    } catch (err) {
      notify({ title: "Failed to load phones provisioning", description: err.message, variant: "error" });
    } finally {
      if (!options.silent) setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (active !== "bridges" && active !== "phones") return undefined;
    const timer = setInterval(() => refresh(false, { silent: true }), 10000);
    return () => clearInterval(timer);
  }, [active, refresh]);

  useEffect(() => {
    if (selectedPhone) {
      setPhoneDraft({
        mac: selectedPhone.mac || "",
        vendor: selectedPhone.vendor || "polycom",
        model: selectedPhone.model || "",
        label: selectedPhone.label || "",
        admin_password: selectedPhone.admin_password || "",
        ip_address: selectedPhone.last_ip || selectedPhone.ip_address || "",
        local_bridge_id: selectedPhone.local_bridge_id || selectedPhone.settings?.local_bridge_id || "",
        settings: normalizePhoneSettings(selectedPhone.settings),
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
        local_bridge_id: phoneDraft.local_bridge_id.trim(),
        settings: normalizePhoneSettings({ ...phoneDraft.settings, local_bridge_id: phoneDraft.local_bridge_id.trim() }),
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

  async function rebootPhones(ids) {
    const phoneIds = ids && ids.length ? ids : selectedRebootIds;
    if (!phoneIds.length) return;
    const label = phoneIds.length === phones.length ? "all phones" : `${phoneIds.length} phone${phoneIds.length === 1 ? "" : "s"}`;
    if (!window.confirm(`Send remote reboot to ${label}?`)) return;
    setRebooting(true);
    try {
      const res = await fetch(`${API}/phones/reboot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone_ids: phoneIds }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Remote reboot failed");
      const ok = (data.results || []).filter((r) => r.ok).length;
      notify({ title: "Remote reboot requested", description: `${ok}/${data.results?.length || phoneIds.length} accepted`, variant: ok ? "success" : "warning" });
      await refresh(false);
    } catch (err) {
      notify({ title: "Remote reboot failed", description: err.message, variant: "error" });
    } finally {
      setRebooting(false);
    }
  }

  const headerCreate = active === "phones" ? { label: "New phone", onClick: () => setSelectedPhoneId(null) } : active === "bridges" ? { label: "New bridge", onClick: () => setSelectedBridgeId(null) } : null;
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
                selectedRebootIds={selectedRebootIds}
                setSelectedPhoneId={setSelectedPhoneId}
                setSelectedRebootIds={setSelectedRebootIds}
                deletePhone={deletePhone}
                togglePhoneState={togglePhoneState}
                rebootPhones={rebootPhones}
                rebooting={rebooting}
              />
            ) : active === "bridges" ? (
              <BridgesListView bridges={bridges} phones={phones} selectedBridgeId={selectedBridge?.bridge_id || null} setSelectedBridgeId={setSelectedBridgeId} />
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
                bridges={bridges}
                save={savePhone}
              />
            ) : active === "bridges" ? (
              <BridgeEditor bridges={bridges} bridge={selectedBridge} phones={phones} refresh={refresh} onSelect={setSelectedBridgeId} />
            ) : (
              <SettingsEditor bridges={bridges} refresh={refresh} />
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

function PhonesListView({ phones, selectedPhoneId, selectedRebootIds, setSelectedPhoneId, setSelectedRebootIds, deletePhone, togglePhoneState, rebootPhones, rebooting }) {
  if (!phones.length) {
    return <Empty title="No phones yet" description="Use New phone in the header, fill in the MAC and vendor in Context Settings on the right, then save. A Telnyx SIP credential is created automatically." />;
  }
  const allSelected = selectedRebootIds.length === phones.length;
  const toggleRebootSelection = (id) => setSelectedRebootIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  return (
    <div className="rounded-2xl border bg-background/85 p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Phone inventory</h3>
          <p className="text-sm text-muted-foreground">Rows select configuration in the right Context Settings panel. Use checkboxes for bulk remote reboot.</p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" disabled={rebooting || !selectedRebootIds.length} onClick={() => rebootPhones(selectedRebootIds)} data-testid="hp-bulk-reboot-selected">
            {rebooting ? <IconLoader2 className="mr-2 h-4 w-4 animate-spin" /> : <IconPower className="mr-2 h-4 w-4" />}
            Reboot selected
          </Button>
          <Button size="sm" variant="outline" disabled={rebooting || !phones.length} onClick={() => rebootPhones(phones.map((p) => p.id))} data-testid="hp-bulk-reboot-all">
            Reboot all
          </Button>
          <Badge variant="outline" className="bg-card">{phones.length} total</Badge>
        </div>
      </div>
      <div className="mt-5 overflow-hidden rounded-xl border">
        <div className="grid bg-muted/45 px-3 py-2 text-xs font-semibold text-muted-foreground" style={{ gridTemplateColumns: "36px minmax(0,1.6fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.1fr) 96px" }}>
          <span><input type="checkbox" checked={allSelected} onChange={() => setSelectedRebootIds(allSelected ? [] : phones.map((p) => p.id))} aria-label="Select all phones for reboot" /></span><span>Phone</span><span>Vendor</span><span>Model</span><span>State</span><span>Last seen</span><span className="text-right">Actions</span>
        </div>
        {phones.map((p) => {
          const selected = selectedPhoneId === p.id;
          const rebootSelected = selectedRebootIds.includes(p.id);
          return (
            <div
              key={p.id}
              onClick={() => setSelectedPhoneId(p.id)}
              className={`grid cursor-pointer items-center border-t px-3 py-2.5 text-sm transition hover:bg-muted/40 ${selected ? "bg-sky-500/10" : ""}`}
              style={{ gridTemplateColumns: "36px minmax(0,1.6fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.1fr) 96px" }}
            >
              <span onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={rebootSelected} onChange={() => toggleRebootSelection(p.id)} aria-label={`Select ${formatMacDisplay(p.mac)} for reboot`} /></span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{p.label || formatMacDisplay(p.mac)}</span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">{formatMacDisplay(p.mac)}</span>
              </span>
              <span><Badge variant="outline" className={vendorBadgeClass(p.vendor)}>{p.vendor}</Badge></span>
              <span className="truncate text-xs">{p.model || "—"}</span>
              <span><Badge variant="outline" className={stateBadgeClass(p.provisioning_state)}>{p.provisioning_state}</Badge><Badge variant="outline" className={`${registrationBadgeClass(p.sip_registration_status)} mt-1`}>Registration {p.sip_registration_status || "unknown"}</Badge></span>
              <span className="truncate text-xs text-muted-foreground">{p.last_seen_at ? formatTime(p.last_seen_at) : "never"}</span>
              <span className="flex items-center justify-end gap-1">
                <Button size="icon" variant="ghost" className="h-7 w-7" title="Remote reboot" disabled={rebooting} onClick={(e) => { e.stopPropagation(); rebootPhones([p.id]); }}>
                  <IconPower className="h-3.5 w-3.5" />
                </Button>
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

function PhoneEditor({ draft, setDraft, editing, phone, valid, saving, bridges = [], save }) {
  const update = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const updateSettings = (patch) => setDraft((d) => ({ ...d, settings: normalizePhoneSettings({ ...(d.settings || {}), ...patch }) }));
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
          <PhoneModelSettingsCard vendor={draft.vendor} model={draft.model} settings={normalizePhoneSettings(draft.settings)} updateSettings={updateSettings} />
          <LocalBridgeSelector draft={draft} update={update} bridges={bridges} />
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
            <Label>Detected phone IP address</Label>
            <Input className="mt-1 font-mono" value={editing ? (phone.last_ip || phone.ip_address || "") : "Auto-detected after first phone callback"} readOnly placeholder="Waiting for provisioning/event callback" />
            <p className="mt-1 text-xs text-muted-foreground">Phone IP address is detected automatically from provisioning callbacks and phone events; admins should not type LAN addresses manually.</p>
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
              <span className="text-xs text-muted-foreground">Telnyx registration</span>
              <Badge variant="outline" className={registrationBadgeClass(phone.sip_registration_status)}>{phone.sip_registration_status || "unknown"}</Badge>
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

function LocalBridgeSelector({ draft, update, bridges = [] }) {
  const useBridge = draft.settings?.cti_mode === "local_bridge";
  return (
    <div className="rounded-xl border bg-muted/20 p-3">
      <div className="mb-3 flex items-start gap-2">
        <IconRouteAltLeft className="mt-0.5 h-4 w-4 text-sky-600" />
        <div>
          <div className="text-sm font-medium">Local bridge ID</div>
          <p className="text-xs text-muted-foreground">Used when CTI mode is Local bridge (outbound WS). The phone stays private in LAN; CC sends commands over the bridge WebSocket.</p>
        </div>
      </div>
      <Select value={draft.local_bridge_id || "none"} onValueChange={(v) => update({ local_bridge_id: v === "none" ? "" : v })} disabled={!useBridge}>
        <SelectTrigger className="w-full"><SelectValue placeholder="Select local bridge" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="none">No bridge assigned</SelectItem>
          {bridges.map((b) => (
            <SelectItem key={b.bridge_id} value={b.bridge_id}>{b.label || b.bridge_id} · {b.online ? "online" : "offline"}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!useBridge ? <p className="mt-2 text-xs text-muted-foreground">Switch CTI mode to Local bridge (outbound WS) to activate this selector.</p> : null}
    </div>
  );
}

function PhoneModelSettingsCard({ vendor, model, settings, updateSettings }) {
  const isPoly = vendor === "polycom";
  const isAudioCodes = vendor === "audiocodes";
  const capabilityText = isPoly
    ? "Poly UCS/PVOS config supports line keys, polling/reload, firmware source, time/SNTP, admin password and REST API enablement."
    : isAudioCodes
      ? "AudioCodes 400HD config supports dynamic reload, automatic firmware updates, line keys, time/SNTP and custom config file append URLs."
      : "Yealink config supports line keys, auto-provision schedule, time/SNTP and Action URI control.";
  return (
    <div className="rounded-xl border bg-muted/20 p-3">
      <div className="mb-3">
        <div className="text-sm font-medium">Context settings view{model ? ` · ${model}` : ""}</div>
        <p className="mt-1 text-xs text-muted-foreground">{capabilityText}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>Line keys</Label>
          <Input className="mt-1" value={settings.line_keys || ""} onChange={(e) => updateSettings({ line_keys: e.target.value })} placeholder="1" />
        </div>
        <div>
          <Label>CTI mode</Label>
          <Select value={settings.cti_mode || "direct"} onValueChange={(v) => updateSettings({ cti_mode: v })}>
            <SelectTrigger className="mt-1 w-full"><SelectValue placeholder="CTI mode" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="direct">Direct phone API</SelectItem>
              <SelectItem value="local_bridge">Local bridge (outbound WS)</SelectItem>
              <SelectItem value="telnyx">Telnyx fallback</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>SNTP server</Label>
          <Input className="mt-1 font-mono" value={settings.sntp_server || ""} onChange={(e) => updateSettings({ sntp_server: e.target.value })} placeholder="pool.ntp.org" />
        </div>
        <div>
          <Label>Firmware source URL</Label>
          <Input className="mt-1 font-mono" value={settings.firmware_source || ""} onChange={(e) => updateSettings({ firmware_source: e.target.value })} placeholder="vendor-default or https://..." />
        </div>
        <div>
          <Label>Custom config URL</Label>
          <Input className="mt-1 font-mono" value={settings.custom_config_url || ""} onChange={(e) => updateSettings({ custom_config_url: e.target.value })} placeholder="https://.../extra.cfg" />
        </div>
        <div>
          <Label>Syslog server</Label>
          <Input className="mt-1 font-mono" value={settings.syslog_server || ""} onChange={(e) => updateSettings({ syslog_server: e.target.value })} placeholder="10.0.0.10" />
        </div>
      </div>
      <div className="mt-3 space-y-2 text-xs">
        <label className="flex items-center gap-2"><input type="checkbox" checked={settings.timezone_discovery !== false} onChange={(e) => updateSettings({ timezone_discovery: e.target.checked })} /> Timezone discovery from DHCP / site defaults</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={settings.dynamic_reload !== false} onChange={(e) => updateSettings({ dynamic_reload: e.target.checked })} /> Dynamic reload / periodic provisioning checks</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={settings.automatic_firmware_updates !== false} onChange={(e) => updateSettings({ automatic_firmware_updates: e.target.checked })} /> Automatic firmware updates</label>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">These values are emitted into generated provisioning files when supported by the vendor syntax; unsupported vendor/model combinations keep the values as inventory context.</p>
    </div>
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

  const ctiMode = phone?.settings?.cti_mode === "local_bridge" ? `Local bridge (${phone.local_bridge_id || phone.settings?.local_bridge_id || "unassigned"})` : phone.vendor === "audiocodes" || phone?.settings?.cti_mode === "telnyx" ? "Telnyx Call Control" : phone.vendor === "polycom" ? "Polycom REST API" : "Yealink Action URI";
  const reachableIp = phone.last_ip || phone.ip_address;

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
          {ctlBtn("reboot", "Reboot")}
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

      <SettingCard icon={IconRouteAltLeft} title="NAT and local-network CTI" subtitle="Managed hardphones without inbound firewall holes">
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>
            Direct Poly REST and Yealink Action URI need server-to-phone reachability. For phones behind customer NAT, prefer <span className="font-medium text-foreground">Telnyx Call Control fallback</span>: the phone registers outbound to Telnyx, auto-answers the CTI leg, and the Contact Center controls that Telnyx leg instead of opening inbound firewall access to the handset.
          </p>
          <p>
            For true local key-level control with NAT-ed phones, use a small LAN bridge/agent that opens an outbound WebSocket to CC and proxies local phone REST/Action URI calls. A browser plugin is possible but weaker operationally because of credentials, CORS/Private Network Access and enterprise rollout policy.
          </p>
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

function bridgeStatusBadgeClass(online) {
  return online ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-slate-400/40 bg-slate-500/10 text-slate-600 dark:text-slate-300";
}

function bridgePhoneCount(bridge, phones = []) {
  if (!bridge?.bridge_id) return 0;
  return phones.filter((p) => (p.local_bridge_id || p.settings?.local_bridge_id) === bridge.bridge_id).length;
}

function BridgesListView({ bridges = [], phones = [], selectedBridgeId, setSelectedBridgeId }) {
  if (!bridges.length) return <Empty title="No local bridges yet" description="Create a bridge enrollment from Context settings, then run the Docker bridge in the customer LAN." />;
  return (
    <div className="space-y-3">
      {bridges.map((bridge) => {
        const selected = bridge.bridge_id === selectedBridgeId;
        return (
          <button
            key={bridge.bridge_id}
            type="button"
            onClick={() => setSelectedBridgeId(bridge.bridge_id)}
            className={`w-full rounded-2xl border bg-background/80 p-4 text-left shadow-sm transition hover:border-sky-500/50 ${selected ? "border-sky-500/70 ring-2 ring-sky-500/15" : ""}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="truncate text-sm font-semibold">{bridge.label || bridge.bridge_id}</h3>
                  <Badge variant="outline" className={bridgeStatusBadgeClass(bridge.online)}>{bridge.online ? "online" : "offline"}</Badge>
                </div>
                <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{bridge.bridge_id}</p>
              </div>
              <IconRouteAltLeft className="h-5 w-5 shrink-0 text-muted-foreground" />
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <MiniStat label="Bridge status" value={bridge.online ? "online" : "offline"} icon={IconActivity} tone={bridge.online ? "emerald" : "amber"} />
              <MiniStat label="Connected phones" value={bridgePhoneCount(bridge, phones)} icon={IconDeviceLandlinePhone} tone="blue" />
              <MiniStat label="Last seen" value={formatTime(bridge.last_seen_at)} icon={IconClockHour4} tone="violet" />
            </div>
          </button>
        );
      })}
    </div>
  );
}

function CopyButton({ value, label = "Copy" }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(value || "");
      notify({ title: "Copied", description: label, variant: "success" });
    } catch (err) {
      notify({ title: "Copy failed", description: err.message, variant: "error" });
    }
  }
  return (
    <Button type="button" size="sm" variant="outline" onClick={copy} disabled={!value}>
      <IconCopy className="mr-2 h-4 w-4" />
      {label}
    </Button>
  );
}

function BridgeEditor({ bridges = [], bridge, phones = [], refresh, onSelect }) {
  const [label, setLabel] = useState("Local office bridge");
  const [site, setSite] = useState("");
  const [creating, setCreating] = useState(false);
  const [enrollment, setEnrollment] = useState(null);
  const assignedPhones = bridge ? phones.filter((p) => (p.local_bridge_id || p.settings?.local_bridge_id) === bridge.bridge_id) : [];

  async function createBridge() {
    setCreating(true);
    try {
      const res = await fetch(`${API}/bridges`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, site }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Bridge enrollment failed");
      setEnrollment(data.enrollment || null);
      if (data.bridge?.bridge_id) onSelect?.(data.bridge.bridge_id);
      notify({ title: "Local bridge enrolled", description: data.bridge?.bridge_id, variant: "success" });
      await refresh?.(false);
    } catch (err) {
      notify({ title: "Bridge enrollment failed", description: err.message, variant: "error" });
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-4">
      <SettingCard icon={IconRouteAltLeft} title="Bridge configuration" subtitle="Create an outbound WebSocket bridge enrollment for a LAN site">
        <div className="space-y-3">
          <div>
            <Label>Bridge label</Label>
            <Input className="mt-1" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Warsaw office bridge" />
          </div>
          <div>
            <Label>Site / location</Label>
            <Input className="mt-1" value={site} onChange={(e) => setSite(e.target.value)} placeholder="Warsaw LAN" />
          </div>
          <Button size="sm" className={neutralActionClass} onClick={createBridge} disabled={creating} data-testid="hp-create-local-bridge">
            {creating ? <IconLoader2 className="mr-2 h-4 w-4 animate-spin" /> : <IconRouteAltLeft className="mr-2 h-4 w-4" />}
            Create bridge enrollment
          </Button>
          {enrollment ? (
            <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 p-3 text-xs">
              <div className="flex items-start justify-between gap-2">
                <div className="font-semibold text-amber-800 dark:text-amber-200">Copy this token now — it is shown only once.</div>
                <CopyButton value={enrollment.env || `BRIDGE_ID=${enrollment.bridge_id}\nBRIDGE_TOKEN=${enrollment.token}\nCC_WS_URL=${enrollment.cc_ws_url}`} label="Copy .env" />
              </div>
              <pre className="mt-2 max-w-full whitespace-pre-wrap break-all rounded-md border bg-background/70 p-2 font-mono text-[11px] leading-relaxed text-foreground">{enrollment.env || `BRIDGE_ID=${enrollment.bridge_id}\nBRIDGE_TOKEN=${enrollment.token}\nCC_WS_URL=${enrollment.cc_ws_url}`}</pre>
            </div>
          ) : null}
        </div>
      </SettingCard>

      <SettingCard icon={IconActivity} title="Bridge status" subtitle="Live relay presence and phones assigned to this bridge">
        {bridge ? (
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2">
              <span className="min-w-0 font-mono text-xs">{bridge.bridge_id}</span>
              <Badge variant="outline" className={bridgeStatusBadgeClass(bridge.online)}>{bridge.online ? "online" : "offline"}</Badge>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <MiniStat label="Connected phones" value={assignedPhones.length} icon={IconDeviceLandlinePhone} tone="blue" />
              <MiniStat label="Last seen" value={formatTime(bridge.last_seen_at)} icon={IconClockHour4} tone="violet" />
            </div>
            {assignedPhones.length ? (
              <div className="space-y-1.5">
                {assignedPhones.map((phone) => <div key={phone.id} className="truncate rounded-lg border bg-background/70 px-3 py-2 text-xs">{phone.label || formatMacDisplay(phone.mac)} · {phone.last_ip || phone.ip_address || "no IP"}</div>)}
              </div>
            ) : <p className="text-xs text-muted-foreground">No phones are assigned to this bridge yet.</p>}
          </div>
        ) : <p className="text-sm text-muted-foreground">Create or select a bridge to see its live status.</p>}
      </SettingCard>
    </div>
  );
}

function SettingsEditor() {
  return (
    <div className="space-y-4">
      <SettingCard icon={IconSettings} title="Provisioning defaults" subtitle="Phase 1 serves Telnyx defaults">
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>Config files are generated with <span className="font-mono text-foreground">sip.telnyx.com</span>, UDP transport and hourly re-provisioning polling.</p>
          <p>Per-phone IP override controls direct Poly REST / Yealink Action URI. For phones behind NAT, use <span className="font-mono text-foreground">settings.cti_mode = &quot;local_bridge&quot;</span> and assign a Local bridge ID for full CTI, or <span className="font-mono text-foreground">settings.cti_mode = &quot;telnyx&quot;</span> for Call Control fallback.</p>
        </div>
      </SettingCard>
    </div>
  );
}
