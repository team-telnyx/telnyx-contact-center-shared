import { getPostgresPool } from "./postgres.mjs";
import { randomBytes, pbkdf2Sync } from "crypto";

/**
 * Seed default owner user from environment variables
 * Reads DEFAULT_OWNER_EMAIL and DEFAULT_OWNER_PASSWORD and creates an owner account
 * This function is idempotent - it won't create duplicate users or overwrite existing passwords
 */
export async function seedDefaultOwner() {
  try {
    const pool = getPostgresPool();
    if (!pool) {
      console.error("[Seed Owner] Database connection failed");
      return false;
    }

    const ownerEmail = process.env.DEFAULT_OWNER_EMAIL || "";
    const ownerPassword = process.env.DEFAULT_OWNER_PASSWORD || "";

    if (!ownerEmail || !ownerPassword) {
      console.log(
        "[Seed Owner] DEFAULT_OWNER_EMAIL or DEFAULT_OWNER_PASSWORD not configured, skipping owner seeding"
      );
      return true; // Not an error, just nothing to seed
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(ownerEmail)) {
      console.error(
        `[Seed Owner] Invalid email format: ${ownerEmail}. Skipping owner creation.`
      );
      return false;
    }

    // Validate password strength (minimum 8 characters)
    if (ownerPassword.length < 8) {
      console.error(
        "[Seed Owner] Password must be at least 8 characters. Skipping owner creation."
      );
      return false;
    }

    const client = await pool.connect();
    try {
      // Set a shorter statement timeout for this operation
      await client.query("SET statement_timeout = '5s'");

      // Check if user already exists
      const existingUser = await client.query(
        "SELECT id, username, roles, verified FROM users WHERE username = $1 LIMIT 1",
        [ownerEmail.toLowerCase()]
      );

      if (existingUser.rows.length > 0) {
        const user = existingUser.rows[0];
        const userRoles = user.roles || [];
        const hasOwnerRole = Array.isArray(userRoles)
          ? userRoles.map((r) => String(r).toLowerCase()).includes("owner")
          : false;

        if (hasOwnerRole) {
          // User exists and has owner role - ensure they're verified
          if (!user.verified) {
            await client.query(
              "UPDATE users SET verified = true, updated_at = NOW() WHERE id = $1",
              [user.id]
            );
            console.log(
              `[Seed Owner] ✓ Existing owner user verified: ${ownerEmail}`
            );
          } else {
            console.log(
              `[Seed Owner] → Owner user already exists and is verified: ${ownerEmail}`
            );
          }
          return true;
        } else {
          // User exists but doesn't have owner role - update to add owner role
          const updatedRoles = Array.isArray(userRoles)
            ? [
                ...new Set([
                  ...userRoles.map((r) => String(r).toLowerCase()),
                  "owner",
                ]),
              ]
            : ["owner"];

          await client.query(
            "UPDATE users SET roles = $1, verified = true, updated_at = NOW() WHERE id = $2",
            [updatedRoles, user.id]
          );
          console.log(
            `[Seed Owner] ✓ Updated existing user to owner role: ${ownerEmail}`
          );
          return true;
        }
      }

      // Extract domain from email and verify it's allowed
      const domain = ownerEmail.split("@")[1]?.toLowerCase();
      if (domain) {
        const domainCheck = await client.query(
          "SELECT id FROM domains WHERE domain = $1 AND active = true LIMIT 1",
          [domain]
        );

        if (domainCheck.rows.length === 0) {
          console.warn(
            `[Seed Owner] Warning: Domain '${domain}' is not in allowed domains list. ` +
              `Owner user will be created anyway, but you may want to add this domain to ALLOWED_EMAIL_DOMAINS.`
          );
        }
      }

      // Create new owner user
      const salt = randomBytes(32).toString("hex");
      const hash = pbkdf2Sync(
        ownerPassword,
        salt,
        25000,
        64,
        "sha256"
      ).toString("hex");
      const iterations = 25000;

      // Extract name from email (use email prefix as first name, or "Owner")
      const emailPrefix = ownerEmail.split("@")[0];
      const firstName = emailPrefix.split(".")[0] || "Owner";
      const lastName = emailPrefix.split(".").slice(1).join(" ") || "";

      const userId = randomBytes(16).toString("hex");

      await client.query(
        `INSERT INTO users (
          id, username, email, first_name, last_name, nick,
          roles, verified, auth_strategy, hash, salt, iterations,
          agent_status, available_for_routing, active,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())`,
        [
          userId,
          ownerEmail.toLowerCase(),
          ownerEmail.toLowerCase(),
          firstName,
          lastName || null,
          firstName,
          ["owner"], // roles array
          true, // verified - owner can log in immediately
          "local", // auth_strategy
          hash,
          salt,
          iterations,
          "Available", // agent_status
          false, // available_for_routing - owner typically doesn't take calls
          true, // active
        ]
      );

      console.log(
        `[Seed Owner] ✓ Default owner user created successfully: ${ownerEmail}`
      );
      console.log(
        `[Seed Owner] ⚠️  IMPORTANT: Change the default password after first login!`
      );
      return true;
    } finally {
      // Reset statement timeout
      try {
        await client.query("RESET statement_timeout");
      } catch (e) {
        // Ignore reset errors
      }
      client.release();
    }
  } catch (error) {
    // Don't log timeout errors as critical - they're expected in some cases
    if (error.code === "57014") {
      console.log(
        "[Seed Owner] Seeding skipped due to timeout (owner may already exist)"
      );
    } else {
      console.error("[Seed Owner] Error seeding default owner:", error.message);
    }
    return false;
  }
}
