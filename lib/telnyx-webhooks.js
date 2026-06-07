import crypto from "crypto";
import nacl from "tweetnacl";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "./runtime-logging.mjs";

function normalizeMaybePem(input) {
  const value = String(input || "").trim();
  if (!value) return "";
  return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
}

function decodeBase64Url(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  return Buffer.from(padded, "base64");
}

export function decodePublicKeyBytes(input) {
  if (!input) return null;
  const trimmed = String(input).trim().replace(/^0x/i, "");
  if (!trimmed) return null;

  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    const out = Buffer.from(trimmed, "hex");
    return out.length === 32 ? out : null;
  }

  try {
    const out = decodeBase64Url(trimmed);
    return out.length === 32 ? out : null;
  } catch (_) {
    return null;
  }
}

function debugEnabled() {
  return String(process.env.TELNYX_WEBHOOK_DEBUG || "false").toLowerCase() === "true";
}

function debugLog(message, extra = {}) {
  if (!debugEnabled()) return;
  platformApiLogger.info("runtime_diagnostic", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
}

export async function verifyTelnyxSignature(request, rawBody) {
  const signatureHeader = request.headers.get("telnyx-signature-ed25519") || "";
  const timestampHeader = request.headers.get("telnyx-timestamp") || "";
  if (!signatureHeader || !timestampHeader) {
    debugLog("missing required signature headers", {
      hasSignature: Boolean(signatureHeader),
      hasTimestamp: Boolean(timestampHeader),
    });
    return false;
  }

  const publicKeyEnvRaw =
    process.env.TELNYX_WEBHOOK_SECRET ||
    process.env.TELNYX_WEBHOOK_PUBLIC_KEY ||
    "";
  if (!publicKeyEnvRaw) {
    debugLog("missing webhook public key env", {
      tried: ["TELNYX_WEBHOOK_SECRET", "TELNYX_WEBHOOK_PUBLIC_KEY"],
    });
    return false;
  }

  const publicKeyEnv = normalizeMaybePem(publicKeyEnvRaw);

  const toleranceSec = Number(process.env.TELNYX_WEBHOOK_TOLERANCE_SECONDS || 300);
  const nowSec = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestampHeader, 10);
  if (!Number.isFinite(ts)) {
    debugLog("invalid timestamp header", { timestampHeader });
    return false;
  }
  if (Math.abs(nowSec - ts) > toleranceSec) {
    debugLog("timestamp outside tolerance", { nowSec, ts, toleranceSec, driftSec: nowSec - ts });
    return false;
  }

  const data = Buffer.from(`${timestampHeader}|${rawBody}`, "utf8");

  let signature;
  try {
    signature = decodeBase64Url(signatureHeader);
  } catch (_) {
    debugLog("invalid signature encoding");
    return false;
  }

  if (publicKeyEnv.includes("BEGIN PUBLIC KEY")) {
    try {
      const key = crypto.createPublicKey({ key: publicKeyEnv, format: "pem" });
      const ok = crypto.verify(null, data, key, signature);
      if (!ok) debugLog("signature verification failed (pem)");
      return ok;
    } catch (err) {
      debugLog("pem key parse/verify failed", { error: err?.message || String(err) });
    }
  }

  const pubBytes = decodePublicKeyBytes(publicKeyEnv);
  if (!pubBytes) {
    debugLog("public key decode failed or invalid length", { keyLength: String(publicKeyEnv || "").length });
    return false;
  }

  try {
    const ok = nacl.sign.detached.verify(
      new Uint8Array(data),
      new Uint8Array(signature),
      new Uint8Array(pubBytes),
    );
    if (!ok) debugLog("signature verification failed (raw key)");
    return !!ok;
  } catch (err) {
    debugLog("tweetnacl verify exception", { error: err?.message || String(err) });
    return false;
  }
}
