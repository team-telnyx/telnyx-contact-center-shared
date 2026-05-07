"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { TelnyxRTC } from "@telnyx/webrtc";
import { notify } from "@/components/ToastNotify";

const WEBRTC_REGIONS = [
  { value: "auto", label: "AUTO" },
  { value: "eu", label: "EU" },
  { value: "us-central", label: "US-CENTRAL" },
  { value: "us-east", label: "US-EAST" },
  { value: "us-west", label: "US-WEST" },
  { value: "ca-central", label: "CA-CENTRAL" },
  { value: "apac", label: "APAC" },
];

const normalizeWebrtcRegion = (value) => {
  const normalized = String(value || "auto").toLowerCase();
  return WEBRTC_REGIONS.some((region) => region.value === normalized)
    ? normalized
    : "auto";
};

const DEFAULT_WEBRTC_REGION = normalizeWebrtcRegion(
  process.env.NEXT_PUBLIC_TELNYX_WEBRTC_REGION || "auto"
);

const TelephonyContext = createContext({
  client: null,
  status: "disconnected",
  error: "",
  reconnect: () => {},
  clearCache: () => {},
  region: "auto",
  setRegion: () => {},
  regions: WEBRTC_REGIONS,
});

export function useTelnyx() {
  return useContext(TelephonyContext);
}

export function TelephonyProvider({ children }) {
  const clientRef = useRef(null);
  const connectingRef = useRef(false);
  const reconnectTimerRef = useRef(null);
  const retryAttemptRef = useRef(0);
  const statusRef = useRef("disconnected");
  const tokenRef = useRef(null);
  const tokenFetchedAtRef = useRef(0);
  const SKEW_MS = 60 * 1000; // refresh 1 minute early
  const CACHE_VERSION = "v2"; // Increment this to invalidate all cached tokens

  // Suppress Performance API errors from Telnyx WebRTC SDK
  // The SDK sometimes tries to measure performance before marks are created
  useEffect(() => {
    if (typeof window === "undefined" || !window.performance) return;

    const originalMeasure = performance.measure.bind(performance);

    // Wrap performance.measure to catch errors when marks don't exist
    performance.measure = function (name, startMark, endMark) {
      try {
        return originalMeasure(name, startMark, endMark);
      } catch (err) {
        // Silently ignore errors about missing marks (common in WebRTC SDK)
        // This happens when the SDK tries to measure before the mark is created
        if (
          err?.name === "SyntaxError" &&
          (err?.message?.includes("does not exist") ||
            err?.message?.includes("mark"))
        ) {
          console.debug(
            `[Performance] Suppressed missing mark error: ${name}`,
            startMark,
            endMark
          );
          return undefined;
        }
        throw err;
      }
    };

    return () => {
      // Restore original function on cleanup
      performance.measure = originalMeasure;
    };
  }, []);

  function decodeJwtExpMs(jwt) {
    try {
      const parts = String(jwt).split(".");
      if (parts.length < 2) return 0;
      const payloadStr = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
      const payload = JSON.parse(payloadStr || "{}");
      if (!payload?.exp) return 0;
      return Number(payload.exp) * 1000;
    } catch (_) {
      return 0;
    }
  }

  function getCurrentEnvironment() {
    // Detect current environment based on URL
    if (typeof window === "undefined") return "unknown";
    const hostname = window.location.hostname;
    if (hostname.includes("tunnel.demotelnyx.com")) return "dev";
    if (hostname.includes("dev.demotelnyx.com")) return "staging";
    if (
      hostname.includes("www.demotelnyx.com") ||
      hostname.includes("demotelnyx.com")
    )
      return "production";
    return "unknown";
  }

  function shouldForceTokenRefresh() {
    // Force refresh on page load (sessionStorage check)
    const lastRefresh = sessionStorage.getItem("webrtc.lastTokenRefresh");
    const now = Date.now();
    const REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes

    if (!lastRefresh || now - parseInt(lastRefresh) > REFRESH_INTERVAL) {
      sessionStorage.setItem("webrtc.lastTokenRefresh", now.toString());
      return true;
    }
    return false;
  }

  function clearTokenCache() {
    try {
      localStorage.removeItem("webrtc.token.cache");
    } catch (_) {}
  }

  const [status, setStatus] = useState("disconnected");
  const [error, setError] = useState("");
  const [client, setClient] = useState(null);
  const [region, setRegionState] = useState(DEFAULT_WEBRTC_REGION);
  const regionRef = useRef(DEFAULT_WEBRTC_REGION);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const cleanupClient = useCallback(() => {
    try {
      const client = clientRef.current;
      if (!client) return;
      client.disconnect?.();
    } catch (_) {}
    clientRef.current = null;
    setClient(null); // Clear client from state
  }, []);

  const scheduleReconnect = useCallback((immediate = false) => {
    if (statusRef.current === "connected" || connectingRef.current) return;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const attempt = retryAttemptRef.current || 0;
    const delay = immediate ? 0 : Math.min(1000 * Math.pow(2, attempt), 30000);
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      if (statusRef.current !== "connected" && !connectingRef.current) {
        connect();
      }
    }, delay);
  }, []);

  const connect = useCallback(async () => {
    if (statusRef.current === "connected" || connectingRef.current) return;
    connectingRef.current = true;
    setError("");
    setStatus("connecting");
    try {
      let token = null;
      const currentEnv = getCurrentEnvironment();
      const forceRefresh = shouldForceTokenRefresh();

      try {
        const cached = JSON.parse(
          localStorage.getItem("webrtc.token.cache") || "null"
        );

        // Check if cached token is valid and from the same environment
        if (
          cached &&
          cached.token &&
          cached.expMs &&
          cached.env === currentEnv &&
          cached.version === CACHE_VERSION
        ) {
          const now = Date.now();
          if (!forceRefresh && now + SKEW_MS < Number(cached.expMs)) {
            token = String(cached.token);
            tokenRef.current = token;
            tokenFetchedAtRef.current = Number(cached.ts || now);
          }
        }
      } catch (_) {
        // Cache parse error, fetching fresh token
      }

      if (!token) {
        // Try to refresh access token if we get a 401/403
        let resp = await fetch("/api/voice/token", {
          method: "POST",
          credentials: "include",
          cache: "no-store",
        });

        // If auth error, try refreshing the session token first
        if (resp.status === 401 || resp.status === 403) {
          try {
            const refreshResp = await fetch("/api/auth/refresh", {
              method: "POST",
              credentials: "include",
              cache: "no-store",
            });
            if (refreshResp.ok) {
              // Retry voice token request after refresh
              resp = await fetch("/api/voice/token", {
                method: "POST",
                credentials: "include",
                cache: "no-store",
              });
            } else {
              // Refresh failed, user needs to re-authenticate
              const error = new Error("Session expired. Please sign in again.");
              error.code = "SESSION_EXPIRED";
              throw error;
            }
          } catch (refreshErr) {
            if (refreshErr.code === "SESSION_EXPIRED") {
              throw refreshErr;
            }
            // If refresh fails, continue with original error
          }
        }

        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          // Check if it's a missing environment variable error
          if (data.code === "MISSING_SIP_CONNECTION_ID") {
            const error = new Error(
              "Configuration Error: TELNYX_SIP_CONNECTION_ID environment variable is not configured"
            );
            error.code = "MISSING_SIP_CONNECTION_ID";
            throw error;
          }
          // Check if session expired
          if (resp.status === 401 || resp.status === 403) {
            const error = new Error("Session expired. Please sign in again.");
            error.code = "SESSION_EXPIRED";
            throw error;
          }
          throw new Error(data?.error || "Failed to obtain token");
        }
        token = data?.token;
        if (!token) throw new Error("Missing token");
        tokenRef.current = token;
        tokenFetchedAtRef.current = Date.now();
        const expMs =
          decodeJwtExpMs(token) || tokenFetchedAtRef.current + 15 * 60 * 1000; // fallback 15m

        // Store token with environment and version info
        try {
          localStorage.setItem(
            "webrtc.token.cache",
            JSON.stringify({
              token,
              ts: tokenFetchedAtRef.current,
              expMs,
              env: currentEnv,
              version: CACHE_VERSION,
            })
          );
        } catch (_) {}
      }

      cleanupClient();
      const selectedRegion = normalizeWebrtcRegion(regionRef.current || region);
      console.log("[webrtc] Connecting with region:", selectedRegion);
      const client = new TelnyxRTC({
        login_token: token,
        ...(selectedRegion !== "auto" && { region: selectedRegion }),
        ringbackFile: "/audio/ringback.mp3",
        ringtoneFile: "/audio/ringtone.mp3",
      });

      client.on("telnyx.ready", () => {
        setStatus("connected");
        setError("");
        retryAttemptRef.current = 0;
        setClient(client); // Update state so context consumers get the client
      });
      client.on("telnyx.socket.close", () => {
        setStatus("disconnected");
        setClient(null); // Clear client from state
        scheduleReconnect(false);
      });
      client.on("telnyx.error", (e) => {
        const msg = (e?.message || "").toLowerCase();
        // Tolerate benign BYE failures triggered after remote hangup
        if (msg.includes("bye failed")) {
          // Keep connection intact; do not surface as an error
          return;
        }
        // For auth errors, force token refresh on next reconnect
        if (/401|403|unauth|token/.test(msg)) {
          try {
            localStorage.removeItem("webrtc.token.cache");
          } catch (_) {}
          setStatus("disconnected");
          setClient(null); // Clear client from state
          setError(e?.message || "Auth error");
          scheduleReconnect(true);
          return;
        }
        // Otherwise, keep session and just surface the error
        setError(e?.message || "Client error");
      });

      clientRef.current = client;
      client.connect?.();
    } catch (err) {
      setStatus("disconnected");
      setError(err?.message || "Failed to connect");

      // Show notification for missing environment variables
      if (err.code === "MISSING_SIP_CONNECTION_ID") {
        notify({
          title: "Configuration Error",
          description:
            "TELNYX_SIP_CONNECTION_ID environment variable is not configured. Please contact your administrator to set up the required Telnyx connection ID.",
          variant: "error",
          autoCloseMs: 10000,
        });
      } else if (err.code === "SESSION_EXPIRED") {
        // Session expired - redirect to signin
        clearTokenCache();
        notify({
          title: "Session Expired",
          description: "Your session has expired. Please sign in again.",
          variant: "error",
          autoCloseMs: 5000,
        });
        // Redirect to signin after a short delay
        setTimeout(() => {
          window.location.href = "/signin";
        }, 2000);
      } else if (
        err.message?.includes("token") ||
        err.message?.includes("credential")
      ) {
        // Clear cache on token/credential errors to force fresh token
        clearTokenCache();
        notify({
          title: "Authentication Error",
          description:
            "Token authentication failed. Cache cleared, please try again.",
          variant: "error",
          autoCloseMs: 5000,
        });
      }

      retryAttemptRef.current = Math.min(
        (retryAttemptRef.current || 0) + 1,
        10
      );
      scheduleReconnect(false);
    } finally {
      connectingRef.current = false;
    }
  }, [cleanupClient, region, scheduleReconnect]);


  const setRegion = useCallback(
    (nextRegion) => {
      const normalized = normalizeWebrtcRegion(nextRegion);
      regionRef.current = normalized;
      setRegionState((currentRegion) => {
        if (currentRegion === normalized) return currentRegion;
        try {
          localStorage.setItem("webrtc.region", normalized);
        } catch (_) {}
        cleanupClient();
        statusRef.current = "disconnected";
        setStatus("disconnected");
        setError("");
        retryAttemptRef.current = 0;
        return normalized;
      });
    },
    [cleanupClient]
  );

  useEffect(() => {
    try {
      const storedRegion = normalizeWebrtcRegion(
        localStorage.getItem("webrtc.region") || DEFAULT_WEBRTC_REGION
      );
      regionRef.current = storedRegion;
      if (storedRegion !== region) {
        setRegionState(storedRegion);
      }
    } catch (_) {}
    // Run once on mount; subsequent changes go through setRegion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    connect();
    const onOnline = () => {
      if (statusRef.current !== "connected") scheduleReconnect(true);
    };
    const onVisible = () => {
      if (
        document.visibilityState === "visible" &&
        statusRef.current !== "connected"
      )
        scheduleReconnect(true);
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      try {
        cleanupClient();
      } catch (_) {}
    };
  }, [connect, cleanupClient, scheduleReconnect]);

  const value = useMemo(
    () => ({
      client: client,
      status,
      error,
      reconnect: () => scheduleReconnect(true),
      clearCache: () => {
        clearTokenCache();
        scheduleReconnect(true);
      },
      region,
      setRegion,
      regions: WEBRTC_REGIONS,
    }),
    [client, status, error, region, setRegion, scheduleReconnect]
  );

  return (
    <TelephonyContext.Provider value={value}>
      {children}
    </TelephonyContext.Provider>
  );
}
