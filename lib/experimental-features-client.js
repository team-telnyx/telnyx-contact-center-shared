"use client";

import { useSyncExternalStore } from "react";

const REFRESH_EVENT = "experimental-features:refresh";

let snapshot = {
  enabled: false,
  loading: true,
  userId: null,
};
let requestPromise = null;
const listeners = new Set();

function emit(nextSnapshot) {
  snapshot = nextSnapshot;
  for (const listener of listeners) listener();
}

export async function refreshExperimentalFeatures() {
  if (requestPromise) return requestPromise;

  requestPromise = fetch("/api/user/profile", { cache: "no-store" })
    .then(async (response) => {
      const payload = await response.json().catch(() => null);
      const user = payload?.data || null;
      emit({
        enabled: response.ok && user?.experimental_features === true,
        loading: false,
        userId: user?.id ? String(user.id) : null,
      });
      return snapshot;
    })
    .catch(() => {
      emit({ ...snapshot, enabled: false, loading: false });
      return snapshot;
    })
    .finally(() => {
      requestPromise = null;
    });

  return requestPromise;
}

function handleRefreshEvent(event) {
  const targetUserId = event?.detail?.userId;
  if (!targetUserId || !snapshot.userId || String(targetUserId) === snapshot.userId) {
    refreshExperimentalFeatures();
  }
}

function subscribe(listener) {
  listeners.add(listener);

  if (listeners.size === 1 && typeof window !== "undefined") {
    refreshExperimentalFeatures();
    window.addEventListener(REFRESH_EVENT, handleRefreshEvent);
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener(REFRESH_EVENT, handleRefreshEvent);
      snapshot = { enabled: false, loading: true, userId: null };
    }
  };
}

export function notifyExperimentalFeaturesChanged(userId) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(REFRESH_EVENT, {
      detail: { userId: userId ? String(userId) : null },
    }),
  );
}

export function useExperimentalFeatures() {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
