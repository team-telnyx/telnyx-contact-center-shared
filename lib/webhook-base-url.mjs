const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Resolve the public base URL used for webhook registration.
 *
 * Server-only configuration takes precedence over public/auth fallbacks. In
 * production, fail closed instead of registering an unusable placeholder URL
 * with an external provider.
 */
export function resolveWebhookBaseUrl({
  env = process.env,
  requestUrl = null,
} = {}) {
  const candidates = [
    env.TELNYX_WEBHOOK_BASE_URL,
    env.APP_BASE_URL,
    env.NEXT_PUBLIC_BASE_URL,
    env.NEXTAUTH_URL,
  ];

  const configuredUrl = candidates.find(
    (candidate) => typeof candidate === "string" && candidate.trim(),
  );

  if (configuredUrl) {
    const normalizedUrl = configuredUrl.trim().replace(/\/+$/, "");
    let parsedUrl;
    try {
      parsedUrl = new URL(normalizedUrl);
    } catch {
      throw new Error("Configured webhook base URL is not a valid URL");
    }

    if (!HTTP_PROTOCOLS.has(parsedUrl.protocol)) {
      throw new Error("Configured webhook base URL must use HTTP or HTTPS");
    }

    return normalizedUrl;
  }

  if (env.NODE_ENV === "development") {
    try {
      return requestUrl ? new URL(requestUrl).origin : "http://localhost:3000";
    } catch {
      return "http://localhost:3000";
    }
  }

  throw new Error(
    "Webhook base URL is not configured. Set APP_BASE_URL or TELNYX_WEBHOOK_BASE_URL.",
  );
}
