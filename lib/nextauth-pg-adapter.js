import { getPostgresPool } from "@/lib/postgres.mjs";
import { randomUUID } from "crypto";

function requirePostgresPool() {
  const pool = getPostgresPool();
  if (!pool) throw new Error("Postgres not configured");
  return pool;
}

export function PostgresNextAuthAdapter() {
  return {
    async createUser(data) {
      const id = data.id || randomUUID();
      await requirePostgresPool().query(
        `INSERT INTO auth_users (id, name, email, email_verified, image)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, image=EXCLUDED.image
        `,
        [
          id,
          data.name || null,
          data.email || null,
          data.emailVerified || null,
          data.image || null,
        ]
      );
      const r = await requirePostgresPool().query(
        `SELECT * FROM auth_users WHERE id=$1`,
        [id]
      );
      return r.rows?.[0] || null;
    },
    async getUser(id) {
      const r = await requirePostgresPool().query(
        `SELECT * FROM auth_users WHERE id=$1`,
        [id]
      );
      return r.rows?.[0] || null;
    },
    async getUserByEmail(email) {
      const r = await requirePostgresPool().query(
        `SELECT * FROM auth_users WHERE email=$1`,
        [email]
      );
      return r.rows?.[0] || null;
    },
    async getUserByAccount({ provider, providerAccountId }) {
      const r = await requirePostgresPool().query(
        `SELECT u.* FROM auth_users u
         JOIN auth_accounts a ON a.user_id=u.id
         WHERE a.provider=$1 AND a.provider_account_id=$2
         LIMIT 1`,
        [provider, providerAccountId]
      );
      return r.rows?.[0] || null;
    },
    async updateUser(data) {
      const fields = [];
      const values = [];
      let i = 1;
      for (const [k, v] of Object.entries({
        name: data.name,
        email: data.email,
        email_verified: data.emailVerified,
        image: data.image,
      })) {
        if (typeof v === "undefined") continue;
        fields.push(`${k}=$${i++}`);
        values.push(v);
      }
      values.push(data.id);
      await requirePostgresPool().query(
        `UPDATE auth_users SET ${fields.join(", ")} WHERE id=$${values.length}`,
        values
      );
      const r = await requirePostgresPool().query(
        `SELECT * FROM auth_users WHERE id=$1`,
        [data.id]
      );
      return r.rows?.[0] || null;
    },
    async deleteUser(id) {
      await requirePostgresPool().query(`DELETE FROM auth_users WHERE id=$1`, [
        id,
      ]);
    },
    async linkAccount(data) {
      const id = data.id || randomUUID();
      await requirePostgresPool().query(
        `INSERT INTO auth_accounts (
          id, user_id, type, provider, provider_account_id, refresh_token,
          access_token, expires_at, token_type, scope, id_token, session_state,
          oauth_token_secret, oauth_token
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
        ) ON CONFLICT (provider, provider_account_id) DO NOTHING`,
        [
          id,
          data.userId,
          data.type,
          data.provider,
          data.providerAccountId,
          data.refresh_token || null,
          data.access_token || null,
          data.expires_at || null,
          data.token_type || null,
          data.scope || null,
          data.id_token || null,
          data.session_state || null,
          data.oauth_token_secret || null,
          data.oauth_token || null,
        ]
      );
      return data;
    },
    async unlinkAccount({ provider, providerAccountId }) {
      await requirePostgresPool().query(
        `DELETE FROM auth_accounts WHERE provider=$1 AND provider_account_id=$2`,
        [provider, providerAccountId]
      );
    },
    async createSession(data) {
      const id = data.id || randomUUID();
      await requirePostgresPool().query(
        `INSERT INTO auth_sessions (id, session_token, user_id, expires)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (session_token) DO UPDATE SET user_id=EXCLUDED.user_id, expires=EXCLUDED.expires`,
        [id, data.sessionToken, data.userId, data.expires]
      );
      const r = await requirePostgresPool().query(`SELECT * FROM auth_sessions WHERE id=$1`, [
        id,
      ]);
      return {
        id: r.rows?.[0]?.id,
        sessionToken: r.rows?.[0]?.session_token,
        userId: r.rows?.[0]?.user_id,
        expires: r.rows?.[0]?.expires,
      };
    },
    async getSessionAndUser(sessionToken) {
      const r = await requirePostgresPool().query(
        `SELECT s.*, u.* FROM auth_sessions s JOIN auth_users u ON s.user_id=u.id WHERE s.session_token=$1 LIMIT 1`,
        [sessionToken]
      );
      const row = r.rows?.[0];
      if (!row) return null;
      const session = {
        id: row.id,
        sessionToken: row.session_token,
        userId: row.user_id,
        expires: row.expires,
      };
      const user = {
        id: row.user_id,
        name: row.name,
        email: row.email,
        emailVerified: row.email_verified,
        image: row.image,
      };
      return { session, user };
    },
    async updateSession(data) {
      await requirePostgresPool().query(
        `UPDATE auth_sessions SET user_id=$1, expires=$2 WHERE session_token=$3`,
        [data.userId, data.expires, data.sessionToken]
      );
      return data;
    },
    async deleteSession(sessionToken) {
      await requirePostgresPool().query(`DELETE FROM auth_sessions WHERE session_token=$1`, [
        sessionToken,
      ]);
    },
    async createVerificationToken(data) {
      await requirePostgresPool().query(
        `INSERT INTO auth_verification_tokens (identifier, token, expires) VALUES ($1,$2,$3)
         ON CONFLICT (identifier, token) DO UPDATE SET expires=EXCLUDED.expires`,
        [data.identifier, data.token, data.expires]
      );
      return data;
    },
    async useVerificationToken({ identifier, token }) {
      const r = await requirePostgresPool().query(
        `DELETE FROM auth_verification_tokens WHERE identifier=$1 AND token=$2 RETURNING *`,
        [identifier, token]
      );
      const row = r.rows?.[0];
      if (!row) return null;
      return {
        identifier: row.identifier,
        token: row.token,
        expires: row.expires,
      };
    },
  };
}
