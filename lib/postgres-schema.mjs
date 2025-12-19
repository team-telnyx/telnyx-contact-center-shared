// PostgreSQL schema for Telnyx Contact Center
// This schema includes users table with skills-based routing configuration

export async function ensurePostgresSchema() {
  try {
    const { getPostgresPool } = await import("./postgres.mjs");
    const pool = getPostgresPool();
    if (!pool) return false;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Users table with contact center configuration
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          email TEXT UNIQUE,
          first_name TEXT,
          last_name TEXT,
          nick TEXT,
          language TEXT DEFAULT 'en-US',
          status TEXT DEFAULT 'Available',
          theme TEXT DEFAULT 'system',
          mobile TEXT,
          sms_number TEXT,
          voice_number TEXT,
          role TEXT DEFAULT 'user',
          verified BOOLEAN DEFAULT false,
          auth_strategy TEXT DEFAULT 'local',
          refresh_tokens JSONB,
          telephony_credentials_id TEXT,
          telephony_user_name TEXT,
          reset_password_token TEXT,
          reset_password_token_expires TIMESTAMPTZ,
          activation_token TEXT,
          activation_token_expires TIMESTAMPTZ,
          profile_picture_uri TEXT,
          hash TEXT,
          salt TEXT,
          iterations INTEGER,
          
          -- Contact Center specific fields
          -- Skills with proficiency levels (JSONB for flexibility)
          -- Format: {"skill_name": proficiency_level (1-10)}
          -- Example: {"sales": 8, "support": 6, "technical": 9}
          skills JSONB DEFAULT '{}'::jsonb,
          
          -- Agent availability status for contact center
          agent_status TEXT DEFAULT 'Available',
          
          -- Maximum concurrent calls this agent can handle
          max_concurrent_calls INTEGER DEFAULT 1,
          
          -- Agent groups this user belongs to (array of group IDs)
          agent_groups TEXT[] DEFAULT ARRAY[]::TEXT[],
          
          -- Preferred languages for routing (array of language codes)
          preferred_languages TEXT[] DEFAULT ARRAY['en-US']::TEXT[],
          
          -- Time zone for scheduling
          timezone TEXT DEFAULT 'UTC',
          
          -- Agent extension/phone number for internal routing
          extension TEXT,
          
          -- Whether agent is available for skills-based routing
          available_for_routing BOOLEAN DEFAULT true,
          
          -- Last activity timestamp
          last_activity TIMESTAMPTZ,
          
          -- Metadata for contact center configuration
          cc_config JSONB DEFAULT '{}'::jsonb,
          
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      // Create indexes for performance
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);
        CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
        CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);
        CREATE INDEX IF NOT EXISTS idx_users_status ON users (status);
        CREATE INDEX IF NOT EXISTS idx_users_agent_status ON users (agent_status);
        CREATE INDEX IF NOT EXISTS idx_users_available_for_routing ON users (available_for_routing);
        CREATE INDEX IF NOT EXISTS idx_users_agent_groups ON users USING GIN (agent_groups);
        CREATE INDEX IF NOT EXISTS idx_users_skills ON users USING GIN (skills);
        CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users (reset_password_token);
        CREATE INDEX IF NOT EXISTS idx_users_activation_token ON users (activation_token);
      `);

      // Skills table for managing available skills in the system
      await client.query(`
        CREATE TABLE IF NOT EXISTS skills (
          id TEXT PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          description TEXT,
          category TEXT,
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_skills_name ON skills (name);
        CREATE INDEX IF NOT EXISTS idx_skills_category ON skills (category);
        CREATE INDEX IF NOT EXISTS idx_skills_active ON skills (is_active);
      `);

      // Agent groups table
      await client.query(`
        CREATE TABLE IF NOT EXISTS agent_groups (
          id TEXT PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          description TEXT,
          skills_required JSONB DEFAULT '{}'::jsonb,
          max_agents INTEGER,
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_agent_groups_name ON agent_groups (name);
        CREATE INDEX IF NOT EXISTS idx_agent_groups_active ON agent_groups (is_active);
      `);

      // Domains table for email domain validation
      await client.query(`
        CREATE TABLE IF NOT EXISTS domains (
          id TEXT PRIMARY KEY,
          domain TEXT UNIQUE,
          active BOOLEAN DEFAULT true,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_domains_active ON domains (active);
      `);

      // NextAuth tables for authentication
      await client.query(`
        CREATE TABLE IF NOT EXISTS auth_users (
          id TEXT PRIMARY KEY,
          name TEXT,
          email TEXT UNIQUE,
          email_verified TIMESTAMPTZ,
          image TEXT
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS auth_accounts (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          type TEXT NOT NULL,
          provider TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          refresh_token TEXT,
          access_token TEXT,
          expires_at BIGINT,
          token_type TEXT,
          scope TEXT,
          id_token TEXT,
          session_state TEXT,
          oauth_token_secret TEXT,
          oauth_token TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT fk_auth_accounts_user FOREIGN KEY(user_id) REFERENCES auth_users(id) ON DELETE CASCADE
        );
      `);

      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_accounts_provider ON auth_accounts (provider, provider_account_id);
        CREATE INDEX IF NOT EXISTS idx_auth_accounts_user_id ON auth_accounts (user_id);
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS auth_sessions (
          id TEXT PRIMARY KEY,
          session_token TEXT UNIQUE,
          user_id TEXT NOT NULL,
          expires TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT fk_auth_sessions_user FOREIGN KEY(user_id) REFERENCES auth_users(id) ON DELETE CASCADE
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions (user_id);
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS auth_verification_tokens (
          identifier TEXT NOT NULL,
          token TEXT NOT NULL,
          expires TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(identifier, token)
        );
      `);

      await client.query("COMMIT");
      console.log("[Postgres] Schema created successfully");
      return true;
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[Postgres] Schema creation error:", err);
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("[Postgres] Failed to ensure schema:", err);
    return false;
  }
}
