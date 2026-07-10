import { createDiagnosticLogger } from "./diagnostic-logger.mjs";
import { getPostgresPool } from "./postgres.mjs";
import { randomBytes, pbkdf2Sync } from "crypto";
import { SEEDED_DEFAULT_QUEUE_ID } from "./seed-default-queue.mjs";

const seedLogger = createDiagnosticLogger("platform.app");

// The seeded owner account is meant to be immediately useful in the CC UI,
// not just an account that can log into Admin — so it gets every role the
// app defines (see config/user.js's USER_ROLES: agent, supervisor, admin,
// owner), not just "owner". Without agent/supervisor/admin, a freshly
// seeded owner logging in for the first time has no access to the Contact
// Center agent desktop or its admin screens, only whatever "owner"-gated
// pages exist — confirmed as a real gap during GCP wizard E2E testing
// (2026-07-09, cc-gcp1).
const ALL_ROLES = ["agent", "supervisor", "admin", "owner"];

/**
 * Seed default owner user from environment variables
 * Reads DEFAULT_OWNER_EMAIL and DEFAULT_OWNER_PASSWORD and creates an owner account
 * This function is idempotent - it won't create duplicate users or overwrite existing passwords
 */
export async function seedDefaultOwner() {
  try {
    const pool = getPostgresPool();
    if (!pool) {
      seedLogger.error("seed_owner_db_unavailable");
      return false;
    }

    const ownerEmail = process.env.DEFAULT_OWNER_EMAIL || "";
    const ownerPassword = process.env.DEFAULT_OWNER_PASSWORD || "";

    if (!ownerEmail || !ownerPassword) {
      seedLogger.info("seed_owner_skipped_not_configured");


      return true; // Not an error, just nothing to seed
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(ownerEmail)) {
      seedLogger.error("seed_owner_invalid_email");


      return false;
    }

    // Validate password strength (minimum 8 characters)
    if (ownerPassword.length < 8) {
      seedLogger.error("seed_owner_invalid_password");


      return false;
    }

    // Telnyx-side voice number wiring for the owner, populated by the deploy
    // wizard's Telnyx bootstrap step. Read once here so both the create path
    // and the existing-user path below can push it onto the `users` row.
    // NOTE: telephony_credentials_id/telephony_user_name are intentionally
    // NOT sourced from env here anymore — the app itself (NextAuth's
    // authorize()/JWT callback, via createUserTelephonyCredentials) creates
    // the owner's telephony credential lazily on first login, exactly like
    // it does for every other user. Pre-seeding it here from
    // TELNYX_OWNER_TELEPHONY_CREDENTIAL_ID/_USER_NAME was pure duplication
    // of that idempotent app-side mechanism (confirmed via real E2E
    // testing) and left an extra, unused Telnyx credential behind on every
    // wizard re-run.
    const ownerVoiceNumber = process.env.TELNYX_MAIN_FROM_NUMBER || "";

    const client = await pool.connect();
    try {
      // Set a shorter statement timeout for this operation
      await client.query("SET statement_timeout = '5s'");

      // Check if user already exists
      const existingUser = await client.query(
        "SELECT id, username, roles, verified, telephony_credentials_id, telephony_user_name, voice_number FROM users WHERE username = $1 LIMIT 1",
        [ownerEmail.toLowerCase()]
      );

      let ownerUserId;

      if (existingUser.rows.length > 0) {
        const user = existingUser.rows[0];
        ownerUserId = user.id;
        const userRoles = user.roles || [];
        const normalizedRoles = Array.isArray(userRoles) ?
        userRoles.map((r) => String(r).toLowerCase()) :
        [];
        const hasAllRoles = ALL_ROLES.every((r) => normalizedRoles.includes(r));

        // Sync Telnyx voice number wiring onto the existing row whenever we
        // have a value the wizard produced and the row doesn't already
        // have one - covers both a brand-new deploy hitting this on second
        // container start (schema init + app start race) and a resume /
        // re-run of `cc up` / `cc telnyx` after the owner row already
        // exists from a prior run. Built as {column, value} pairs (not
        // pre-rendered placeholders) so both branches below can prepend
        // their own params (roles, verified) without $-index collisions.
        // NOTE: telephony_credentials_id/telephony_user_name are no longer
        // synced here — see the comment above on ownerVoiceNumber for why.
        const telephonyFields = [];
        if (ownerVoiceNumber && !user.voice_number) {
          telephonyFields.push(["voice_number", ownerVoiceNumber]);
        }

        if (hasAllRoles) {
          // User exists and already has every role - ensure they're
          // verified and any pending telephony fields are synced.
          if (!user.verified || telephonyFields.length > 0) {
            const params = [...telephonyFields.map(([, v]) => v)];
            const setClauses = [
              "verified = true",
              "updated_at = NOW()",
              ...telephonyFields.map(([col], i) => `${col} = $${i + 1}`),
            ];
            params.push(user.id);
            await client.query(
              `UPDATE users SET ${setClauses.join(", ")} WHERE id = $${params.length}`,
              params
            );
            seedLogger.info("seed_owner_existing_verified");


          } else {
            seedLogger.info("seed_owner_existing_verified");


          }
        } else {
          // User exists but is missing one or more of the standard roles
          // (e.g. seeded before this fully-loaded-roles change, or an
          // older row that only ever got "owner") - merge in whatever is
          // missing rather than overwriting any extra/custom roles that
          // might be present.
          const updatedRoles = [...new Set([...normalizedRoles, ...ALL_ROLES])];

          const params = [updatedRoles, ...telephonyFields.map(([, v]) => v)];
          const setClauses = [
            "roles = $1",
            "verified = true",
            "updated_at = NOW()",
            ...telephonyFields.map(([col], i) => `${col} = $${i + 2}`),
          ];
          params.push(user.id);
          await client.query(
            `UPDATE users SET ${setClauses.join(", ")} WHERE id = $${params.length}`,
            params
          );
          seedLogger.info("seed_owner_existing_updated");

        }
      } else {
        // Extract domain from email and verify it's allowed
        const domain = ownerEmail.split("@")[1]?.toLowerCase();
        if (domain) {
          const domainCheck = await client.query(
            "SELECT id FROM domains WHERE domain = $1 AND active = true LIMIT 1",
            [domain]
          );

          if (domainCheck.rows.length === 0) {
            seedLogger.warn("seed_owner_domain_not_allowed");


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

        ownerUserId = randomBytes(16).toString("hex");

        await client.query(
          `INSERT INTO users (
            id, username, email, first_name, last_name, nick,
            roles, verified, auth_strategy, hash, salt, iterations,
            available_for_routing, active,
            telephony_credentials_id, telephony_user_name, voice_number,
            created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW(), NOW())`,
          [
          ownerUserId,
          ownerEmail.toLowerCase(),
          ownerEmail.toLowerCase(),
          firstName,
          lastName || null,
          firstName,
          ALL_ROLES, // roles array - full access (agent, supervisor, admin, owner)
          true, // verified - owner can log in immediately
          "local", // auth_strategy
          hash,
          salt,
          iterations,
          // available_for_routing - the owner also holds the `agent` role
          // and is assigned into the seeded "Sales" queue below, so it
          // must be routable to actually receive calls from that queue
          // rather than just appearing as an inactive member.
          true,
          true, // active
          null, // telephony_credentials_id - created lazily by NextAuth on first login (see createUserTelephonyCredentials)
          null, // telephony_user_name - same
          ownerVoiceNumber || null
          ]
        );

        seedLogger.info("seed_owner_created");


        seedLogger.info("seed_owner_default_password_warning");

      }

      // Assign the owner into the seeded "Sales" queue so they show up as
      // an active agent there (not just an account with role access) -
      // mirrors what an admin would otherwise have to do by hand via
      // Admin > Queues > Sales > Agents after every fresh deploy. Runs for
      // both the brand-new-user and existing-user paths above (ownerUserId
      // is set in either branch). Requires seed-default-queue.mjs to have
      // already run in this boot (see postgres-schema.mjs's seed call
      // ordering - queue seed now runs before owner seed specifically for
      // this FK dependency). ON CONFLICT DO NOTHING keeps this idempotent
      // across restarts/re-runs and preserves an operator's later choice to
      // deactivate the owner from this queue by hand (deactivating sets
      // deactivated_at, doesn't delete the row - it won't be touched here).
      try {
        await client.query(
          `INSERT INTO cc_queue_user_assignments (
            id, queue_id, user_id, priority, enabled, activated_at, created_at, updated_at
          ) VALUES (gen_random_uuid()::text, $1, $2, 1, true, NOW(), NOW(), NOW())
          ON CONFLICT (queue_id, user_id) DO NOTHING`,
          [SEEDED_DEFAULT_QUEUE_ID, ownerUserId]
        );
        seedLogger.info("seed_owner_queue_assignment_synced");
      } catch (queueAssignError) {
        // The "Sales" queue row might not exist yet on a very first boot if
        // seedDefaultQueue() itself failed (see its own try/catch in
        // postgres-schema.mjs) - don't let that fail owner seeding overall,
        // just log it. A later boot's owner-seed re-run (idempotent) will
        // pick this up once the queue exists.
        seedLogger.warn("seed_owner_queue_assignment_failed");
      }

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
      seedLogger.info("seed_owner_timeout");


    } else {
      seedLogger.error("seed_owner_failed");
    }
    return false;
  }
}
