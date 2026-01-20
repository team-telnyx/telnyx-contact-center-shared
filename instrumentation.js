export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Only run on server-side
    try {
      const { ensurePostgresSchema } = await import(
        "./lib/postgres-schema.mjs"
      );

      // Ensure schema is created/updated on startup
      // This runs once when the server starts
      console.log("[Instrumentation] Ensuring PostgreSQL schema...");
      const success = await ensurePostgresSchema();

      if (success) {
        console.log("[Instrumentation] PostgreSQL schema ensured successfully");
      } else {
        console.warn("[Instrumentation] Failed to ensure PostgreSQL schema");
      }
    } catch (error) {
      // Don't fail startup if schema initialization fails
      // It might fail if PostgreSQL is not available yet
      console.warn(
        "[Instrumentation] Error ensuring PostgreSQL schema:",
        error.message
      );
    }
  }
}
