export const PREVIEW_DEVICES = Object.freeze([
  {
    id: "desktop-responsive",
    name: "Desktop",
    detail: "Responsive browser",
    type: "desktop",
    platform: "desktop",
    width: 1440,
    height: 900,
    dpr: 1,
    frame: "browser",
    orientations: ["landscape"],
  },
  {
    id: "iphone-16-pro",
    name: "iPhone 16 Pro",
    detail: "iOS · Dynamic Island",
    type: "phone",
    platform: "ios",
    width: 402,
    height: 874,
    dpr: 3,
    frame: "iphone-island",
    orientations: ["portrait", "landscape"],
  },
  {
    id: "iphone-se",
    name: "iPhone SE",
    detail: "iOS · compact",
    type: "phone",
    platform: "ios",
    width: 375,
    height: 667,
    dpr: 2,
    frame: "iphone-home",
    orientations: ["portrait", "landscape"],
  },
  {
    id: "pixel-9-pro",
    name: "Google Pixel 9 Pro",
    detail: "Android · punch-hole",
    type: "phone",
    platform: "android",
    width: 412,
    height: 915,
    dpr: 2.625,
    frame: "android-punch",
    orientations: ["portrait", "landscape"],
  },
  {
    id: "galaxy-s24",
    name: "Samsung Galaxy S24",
    detail: "Android · compact",
    type: "phone",
    platform: "android",
    width: 360,
    height: 780,
    dpr: 3,
    frame: "android-punch",
    orientations: ["portrait", "landscape"],
  },
  {
    id: "ipad-air-11",
    name: "iPad Air 11\"",
    detail: "iPadOS · tablet",
    type: "tablet",
    platform: "ios",
    width: 820,
    height: 1180,
    dpr: 2,
    frame: "tablet",
    orientations: ["portrait", "landscape"],
  },
  {
    id: "galaxy-tab-s9",
    name: "Samsung Galaxy Tab S9",
    detail: "Android · tablet",
    type: "tablet",
    platform: "android",
    width: 800,
    height: 1280,
    dpr: 2,
    frame: "tablet",
    orientations: ["portrait", "landscape"],
  },
]);

export const DEFAULT_PREVIEW_DEVICE_ID = "desktop-responsive";
export const DEFAULT_PREVIEW_ORIENTATION = "landscape";

export const DEFAULT_PREVIEW_BACKGROUND = Object.freeze({
  backgroundMode: "schematic",
  backgroundImageUrl: "",
  backgroundFit: "cover",
  backgroundPosition: "top",
  overlayPercent: 0,
});

export function getPreviewDevice(deviceId) {
  return PREVIEW_DEVICES.find((device) => device.id === deviceId) || PREVIEW_DEVICES[0];
}

export function normalizePreviewOrientation(device, orientation) {
  return device.orientations.includes(orientation) ? orientation : device.orientations[0];
}

export function previewViewport(device, orientation) {
  const normalized = normalizePreviewOrientation(device, orientation);
  return normalized === "landscape" && device.type !== "desktop"
    ? { width: device.height, height: device.width, orientation: normalized }
    : { width: device.width, height: device.height, orientation: normalized };
}

export function previewVariantKey(deviceId, orientation) {
  const device = getPreviewDevice(deviceId);
  const normalized = normalizePreviewOrientation(device, orientation);
  return `${device.id}__${normalized}`;
}

export function previewBackground(config, deviceId, orientation) {
  const key = previewVariantKey(deviceId, orientation);
  return {
    ...DEFAULT_PREVIEW_BACKGROUND,
    ...(config?.preview?.backgrounds?.[key] || {}),
  };
}
