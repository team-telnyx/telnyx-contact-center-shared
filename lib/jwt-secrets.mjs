const MINIMUM_SECRET_LENGTH = 32;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function resolveJwtSecrets(env = process.env) {
  const nextAuthSecret = clean(env.AUTH_SECRET) || clean(env.NEXTAUTH_SECRET);
  const sharedJwtSecret = clean(env.JWT_SECRET);
  return {
    nextAuthSecret,
    accessSecret:
      clean(env.ACCESS_JWT_SECRET) || sharedJwtSecret || nextAuthSecret,
    refreshSecret:
      clean(env.REFRESH_JWT_SECRET) || sharedJwtSecret || nextAuthSecret,
  };
}

export function validateJwtSecrets(env = process.env) {
  const secrets = resolveJwtSecrets(env);
  const invalid = Object.entries(secrets)
    .filter(([, value]) => value.length < MINIMUM_SECRET_LENGTH)
    .map(([name]) => name);

  if (invalid.length > 0) {
    throw new Error(
      `Authentication secrets are missing or shorter than ${MINIMUM_SECRET_LENGTH} characters: ${invalid.join(
        ", ",
      )}. Configure NEXTAUTH_SECRET (or AUTH_SECRET) and, preferably, distinct ACCESS_JWT_SECRET and REFRESH_JWT_SECRET values.`,
    );
  }

  return secrets;
}
