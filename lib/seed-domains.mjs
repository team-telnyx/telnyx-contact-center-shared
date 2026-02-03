import { getPostgresPool } from "./postgres.mjs";

/**
 * Seed allowed email domains from environment variable
 * Reads ALLOWED_EMAIL_DOMAINS (comma-separated) and inserts them into the domains table
 * This function is idempotent - it won't create duplicate domains
 */
export async function seedAllowedEmailDomains() {
  try {
    const pool = getPostgresPool();
    if (!pool) {
      console.error("[Seed Domains] Database connection failed");
      return false;
    }

    const allowedDomainsEnv = process.env.ALLOWED_EMAIL_DOMAINS || "";

    // Parse comma-separated domains, trim whitespace, filter empty values
    const domainsToSeed = allowedDomainsEnv
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter((d) => d.length > 0);

    if (domainsToSeed.length === 0) {
      console.log(
        "[Seed Domains] No ALLOWED_EMAIL_DOMAINS configured, skipping domain seeding"
      );
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
                console.log(`[Seed Domains] ✓ Inserted domain: ${domain}`);
              } else {
                skippedCount++;
                console.log(
                  `[Seed Domains] → Domain already exists (activated): ${domain}`
                );
              }
            }
          }
        } catch (err) {
          // Log but continue with other domains
          console.error(
            `[Seed Domains] Error seeding domain '${domain}':`,
            err.message
          );
        }
      }

      console.log(
        `[Seed Domains] Seeding completed: ${insertedCount} inserted, ${skippedCount} already existed`
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
        "[Seed Domains] Seeding skipped due to timeout (domains may already exist)"
      );
    } else {
      console.error("[Seed Domains] Error seeding domains:", error.message);
    }
    return false;
  }
}
