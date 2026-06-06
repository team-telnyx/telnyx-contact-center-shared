import { createDiagnosticLogger } from "./diagnostic-logger.mjs";
import { getPostgresPool } from "./postgres.mjs";

const seedLogger = createDiagnosticLogger("platform.app");

/**
 * Seed allowed email domains from environment variable
 * Reads ALLOWED_EMAIL_DOMAINS (comma-separated) and inserts them into the domains table
 * This function is idempotent - it won't create duplicate domains
 */
export async function seedAllowedEmailDomains() {
  try {
    const pool = getPostgresPool();
    if (!pool) {
      seedLogger.error("seed_domains_db_unavailable");
      return false;
    }

    const allowedDomainsEnv = process.env.ALLOWED_EMAIL_DOMAINS || "";

    // Parse comma-separated domains, trim whitespace, filter empty values
    const domainsToSeed = allowedDomainsEnv.
    split(",").
    map((d) => d.trim().toLowerCase()).
    filter((d) => d.length > 0);

    if (domainsToSeed.length === 0) {
      seedLogger.info("seed_domains_skipped_not_configured");


      return true; // Not an error, just nothing to seed
    }

    const client = await pool.connect();
    try {
      // Set a shorter statement timeout for this operation
      await client.query("SET statement_timeout = '5s'");

      let insertedCount = 0;
      let skippedCount = 0;

      // Insert each domain (idempotent - won't create duplicates)
      for (const domain of domainsToSeed) {
        try {
          const result = await client.query(
            `INSERT INTO domains (id, domain, active, created_at, updated_at)
             VALUES (gen_random_uuid()::text, $1, true, NOW(), NOW())
             ON CONFLICT (domain) DO UPDATE SET
               active = true,
               updated_at = NOW()
             RETURNING id`,
            [domain]
          );

          if (result.rows.length > 0) {
            // Check if this was an insert or update
            const existingCheck = await client.query(
              "SELECT created_at FROM domains WHERE domain = $1",
              [domain]
            );

            if (existingCheck.rows.length > 0) {
              // Check if it was just created (within last second) or updated
              const createdAt = new Date(existingCheck.rows[0].created_at);
              const now = new Date();
              const diffSeconds = (now - createdAt) / 1000;

              if (diffSeconds < 2) {
                insertedCount++;
                seedLogger.info("seed_domains_inserted");
              } else {
                skippedCount++;
                seedLogger.info("seed_domains_existing_activated");


              }
            }
          }
        } catch (err) {
          // Log but continue with other domains
          seedLogger.error("seed_domains_domain_failed");



        }
      }

      seedLogger.info("seed_domains_complete");


      return true;
    } finally {
      // Reset statement timeout
      try {
        await client.query("RESET statement_timeout");
      } catch (e) {

        // Ignore reset errors
      }client.release();
    }
  } catch (error) {
    // Don't log timeout errors as critical - they're expected in some cases
    if (error.code === "57014") {
      seedLogger.info("seed_domains_timeout");


    } else {
      seedLogger.error("seed_domains_domain_failed");
    }
    return false;
  }
}
