function envFlagEnabled(value) {
  return ["1", "true", "yes", "on", "require", "required"].includes(
    String(value || "").trim().toLowerCase(),
  );
}

export function readPostgresSslConfig(env = process.env) {
  const sslMode = String(env.PGSSLMODE || env.POSTGRES_SSLMODE || "").trim().toLowerCase();
  const postgresSsl = String(env.POSTGRES_SSL || "").trim().toLowerCase();
  const databaseSsl = String(env.DATABASE_SSL || "").trim().toLowerCase();
  const explicitSsl = envFlagEnabled(postgresSsl) || envFlagEnabled(databaseSsl);

  if (["disable", "disabled"].includes(sslMode) || postgresSsl === "false" || databaseSsl === "false") {
    return false;
  }

  if (["verify-ca", "verify-full"].includes(sslMode)) {
    return { rejectUnauthorized: true };
  }

  if (explicitSsl || sslMode === "require") {
    return { rejectUnauthorized: envFlagEnabled(env.POSTGRES_SSL_REJECT_UNAUTHORIZED) };
  }

  return false;
}
