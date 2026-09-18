// Provider adapter boundary (the internal documentation §5.4).
// The saga engine talks to exactly this interface; tests inject a fake.
// Classification contract:
//   accepted   — provider took the command (HTTP 2xx)
//   failed     — definitively rejected (4xx that cannot become true later)
//   ambiguous  — unknown outcome (timeout, 5xx, 408/429, network error):
//                the engine must reconcile evidence before any new effect.

import { buildTelnyxV2Url } from "../telnyx.js";
import {
  verifyProviderAbsence,
  verifyAgentConnectionIdle,
  verifyProviderCallEnded,
  verifyConsultCompletion,
} from "./provider-absence.mjs";

const DEFINITIVE_FAILURE_STATUSES = new Set([400, 401, 403, 404, 405, 409, 410, 422]);

export function classifyProviderResult({ httpStatus, networkError }) {
  if (networkError) return "ambiguous";
  if (httpStatus >= 200 && httpStatus < 300) return "accepted";
  if (DEFINITIVE_FAILURE_STATUSES.has(httpStatus)) return "failed";
  return "ambiguous";
}

const HANGUP_ENDPOINT_PATTERN = /\/calls\/([^/]+)\/actions\/hangup$/;

// Telnyx answers a hangup for a call that has already ended with 422 and
// error code 90018. The requested end state already holds, so the engine
// treats that reply as evidence that the leg is gone, not as a rejected
// effect: the saga continues along its leg.ended path and no failed command
// or compensation is journaled for a race the provider has already settled.
export function isHangupEndpoint(endpoint) {
  return HANGUP_ENDPOINT_PATTERN.test(String(endpoint || ""));
}

export function hangupEndpointCallId(endpoint) {
  const match = HANGUP_ENDPOINT_PATTERN.exec(String(endpoint || ""));
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function isAlreadyEndedResponse(response) {
  const errors = response?.errors;
  return Array.isArray(errors) && errors.some((error) => String(error?.code) === "90018");
}

export function createTelnyxProvider({ apiKey = process.env.TELNYX_API_KEY, timeoutMs = 5000 } = {}) {
  return {
    name: "telnyx",
    async send({ endpoint, request, commandId, operation }) {
      if (operation === "email_send") {
        const { emailProvider } = await import("../email/provider.mjs");
        return emailProvider().send({endpoint,request,commandId,operation});
      }
      if (!apiKey) {
        return { outcome: "failed", httpStatus: 0, response: { error: "TELNYX_API_KEY not configured" } };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        if(operation==='verify_direct_agent_absence') {
          const evidence=await verifyAgentConnectionIdle(request,async path=>{
            const r=await fetch(buildTelnyxV2Url(path),{method:'GET',headers:{Authorization:`Bearer ${apiKey}`},signal:controller.signal,redirect:'error'});
            if(!r.ok)throw Error(`Provider evidence read failed (${r.status})`);
            return r.json();
          });
          return {outcome:'accepted',httpStatus:200,response:{data:evidence}};
        }
        if(operation==='verify_agent_leg_end') {
          const evidence=await verifyProviderCallEnded(request,async path=>{
            const r=await fetch(buildTelnyxV2Url(path),{method:'GET',headers:{Authorization:`Bearer ${apiKey}`},signal:controller.signal,redirect:'error'});
            if(!r.ok)throw Error(`Provider call evidence read failed (${r.status})`);
            return r.json();
          });
          return {outcome:'accepted',httpStatus:200,response:{data:evidence}};
        }
        if(operation==='verify_cancelled_agent_absence') {
          const evidence=await verifyProviderAbsence(request,async path=>{
            const r=await fetch(buildTelnyxV2Url(path),{method:'GET',headers:{Authorization:`Bearer ${apiKey}`},signal:controller.signal,redirect:'error'});
            if(!r.ok)throw Error(`Provider evidence read failed (${r.status})`);
            return r.json();
          });
          return {outcome:'accepted',httpStatus:200,response:{data:evidence}};
        }
        if (operation === "verify_consult_completion") {
          const evidence = await verifyConsultCompletion(request, async (path) => {
            const response = await fetch(buildTelnyxV2Url(path), {
              method: "GET",
              headers: { Authorization: `Bearer ${apiKey}` },
              signal: controller.signal,
              redirect: "error",
            });
            if (!response.ok) {
              throw Error(`Provider evidence read failed (${response.status})`);
            }
            return response.json();
          });
          return {
            outcome: "accepted",
            httpStatus: 200,
            response: { data: evidence },
          };
        }
        const response = await fetch(buildTelnyxV2Url(endpoint), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ...request, command_id: commandId }),
          signal: controller.signal,
        });
        const body = await response.json().catch(() => ({}));
        return {
          outcome: classifyProviderResult({ httpStatus: response.status }),
          httpStatus: response.status,
          response: body,
        };
      } catch (error) {
        return {
          outcome: "ambiguous",
          httpStatus: null,
          response: { error: String(error?.message || error) },
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
