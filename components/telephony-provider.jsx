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
import { TelnyxRTC, TELNYX_ERROR_CODES } from "@telnyx/webrtc";
import useActiveCallStore from "@/lib/stores/active-call-store";
import { createCallRecovery } from "@/lib/telephony/call-recovery.mjs";
import { notify } from "@/components/ToastNotify";
import { useAuth } from "@/components/auth-provider";

// Grants that come with a WebRTC softphone: agent work, or call supervision
// (RBAC Phase 5). Users without them get no token and no heartbeat.
const VOICE_PERMISSIONS = ["agent:self", "calls:supervise.listen", "calls:supervise.whisper", "calls:supervise.barge"];

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

const readWebrtcBooleanFlag = (storageKey, envValue = "false") => {
  const normalize = (value) =>
    ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());

  if (typeof window !== "undefined") {
    try {
      const storedValue = localStorage.getItem(storageKey);
      if (storedValue !== null) {
        return normalize(storedValue);
      }
    } catch (_) {}
  }

  return normalize(envValue);
};

const getWebrtcExperimentalOptions = () => ({
  prefetchIceCandidates: readWebrtcBooleanFlag(
    "webrtc.prefetchIceCandidates",
    process.env.NEXT_PUBLIC_TELNYX_WEBRTC_PREFETCH_ICE_CANDIDATES
  ),
});

const TelephonyContext = createContext({
  client: null,
  status: "disconnected",
  error: "",
  recovery: { state: "idle" },
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
  const { loaded: authLoaded, can } = useAuth();
  const voiceAllowed = authLoaded && can(VOICE_PERMISSIONS);
  const agentHeartbeat = authLoaded && can("agent:self");
  const voiceAllowedRef = useRef(false);
  useEffect(() => {
    voiceAllowedRef.current = voiceAllowed;
  }, [voiceAllowed]);
  const clientRef = useRef(null);
  const recoveryRef = useRef(null);
  const [recovery, setRecovery] = useState({ state: "idle" });
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
    // The value only keys the cached WebRTC token, so that a token minted
    // against one deployment is never reused against another. The origin is
    // both the most precise discriminator and the only one that works for
    // every installation: the previous version matched a fixed set of demo
    // hostnames by substring, so any other deployment reported "unknown" for
    // dev, staging and production alike and the cache could not tell them
    // apart.
    if (typeof window === "undefined") return "unknown";
    return window.location.origin;
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

  const acdSessionId = useRef(null);
  useEffect(() => {
    // The ACD session heartbeat belongs to agent work only.
    if (!agentHeartbeat) return undefined;
    acdSessionId.current ||= crypto.randomUUID();
    const publish = (offline = false) => fetch("/api/contact-center/agent/session", {
      method: "PUT", headers: { "Content-Type": "application/json" }, keepalive: offline,
      body: JSON.stringify({ sessionId: acdSessionId.current, voiceReady: status === "connected", offline }),
    }).catch(() => {});
    publish();
    const timer = setInterval(() => publish(), 15000);
    const leave = () => publish(true);
    window.addEventListener("pagehide", leave);
    return () => { clearInterval(timer); window.removeEventListener("pagehide", leave); };
  }, [status, agentHeartbeat]);

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
      recoveryRef.current?.stop();
      recoveryRef.current = null;
      setRecovery({ state: "idle" });
      clientRef.current = null;
      client.clearReconnectToken?.();
      Promise.resolve(client.disconnect?.()).catch(() => {});
    } catch (_) {}
    clientRef.current = null;
    setClient(null); // Clear client from state
  }, []);

  const scheduleReconnect = useCallback((immediate = false) => {
    if (statusRef.current === "connected" || connectingRef.current) return;
    // The SDK owns transient socket recovery. Replacing it loses active calls
    // and races its session reattachment and exponential backoff.
    if (clientRef.current) return;
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
    // No softphone for roles without agent work or supervision grants; the
    // permission answer arrives asynchronously, so connect() is re-armed when it does.
    if (!voiceAllowedRef.current) {
      setStatus("disconnected");
      return;
    }
    connectingRef.current = true;
    setError("");
    setStatus("connecting");
    try {
      const profileResponse = await fetch("/api/user/profile", {cache:"no-store"});
      const profile = await profileResponse.json().catch(()=>({}));
      if (profileResponse.ok && profile.data?.voice_enabled === false) {
        clearTokenCache();
        setStatus("disconnected");
        return;
      }
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

        // 403 means the roles do not include voice: stop here, never sign out.
        if (resp.status === 403) {
          const error = new Error("Voice is not enabled for your roles.");
          error.code = "VOICE_NOT_PERMITTED";
          throw error;
        }
        // If auth error, try refreshing the session token first
        if (resp.status === 401) {
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
          // Check if session expired (401); 403 is a permission answer
          if (resp.status === 403) {
            const error = new Error("Voice is not enabled for your roles.");
            error.code = "VOICE_NOT_PERMITTED";
            throw error;
          }
          if (resp.status === 401) {
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
      const experimentalOptions = getWebrtcExperimentalOptions();
      console.log("[webrtc] Connecting", {
        region: selectedRegion,
        prefetchIceCandidates: experimentalOptions.prefetchIceCandidates,
      });
      const client = new TelnyxRTC({
        login_token: token,
        keepConnectionAliveOnSocketClose: true,
        maxReconnectAttempts: 10,
        ...(selectedRegion !== "auto" && { region: selectedRegion }),
        ...(experimentalOptions.prefetchIceCandidates && {
          prefetchIceCandidates: true,
        }),
        ringbackFile: "/audio/ringback.mp3",
        ringtoneFile: "/audio/ringtone.mp3",
      });

      client.on("telnyx.ready", () => {
        if (clientRef.current !== client) return;
        statusRef.current = "connected";
        setStatus("connected");
        setError("");
        retryAttemptRef.current = 0;
        setClient(client); // Update state so context consumers get the client
      });
      client.on("telnyx.socket.close", () => {
        if (clientRef.current !== client) return;
        statusRef.current = "disconnected";
        setStatus("disconnected");
        // Keep subscribers attached to this client for SDK recovery events.
      });
      client.on("telnyx.error", (e) => {
        if (clientRef.current !== client) return;
        const sdkError = e?.error || e;
        const msg = (sdkError?.message || "").toLowerCase();
        if (Number(sdkError?.code) === TELNYX_ERROR_CODES.RECONNECTION_EXHAUSTED) {
          // The SDK exhausted its bounded retries and terminated local calls.
          cleanupClient();
          statusRef.current = "disconnected";
          setStatus("disconnected");
          setError(sdkError?.message || "Reconnection exhausted");
          scheduleReconnect(false);
          return;
        }
        // Tolerate benign BYE failures triggered after remote hangup
        if (msg.includes("bye failed")) {
          // Keep connection intact; do not surface as an error
          return;
        }
        // For auth errors, force token refresh on next reconnect
        if ([TELNYX_ERROR_CODES.LOGIN_FAILED, TELNYX_ERROR_CODES.INVALID_CREDENTIALS, TELNYX_ERROR_CODES.AUTHENTICATION_REQUIRED].includes(Number(sdkError?.code)) || /401|403|unauth|token/.test(msg)) {
          try {
            localStorage.removeItem("webrtc.token.cache");
          } catch (_) {}
          cleanupClient();
          tokenRef.current = null;
          statusRef.current = "disconnected";
          setStatus("disconnected");
          setError(sdkError?.message || "Auth error");
          scheduleReconnect(true);
          return;
        }
        // Otherwise, keep session and just surface the error
        setError(sdkError?.message || "Client error");
      });

      clientRef.current = client;
      recoveryRef.current = createCallRecovery({
        client,
        getCall: () => useActiveCallStore.getState().call,
        isHeld: () => Boolean(useActiveCallStore.getState().ui?.isHeld),
        isMuted: () => Boolean(useActiveCallStore.getState().ui?.isMuted),
        onChange: (value) => { if (clientRef.current === client) setRecovery(value); },
        onDiagnostic: (detail) => {
          // Whitelisted metadata only: no tokens, SDP, URLs or SDK payloads.
          window.dispatchEvent(new CustomEvent("cc:voice-recovery", { detail }));
        },
      });
      client.connect?.();
    } catch (err) {
      setStatus("disconnected");
      setError(err?.message || "Failed to connect");

      if (err.code === "VOICE_NOT_PERMITTED") {
        // Not an outage: the user's roles carry no voice grant. No retry, no sign-out.
        clearTokenCache();
        connectingRef.current = false;
        return;
      }

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
  }, [cleanupClient, scheduleReconnect]);


  const setRegion = useCallback(
    (nextRegion) => {
      const normalized = normalizeWebrtcRegion(nextRegion);
      if (regionRef.current === normalized) return;

      regionRef.current = normalized;
      try {
        localStorage.setItem("webrtc.region", normalized);
      } catch (_) {}

      setRegionState(normalized);
      cleanupClient();
      statusRef.current = "disconnected";
      setStatus("disconnected");
      setError("");
      retryAttemptRef.current = 0;
      scheduleReconnect(true);
    },
    [cleanupClient, scheduleReconnect]
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

  // Connect once the permission answer admits voice (also covers roles changed at runtime).
  useEffect(() => {
    if (voiceAllowed) scheduleReconnect(true);
  }, [voiceAllowed, scheduleReconnect]);

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
      recovery,
      reconnect: () => scheduleReconnect(true),
      clearCache: () => {
        clearTokenCache();
        scheduleReconnect(true);
      },
      region,
      setRegion,
      regions: WEBRTC_REGIONS,
    }),
    [client, status, error, recovery, region, setRegion, scheduleReconnect]
  );

  return (
    <TelephonyContext.Provider value={value}>
      {children}
    </TelephonyContext.Provider>
  );
}
