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
  };

  const handleOffline = () => {
    console.log("[SessionMonitor] Network offline");
    // Network is offline, but don't set status yet
    // Wait for server to detect SSE disconnect
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

