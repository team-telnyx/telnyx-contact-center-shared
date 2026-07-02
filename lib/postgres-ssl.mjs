import { readFileSync } from "node:fs";

function envFlagEnabled(value) {
  return ["1", "true", "yes", "on", "require", "required"].includes(
    String(value || "").trim().toLowerCase(),
  );
}

function readOptionalTlsFile(path) {
  if (!path) {
    return undefined;
  }

  return readFileSync(path, "utf8");
}

function readPostgresTlsFiles(env) {
  const tlsFiles = {
    ca: readOptionalTlsFile(env.PGSSLROOTCERT),
    cert: readOptionalTlsFile(env.PGSSLCERT),
    key: readOptionalTlsFile(env.PGSSLKEY),
  };

  return Object.fromEntries(Object.entries(tlsFiles).filter(([, value]) => value !== undefined));
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
    return { rejectUnauthorized: true, ...readPostgresTlsFiles(env) };
  }

  if (explicitSsl || ["require", "no-verify"].includes(sslMode)) {
    return { rejectUnauthorized: envFlagEnabled(env.POSTGRES_SSL_REJECT_UNAUTHORIZED) };
  }

  return false;
}
