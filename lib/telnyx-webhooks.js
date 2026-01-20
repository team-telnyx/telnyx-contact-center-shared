import crypto from "crypto";
import nacl from "tweetnacl";

export function decodePublicKeyBytes(input) {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (trimmed.includes("BEGIN PUBLIC KEY")) return trimmed;
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    return Buffer.from(trimmed, "hex");
  }
  try {
    return Buffer.from(trimmed, "base64");
  } catch (_) {
    return null;
  }
}

export async function verifyTelnyxSignature(request, rawBody) {
  const signatureB64 = request.headers.get("telnyx-signature-ed25519") || "";
  const timestampHeader = request.headers.get("telnyx-timestamp") || "";
  if (!signatureB64 || !timestampHeader) return false;

  const publicKeyEnv = process.env.TELNYX_WEBHOOK_SECRET || "";
  if (!publicKeyEnv) return false;

  const toleranceSec = Number(
    process.env.TELNYX_WEBHOOK_TOLERANCE_SECONDS || 300
  );
  const nowSec = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestampHeader, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowSec - ts) > toleranceSec) return false;

  const data = Buffer.from(`${ts}|${rawBody}`, "utf8");
  const signature = Buffer.from(signatureB64, "base64");

  // Try PEM (Node crypto) first if provided
  if (publicKeyEnv.includes("BEGIN PUBLIC KEY")) {
    try {
      const key = crypto.createPublicKey({ key: publicKeyEnv, format: "pem" });
      return crypto.verify(null, data, key, signature);
    } catch (_) {
      // fallthrough to tweetnacl verification
    }
  }

  // Fallback to raw 32-byte Ed25519 public key (hex/base64)
  const pubBytes = decodePublicKeyBytes(publicKeyEnv);
  if (!pubBytes) return false;
  try {
    const ok = nacl.sign.detached.verify(
      new Uint8Array(data),
      new Uint8Array(signature),
      new Uint8Array(pubBytes)
    );
    return !!ok;
  } catch (_) {
    return false;
  }
}
