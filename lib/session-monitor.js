"use client";

/**
 * Monitors user session and sets status to offline when session is lost
 */
export function setupSessionMonitor() {
  if (typeof window === "undefined") return () => {};

  let isLoggingOut = false;
  let heartbeatInterval = null;

  // Mark that user is logging out (prevents automatic offline status)
  window.__markLoggingOut = () => {
    isLoggingOut = true;
  };

  // Set status to offline using sendBeacon (works even when page is closing)
  const setOfflineStatus = async () => {
    if (isLoggingOut) return;

    try {
      const statusData = JSON.stringify({ status: "Offline" });
      const blob = new Blob([statusData], { type: "application/json" });

      // Use sendBeacon for reliable delivery
      if (navigator.sendBeacon) {
        navigator.sendBeacon("/api/user/profile", blob);
      } else {
        // Fallback to fetch (may not complete if page is closing)
        await fetch("/api/user/profile", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: statusData,
          keepalive: true, // Keep request alive even after page unload
        });
      }
    } catch (error) {
      console.error("[SessionMonitor] Failed to set offline status:", error);
    }
  };

  // Handle page unload
  const handleBeforeUnload = (event) => {
    setOfflineStatus();
  };

  // Handle visibility change (tab switching, minimizing)
  const handleVisibilityChange = () => {
    if (document.hidden) {
      // Tab is hidden - server will detect disconnect via SSE
      // No immediate action needed
    }
  };

  // Handle online/offline network events
  const handleOnline = () => {
    console.log("[SessionMonitor] Network back online");
    // Network is back online - status will be updated when SSE reconnects
  };

  const handleOffline = () => {
    console.log("[SessionMonitor] Network offline");
    // Network is offline - set status to Offline after a short delay
    // This handles cases where SSE disconnect detection might be delayed
    if (isLoggingOut) return;

    setTimeout(() => {
      // Double-check network is still offline and user is not logging out
      if (!navigator.onLine && !isLoggingOut) {
        setOfflineStatus();
      }
    }, 3000); // Wait 3 seconds to avoid false positives from brief network hiccups
  };

  // Set up event listeners
  window.addEventListener("beforeunload", handleBeforeUnload);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("online", handleOnline);
  window.addEventListener("offline", handleOffline);

  // Cleanup function
  return () => {
    window.removeEventListener("beforeunload", handleBeforeUnload);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("online", handleOnline);
    window.removeEventListener("offline", handleOffline);
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }
  };
}
