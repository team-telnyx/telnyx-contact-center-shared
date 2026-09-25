import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function secret() {
  const value = String(process.env.COBROWSE_SIGNING_SECRET || process.env.WIDGET_SESSION_SIGNING_SECRET || process.env.NEXTAUTH_SECRET || "").trim();
  if (value.length < 32) throw new Error("Co-browse signing secret must contain at least 32 characters");
  return value;
}

export function hashCredential(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

export function equalHash(supplied, expectedHash) {
  if (typeof supplied !== "string" || supplied.length < 30 || supplied.length > 160) return false;
  const left = Buffer.from(hashCredential(supplied), "hex");
  const right = Buffer.from(String(expectedHash || ""), "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function freshCredential(prefix = "cbr") {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function pairingCodeHmac(code) {
  if (!/^\d{6}$/.test(String(code))) return null;
  return createHmac("sha256", secret()).update(`cc-cobrowse-pairing-v1:${code}`).digest("hex");
}

export function generatePairingCode() {
  // Rejection sampling avoids bias from taking a random byte modulo 1,000,000.
  const max = Math.floor(0x100000000 / 1_000_000) * 1_000_000;
  let value;
  do { value = randomBytes(4).readUInt32BE(0); } while (value >= max);
  return String(value % 1_000_000).padStart(6, "0");
}

// Distinct from the pairing credential and stable across a lost polling reply.
// The pairing secret itself never becomes an agent-facing or socket ticket.
export function pairingResumeCredential(pairingId, pairingSecretHash, sessionId) {
  const digest = createHmac("sha256", secret())
    .update(`cc-cobrowse-pairing-resume-v1:${pairingId}:${pairingSecretHash}:${sessionId}`)
    .digest("base64url");
  return `cbr_${digest}`;
}
