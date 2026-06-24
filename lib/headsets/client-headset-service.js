"use client";

import { createHeadsetControlService } from "@/lib/headsets/headset-control-service.mjs";
import { createJabraAdapter } from "@/lib/headsets/adapters/jabra-adapter.mjs";
import { createEposAdapter } from "@/lib/headsets/adapters/epos-adapter.mjs";

let headsetControlService = null;
let initPromise = null;

export function isHeadsetIntegrationEnabled() {
  return String(process.env.NEXT_PUBLIC_HEADSET_INTEGRATION_ENABLED || "false").toLowerCase() === "true";
}

export function getHeadsetControlService() {
  if (!isHeadsetIntegrationEnabled()) return null;
  if (!headsetControlService) {
    headsetControlService = createHeadsetControlService({
      adapters: [createJabraAdapter(), createEposAdapter()],
    });
  }
  return headsetControlService;
}

export async function initHeadsetControlService() {
  const service = getHeadsetControlService();
  if (!service) return null;
  if (!initPromise) {
    initPromise = service.init().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  await initPromise;
  return service;
}

export async function disposeHeadsetControlServiceForTests() {
  if (headsetControlService) {
    await headsetControlService.dispose();
  }
  headsetControlService = null;
  initPromise = null;
}
