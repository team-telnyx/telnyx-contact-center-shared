export const EPOS_DEVICE_CATALOG = [
  {
    id: "epos-btd-800-usb",
    vendor: "epos",
    vendorLabel: "EPOS",
    name: "BTD 800 USB for Lync",
    aliases: ["btd 800", "btd800", "btd 800 usb", "btd 800 usb for lync", "1000227"],
    role: "dongle",
    image: "/images/headsets/epos/btd-800-usb.png",
    status: "Detected by EPOS Connect as the Bluetooth USB dongle",
    capabilities: ["Bluetooth link", "EPOS Connect bridge", "Call-control transport"],
  },
  {
    id: "epos-mb-pro-2",
    vendor: "epos",
    vendorLabel: "EPOS",
    name: "MB Pro 2",
    aliases: ["mb pro 2", "mbpro2", "mb pro", "mobile business pro 2"],
    role: "headset",
    image: "/images/headsets/epos/mb-pro-2.png",
    status: "Wireless stereo headset paired through BTD 800",
    capabilities: ["Answer / hang up", "Mute", "Battery", "Call audio"],
  },
];

const normalize = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function findHeadsetCatalogEntry(device = {}) {
  const safeDevice = device || {};
  const haystack = normalize([
    safeDevice.model,
    safeDevice.productName,
    safeDevice.productId,
    safeDevice.serialNumber,
    safeDevice.id,
    safeDevice.vendorLabel,
  ].filter(Boolean).join(" "));

  if (!haystack) return null;
  return EPOS_DEVICE_CATALOG.find((entry) =>
    entry.aliases.some((alias) => haystack.includes(normalize(alias)))
  ) || null;
}

export function getDeviceCatalogForVendor(vendor) {
  if (vendor === "epos") return EPOS_DEVICE_CATALOG;
  return [];
}
