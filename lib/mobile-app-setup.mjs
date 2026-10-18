import QRCode from "qrcode";

export const MOBILE_SETUP_QR_FILENAME = "mobile-setup-qr.png";
export const MOBILE_SETUP_QR_OPTIONS = Object.freeze({
  errorCorrectionLevel: "M",
  margin: 4,
  width: 400,
  color: { dark: "#000000", light: "#ffffff" },
});

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

export function resolveMobileAppBaseUrl(env = process.env) {
  const configured = [
    env.APP_BASE_URL,
    env.NEXT_PUBLIC_BASE_URL,
    env.NEXTAUTH_URL,
  ].find((value) => typeof value === "string" && value.trim());

  if (!configured) {
    if (env.NODE_ENV === "development" || env.NODE_ENV === "test") {
      return "http://localhost:3000";
    }
    throw new Error("Public application URL is not configured. Set APP_BASE_URL.");
  }

  let parsed;
  try {
    parsed = new URL(configured.trim());
  } catch {
    throw new Error("Configured public application URL is invalid.");
  }
  if (!HTTP_PROTOCOLS.has(parsed.protocol)) {
    throw new Error("Configured public application URL must use HTTP or HTTPS.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Configured public application URL cannot contain credentials, a query, or a fragment.");
  }
  if (parsed.pathname && parsed.pathname !== "/") {
    throw new Error("The mobile app does not support Contact Center path prefixes.");
  }

  return parsed.origin;
}

export function buildMobileAppSetup({
  baseUrl,
  organizationName,
  installUrl,
} = {}) {
  const publicBaseUrl = resolveMobileAppBaseUrl({
    APP_BASE_URL: baseUrl,
    NODE_ENV: "production",
  });
  const parsed = new URL(publicBaseUrl);
  const address = parsed.protocol === "http:"
    ? `http://${parsed.host.toLowerCase()}`
    : parsed.host.toLowerCase();
  const name = typeof organizationName === "string" && organizationName.trim()
    ? organizationName.trim()
    : "Telnyx Contact Center";
  const setupLink = `novumcx-telnyx://setup?host=${address}&name=${encodeURIComponent(name)}`;

  let normalizedInstallUrl = null;
  if (typeof installUrl === "string" && installUrl.trim()) {
    try {
      const parsedInstallUrl = new URL(installUrl.trim());
      if (HTTP_PROTOCOLS.has(parsedInstallUrl.protocol)) normalizedInstallUrl = parsedInstallUrl.toString();
    } catch {
      normalizedInstallUrl = null;
    }
  }

  return {
    publicBaseUrl,
    organizationName: name,
    address,
    setupLink,
    installUrl: normalizedInstallUrl,
  };
}

export function mobileAppSetupFromEnvironment({
  env = process.env,
  organizationName,
} = {}) {
  return buildMobileAppSetup({
    baseUrl: resolveMobileAppBaseUrl(env),
    organizationName,
    installUrl: env.MOBILE_APP_INSTALL_URL,
  });
}

export function createMobileSetupQrDataUrl(setupLink) {
  return QRCode.toDataURL(setupLink, MOBILE_SETUP_QR_OPTIONS);
}

export function createMobileSetupQrPng(setupLink) {
  return QRCode.toBuffer(setupLink, {
    ...MOBILE_SETUP_QR_OPTIONS,
    type: "png",
  });
}
