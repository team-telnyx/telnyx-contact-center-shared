import { SignJWT, jwtVerify } from "jose";
import { validateJwtSecrets } from "./jwt-secrets.mjs";

const issuer = "telnyx-demo-portal";

function encodedSecrets() {
  const { accessSecret, refreshSecret } = validateJwtSecrets();
  const encoder = new TextEncoder();
  return {
    accessSecret: encoder.encode(accessSecret),
    refreshSecret: encoder.encode(refreshSecret),
  };
}

export async function signAccessToken(payload, expiresIn = "1d") {
  const { accessSecret } = encodedSecrets();
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(issuer)
    .setExpirationTime(expiresIn)
    .sign(accessSecret);
}

export async function verifyAccessToken(token) {
  const { accessSecret } = encodedSecrets();
  try {
    const { payload } = await jwtVerify(token, accessSecret, { issuer });
    return payload;
  } catch (_) {
    return null;
  }
}

export async function signRefreshToken(payload, expiresIn = "30d") {
  const { refreshSecret } = encodedSecrets();
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(issuer)
    .setExpirationTime(expiresIn)
    .sign(refreshSecret);
}

export async function verifyRefreshToken(token) {
  const { refreshSecret } = encodedSecrets();
  try {
    const { payload } = await jwtVerify(token, refreshSecret, { issuer });
    return payload;
  } catch (_) {
    return null;
  }
}

export async function hashToken(token) {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Backward-compatible aliases
export async function signSession(payload, expiresIn = "1d") {
  return signAccessToken(payload, expiresIn);
}

export async function verifySession(token) {
  return verifyAccessToken(token);
}
