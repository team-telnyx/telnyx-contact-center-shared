/**
 * Secrets Management System
 * Handles encrypted storage and retrieval of API keys and sensitive data
 * Simplified version for contact center app
 */

import crypto from "crypto";
import { getPostgresPool } from "./postgres.mjs";

const ALGORITHM = "aes-256-gcm";
const SECRET_KEY = process.env.SECRETS_ENCRYPTION_KEY;

// Validate and prepare encryption key
let ENCRYPTION_KEY_BUFFER = null;
if (SECRET_KEY) {
  try {
    // AES-256-GCM requires exactly 32 bytes (256 bits)
    // Hex encoding means we need 64 hex characters (2 chars per byte)
    const keyBuffer = Buffer.from(SECRET_KEY, "hex");
    if (keyBuffer.length < 32) {
      console.error(
        `[secrets] SECRETS_ENCRYPTION_KEY is too short. Expected 64 hex characters (32 bytes), got ${SECRET_KEY.length} characters (${keyBuffer.length} bytes).`
      );
      console.error(
        `[secrets] Generate a key with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
      );
    } else {
      ENCRYPTION_KEY_BUFFER = keyBuffer.slice(0, 32);
    }
  } catch (err) {
    console.error(
      "[secrets] SECRETS_ENCRYPTION_KEY must be a valid hex string:",
      err.message
    );
  }
}

// If no secret key, secrets functionality is disabled
if (!SECRET_KEY || !ENCRYPTION_KEY_BUFFER) {
  console.warn(
    "[secrets] SECRETS_ENCRYPTION_KEY not set or invalid - secret resolution will be disabled"
  );
}

/**
 * Get the encryption key buffer
 */
function getEncryptionKey() {
  if (!ENCRYPTION_KEY_BUFFER) {
    throw new Error(
      "SECRETS_ENCRYPTION_KEY not configured or invalid. It must be a hex-encoded string of at least 64 characters (32 bytes). Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  return ENCRYPTION_KEY_BUFFER;
}

/**
 * Encrypt a secret value
 */
function encryptSecret(value) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from("secrets", "utf8"));

  let encrypted = cipher.update(value, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag();

  return {
    encrypted: encrypted,
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
  };
}

/**
 * Decrypt a secret value
 */
function decryptSecret(encryptedData) {
  const key = getEncryptionKey();
  const { encrypted, iv, authTag } = encryptedData;

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, "hex")
  );
  decipher.setAAD(Buffer.from("secrets", "utf8"));
  decipher.setAuthTag(Buffer.from(authTag, "hex"));

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

/**
 * Create a new secret
 */
export async function createSecret(data) {
  if (!SECRET_KEY) {
    throw new Error("SECRETS_ENCRYPTION_KEY not configured");
  }

  const { name, description, value, expires_at, created_by } = data;

  if (!name || !value) {
    throw new Error("Name and value are required");
  }

  const pool = getPostgresPool();
  if (!pool) {
    throw new Error("Database connection not available");
  }

  const client = await pool.connect();
  try {
    // Check if secret with this name already exists
    const existing = await client.query(
      "SELECT id FROM secrets WHERE name = $1 AND deleted_at IS NULL",
      [name]
    );

    if (existing.rows.length > 0) {
      throw new Error("Secret with this name already exists");
    }

    // Encrypt the value
    const encryptedData = encryptSecret(value);

    const result = await client.query(
      `
      INSERT INTO secrets (name, description, encrypted_value, iv, auth_tag, expires_at, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, name, description, expires_at, created_at
    `,
      [
        name,
        description || "",
        encryptedData.encrypted,
        encryptedData.iv,
        encryptedData.authTag,
        expires_at || null,
        created_by || null,
      ]
    );

    return result.rows[0];
  } finally {
    client.release();
  }
}

/**
 * Get all secrets (without decrypted values)
 */
export async function upsertSecretByName({ name, description, value, expires_at, created_by }) {
  if (!SECRET_KEY) {
    throw new Error("SECRETS_ENCRYPTION_KEY not configured");
  }
  if (!name || !value) {
    throw new Error("Name and value are required");
  }
  const pool = getPostgresPool();
  if (!pool) {
    throw new Error("Database connection not available");
  }
  const encryptedData = encryptSecret(value);
  const result = await pool.query(
    `
      INSERT INTO secrets (name, description, encrypted_value, iv, auth_tag, expires_at, created_by, deleted_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
      ON CONFLICT (name) DO UPDATE
      SET description = EXCLUDED.description,
          encrypted_value = EXCLUDED.encrypted_value,
          iv = EXCLUDED.iv,
          auth_tag = EXCLUDED.auth_tag,
          expires_at = EXCLUDED.expires_at,
          deleted_at = NULL,
          updated_at = NOW()
      RETURNING id, name, description, expires_at, created_at, updated_at
    `,
    [
      name,
      description || "",
      encryptedData.encrypted,
      encryptedData.iv,
      encryptedData.authTag,
      expires_at || null,
      created_by || null,
    ]
  );
  return result.rows[0];
}

export async function getSecrets() {
  if (!SECRET_KEY) {
    return []; // Secrets disabled
  }

  const pool = getPostgresPool();
  if (!pool) {
    return [];
  }

  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT id, name, description, expires_at, created_at, updated_at
      FROM secrets 
      WHERE deleted_at IS NULL
      ORDER BY name
    `);

    return result.rows;
  } finally {
    client.release();
  }
}

/**
 * Get a secret by ID (without decrypted value)
 */
export async function getSecretById(id) {
  if (!SECRET_KEY) {
    return null; // Secrets disabled
  }

  const pool = getPostgresPool();
  if (!pool) {
    return null;
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      `
      SELECT id, name, description, expires_at, created_at, updated_at
      FROM secrets 
      WHERE id = $1 AND deleted_at IS NULL
    `,
      [id]
    );

    return result.rows[0] || null;
  } finally {
    client.release();
  }
}

/**
 * Get a secret by name (with decrypted value)
 */
export async function getSecretByName(name) {
  if (!SECRET_KEY) {
    return null; // Secrets disabled
  }

  const pool = getPostgresPool();
  if (!pool) {
    return null;
  }

  try {
    const result = await pool.query(
      `
      SELECT id, name, description, encrypted_value, iv, auth_tag, expires_at
      FROM secrets 
      WHERE name = $1 AND deleted_at IS NULL
    `,
      [name]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const secret = result.rows[0];

    // Check if expired
    if (secret.expires_at && new Date(secret.expires_at) < new Date()) {
      throw new Error(`Secret '${name}' has expired`);
    }

    // Decrypt the value
    const decryptedValue = decryptSecret({
      encrypted: secret.encrypted_value,
      iv: secret.iv,
      authTag: secret.auth_tag,
    });

    return {
      id: secret.id,
      name: secret.name,
      description: secret.description,
      value: decryptedValue,
      expires_at: secret.expires_at,
    };
  } catch (error) {
    console.error(`[secrets] Error getting secret '${name}':`, error);
    return null;
  }
}

/**
 * Update a secret
 */
export async function updateSecret(id, data) {
  if (!SECRET_KEY) {
    throw new Error("SECRETS_ENCRYPTION_KEY not configured");
  }

  const { name, description, value, expires_at } = data;

  let updateFields = [];
  let updateValues = [];
  let paramCount = 1;

  if (name !== undefined) {
    updateFields.push(`name = $${paramCount++}`);
    updateValues.push(name);
  }

  if (description !== undefined) {
    updateFields.push(`description = $${paramCount++}`);
    updateValues.push(description);
  }

  if (value !== undefined) {
    const encryptedData = encryptSecret(value);
    updateFields.push(`encrypted_value = $${paramCount++}`);
    updateFields.push(`iv = $${paramCount++}`);
    updateFields.push(`auth_tag = $${paramCount++}`);
    updateValues.push(encryptedData.encrypted);
    updateValues.push(encryptedData.iv);
    updateValues.push(encryptedData.authTag);
  }

  if (expires_at !== undefined) {
    updateFields.push(`expires_at = $${paramCount++}`);
    updateValues.push(expires_at);
  }

  updateFields.push(`updated_at = NOW()`);

  updateValues.push(id);

  const pool = getPostgresPool();
  if (!pool) {
    throw new Error("Database connection not available");
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      `
      UPDATE secrets 
      SET ${updateFields.join(", ")}
      WHERE id = $${paramCount} AND deleted_at IS NULL
      RETURNING id, name, description, expires_at, updated_at
    `,
      updateValues
    );

    return result.rows[0] || null;
  } finally {
    client.release();
  }
}

/**
 * Delete a secret (soft delete)
 */
export async function deleteSecret(id) {
  if (!SECRET_KEY) {
    throw new Error("SECRETS_ENCRYPTION_KEY not configured");
  }

  const pool = getPostgresPool();
  if (!pool) {
    throw new Error("Database connection not available");
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      `
      UPDATE secrets 
      SET deleted_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id, name
    `,
      [id]
    );

    return result.rows[0] || null;
  } finally {
    client.release();
  }
}

/**
 * Get secret names for dropdowns
 */
export async function getSecretNames() {
  const secrets = await getSecrets();
  return secrets.map((secret) => ({
    id: secret.id,
    name: secret.name,
    description: secret.description,
    expires_at: secret.expires_at,
  }));
}

/**
 * Resolve secret references in a string
 * Replaces {{#integration_secret}}SECRET_NAME{{/integration_secret}} with actual values
 */
export async function resolveSecretReferences(text) {
  if (!SECRET_KEY) {
    // If secrets are disabled, return text as-is
    return text;
  }

  if (!text || typeof text !== "string") {
    return text;
  }

  const secretPattern =
    /\{\{#integration_secret\}\}([^{}]+)\{\{\/integration_secret\}\}/g;
  let resolvedText = text;
  let match;

  while ((match = secretPattern.exec(text)) !== null) {
    const secretName = match[1].trim();

    try {
      const secret = await getSecretByName(secretName);
      if (secret) {
        resolvedText = resolvedText.replace(match[0], secret.value);
      } else {
        console.warn(`[secrets] Secret '${secretName}' not found`);
        // Keep the original reference if secret not found
      }
    } catch (error) {
      console.error(
        `[secrets] Error resolving secret '${secretName}':`,
        error.message
      );
      // Keep the original reference if there's an error
    }
  }

  return resolvedText;
}

/**
 * Resolve simple secret references in a string
 * Replaces {{secret_name}} with actual values
 * This is a simpler format for web page URLs
 */
export async function resolveSimpleSecretReferences(text) {
  if (!SECRET_KEY) {
    // If secrets are disabled, return text as-is
    return text;
  }

  if (!text || typeof text !== "string") {
    return text;
  }

  // Match {{secret_name}} pattern
  const secretPattern = /\{\{([a-zA-Z0-9_-]+)\}\}/g;
  let resolvedText = text;
  let match;

  while ((match = secretPattern.exec(text)) !== null) {
    const secretName = match[1].trim();

    try {
      const secret = await getSecretByName(secretName);
      if (secret) {
        // URL encode the secret value to ensure it's safe for URLs
        const encodedValue = encodeURIComponent(secret.value);
        resolvedText = resolvedText.replace(match[0], encodedValue);
      } else {
        console.warn(`[secrets] Secret '${secretName}' not found`);
        // Keep the original reference if secret not found
      }
    } catch (error) {
      console.error(
        `[secrets] Error resolving secret '${secretName}':`,
        error.message
      );
      // Keep the original reference if there's an error
    }
  }

  return resolvedText;
}
