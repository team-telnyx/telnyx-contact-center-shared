import { pbkdf2Sync, randomBytes, timingSafeEqual } from "crypto";
import { PgDb } from "@/lib/pgdb";
import { authLogger, securityUserPayload } from "@/lib/security-logging.mjs";

export async function findUserByEmail(email) {
  if (!email) return null;
  // In our schema, username stores the email
  const user = await PgDb.findUserByUsername(String(email).toLowerCase());
  return user;
}

function derivePassportHash(
  password,
  salt,
  iterations = 25000,
  keylen = 64,
  digest = "sha256"
) {
  return pbkdf2Sync(password, salt, iterations, keylen, digest).toString("hex");
}

export function verifyUserPassword(user, plainPassword) {
  const storedHash = typeof user?.hash === "string" ? user.hash : null;
  const salt = typeof user?.salt === "string" ? user.salt : null;
  if (!storedHash || !salt) return false;
  const keylen = Buffer.from(storedHash, "hex").length || 64; // infer key length
  const iterations =
    typeof user?.iterations === "number" ? user.iterations : 25000;

  const digests = ["sha256", "sha1"]; // try sha256 first, then sha1 for older data
  for (const digest of digests) {
    try {
      const derivedHex = derivePassportHash(
        plainPassword,
        salt,
        iterations,
        keylen,
        digest
      );
      const a = Buffer.from(derivedHex, "hex");
      const b = Buffer.from(storedHash, "hex");
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
    } catch (_) {
      // continue
    }
  }
  return false;
}

export async function createUser({ username, password, name }) {
  const salt = randomBytes(32).toString("hex");
  const hash = derivePassportHash(password, salt, 25000, 64, "sha256");
  const id = await PgDb.upsertUserByUsername(username, {
    firstName: name || username,
    hash,
    salt,
    iterations: 25000,
  });
  return { _id: id, username, name };
}

export async function authenticateUser(username, password) {
  const loginId = (username || "").trim().toLowerCase();
  authLogger.info("local_auth_attempt_started", { email: loginId });
  if (!loginId || !password) return null;
  const user = await PgDb.findUserByUsername(loginId);
  if (!user) {
    authLogger.warn("local_auth_user_not_found", { email: loginId });
    return null;
  }
  authLogger.info("local_auth_user_found", { ...securityUserPayload(user, loginId) });
  const hashed = (typeof user.hash === "string" && user.hash) || null;
  if (!hashed) return null;
  const valid = verifyUserPassword(user, password);
  authLogger.info("local_auth_password_checked", { ...securityUserPayload(user, loginId), valid });
  if (!valid) {
    authLogger.warn("local_auth_failed", { ...securityUserPayload(user, loginId) });
    return null;
  }
  authLogger.info("local_auth_succeeded", { ...securityUserPayload(user, loginId), valid });
  return user;
}
