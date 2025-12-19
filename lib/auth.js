import { pbkdf2Sync, randomBytes, timingSafeEqual } from "crypto";
import { PgDb } from "@/lib/pgdb";

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
  console.log("[AUTH] Authenticating user...", loginId);
  if (!loginId || !password) return null;
  const user = await PgDb.findUserByUsername(loginId);
  if (!user) {
    console.log("[AUTH] User not found in DB");
    return null;
  }
  console.log("[AUTH] User found in DB");
  const hashed = (typeof user.hash === "string" && user.hash) || null;
  if (!hashed) return null;
  const valid = verifyUserPassword(user, password);
  console.log("[AUTH] User authenticated", valid);
  if (!valid) {
    console.log("[AUTH] Authentication failed");
    return null;
  }
  console.log("[AUTH] User authenticated successfully", valid);
  return user;
}
