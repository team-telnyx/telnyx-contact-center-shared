import { createDiagnosticLogger } from "../diagnostic-logger.mjs";

const TOPICS = Object.freeze({
  runner: "outbound.runner",
  campaigns: "outbound.campaigns",
  execution: "outbound.execution",
  imports: "outbound.imports",
  liveCalls: "outbound.live-calls",
});

function compactObject(value = {}) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ""),
  );
}

export function outboundErrorPayload(error) {
  if (!error) return {};
  return compactObject({
    errorName: error.name || "Error",
    errorMessage: error.message || String(error),
    errorCode: error.code,
    errorStatus: error.status || error.statusCode,
  });
}

export function campaignPayload({ campaignId, campaignName, status, reason } = {}) {
  return compactObject({
    campaignId: campaignId ? String(campaignId) : undefined,
    campaignName: campaignName || undefined,
    status: status || undefined,
    reason: reason || undefined,
  });
}

export function contactListPayload({ contactListId, dncListId, recordCount, importedCount, skippedCount } = {}) {
  return compactObject({
    contactListId: contactListId ? String(contactListId) : undefined,
    dncListId: dncListId ? String(dncListId) : undefined,
    recordCount: Number.isFinite(Number(recordCount)) ? Number(recordCount) : undefined,
    importedCount: Number.isFinite(Number(importedCount)) ? Number(importedCount) : undefined,
    skippedCount: Number.isFinite(Number(skippedCount)) ? Number(skippedCount) : undefined,
  });
}

export function outboundConfigPayload({ attemptControlId, filterId, timeSetId, dispositionCodeId } = {}) {
  return compactObject({
    attemptControlId: attemptControlId ? String(attemptControlId) : undefined,
    filterId: filterId ? String(filterId) : undefined,
    timeSetId: timeSetId ? String(timeSetId) : undefined,
    dispositionCodeId: dispositionCodeId ? String(dispositionCodeId) : undefined,
  });
}

export function outboundCallPayload({ callControlId, callSessionId, interactionId } = {}) {
  return compactObject({
    callControlId: callControlId ? String(callControlId) : undefined,
    callSessionId: callSessionId ? String(callSessionId) : undefined,
    interactionId: interactionId ? String(interactionId) : undefined,
  });
}

export const runnerLogger = createDiagnosticLogger("outbound.runner");
export const campaignsLogger = createDiagnosticLogger("outbound.campaigns");
export const executionLogger = createDiagnosticLogger("outbound.execution");
export const importsLogger = createDiagnosticLogger("outbound.imports");
export const liveCallsLogger = createDiagnosticLogger("outbound.live-calls");

export { TOPICS as OUTBOUND_LOGGING_TOPICS };
