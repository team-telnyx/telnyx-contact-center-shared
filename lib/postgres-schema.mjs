import { createDiagnosticLogger } from "./diagnostic-logger.mjs";

const schemaLogger = createDiagnosticLogger("platform.db");

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
          theme TEXT DEFAULT 'system',
          mobile TEXT,
          sms_number TEXT,
          voice_number TEXT,
          roles TEXT[] DEFAULT ARRAY['agent']::TEXT[], -- Multiple roles support
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
          
          -- Whether user is active (visible in lists and can be assigned to queues)
          active BOOLEAN DEFAULT true,
          
          -- Last activity timestamp
          last_activity TIMESTAMPTZ,
          
          -- Metadata for contact center configuration
          cc_config JSONB DEFAULT '{}'::jsonb,
          
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      // Remove legacy users.status so Contact Center routing/reporting cannot read
      // a stale duplicate of the authoritative cc_agent_state.agent_status value.
      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'users' AND column_name = 'status'
          ) THEN
            DROP INDEX IF EXISTS idx_users_status;
            ALTER TABLE users DROP COLUMN status;
            RAISE NOTICE 'Dropped legacy users.status column; cc_agent_state.agent_status is authoritative';
          END IF;
        END $$;
      `);

      // Add roles column if it doesn't exist (migration for existing databases)
      // This must run BEFORE creating indexes on the roles column
      await client.query(`
        DO $$ 
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'users' AND column_name = 'roles'
          ) THEN
            ALTER TABLE users ADD COLUMN roles TEXT[] DEFAULT ARRAY['agent']::TEXT[];
            -- Migrate existing role values to roles array
            UPDATE users SET roles = ARRAY[role] WHERE roles IS NULL OR array_length(roles, 1) IS NULL;
          END IF;
        END $$;
      `);

      // Remove role column (migration for existing databases)
      // This must run AFTER ensuring roles column exists and migrating data
      await client.query(`
        DO $$ 
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'users' AND column_name = 'role'
          ) THEN
            -- First, ensure any remaining role values are migrated to roles array
            UPDATE users 
            SET roles = ARRAY[role] 
            WHERE role IS NOT NULL 
              AND (roles IS NULL OR array_length(roles, 1) IS NULL OR array_length(roles, 1) = 0);
            
            -- Drop index on role column if it exists
            DROP INDEX IF EXISTS idx_users_role;
            
            -- Drop the role column
            ALTER TABLE users DROP COLUMN role;
            
            RAISE NOTICE 'Dropped role column and migrated values to roles array';
          END IF;
        END $$;
      `);

      // Add active column to users table if it doesn't exist (migration for existing databases)
      await client.query(`
        DO $$ 
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'users' AND column_name = 'active'
          ) THEN
            ALTER TABLE users ADD COLUMN active BOOLEAN DEFAULT true;
            -- Set all existing users as active by default
            UPDATE users SET active = true WHERE active IS NULL;
          END IF;
        END $$;
      `);

      // Create indexes for performance
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);
        CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
        CREATE INDEX IF NOT EXISTS idx_users_roles ON users USING GIN (roles);
        CREATE INDEX IF NOT EXISTS idx_users_available_for_routing ON users (available_for_routing);
        CREATE INDEX IF NOT EXISTS idx_users_active ON users (active);
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

      // App settings table for storing theme colors and branding
      await client.query(`
        CREATE TABLE IF NOT EXISTS app_settings (
          id TEXT PRIMARY KEY DEFAULT 'default',
          theme_colors JSONB DEFAULT '{"light": {}, "dark": {}}'::jsonb,
          theme_colors_hex JSONB DEFAULT '{"light": {}, "dark": {}}'::jsonb,
          brand_logo_uri TEXT,
          auth_right_image_uri TEXT,
          sidebar_logo_uri TEXT,
          updated_by TEXT,
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_app_settings_id ON app_settings (id);
      `);

      // Per-admin UI preferences for runtime logging filters
      await client.query(`
        CREATE TABLE IF NOT EXISTS app_logging_user_preferences (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          log_filters JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_app_logging_user_preferences_updated_at
        ON app_logging_user_preferences (updated_at);
      `);

      // Add theme_colors_hex column if it doesn't exist (migration for existing databases)
      await client.query(`
        DO $$ 
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'app_settings' AND column_name = 'theme_colors_hex'
          ) THEN
            ALTER TABLE app_settings ADD COLUMN theme_colors_hex JSONB DEFAULT '{"light": {}, "dark": {}}'::jsonb;
          END IF;
        END $$;
      `);

      // Contact Center Queues table
      await client.query(`
        CREATE TABLE IF NOT EXISTS cc_queues (
          id TEXT PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          display_name TEXT,
          description TEXT,
          routing_strategy TEXT DEFAULT 'FIFO' CHECK (routing_strategy IN ('FIFO', 'Skill-based', 'Priority-based')),
          max_wait_time_secs INTEGER DEFAULT 600,
          max_size INTEGER DEFAULT 100,
          timeout_secs INTEGER DEFAULT 300,
          overflow_queue_id TEXT,
          overflow_action TEXT DEFAULT 'transfer' CHECK (overflow_action IN ('transfer', 'voicemail', 'hangup')),
          priority INTEGER DEFAULT 0,
          enabled BOOLEAN DEFAULT true,
          active BOOLEAN DEFAULT true,
          skill_requirements JSONB DEFAULT '{}'::jsonb,
          priority_rules JSONB DEFAULT '[]'::jsonb,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT fk_overflow_queue FOREIGN KEY(overflow_queue_id) REFERENCES cc_queues(id) ON DELETE SET NULL
        );
      `);

      // Add active column to cc_queues table if it doesn't exist (migration for existing databases)
      await client.query(`
        DO $$ 
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'cc_queues' AND column_name = 'active'
          ) THEN
            ALTER TABLE cc_queues ADD COLUMN active BOOLEAN DEFAULT true;
            -- Set all existing queues as active by default
            UPDATE cc_queues SET active = true WHERE active IS NULL;
          END IF;
        END $$;
      `);

      // Add queue audio settings columns
      await client.query(`
        DO $$ 
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'cc_queues' AND column_name = 'queue_audio_media_name'
          ) THEN
            ALTER TABLE cc_queues ADD COLUMN queue_audio_media_name TEXT;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'cc_queues' AND column_name = 'queue_audio_enable_position'
          ) THEN
            ALTER TABLE cc_queues ADD COLUMN queue_audio_enable_position BOOLEAN DEFAULT false;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'cc_queues' AND column_name = 'queue_audio_position_interval_secs'
          ) THEN
            ALTER TABLE cc_queues ADD COLUMN queue_audio_position_interval_secs INTEGER DEFAULT 60;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'cc_queues' AND column_name = 'queue_audio_tts_voice'
          ) THEN
            ALTER TABLE cc_queues ADD COLUMN queue_audio_tts_voice TEXT;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'cc_queues' AND column_name = 'queue_audio_tts_voice_api_key_ref'
          ) THEN
            ALTER TABLE cc_queues ADD COLUMN queue_audio_tts_voice_api_key_ref TEXT;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'cc_queues' AND column_name = 'agent_answer_timeout_secs'
          ) THEN
            ALTER TABLE cc_queues ADD COLUMN agent_answer_timeout_secs INTEGER DEFAULT 30;
          END IF;
        END $$;
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_cc_queues_name ON cc_queues (name);
        CREATE INDEX IF NOT EXISTS idx_cc_queues_enabled ON cc_queues (enabled);
        CREATE INDEX IF NOT EXISTS idx_cc_queues_active ON cc_queues (active);
        CREATE INDEX IF NOT EXISTS idx_cc_queues_routing_strategy ON cc_queues (routing_strategy);
      `);

      // Wrapup Codes table - agent post-call selections
      await client.query(`
        CREATE TABLE IF NOT EXISTS cc_wrapup_codes (
          id TEXT PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          is_active BOOLEAN DEFAULT true,
          is_default BOOLEAN DEFAULT false,
          display_order INTEGER DEFAULT 0,
          description TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      // Add is_default column to cc_wrapup_codes if it doesn't exist (migration for existing databases)
      await client.query(`
        DO $$ 
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'cc_wrapup_codes' AND column_name = 'is_default'
          ) THEN
            ALTER TABLE cc_wrapup_codes ADD COLUMN is_default BOOLEAN DEFAULT false;
            UPDATE cc_wrapup_codes SET is_default = false WHERE is_default IS NULL;
          END IF;
        END $$;
      `);

      // Add icon and color columns to cc_wrapup_codes if they don't exist (migration for existing databases)
      await client.query(`
        DO $$ 
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'cc_wrapup_codes' AND column_name = 'icon'
          ) THEN
            ALTER TABLE cc_wrapup_codes ADD COLUMN icon TEXT;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'cc_wrapup_codes' AND column_name = 'color'
          ) THEN
            ALTER TABLE cc_wrapup_codes ADD COLUMN color TEXT;
          END IF;
        END $$;
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_wrapup_codes_active ON cc_wrapup_codes (is_active);
        CREATE INDEX IF NOT EXISTS idx_wrapup_codes_default ON cc_wrapup_codes (is_default);
        CREATE INDEX IF NOT EXISTS idx_wrapup_codes_display_order ON cc_wrapup_codes (display_order);
      `);

      // Queue-Wrapup Codes assignments table (many-to-many)
      await client.query(`
        CREATE TABLE IF NOT EXISTS cc_queue_wrapup_codes (
          id TEXT PRIMARY KEY,
          queue_id TEXT NOT NULL,
          wrapup_code_id TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT fk_queue_wrapup_queue FOREIGN KEY(queue_id) REFERENCES cc_queues(id) ON DELETE CASCADE,
          CONSTRAINT fk_queue_wrapup_code FOREIGN KEY(wrapup_code_id) REFERENCES cc_wrapup_codes(id) ON DELETE CASCADE,
          UNIQUE(queue_id, wrapup_code_id)
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_queue_wrapup_queue_id ON cc_queue_wrapup_codes (queue_id);
        CREATE INDEX IF NOT EXISTS idx_queue_wrapup_code_id ON cc_queue_wrapup_codes (wrapup_code_id);
      `);

      // Queue-User Assignments table (many-to-many)
      await client.query(`
        CREATE TABLE IF NOT EXISTS cc_queue_user_assignments (
          id TEXT PRIMARY KEY,
          queue_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          priority INTEGER DEFAULT 1 CHECK (priority >= 1 AND priority <= 5),
          enabled BOOLEAN DEFAULT true,
          activated_at TIMESTAMPTZ,
          deactivated_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT fk_queue_user_queue FOREIGN KEY(queue_id) REFERENCES cc_queues(id) ON DELETE CASCADE,
          CONSTRAINT fk_queue_user_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE(queue_id, user_id)
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_queue_user_queue_id ON cc_queue_user_assignments (queue_id);
        CREATE INDEX IF NOT EXISTS idx_queue_user_user_id ON cc_queue_user_assignments (user_id);
        CREATE INDEX IF NOT EXISTS idx_queue_user_enabled ON cc_queue_user_assignments (enabled);
      `);

      // User Sessions table - tracks login/logout sessions
      await client.query(`
        CREATE TABLE IF NOT EXISTS cc_user_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          session_token TEXT,
          login_at TIMESTAMPTZ NOT NULL,
          logout_at TIMESTAMPTZ,
          duration_seconds INTEGER,
          ip_address TEXT,
          user_agent TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT fk_user_sessions_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON cc_user_sessions (user_id);
        CREATE INDEX IF NOT EXISTS idx_user_sessions_login_at ON cc_user_sessions (login_at);
        CREATE INDEX IF NOT EXISTS idx_user_sessions_logout_at ON cc_user_sessions (logout_at);
        CREATE INDEX IF NOT EXISTS idx_user_sessions_session_token ON cc_user_sessions (session_token);
      `);

      // User Activity Log table - unified activity tracking
      await client.query(`
        CREATE TABLE IF NOT EXISTS cc_user_activity_log (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          activity_type TEXT NOT NULL CHECK (activity_type IN ('login', 'logout', 'status_change', 'queue_activate', 'queue_deactivate', 'call_start', 'call_end', 'break_start', 'break_end')),
          activity_value TEXT,
          previous_value TEXT,
          metadata JSONB DEFAULT '{}'::jsonb,
          interaction_id TEXT,
          queue_id TEXT,
          started_at TIMESTAMPTZ,
          ended_at TIMESTAMPTZ,
          duration_seconds INTEGER,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT fk_activity_log_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
          CONSTRAINT fk_activity_log_queue FOREIGN KEY(queue_id) REFERENCES cc_queues(id) ON DELETE SET NULL
        );
      `);

      // Add foreign key to cc_interactions if that table exists
      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'cc_interactions') THEN
            IF NOT EXISTS (
              SELECT 1 FROM information_schema.table_constraints 
              WHERE constraint_name = 'fk_activity_log_interaction' 
              AND table_name = 'cc_user_activity_log'
            ) THEN
              ALTER TABLE cc_user_activity_log
              ADD CONSTRAINT fk_activity_log_interaction 
              FOREIGN KEY(interaction_id) REFERENCES cc_interactions(id) ON DELETE SET NULL;
            END IF;
          END IF;
        END $$;
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_activity_log_user_id ON cc_user_activity_log (user_id);
        CREATE INDEX IF NOT EXISTS idx_activity_log_activity_type ON cc_user_activity_log (activity_type);
        CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON cc_user_activity_log (created_at);
        CREATE INDEX IF NOT EXISTS idx_activity_log_started_at ON cc_user_activity_log (started_at);
        CREATE INDEX IF NOT EXISTS idx_activity_log_user_type ON cc_user_activity_log (user_id, activity_type);
        CREATE INDEX IF NOT EXISTS idx_activity_log_interaction_id ON cc_user_activity_log (interaction_id);
        CREATE INDEX IF NOT EXISTS idx_activity_log_queue_id ON cc_user_activity_log (queue_id);
      `);

      // Agent status transition history - immutable transition ledger for exact reporting.
      // cc_user_time_tracking is an hourly aggregate; this table keeps the source events.
      await client.query(`
        CREATE TABLE IF NOT EXISTS cc_agent_status_history (
          id TEXT PRIMARY KEY,
          agent_username TEXT NOT NULL,
          status TEXT NOT NULL,
          previous_status TEXT,
          interaction_id TEXT,
          reason TEXT,
          duration_seconds INTEGER,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_agent_status_history_agent_username ON cc_agent_status_history (agent_username);
        CREATE INDEX IF NOT EXISTS idx_agent_status_history_status ON cc_agent_status_history (status);
        CREATE INDEX IF NOT EXISTS idx_agent_status_history_previous_status ON cc_agent_status_history (previous_status);
        CREATE INDEX IF NOT EXISTS idx_agent_status_history_created_at ON cc_agent_status_history (created_at);
        CREATE INDEX IF NOT EXISTS idx_agent_status_history_agent_created ON cc_agent_status_history (agent_username, created_at);
      `);

      // User Time Tracking table - aggregated time summaries for reporting
      await client.query(`
        CREATE TABLE IF NOT EXISTS cc_user_time_tracking (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          tracking_date DATE NOT NULL,
          tracking_hour INTEGER,
          logged_in_seconds INTEGER DEFAULT 0,
          active_seconds INTEGER DEFAULT 0,
          break_seconds INTEGER DEFAULT 0,
          call_seconds INTEGER DEFAULT 0,
          queue_active_seconds INTEGER DEFAULT 0,
          status_available_seconds INTEGER DEFAULT 0,
          status_busy_seconds INTEGER DEFAULT 0,
          status_away_seconds INTEGER DEFAULT 0,
          status_on_queue_seconds INTEGER DEFAULT 0,
          status_off_queue_seconds INTEGER DEFAULT 0,
          login_count INTEGER DEFAULT 0,
          status_change_count INTEGER DEFAULT 0,
          queue_activation_count INTEGER DEFAULT 0,
          queue_deactivation_count INTEGER DEFAULT 0,
          call_count INTEGER DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT fk_time_tracking_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE(user_id, tracking_date, tracking_hour)
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_time_tracking_user_id ON cc_user_time_tracking (user_id);
        CREATE INDEX IF NOT EXISTS idx_time_tracking_date ON cc_user_time_tracking (tracking_date);
        CREATE INDEX IF NOT EXISTS idx_time_tracking_user_date ON cc_user_time_tracking (user_id, tracking_date);
        CREATE INDEX IF NOT EXISTS idx_time_tracking_user_date_hour ON cc_user_time_tracking (user_id, tracking_date, tracking_hour);
      `);

      // Contact Center Interactions table - tracks all calls/interactions
      await client.query(`
        CREATE TABLE IF NOT EXISTS cc_interactions (
          id TEXT PRIMARY KEY,
          interaction_type TEXT DEFAULT 'voice' CHECK (interaction_type IN ('voice', 'sms', 'chat', 'email')),
          queue_name TEXT,
          queue_id TEXT,
          agent_username TEXT,
          call_control_id TEXT UNIQUE,
          call_session_id TEXT,
          direction TEXT CHECK (direction IN ('inbound', 'outbound')),
          state TEXT DEFAULT 'queued' CHECK (state IN ('queued', 'ringing', 'answered', 'connected', 'active', 'bridging', 'hold', 'completed', 'abandoned', 'failed', 'transferring')),
          is_contact_center BOOLEAN DEFAULT true,
          from_number TEXT,
          to_number TEXT,
          from_name TEXT,
          to_name TEXT,
          required_skills JSONB DEFAULT '{}'::jsonb,
          routing_metadata JSONB DEFAULT '{}'::jsonb,
          flow_id TEXT,
          enqueued_at TIMESTAMPTZ,
          assigned_at TIMESTAMPTZ,
          answered_at TIMESTAMPTZ,
          completed_at TIMESTAMPTZ,
          abandoned_at TIMESTAMPTZ,
          wait_time_seconds INTEGER DEFAULT 0,
          handle_time_seconds INTEGER DEFAULT 0,
          talk_time_seconds INTEGER DEFAULT 0,
          transfer_count INTEGER DEFAULT 0,
          transfer_history JSONB DEFAULT '[]'::jsonb,
          hold_count INTEGER DEFAULT 0,
          hold_duration_seconds INTEGER DEFAULT 0,
          recording_url TEXT,
          notes TEXT,
          tags JSONB DEFAULT '[]'::jsonb,
          wrapup_codes JSONB DEFAULT '[]'::jsonb,
          metadata JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT fk_interactions_queue FOREIGN KEY(queue_id) REFERENCES cc_queues(id) ON DELETE SET NULL
        );
      `);

      // Add wrapup_codes column to cc_interactions if it doesn't exist (migration for existing databases)
      await client.query(`
        DO $$ 
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'cc_interactions' AND column_name = 'wrapup_codes'
          ) THEN
            ALTER TABLE cc_interactions ADD COLUMN wrapup_codes JSONB DEFAULT '[]'::jsonb;
            UPDATE cc_interactions SET wrapup_codes = '[]'::jsonb WHERE wrapup_codes IS NULL;
          END IF;
        END $$;
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_interactions_queue_id ON cc_interactions (queue_id);
        CREATE INDEX IF NOT EXISTS idx_interactions_agent_username ON cc_interactions (agent_username);
        CREATE INDEX IF NOT EXISTS idx_interactions_call_control_id ON cc_interactions (call_control_id);
        CREATE INDEX IF NOT EXISTS idx_interactions_call_session_id ON cc_interactions (call_session_id);
        CREATE INDEX IF NOT EXISTS idx_interactions_state ON cc_interactions (state);
        CREATE INDEX IF NOT EXISTS idx_interactions_enqueued_at ON cc_interactions (enqueued_at);
        CREATE INDEX IF NOT EXISTS idx_interactions_created_at ON cc_interactions (created_at);
        CREATE INDEX IF NOT EXISTS idx_interactions_queue_state ON cc_interactions (queue_id, state);
      `);

      // Agent form builder tables - custom visual + AI generated JSON forms
      await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS form_definitions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          slug TEXT UNIQUE NOT NULL,
          description TEXT,
          category TEXT,
          status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
          version INTEGER NOT NULL DEFAULT 1,
          schema JSONB NOT NULL DEFAULT '{}'::jsonb,
          layout JSONB NOT NULL DEFAULT '{}'::jsonb,
          theme JSONB NOT NULL DEFAULT '{}'::jsonb,
          bindings JSONB NOT NULL DEFAULT '{}'::jsonb,
          actions JSONB NOT NULL DEFAULT '[]'::jsonb,
          queue_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          queue_names TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          auto_open BOOLEAN NOT NULL DEFAULT false,
          created_by TEXT,
          updated_by TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          published_at TIMESTAMPTZ
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS form_versions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          form_id UUID NOT NULL REFERENCES form_definitions(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          schema JSONB NOT NULL DEFAULT '{}'::jsonb,
          layout JSONB NOT NULL DEFAULT '{}'::jsonb,
          theme JSONB NOT NULL DEFAULT '{}'::jsonb,
          bindings JSONB NOT NULL DEFAULT '{}'::jsonb,
          actions JSONB NOT NULL DEFAULT '[]'::jsonb,
          created_by TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(form_id, version)
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS form_submissions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          form_id UUID NOT NULL REFERENCES form_definitions(id) ON DELETE RESTRICT,
          form_version INTEGER NOT NULL,
          interaction_id TEXT REFERENCES cc_interactions(id) ON DELETE SET NULL,
          call_control_id TEXT,
          call_session_id TEXT,
          queue_name TEXT,
          agent_username TEXT,
          status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'voided')),
          data JSONB NOT NULL DEFAULT '{}'::jsonb,
          context_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
          validation_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          submitted_at TIMESTAMPTZ
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS form_media_assets (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          filename TEXT NOT NULL,
          url TEXT NOT NULL UNIQUE,
          title TEXT,
          display_name TEXT,
          content_type TEXT,
          size_bytes BIGINT,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_form_definitions_status ON form_definitions (status);
        CREATE INDEX IF NOT EXISTS idx_form_definitions_slug ON form_definitions (slug);
        CREATE INDEX IF NOT EXISTS idx_form_definitions_category ON form_definitions (category);
        CREATE INDEX IF NOT EXISTS idx_form_definitions_queue_ids ON form_definitions USING GIN (queue_ids);
        CREATE INDEX IF NOT EXISTS idx_form_definitions_queue_names ON form_definitions USING GIN (queue_names);
        CREATE INDEX IF NOT EXISTS idx_form_versions_form_id ON form_versions (form_id);
        CREATE INDEX IF NOT EXISTS idx_form_submissions_form_id ON form_submissions (form_id);
        CREATE INDEX IF NOT EXISTS idx_form_submissions_interaction_id ON form_submissions (interaction_id);
        CREATE INDEX IF NOT EXISTS idx_form_submissions_call_control_id ON form_submissions (call_control_id);
        CREATE INDEX IF NOT EXISTS idx_form_submissions_queue_name ON form_submissions (queue_name);
        CREATE INDEX IF NOT EXISTS idx_form_submissions_status ON form_submissions (status);
        CREATE INDEX IF NOT EXISTS idx_form_submissions_data ON form_submissions USING GIN (data);
        CREATE INDEX IF NOT EXISTS idx_form_media_assets_url ON form_media_assets (url);
        CREATE INDEX IF NOT EXISTS idx_form_media_assets_filename ON form_media_assets (filename);
      `);

      // Outbound Dialer Phase 1 tables - UI/API scaffolding for future dialing workers.
      // Execution engines are intentionally not created here.
      await client.query(`
        CREATE TABLE IF NOT EXISTS outbound_contact_lists (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'validating', 'validated', 'archived')),
          source_type TEXT NOT NULL DEFAULT 'csv' CHECK (source_type IN ('csv', 'api', 'crm', 'manual')),
          custom_field_schema JSONB NOT NULL DEFAULT '[]'::jsonb,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          record_count INTEGER NOT NULL DEFAULT 0,
          valid_phone_count INTEGER NOT NULL DEFAULT 0,
          dnc_suppressed_count INTEGER NOT NULL DEFAULT 0,
          created_by TEXT,
          updated_by TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'outbound_contact_lists' AND column_name = 'metadata'
          ) THEN
            ALTER TABLE outbound_contact_lists ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
          END IF;
        END $$;
      `);


      await client.query(`
        CREATE TABLE IF NOT EXISTS outbound_campaigns (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'paused', 'running', 'stopped', 'completed', 'archived')),
          channel TEXT NOT NULL DEFAULT 'voice' CHECK (channel IN ('voice', 'sms', 'whatsapp')),
          mode TEXT NOT NULL DEFAULT 'preview' CHECK (mode IN ('preview', 'progressive', 'agentless_ai', 'agentless_flow', 'power', 'predictive')),
          handler_type TEXT NOT NULL DEFAULT 'queue' CHECK (handler_type IN ('queue', 'ai_assistant', 'call_flow')),
          handler_ref TEXT,
          contact_list_id UUID REFERENCES outbound_contact_lists(id) ON DELETE SET NULL,
          attached_form_id UUID REFERENCES form_definitions(id) ON DELETE SET NULL,
          pacing_config JSONB NOT NULL DEFAULT '{}'::jsonb,
          concurrency_config JSONB NOT NULL DEFAULT '{}'::jsonb,
          dialing_windows JSONB NOT NULL DEFAULT '[]'::jsonb,
          retry_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
          amd_config JSONB NOT NULL DEFAULT '{}'::jsonb,
          form_variable_mapping JSONB NOT NULL DEFAULT '[]'::jsonb,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_by TEXT,
          updated_by TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS outbound_contact_records (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          contact_list_id UUID NOT NULL REFERENCES outbound_contact_lists(id) ON DELETE CASCADE,
          row_data JSONB NOT NULL DEFAULT '{}'::jsonb,
          contact_methods JSONB NOT NULL DEFAULT '{}'::jsonb,
          validation_status TEXT NOT NULL DEFAULT 'needs_review' CHECK (validation_status IN ('valid', 'needs_review', 'suppressed')),
          last_attempt_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS outbound_campaign_agent_assignments (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          campaign_id UUID NOT NULL REFERENCES outbound_campaigns(id) ON DELETE CASCADE,
          agent_username TEXT NOT NULL,
          enabled BOOLEAN NOT NULL DEFAULT true,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE (campaign_id, agent_username)
        );
      `);


      // Contact List import storage simplification (2026-05): imported CSV values live in
      // outbound_contact_records.row_data JSONB, while list-level mapping/schema lives in
      // outbound_contact_lists.metadata.csv_import_settings + custom_field_schema. The old
      // standard/custom split was transitional and is removed after preserving existing data.
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'outbound_contact_records' AND column_name = 'row_data'
          ) THEN
            ALTER TABLE outbound_contact_records ADD COLUMN row_data JSONB NOT NULL DEFAULT '{}'::jsonb;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'outbound_contact_records' AND column_name = 'contact_methods'
          ) THEN
            ALTER TABLE outbound_contact_records ADD COLUMN contact_methods JSONB NOT NULL DEFAULT '{}'::jsonb;
          END IF;
        END $$;
      `);

      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'outbound_contact_records' AND column_name = 'standard_fields')
             AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'outbound_contact_records' AND column_name = 'custom_fields') THEN
            UPDATE outbound_contact_records
            SET row_data = COALESCE(row_data, '{}'::jsonb)
              || COALESCE(standard_fields, '{}'::jsonb)
              || COALESCE(custom_fields, '{}'::jsonb)
            WHERE COALESCE(row_data, '{}'::jsonb) = '{}'::jsonb;
          ELSIF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'outbound_contact_records' AND column_name = 'custom_fields') THEN
            UPDATE outbound_contact_records
            SET row_data = COALESCE(row_data, '{}'::jsonb) || COALESCE(custom_fields, '{}'::jsonb)
            WHERE COALESCE(row_data, '{}'::jsonb) = '{}'::jsonb;
          ELSIF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'outbound_contact_records' AND column_name = 'standard_fields') THEN
            UPDATE outbound_contact_records
            SET row_data = COALESCE(row_data, '{}'::jsonb) || COALESCE(standard_fields, '{}'::jsonb)
            WHERE COALESCE(row_data, '{}'::jsonb) = '{}'::jsonb;
          END IF;
        END $$;
      `);

      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'outbound_contact_records' AND column_name = 'phone_number'
          ) THEN
            UPDATE outbound_contact_records
            SET contact_methods = jsonb_build_object('number', jsonb_build_object('primary', phone_number))
            WHERE phone_number IS NOT NULL
              AND COALESCE(contact_methods, '{}'::jsonb) = '{}'::jsonb;
          END IF;
        END $$;
      `);

      await client.query(`
        DROP INDEX IF EXISTS idx_outbound_contact_records_standard_fields;
        DROP INDEX IF EXISTS idx_outbound_contact_records_custom_fields;
        DROP INDEX IF EXISTS idx_outbound_contact_records_phone_number;
        DROP INDEX IF EXISTS idx_outbound_contact_lists_custom_fields;
        ALTER TABLE outbound_contact_records DROP COLUMN IF EXISTS standard_fields;
        ALTER TABLE outbound_contact_records DROP COLUMN IF EXISTS custom_fields;
        ALTER TABLE outbound_contact_records DROP COLUMN IF EXISTS phone_number;
        ALTER TABLE outbound_contact_lists DROP COLUMN IF EXISTS standard_columns;
        ALTER TABLE outbound_contact_lists DROP COLUMN IF EXISTS custom_fields;
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS outbound_dnc_lists (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'archived')),
          source_type TEXT NOT NULL DEFAULT 'csv' CHECK (source_type IN ('csv', 'api', 'manual')),
          match_strategy TEXT NOT NULL DEFAULT 'phone' CHECK (match_strategy IN ('phone', 'email', 'phone_or_email')),
          record_count INTEGER NOT NULL DEFAULT 0,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_by TEXT,
          updated_by TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS outbound_dnc_entries (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          dnc_list_id UUID NOT NULL REFERENCES outbound_dnc_lists(id) ON DELETE CASCADE,
          value_type TEXT NOT NULL CHECK (value_type IN ('phone', 'email')),
          original_value TEXT NOT NULL,
          normalized_value TEXT NOT NULL,
          source_column TEXT,
          row_data JSONB NOT NULL DEFAULT '{}'::jsonb,
          source_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE (dnc_list_id, value_type, normalized_value)
        );
      `);


      await client.query(`
        CREATE TABLE IF NOT EXISTS outbound_contact_filters (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'archived')),
          contact_list_id UUID REFERENCES outbound_contact_lists(id) ON DELETE SET NULL,
          conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_by TEXT,
          updated_by TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS outbound_time_sets (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'archived')),
          timezone TEXT NOT NULL DEFAULT 'Europe/Warsaw',
          windows JSONB NOT NULL DEFAULT '[]'::jsonb,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_by TEXT,
          updated_by TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS outbound_attempt_controls (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'archived')),
          reset_period TEXT NOT NULL DEFAULT 'daily' CHECK (reset_period IN ('daily', 'weekly', 'monthly', 'campaign', 'lifetime')),
          timezone TEXT NOT NULL DEFAULT 'Europe/Warsaw',
          max_attempts_per_contact INTEGER NOT NULL DEFAULT 4,
          max_attempts_per_number INTEGER NOT NULL DEFAULT 2,
          recall_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
          phone_type_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_by TEXT,
          updated_by TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS outbound_disposition_code_mappings (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          wrapup_code_id TEXT NOT NULL REFERENCES cc_wrapup_codes(id) ON DELETE CASCADE,
          campaign_id UUID REFERENCES outbound_campaigns(id) ON DELETE CASCADE,
          classification TEXT NOT NULL DEFAULT 'none' CHECK (classification IN ('none', 'right_party_contact', 'number_uncallable', 'contact_uncallable', 'retry')),
          business_category TEXT NOT NULL DEFAULT 'none' CHECK (business_category IN ('none', 'success', 'neutral', 'failure')),
          retry_eligible BOOLEAN NOT NULL DEFAULT false,
          requires_callback BOOLEAN NOT NULL DEFAULT false,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'paused', 'archived')),
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_by TEXT,
          updated_by TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE (wrapup_code_id, campaign_id)
        );
      `);

      await client.query(`CREATE INDEX IF NOT EXISTS idx_outbound_disposition_code_mappings_status ON outbound_disposition_code_mappings (status);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_outbound_disposition_code_mappings_campaign ON outbound_disposition_code_mappings (campaign_id);`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_disposition_code_mappings_scope_unique ON outbound_disposition_code_mappings (wrapup_code_id, COALESCE(campaign_id, '00000000-0000-0000-0000-000000000000'::uuid));`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS outbound_settings (
          id TEXT PRIMARY KEY DEFAULT 'default',
          settings JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_by TEXT,
          updated_by TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS outbound_campaign_runs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          campaign_id UUID NOT NULL REFERENCES outbound_campaigns(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'paused', 'stopped', 'completed', 'failed')),
          started_by TEXT,
          stopped_by TEXT,
          stop_reason TEXT,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          started_at TIMESTAMPTZ DEFAULT NOW(),
          stopped_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS outbound_attempt_ledger (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          campaign_id UUID NOT NULL REFERENCES outbound_campaigns(id) ON DELETE CASCADE,
          run_id UUID REFERENCES outbound_campaign_runs(id) ON DELETE SET NULL,
          contact_record_id UUID REFERENCES outbound_contact_records(id) ON DELETE SET NULL,
          status TEXT NOT NULL CHECK (status IN ('claimed', 'dialing', 'answered', 'completed', 'failed', 'suppressed', 'skipped', 'cancelled')),
          channel TEXT NOT NULL DEFAULT 'voice' CHECK (channel IN ('voice', 'sms', 'whatsapp')),
          handler_type TEXT CHECK (handler_type IN ('queue', 'ai_assistant', 'call_flow')),
          handler_ref TEXT,
          claim_key TEXT,
          lease_expires_at TIMESTAMPTZ,
          call_control_id TEXT,
          call_session_id TEXT,
          attempt_reason TEXT,
          failure_reason TEXT,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS outbound_webhook_events (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          event_id TEXT NOT NULL,
          call_control_id TEXT,
          event_type TEXT,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(event_id)
        );
      `);

      // WS5-T1: fine-grained Appendix C dial-state lifecycle, additive to the
      // coarse status column used by the existing agentless runner.
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'outbound_attempt_ledger' AND column_name = 'dial_state'
          ) THEN
            ALTER TABLE outbound_attempt_ledger ADD COLUMN dial_state TEXT NOT NULL DEFAULT 'pending'
              CHECK (dial_state IN (
                'pending', 'dialing', 'ringing',
                'human', 'machine', 'no_answer', 'busy', 'failed',
                'connecting', 'connected', 'wrapup', 'disposed',
                'abandoned', 'voicemail_action', 'retry', 'exhausted'
              ));
          END IF;
        END $$;
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_outbound_attempt_ledger_dial_state
          ON outbound_attempt_ledger (campaign_id, dial_state);
      `);

      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'outbound_campaigns' AND column_name = 'attempt_control_id'
          ) THEN
            ALTER TABLE outbound_campaigns ADD COLUMN attempt_control_id UUID REFERENCES outbound_attempt_controls(id) ON DELETE SET NULL;
          END IF;
        END $$;
      `);

      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'outbound_campaigns_status_check'
              AND conrelid = 'outbound_campaigns'::regclass
          ) THEN
            ALTER TABLE outbound_campaigns DROP CONSTRAINT outbound_campaigns_status_check;
          END IF;
          ALTER TABLE outbound_campaigns
            ADD CONSTRAINT outbound_campaigns_status_check
            CHECK (status IN ('draft', 'ready', 'paused', 'running', 'stopped', 'completed', 'archived'));
        END $$;
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_outbound_contact_lists_status ON outbound_contact_lists (status);
        CREATE INDEX IF NOT EXISTS idx_outbound_contact_lists_custom_field_schema ON outbound_contact_lists USING GIN (custom_field_schema);
        CREATE INDEX IF NOT EXISTS idx_outbound_contact_lists_metadata ON outbound_contact_lists USING GIN (metadata);
        CREATE INDEX IF NOT EXISTS idx_outbound_campaigns_status ON outbound_campaigns (status);
        CREATE INDEX IF NOT EXISTS idx_outbound_campaigns_channel ON outbound_campaigns (channel);
        CREATE INDEX IF NOT EXISTS idx_outbound_campaigns_mode ON outbound_campaigns (mode);
        CREATE INDEX IF NOT EXISTS idx_outbound_campaigns_contact_list_id ON outbound_campaigns (contact_list_id);
        CREATE INDEX IF NOT EXISTS idx_outbound_campaigns_attached_form_id ON outbound_campaigns (attached_form_id);
        CREATE INDEX IF NOT EXISTS idx_outbound_campaigns_form_variable_mapping ON outbound_campaigns USING GIN (form_variable_mapping);
        CREATE INDEX IF NOT EXISTS idx_outbound_campaign_agent_assignments_agent ON outbound_campaign_agent_assignments (agent_username, enabled);
        CREATE INDEX IF NOT EXISTS idx_outbound_campaign_agent_assignments_campaign ON outbound_campaign_agent_assignments (campaign_id, enabled);
        CREATE INDEX IF NOT EXISTS idx_outbound_contact_records_list_id ON outbound_contact_records (contact_list_id);
        CREATE INDEX IF NOT EXISTS idx_outbound_contact_records_validation_status ON outbound_contact_records (validation_status);
        CREATE INDEX IF NOT EXISTS idx_outbound_contact_records_row_data ON outbound_contact_records USING GIN (row_data);
        CREATE INDEX IF NOT EXISTS idx_outbound_contact_records_contact_methods ON outbound_contact_records USING GIN (contact_methods);
        CREATE INDEX IF NOT EXISTS idx_outbound_dnc_lists_status ON outbound_dnc_lists (status);
        CREATE INDEX IF NOT EXISTS idx_outbound_dnc_lists_source_type ON outbound_dnc_lists (source_type);
        CREATE INDEX IF NOT EXISTS idx_outbound_dnc_lists_metadata ON outbound_dnc_lists USING GIN (metadata);
        CREATE INDEX IF NOT EXISTS idx_outbound_dnc_entries_list_lookup ON outbound_dnc_entries (dnc_list_id, value_type, normalized_value);
        CREATE INDEX IF NOT EXISTS idx_outbound_dnc_entries_normalized_lookup ON outbound_dnc_entries (value_type, normalized_value);
        CREATE INDEX IF NOT EXISTS idx_outbound_dnc_entries_row_data ON outbound_dnc_entries USING GIN (row_data);
        CREATE INDEX IF NOT EXISTS idx_outbound_contact_filters_status ON outbound_contact_filters (status);
        CREATE INDEX IF NOT EXISTS idx_outbound_contact_filters_contact_list_id ON outbound_contact_filters (contact_list_id);
        CREATE INDEX IF NOT EXISTS idx_outbound_contact_filters_conditions ON outbound_contact_filters USING GIN (conditions);
        CREATE INDEX IF NOT EXISTS idx_outbound_time_sets_status ON outbound_time_sets (status);
        CREATE INDEX IF NOT EXISTS idx_outbound_time_sets_windows ON outbound_time_sets USING GIN (windows);
        CREATE INDEX IF NOT EXISTS idx_outbound_attempt_controls_status ON outbound_attempt_controls (status);
        CREATE INDEX IF NOT EXISTS idx_outbound_attempt_controls_recall_rules ON outbound_attempt_controls USING GIN (recall_rules);
        CREATE INDEX IF NOT EXISTS idx_outbound_attempt_controls_phone_type_rules ON outbound_attempt_controls USING GIN (phone_type_rules);
        CREATE INDEX IF NOT EXISTS idx_outbound_campaigns_attempt_control_id ON outbound_campaigns (attempt_control_id);
        CREATE INDEX IF NOT EXISTS idx_outbound_campaign_runs_campaign_id ON outbound_campaign_runs (campaign_id);
        CREATE INDEX IF NOT EXISTS idx_outbound_campaign_runs_status ON outbound_campaign_runs (status);
        CREATE INDEX IF NOT EXISTS idx_outbound_attempt_ledger_campaign_id ON outbound_attempt_ledger (campaign_id);
        CREATE INDEX IF NOT EXISTS idx_outbound_attempt_ledger_run_id ON outbound_attempt_ledger (run_id);
        CREATE INDEX IF NOT EXISTS idx_outbound_attempt_ledger_record_id ON outbound_attempt_ledger (contact_record_id);
        CREATE INDEX IF NOT EXISTS idx_outbound_attempt_ledger_status_created ON outbound_attempt_ledger (status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_outbound_attempt_ledger_claim_key ON outbound_attempt_ledger (claim_key);
        CREATE INDEX IF NOT EXISTS idx_outbound_attempt_ledger_lease_expires_at ON outbound_attempt_ledger (lease_expires_at);
        CREATE INDEX IF NOT EXISTS idx_outbound_webhook_events_created_at ON outbound_webhook_events (created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_outbound_webhook_events_call_control_id ON outbound_webhook_events (call_control_id);
        CREATE INDEX IF NOT EXISTS idx_outbound_webhook_events_event_type ON outbound_webhook_events (event_type);
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS form_templates (
          slug TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          category TEXT,
          schema JSONB NOT NULL DEFAULT '{}'::jsonb,
          layout JSONB NOT NULL DEFAULT '{}'::jsonb,
          theme JSONB NOT NULL DEFAULT '{}'::jsonb,
          bindings JSONB NOT NULL DEFAULT '{}'::jsonb,
          actions JSONB NOT NULL DEFAULT '[]'::jsonb,
          queue_names TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          auto_open BOOLEAN NOT NULL DEFAULT false,
          active BOOLEAN NOT NULL DEFAULT true,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_form_templates_active ON form_templates (active);
        CREATE INDEX IF NOT EXISTS idx_form_templates_category ON form_templates (category);
      `);

      try {
        const { seedFormTemplateMediaAssets, seedFormTemplates } = await import("./forms/form-builder-seeds.js");
        await seedFormTemplateMediaAssets(client);
        await seedFormTemplates(client);
      } catch (err) {
        schemaLogger.warn("postgres_form_template_seed_skipped");
      }

      // Real-time Queue State table - tracks current queue positions and active calls
      await client.query(`
        CREATE TABLE IF NOT EXISTS cc_queue_state (
          queue_id TEXT PRIMARY KEY,
          queue_name TEXT NOT NULL,
          current_size INTEGER DEFAULT 0,
          longest_wait_seconds INTEGER DEFAULT 0,
          oldest_call_enqueued_at TIMESTAMPTZ,
          active_agents_count INTEGER DEFAULT 0,
          available_agents_count INTEGER DEFAULT 0,
          busy_agents_count INTEGER DEFAULT 0,
          last_updated TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT fk_queue_state_queue FOREIGN KEY(queue_id) REFERENCES cc_queues(id) ON DELETE CASCADE
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_queue_state_last_updated ON cc_queue_state (last_updated);
      `);

      // Queue Statistics table - aggregated statistics for reporting
      await client.query(`
        CREATE TABLE IF NOT EXISTS cc_queue_statistics (
          id TEXT PRIMARY KEY,
          queue_id TEXT NOT NULL,
          stat_date DATE NOT NULL,
          stat_hour INTEGER,
          total_calls INTEGER DEFAULT 0,
          answered_calls INTEGER DEFAULT 0,
          abandoned_calls INTEGER DEFAULT 0,
          avg_wait_time_seconds NUMERIC(10,2) DEFAULT 0,
          max_wait_time_seconds INTEGER DEFAULT 0,
          avg_handle_time_seconds NUMERIC(10,2) DEFAULT 0,
          avg_talk_time_seconds NUMERIC(10,2) DEFAULT 0,
          service_level_percentage NUMERIC(5,2) DEFAULT 0,
          service_level_threshold_seconds INTEGER DEFAULT 20,
          peak_queue_size INTEGER DEFAULT 0,
          total_wait_time_seconds INTEGER DEFAULT 0,
          total_handle_time_seconds INTEGER DEFAULT 0,
          total_talk_time_seconds INTEGER DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT fk_queue_statistics_queue FOREIGN KEY(queue_id) REFERENCES cc_queues(id) ON DELETE CASCADE,
          UNIQUE(queue_id, stat_date, stat_hour)
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_queue_statistics_queue_id ON cc_queue_statistics (queue_id);
        CREATE INDEX IF NOT EXISTS idx_queue_statistics_date ON cc_queue_statistics (stat_date);
        CREATE INDEX IF NOT EXISTS idx_queue_statistics_queue_date ON cc_queue_statistics (queue_id, stat_date);
        CREATE INDEX IF NOT EXISTS idx_queue_statistics_queue_date_hour ON cc_queue_statistics (queue_id, stat_date, stat_hour);
      `);

      // Agent Real-time State table - tracks current agent availability and capacity
      await client.query(`
        CREATE TABLE IF NOT EXISTS cc_agent_state (
          user_id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          agent_status TEXT DEFAULT 'Available',
          current_calls_count INTEGER DEFAULT 0,
          max_concurrent_calls INTEGER DEFAULT 1,
          is_available_for_routing BOOLEAN DEFAULT true,
          active_queue_ids TEXT[] DEFAULT ARRAY[]::TEXT[],
          last_status_change TIMESTAMPTZ DEFAULT NOW(),
          last_activity TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT fk_agent_state_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );
      `);

      // Remove legacy users.agent_status after preserving any missing values in
      // cc_agent_state. Contact Center runtime status must have exactly one DB
      // source of truth: cc_agent_state.agent_status.
      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'users' AND column_name = 'agent_status'
          ) THEN
            INSERT INTO cc_agent_state (
              user_id,
              username,
              agent_status,
              max_concurrent_calls,
              is_available_for_routing,
              last_status_change,
              last_activity
            )
            SELECT
              u.id,
              u.username,
              COALESCE(u.agent_status, 'Available'),
              COALESCE(u.max_concurrent_calls, 1),
              COALESCE(u.available_for_routing, true),
              NOW(),
              NOW()
            FROM users u
            WHERE NOT EXISTS (
              SELECT 1 FROM cc_agent_state ast WHERE ast.user_id = u.id
            );

            DROP INDEX IF EXISTS idx_users_agent_status;
            ALTER TABLE users DROP COLUMN agent_status;
            RAISE NOTICE 'Dropped legacy users.agent_status column; cc_agent_state.agent_status is authoritative';
          END IF;
        END $$;
      `);

      // Drop the old check constraint if it exists
      // This allows any status value from cc_user_statuses table
      await client.query(`
        DO $$ 
        BEGIN
          -- Drop old check constraint if it exists
          IF EXISTS (
            SELECT 1 FROM pg_constraint 
            WHERE conname = 'cc_agent_state_agent_status_check'
            AND conrelid = 'cc_agent_state'::regclass
          ) THEN
            ALTER TABLE cc_agent_state DROP CONSTRAINT cc_agent_state_agent_status_check;
            RAISE NOTICE 'Dropped constraint cc_agent_state_agent_status_check';
          END IF;
        EXCEPTION
          WHEN OTHERS THEN
            RAISE NOTICE 'Error dropping constraint: %', SQLERRM;
        END $$;
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_agent_state_status ON cc_agent_state (agent_status);
        CREATE INDEX IF NOT EXISTS idx_agent_state_available ON cc_agent_state (is_available_for_routing);
        CREATE INDEX IF NOT EXISTS idx_agent_state_status_available ON cc_agent_state (agent_status, is_available_for_routing);
      `);

      // Routing foundation columns for server-authoritative status / wrapup.
      await client.query(`
        ALTER TABLE cc_agent_state ADD COLUMN IF NOT EXISTS wrapup_expires_at TIMESTAMPTZ;
        ALTER TABLE cc_agent_state ADD COLUMN IF NOT EXISTS status_reason TEXT;
        ALTER TABLE cc_agent_state ADD COLUMN IF NOT EXISTS active_channel TEXT;
      `);

      // Agent reservation table - leased claims on agent capacity for routing and outbound dialing.
      await client.query(`
        CREATE TABLE IF NOT EXISTS cc_agent_reservations (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          channel TEXT NOT NULL CHECK (channel IN ('inbound', 'outbound', 'consult')),
          state TEXT NOT NULL CHECK (state IN ('reserved', 'ringing', 'active', 'released')),
          interaction_id TEXT,
          attempt_id TEXT,
          queue_id TEXT,
          campaign_id TEXT,
          reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          lease_expires_at TIMESTAMPTZ NOT NULL,
          released_at TIMESTAMPTZ,
          CONSTRAINT fk_agent_reservations_agent FOREIGN KEY(agent_id) REFERENCES users(id) ON DELETE CASCADE
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_resv_agent_active
          ON cc_agent_reservations (agent_id) WHERE state IN ('reserved', 'ringing', 'active');
        CREATE INDEX IF NOT EXISTS idx_resv_lease
          ON cc_agent_reservations (lease_expires_at) WHERE state IN ('reserved', 'ringing');
        CREATE INDEX IF NOT EXISTS idx_resv_interaction
          ON cc_agent_reservations (interaction_id) WHERE interaction_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_resv_attempt
          ON cc_agent_reservations (attempt_id) WHERE attempt_id IS NOT NULL;
      `);

      // DB-backed idempotency for Telnyx webhooks and internal transition events.
      await client.query(`
        CREATE TABLE IF NOT EXISTS cc_processed_events (
          event_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_processed_events_created_at ON cc_processed_events (created_at);
        CREATE INDEX IF NOT EXISTS idx_processed_events_kind ON cc_processed_events (kind);
      `);

      // DB-backed coordinator leases for HA-safe periodic contact-center work.
      await client.query(`
        CREATE TABLE IF NOT EXISTS cc_coordinator_leases (
          lease_name TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          lease_expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_coordinator_leases_expires_at
          ON cc_coordinator_leases (lease_expires_at);
      `);

      // User Statuses table - manages available status types (Available, Busy, Away, Offline, Break, etc.)
      await client.query(`
        CREATE TABLE IF NOT EXISTS cc_user_statuses (
          id TEXT PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('active', 'break')),
          is_active BOOLEAN DEFAULT true,
          user_selectable BOOLEAN DEFAULT true,
          icon TEXT,
          color TEXT,
          display_order INTEGER DEFAULT 0,
          description TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      await client.query(`
        ALTER TABLE cc_user_statuses
        ADD COLUMN IF NOT EXISTS user_selectable BOOLEAN DEFAULT true;
      `);

      await client.query(`
        ALTER TABLE cc_user_statuses
        ADD COLUMN IF NOT EXISTS icon TEXT;
      `);

      await client.query(`
        ALTER TABLE cc_user_statuses
        ADD COLUMN IF NOT EXISTS color TEXT;
      `);

      await client.query(`
        UPDATE cc_user_statuses
        SET user_selectable = true
        WHERE user_selectable IS NULL;
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_user_statuses_type ON cc_user_statuses (type);
        CREATE INDEX IF NOT EXISTS idx_user_statuses_active ON cc_user_statuses (is_active);
        CREATE INDEX IF NOT EXISTS idx_user_statuses_display_order ON cc_user_statuses (display_order);
      `);

      // Seed default statuses
      // Use ON CONFLICT (name) to handle both id and name conflicts
      await client.query(`
        INSERT INTO cc_user_statuses (id, name, type, is_active, user_selectable, icon, color, display_order, description)
        VALUES 
          ('available', 'Available', 'active', true, true, 'check', '#16a34a', 1, 'Agent is available to take calls'),
          ('busy', 'Busy', 'active', true, false, 'x', '#dc2626', 2, 'Agent is busy handling calls'),
          ('away', 'Away', 'active', true, true, 'circle-off', '#f97316', 3, 'Agent is away from desk'),
          ('offline', 'Offline', 'active', true, false, 'circle-off', '#f43f5e', 4, 'Agent is offline'),
          ('break', 'Break', 'break', true, true, 'clock', '#eab308', 5, 'Agent is on break'),
          ('wrapup', 'Wrapup', 'break', true, false, 'clock', '#0ea5e9', 6, 'Agent is finishing wrapup'),
          ('lunch', 'Lunch', 'break', true, true, 'coffee', '#eab308', 7, 'Agent is on lunch break'),
          ('vacation', 'Vacation', 'break', true, true, 'plane', '#0ea5e9', 8, 'Agent is on vacation'),
          ('sick', 'Sick', 'break', true, true, 'heartbeat', '#dc2626', 9, 'Agent is out sick'),
          ('training', 'Training', 'break', true, true, 'school', '#7c3aed', 10, 'Agent is in training'),
          ('agent-not-answering', 'Agent Not Answering', 'active', true, false, 'phone-off', '#dc2626', 11, 'Agent did not answer call within timeout period'),
          ('on-outbound-call', 'On Outbound Call', 'active', true, false, 'phone-call', '#7c3aed', 12, 'Agent is handling an outbound call')
        ON CONFLICT (name) DO UPDATE SET
          id = EXCLUDED.id,
          type = EXCLUDED.type,
          is_active = EXCLUDED.is_active,
          user_selectable = EXCLUDED.user_selectable,
          icon = EXCLUDED.icon,
          color = EXCLUDED.color,
          display_order = EXCLUDED.display_order,
          description = EXCLUDED.description,
          updated_at = NOW();
      `);

      // Seed default wrapup code
      await client.query(`
        INSERT INTO cc_wrapup_codes (id, name, is_active, is_default, display_order, description, icon, color)
        VALUES ('default', 'Default', true, true, 0, 'Default wrapup code when no selection is made', 'circle-off', '#64748b')
        ON CONFLICT (id) DO NOTHING;
      `);

      // Seed predefined wrapup codes
      await client.query(`
        INSERT INTO cc_wrapup_codes (id, name, is_active, is_default, display_order, description, icon, color)
        VALUES 
          ('general-inquiry', 'General Inquiry', true, false, 1, 'Customer requested information only.', 'info', '#0ea5e9'),
          ('billing-problem', 'Billing Problem/Question', true, false, 2, 'Related to invoicing or payments.', 'briefcase', '#dc2626'),
          ('technical-issue', 'Technical Issue/Support', true, false, 3, 'Troubleshooting or product help.', 'tool', '#f97316'),
          ('complaint', 'Complaint/Dissatisfied Customer', true, false, 4, 'Issue requiring escalation or feedback.', 'alert-circle', '#dc2626'),
          ('order-completed', 'Order/Sale Completed', true, false, 5, 'A successful transaction.', 'check', '#16a34a'),
          ('service-request', 'Service Request/Follow-up Required', true, false, 6, 'Further action needed.', 'clock', '#0ea5e9'),
          ('account-update', 'Account Update', true, false, 7, 'Change of address, phone, or personal details.', 'user', '#6366f1'),
          ('general-feedback', 'General Feedback', true, false, 8, 'Surveys or general comments.', 'message', '#7c3aed'),
          ('sale-lead', 'Sale/Lead Generated', true, false, 9, 'Successful conversion.', 'star', '#16a34a'),
          ('no-answer', 'No Answer/Busy Signal', true, false, 10, 'Call did not connect.', 'phone-off', '#64748b'),
          ('voicemail', 'Left Voicemail', true, false, 11, 'Reached automated system.', 'mail', '#0ea5e9'),
          ('wrong-number', 'Wrong Number/Disconnected', true, false, 12, 'Invalid contact info.', 'x', '#f97316'),
          ('dnc-request', 'Do Not Call (DNC) Request', true, false, 13, 'Customer requested removal.', 'bell-off', '#dc2626'),
          ('not-interested', 'Not Interested', true, false, 14, 'Lead rejected.', 'user-x', '#64748b'),
          ('callback-scheduled', 'Callback Scheduled', true, false, 15, 'Appointment set for later.', 'calendar-time', '#0ea5e9'),
          ('dropped-call', 'Dropped Call', true, false, 16, 'Call interrupted technical failure.', 'phone-off', '#dc2626')
        ON CONFLICT (id) DO NOTHING;
      `);

      await client.query(`
        INSERT INTO outbound_disposition_code_mappings (wrapup_code_id, campaign_id, classification, business_category, retry_eligible, requires_callback, status, metadata)
        SELECT * FROM (VALUES
          ('order-completed', NULL::uuid, 'right_party_contact', 'success', false, false, 'active', jsonb_build_object('seeded', true)),
          ('sale-lead', NULL::uuid, 'right_party_contact', 'success', false, false, 'active', jsonb_build_object('seeded', true)),
          ('not-interested', NULL::uuid, 'right_party_contact', 'failure', false, false, 'active', jsonb_build_object('seeded', true)),
          ('callback-scheduled', NULL::uuid, 'retry', 'none', true, true, 'active', jsonb_build_object('seeded', true)),
          ('no-answer', NULL::uuid, 'retry', 'none', true, false, 'active', jsonb_build_object('seeded', true)),
          ('voicemail', NULL::uuid, 'retry', 'none', true, false, 'active', jsonb_build_object('seeded', true)),
          ('wrong-number', NULL::uuid, 'number_uncallable', 'none', false, false, 'active', jsonb_build_object('seeded', true)),
          ('dnc-request', NULL::uuid, 'contact_uncallable', 'none', false, false, 'active', jsonb_build_object('seeded', true))
        ) AS defaults(wrapup_code_id, campaign_id, classification, business_category, retry_eligible, requires_callback, status, metadata)
        WHERE NOT EXISTS (
          SELECT 1 FROM outbound_disposition_code_mappings existing
          WHERE existing.wrapup_code_id = defaults.wrapup_code_id AND existing.campaign_id IS NULL
        );
      `);

      // Voice Flow Builder Tables
      await client.query(`
        CREATE TABLE IF NOT EXISTS voice_flows (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          
          -- Telnyx Voice Application integration
          telnyx_voice_app_id TEXT, -- Telnyx Call Control Application ID
          webhook_url TEXT, -- Unique webhook URL for this flow
          
          -- Flow definition
          nodes JSONB NOT NULL,
          edges JSONB NOT NULL,
          variables JSONB DEFAULT '{}',
          metadata JSONB DEFAULT '{}',
          
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_voice_flows_username ON voice_flows (username);
        CREATE INDEX IF NOT EXISTS idx_voice_flows_telnyx_app_id ON voice_flows (telnyx_voice_app_id);
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS voice_flow_phone_numbers (
          id TEXT PRIMARY KEY,
          flow_id TEXT NOT NULL REFERENCES voice_flows(id) ON DELETE CASCADE,
          phone_number_id TEXT NOT NULL, -- Telnyx phone number ID
          phone_number TEXT NOT NULL, -- E.164 format (e.g., +13125551234)
          assigned_at TIMESTAMPTZ DEFAULT NOW(),
          assigned_by TEXT, -- Username who assigned the number
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(flow_id, phone_number_id)
        );
        CREATE INDEX IF NOT EXISTS idx_flow_phone_numbers_flow_id ON voice_flow_phone_numbers (flow_id);
        CREATE INDEX IF NOT EXISTS idx_flow_phone_numbers_phone_number_id ON voice_flow_phone_numbers (phone_number_id);
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS voice_flow_executions (
          id TEXT PRIMARY KEY,
          flow_id TEXT NOT NULL,
          call_control_id TEXT NOT NULL,
          current_node_id TEXT,
          variables JSONB DEFAULT '{}',
          execution_history JSONB DEFAULT '[]',
          status TEXT DEFAULT 'active',
          started_at TIMESTAMPTZ DEFAULT NOW(),
          completed_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS idx_voice_flow_executions_call_control_id ON voice_flow_executions (call_control_id);
        CREATE INDEX IF NOT EXISTS idx_voice_flow_executions_flow_id ON voice_flow_executions (flow_id);
      `);

      // Do not seed Form Builder data-action voice flows during schema initialization.
      // These flows are editable user data and must not be recreated/overwritten on deploy.

      // Secrets Management Table
      await client.query(`
        CREATE TABLE IF NOT EXISTS secrets (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) UNIQUE NOT NULL,
          description TEXT,
          encrypted_value TEXT NOT NULL,
          iv VARCHAR(32) NOT NULL,
          auth_tag VARCHAR(32) NOT NULL,
          expires_at TIMESTAMP WITH TIME ZONE,
          created_by TEXT REFERENCES users(id),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          deleted_at TIMESTAMP WITH TIME ZONE
        );
        CREATE INDEX IF NOT EXISTS idx_secrets_name ON secrets(name) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_secrets_expires ON secrets(expires_at) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_secrets_created_by ON secrets(created_by) WHERE deleted_at IS NULL;
      `);

      // Local MCP server registry for Contact Center call-flow runtime.
      // This is intentionally independent from Telnyx /ai/mcp_servers because
      // Contact Center executes MCP calls itself and must own runtime auth + schema cache.
      await client.query(`
        CREATE TABLE IF NOT EXISTS mcp_servers (
          id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          name TEXT NOT NULL,
          description TEXT,
          type TEXT NOT NULL DEFAULT 'sse' CHECK (type IN ('sse', 'http')),
          url TEXT NOT NULL,
          auth_type TEXT NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'bearer', 'api_key', 'custom_header', 'oauth_client_credentials', 'oauth_authorization_code')),
          auth_header_name TEXT,
          auth_scheme TEXT,
          auth_secret_name TEXT,
          headers JSONB NOT NULL DEFAULT '{}'::jsonb,
          allowed_tools JSONB NOT NULL DEFAULT '[]'::jsonb,
          enabled BOOLEAN NOT NULL DEFAULT true,
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          deleted_at TIMESTAMPTZ
        );

        CREATE TABLE IF NOT EXISTS mcp_server_tools (
          id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          mcp_server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          title TEXT,
          description TEXT,
          input_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
          output_schema JSONB,
          schema_hash TEXT,
          enabled BOOLEAN NOT NULL DEFAULT true,
          last_discovered_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (mcp_server_id, name)
        );

        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'mcp_servers_auth_type_check'
              AND conrelid = 'mcp_servers'::regclass
          ) THEN
            ALTER TABLE mcp_servers DROP CONSTRAINT mcp_servers_auth_type_check;
          END IF;
          ALTER TABLE mcp_servers
            ADD CONSTRAINT mcp_servers_auth_type_check
            CHECK (auth_type IN ('none', 'bearer', 'api_key', 'custom_header', 'oauth_client_credentials', 'oauth_authorization_code'));
        END $$;

        CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers(enabled) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_mcp_servers_name ON mcp_servers(name) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_mcp_server_tools_server ON mcp_server_tools(mcp_server_id) WHERE enabled = true;
        CREATE INDEX IF NOT EXISTS idx_mcp_server_tools_schema_hash ON mcp_server_tools(schema_hash);
      `);

      // Contacts Table - Contact management with separate phone and email columns
      await client.query(`
        CREATE TABLE IF NOT EXISTS contacts (
          id TEXT PRIMARY KEY,
          first_name TEXT,
          last_name TEXT,
          display_name TEXT,
          company_name TEXT,
          job_title TEXT,
          department TEXT,
          
          -- Phone numbers as separate columns
          phone TEXT,
          mobile TEXT,
          business_phone_1 TEXT,
          business_phone_2 TEXT,
          home_phone_1 TEXT,
          home_phone_2 TEXT,
          
          -- Email addresses as separate columns
          email_address_1 TEXT,
          email_address_2 TEXT,
          
          -- Address information
          address_street TEXT,
          address_city TEXT,
          address_state TEXT,
          address_zip TEXT,
          address_country TEXT,
          
          -- Notes and additional information
          notes TEXT,
          custom_data JSONB DEFAULT '{}'::jsonb,
          
          -- Relationship to contact center
          last_interaction_at TIMESTAMPTZ,
          interaction_count INTEGER DEFAULT 0,
          
          -- Metadata
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          deleted_at TIMESTAMPTZ
        );
      `);

      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'contacts' AND column_name = 'custom_data'
          ) THEN
            ALTER TABLE contacts ADD COLUMN custom_data JSONB DEFAULT '{}'::jsonb;
          END IF;
          UPDATE contacts SET custom_data = '{}'::jsonb WHERE custom_data IS NULL;
        END $$;
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_contacts_first_name ON contacts (first_name) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_contacts_last_name ON contacts (last_name) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_contacts_display_name ON contacts (display_name) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_contacts_company_name ON contacts (company_name) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts (phone) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_contacts_mobile ON contacts (mobile) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_contacts_email_address_1 ON contacts (email_address_1) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_contacts_email_address_2 ON contacts (email_address_2) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_contacts_created_at ON contacts (created_at) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_contacts_last_interaction_at ON contacts (last_interaction_at) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_contacts_custom_data ON contacts USING GIN (custom_data);
      `);

      // Knowledge Base Articles table - simplified version for agent assist
      await client.query(`
        CREATE TABLE IF NOT EXISTS kb_articles (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          title TEXT NOT NULL,
          slug TEXT NOT NULL,
          summary TEXT,
          content TEXT NOT NULL,
          category TEXT NOT NULL,
          subcategory TEXT,
          tags TEXT[],
          keywords TEXT[],
          author_name TEXT,
          status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Published', 'Archived')),
          language TEXT DEFAULT 'en',
          custom_data JSONB DEFAULT '{}'::jsonb,
          search_vector TSVECTOR,
          published_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'kb_articles' AND column_name = 'custom_data'
          ) THEN
            ALTER TABLE kb_articles ADD COLUMN custom_data JSONB DEFAULT '{}'::jsonb;
          END IF;
          UPDATE kb_articles SET custom_data = '{}'::jsonb WHERE custom_data IS NULL;
        END $$;
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_kb_articles_username_created ON kb_articles (username, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_kb_articles_status ON kb_articles (status);
        CREATE INDEX IF NOT EXISTS idx_kb_articles_category ON kb_articles (category);
        CREATE INDEX IF NOT EXISTS idx_kb_articles_slug ON kb_articles (slug);
        CREATE INDEX IF NOT EXISTS idx_kb_articles_published ON kb_articles (published_at DESC) WHERE status = 'Published';
        CREATE INDEX IF NOT EXISTS idx_kb_articles_search_vector ON kb_articles USING GIN (search_vector);
        CREATE INDEX IF NOT EXISTS idx_kb_articles_tags ON kb_articles USING GIN (tags);
        CREATE INDEX IF NOT EXISTS idx_kb_articles_keywords ON kb_articles USING GIN (keywords);
        CREATE INDEX IF NOT EXISTS idx_kb_articles_custom_data ON kb_articles USING GIN (custom_data);
      `);

      // Create or replace trigger function for KB articles search vector
      await client.query(`
        CREATE OR REPLACE FUNCTION kb_articles_search_vector_update() RETURNS TRIGGER AS $$
        BEGIN
          NEW.search_vector := 
            setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
            setweight(to_tsvector('english', COALESCE(NEW.summary, '')), 'B') ||
            setweight(to_tsvector('english', COALESCE(NEW.content, '')), 'C') ||
            setweight(to_tsvector('english', COALESCE(array_to_string(NEW.tags, ' '), '')), 'B') ||
            setweight(to_tsvector('english', COALESCE(array_to_string(NEW.keywords, ' '), '')), 'B');
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);

      // Create trigger to automatically update search_vector
      await client.query(`
        DROP TRIGGER IF EXISTS kb_articles_search_vector_trigger ON kb_articles;
        CREATE TRIGGER kb_articles_search_vector_trigger
        BEFORE INSERT OR UPDATE ON kb_articles
        FOR EACH ROW
        EXECUTE FUNCTION kb_articles_search_vector_update();
      `);

      // Tasks Table - Universal task management for incidents, sales queries, complaints, etc.
      await client.query(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          
          -- Task identification
          title TEXT NOT NULL,
          description TEXT,
          task_type TEXT NOT NULL, -- Flexible: predefined types or custom strings
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed', 'cancelled')),
          priority TEXT DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
          
          -- Caller information (can be standalone or linked to contact)
          caller_name TEXT,
          caller_phone TEXT,
          caller_email TEXT,
          contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL, -- Optional link to existing contact
          
          -- Agent/User tracking
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL, -- Agent/user who created the task
          assigned_to TEXT REFERENCES users(id) ON DELETE SET NULL, -- Agent assigned to handle task
          resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL, -- Agent who resolved it
          
          -- Call/interaction context (for future integration)
          call_control_id TEXT, -- Link to call if created during call
          interaction_id TEXT, -- Link to contact center interaction
          flow_id TEXT, -- Link to voice flow if created from flow
          
          -- Timestamps
          due_date TIMESTAMPTZ,
          resolved_at TIMESTAMPTZ,
          closed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          deleted_at TIMESTAMPTZ, -- Soft delete support
          
          -- Flexible metadata for different task types
          metadata JSONB DEFAULT '{}'::jsonb, -- Store type-specific data (e.g., incident details, sales info)
          custom_data JSONB DEFAULT '{}'::jsonb,
          
          -- Tags for categorization
          tags TEXT[] DEFAULT ARRAY[]::TEXT[]
        );
      `);

      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'tasks' AND column_name = 'custom_data'
          ) THEN
            ALTER TABLE tasks ADD COLUMN custom_data JSONB DEFAULT '{}'::jsonb;
          END IF;
          UPDATE tasks SET custom_data = '{}'::jsonb WHERE custom_data IS NULL;
        END $$;
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_tasks_task_type ON tasks (task_type) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks (priority) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_tasks_contact_id ON tasks (contact_id) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON tasks (created_by) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks (assigned_to) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks (created_at DESC) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks (due_date) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_tasks_tags ON tasks USING GIN (tags);
        CREATE INDEX IF NOT EXISTS idx_tasks_metadata ON tasks USING GIN (metadata);
        CREATE INDEX IF NOT EXISTS idx_tasks_custom_data ON tasks USING GIN (custom_data);
        CREATE INDEX IF NOT EXISTS idx_tasks_call_control_id ON tasks (call_control_id) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_tasks_interaction_id ON tasks (interaction_id) WHERE deleted_at IS NULL;
      `);

      // Web Pages table for managing external portals
      await client.query(`
        CREATE TABLE IF NOT EXISTS web_pages (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          url TEXT NOT NULL,
          icon TEXT, -- Optional icon identifier
          order_index INTEGER DEFAULT 0, -- For ordering pages
          is_active BOOLEAN DEFAULT true,
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_web_pages_is_active ON web_pages (is_active) WHERE is_active = true;
        CREATE INDEX IF NOT EXISTS idx_web_pages_order ON web_pages (order_index);
      `);

      // ============================================
      // Routing Engine Redesign - Schema Migrations
      // ============================================

      // Migration: Add routing engine enhancements to cc_agent_state
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_agent_state' AND column_name = 'last_call_ended_at') THEN
            ALTER TABLE cc_agent_state ADD COLUMN last_call_ended_at TIMESTAMPTZ;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_agent_state' AND column_name = 'available_since') THEN
            ALTER TABLE cc_agent_state ADD COLUMN available_since TIMESTAMPTZ;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_agent_state' AND column_name = 'last_call_from_queue_id') THEN
            ALTER TABLE cc_agent_state ADD COLUMN last_call_from_queue_id TEXT;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_agent_state' AND column_name = 'queue_call_counts') THEN
            ALTER TABLE cc_agent_state ADD COLUMN queue_call_counts JSONB DEFAULT '{}'::jsonb;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_agent_state' AND column_name = 'total_idle_seconds') THEN
            ALTER TABLE cc_agent_state ADD COLUMN total_idle_seconds INTEGER DEFAULT 0;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_agent_state' AND column_name = 'total_handle_seconds') THEN
            ALTER TABLE cc_agent_state ADD COLUMN total_handle_seconds INTEGER DEFAULT 0;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_agent_state' AND column_name = 'calls_handled_today') THEN
            ALTER TABLE cc_agent_state ADD COLUMN calls_handled_today INTEGER DEFAULT 0;
          END IF;
        END $$;
      `);

      // Migration: Add routing engine enhancements to cc_queues
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_queues' AND column_name = 'skill_relaxation_enabled') THEN
            ALTER TABLE cc_queues ADD COLUMN skill_relaxation_enabled BOOLEAN DEFAULT false;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_queues' AND column_name = 'skill_relaxation_after_seconds') THEN
            ALTER TABLE cc_queues ADD COLUMN skill_relaxation_after_seconds INTEGER DEFAULT 60;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_queues' AND column_name = 'skill_relaxation_strategy') THEN
            ALTER TABLE cc_queues ADD COLUMN skill_relaxation_strategy TEXT DEFAULT 'progressive';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_queues' AND column_name = 'default_call_priority') THEN
            ALTER TABLE cc_queues ADD COLUMN default_call_priority INTEGER DEFAULT 3 CHECK (default_call_priority >= 1 AND default_call_priority <= 5);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_queues' AND column_name = 'sla_answer_threshold_seconds') THEN
            ALTER TABLE cc_queues ADD COLUMN sla_answer_threshold_seconds INTEGER DEFAULT 20;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_queues' AND column_name = 'sla_target_percentage') THEN
            ALTER TABLE cc_queues ADD COLUMN sla_target_percentage INTEGER DEFAULT 80;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_queues' AND column_name = 'avg_handle_time_seconds') THEN
            ALTER TABLE cc_queues ADD COLUMN avg_handle_time_seconds INTEGER DEFAULT 180;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_queues' AND column_name = 'last_avg_calculated_at') THEN
            ALTER TABLE cc_queues ADD COLUMN last_avg_calculated_at TIMESTAMPTZ;
          END IF;
        END $$;
      `);

      // Migration: Add priority to cc_interactions
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_interactions' AND column_name = 'priority') THEN
            ALTER TABLE cc_interactions ADD COLUMN priority INTEGER DEFAULT 3 CHECK (priority >= 1 AND priority <= 5);
          END IF;
        END $$;
      `);

      // Migration: Remove per-queue capacity column if it exists (feature removed - only global user.max_concurrent_calls is used)
      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cc_queue_user_assignments' AND column_name = 'max_concurrent_calls') THEN
            ALTER TABLE cc_queue_user_assignments DROP COLUMN max_concurrent_calls;
          END IF;
        END $$;
      `);

      // Migration: Update priority column to enforce 1-5 range and default to 1
      await client.query(`
        DO $$
        BEGIN
          -- Update existing 0 values to 1 (minimum)
          UPDATE cc_queue_user_assignments SET priority = 1 WHERE priority = 0 OR priority IS NULL;
          
          -- Change default to 1 if not already
          IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'cc_queue_user_assignments' 
            AND column_name = 'priority' 
            AND column_default != '1'
          ) THEN
            ALTER TABLE cc_queue_user_assignments ALTER COLUMN priority SET DEFAULT 1;
          END IF;
          
          -- Add CHECK constraint if it doesn't exist
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint 
            WHERE conrelid = 'cc_queue_user_assignments'::regclass 
            AND conname = 'cc_queue_user_assignments_priority_check'
          ) THEN
            ALTER TABLE cc_queue_user_assignments 
            ADD CONSTRAINT cc_queue_user_assignments_priority_check 
            CHECK (priority >= 1 AND priority <= 5);
          END IF;
        END $$;
      `);

      // Create SLA metrics table
      await client.query(`
        CREATE TABLE IF NOT EXISTS cc_queue_sla_metrics (
          id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          queue_id TEXT NOT NULL REFERENCES cc_queues(id) ON DELETE CASCADE,
          date DATE NOT NULL DEFAULT CURRENT_DATE,
          total_calls INTEGER DEFAULT 0,
          calls_answered INTEGER DEFAULT 0,
          calls_within_sla INTEGER DEFAULT 0,
          calls_abandoned INTEGER DEFAULT 0,
          avg_speed_of_answer_seconds DECIMAL(10,2),
          sla_compliance_percentage DECIMAL(5,2),
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(queue_id, date)
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_queue_sla_metrics_queue_date
        ON cc_queue_sla_metrics(queue_id, date);
      `);

      // CRITICAL: Migrate existing agent skills from 1-10 scale to 1-5 scale
      await client.query(`
        UPDATE users
        SET skills = (
          SELECT jsonb_object_agg(
            key,
            CASE
              WHEN (value::text::integer) <= 2 THEN 1
              WHEN (value::text::integer) <= 4 THEN 2
              WHEN (value::text::integer) <= 6 THEN 3
              WHEN (value::text::integer) <= 8 THEN 4
              ELSE 5
            END
          )
          FROM jsonb_each(skills)
        )
        WHERE skills IS NOT NULL
          AND skills != '{}'::jsonb
          AND EXISTS (
            SELECT 1 FROM jsonb_each(skills)
            WHERE (value::text::integer) > 5
          );
      `);

      // CRITICAL: Migrate existing queue skill_requirements from 1-10 to 1-5 scale
      await client.query(`
        UPDATE cc_queues
        SET skill_requirements = (
          SELECT jsonb_object_agg(
            key,
            CASE
              WHEN (value::text::integer) <= 2 THEN 1
              WHEN (value::text::integer) <= 4 THEN 2
              WHEN (value::text::integer) <= 6 THEN 3
              WHEN (value::text::integer) <= 8 THEN 4
              ELSE 5
            END
          )
          FROM jsonb_each(skill_requirements)
        )
        WHERE skill_requirements IS NOT NULL
          AND skill_requirements != '{}'::jsonb
          AND EXISTS (
            SELECT 1 FROM jsonb_each(skill_requirements)
            WHERE (value::text::integer) > 5
          );
      `);

      // ============================================
      // Agent Assist Workflow Tables
      // ============================================

      // Workflow templates table - defines reusable workflow configurations
      await client.query(`
        CREATE TABLE IF NOT EXISTS aa_workflows (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR(255) NOT NULL,
          description TEXT,
          category VARCHAR(100), -- e.g., "sales", "support", "healthcare", "collections"
          is_active BOOLEAN DEFAULT true,
          llm_confidence_threshold FLOAT DEFAULT 0.95 CHECK (llm_confidence_threshold >= 0 AND llm_confidence_threshold <= 1),
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_aa_workflows_name ON aa_workflows (name);
        CREATE INDEX IF NOT EXISTS idx_aa_workflows_category ON aa_workflows (category);
        CREATE INDEX IF NOT EXISTS idx_aa_workflows_is_active ON aa_workflows (is_active);
      `);

      // Workflow stages - ordered steps within a workflow
      await client.query(`
        CREATE TABLE IF NOT EXISTS aa_workflow_stages (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          workflow_id UUID NOT NULL REFERENCES aa_workflows(id) ON DELETE CASCADE,
          name VARCHAR(255) NOT NULL, -- e.g., "Call Opening", "Verification", "Resolution"
          description TEXT,
          order_index INTEGER NOT NULL,
          is_required BOOLEAN DEFAULT true,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_aa_workflow_stages_workflow_id ON aa_workflow_stages (workflow_id);
        CREATE INDEX IF NOT EXISTS idx_aa_workflow_stages_order ON aa_workflow_stages (workflow_id, order_index);
      `);

      // Stage items - actions/questions/topics/slots within a stage
      await client.query(`
        CREATE TABLE IF NOT EXISTS aa_workflow_items (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          stage_id UUID NOT NULL REFERENCES aa_workflow_stages(id) ON DELETE CASCADE,
          type VARCHAR(50) NOT NULL CHECK (type IN ('action', 'question', 'topic', 'slot')),
          label VARCHAR(500) NOT NULL, -- Display text, e.g., "Thank you for calling..."
          description TEXT, -- Additional context for the agent
          prompt_hint TEXT, -- LLM hint for detection (keywords, phrases)
          order_index INTEGER NOT NULL,
          is_required BOOLEAN DEFAULT true,
          
          -- For slot-type items
          slot_name VARCHAR(100), -- e.g., "customer_name", "account_number"
          slot_type VARCHAR(50), -- "text", "number", "date", "email", "phone", "boolean", "enum"
          slot_options JSONB, -- For enum type: ["option1", "option2"]
          slot_validation TEXT, -- Regex or validation rule
          
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_aa_workflow_items_stage_id ON aa_workflow_items (stage_id);
        CREATE INDEX IF NOT EXISTS idx_aa_workflow_items_order ON aa_workflow_items (stage_id, order_index);
        CREATE INDEX IF NOT EXISTS idx_aa_workflow_items_type ON aa_workflow_items (type);
        CREATE INDEX IF NOT EXISTS idx_aa_workflow_items_slot_name ON aa_workflow_items (slot_name) WHERE slot_name IS NOT NULL;
      `);

      // Add hints JSONB column to aa_workflow_items if it doesn't exist (migration for existing databases)
      await client.query(`
        DO $$ 
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'aa_workflow_items' AND column_name = 'hints'
          ) THEN
            ALTER TABLE aa_workflow_items ADD COLUMN hints JSONB DEFAULT '[]'::jsonb;
          END IF;
        END $$;
      `);

      // Migrate existing prompt_hint (comma-delimited TEXT) to hints (JSONB array)
      await client.query(`
        UPDATE aa_workflow_items
        SET hints = (
          SELECT jsonb_agg(trim(value))
          FROM unnest(string_to_array(prompt_hint, ',')) AS value
          WHERE trim(value) != ''
        )
        WHERE prompt_hint IS NOT NULL 
          AND prompt_hint != ''
          AND (hints IS NULL OR hints = '[]'::jsonb);
      `);

      // Add llm_model column to aa_workflows if it doesn't exist (migration for existing databases)
      await client.query(`
        DO $$ 
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'aa_workflows' AND column_name = 'llm_model'
          ) THEN
            ALTER TABLE aa_workflows ADD COLUMN llm_model VARCHAR(100) DEFAULT 'openai/gpt-4o';
          END IF;
        END $$;
      `);

      // Add ai_assistant_id column to aa_workflows for storing created Telnyx AI Assistant ID
      await client.query(`
        DO $$ 
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'aa_workflows' AND column_name = 'ai_assistant_id'
          ) THEN
            ALTER TABLE aa_workflows ADD COLUMN ai_assistant_id VARCHAR(255);
          END IF;
        END $$;
      `);

      // Add per-workflow LLM confidence threshold for auto-filled Agent Assist workflow slots
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'aa_workflows' AND column_name = 'llm_confidence_threshold'
          ) THEN
            ALTER TABLE aa_workflows ADD COLUMN llm_confidence_threshold FLOAT DEFAULT 0.95;
          END IF;

          UPDATE aa_workflows
          SET llm_confidence_threshold = 0.95
          WHERE llm_confidence_threshold IS NULL;

          ALTER TABLE aa_workflows
            ALTER COLUMN llm_confidence_threshold SET DEFAULT 0.95;

          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'aa_workflows_llm_confidence_threshold_check'
          ) THEN
            ALTER TABLE aa_workflows ADD CONSTRAINT aa_workflows_llm_confidence_threshold_check
              CHECK (llm_confidence_threshold >= 0 AND llm_confidence_threshold <= 1);
          END IF;
        END $$;
      `);

      // Add completion_trigger column to aa_workflow_items if it doesn't exist (migration for existing databases)
      // Determines who must complete the item: 'agent' (agent performs action), 'customer' (customer provides info), 'either'
      await client.query(`
        DO $$ 
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'aa_workflow_items' AND column_name = 'completion_trigger'
          ) THEN
            ALTER TABLE aa_workflow_items ADD COLUMN completion_trigger VARCHAR(20) DEFAULT 'agent';
            -- Add check constraint
            ALTER TABLE aa_workflow_items ADD CONSTRAINT aa_workflow_items_completion_trigger_check 
              CHECK (completion_trigger IN ('agent', 'customer', 'either'));
            -- Set smart defaults: slots default to 'customer', others to 'agent'
            UPDATE aa_workflow_items SET completion_trigger = 'customer' WHERE type = 'slot';
            UPDATE aa_workflow_items SET completion_trigger = 'agent' WHERE type != 'slot' AND completion_trigger IS NULL;
          END IF;
        END $$;
      `);

      // Active workflow sessions - tracks workflow progress per interaction
      await client.query(`
        CREATE TABLE IF NOT EXISTS aa_workflow_sessions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          interaction_id TEXT NOT NULL REFERENCES cc_interactions(id) ON DELETE CASCADE,
          workflow_id UUID NOT NULL REFERENCES aa_workflows(id) ON DELETE CASCADE,
          current_stage_id UUID REFERENCES aa_workflow_stages(id) ON DELETE SET NULL,
          status VARCHAR(50) DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'abandoned')),
          started_at TIMESTAMPTZ DEFAULT NOW(),
          completed_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          
          -- Aggregated data
          slots_filled JSONB DEFAULT '{}'::jsonb, -- {"customer_name": "John Doe", "account_number": "12345"}
          completion_percentage INTEGER DEFAULT 0,
          
          UNIQUE(interaction_id)
        );
      `);

      // Add updated_at column if it doesn't exist (for existing databases)
      await client.query(`
        ALTER TABLE aa_workflow_sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_aa_workflow_sessions_interaction_id ON aa_workflow_sessions (interaction_id);
        CREATE INDEX IF NOT EXISTS idx_aa_workflow_sessions_workflow_id ON aa_workflow_sessions (workflow_id);
        CREATE INDEX IF NOT EXISTS idx_aa_workflow_sessions_status ON aa_workflow_sessions (status);
        CREATE INDEX IF NOT EXISTS idx_aa_workflow_sessions_current_stage ON aa_workflow_sessions (current_stage_id);
      `);

      // Item completion tracking - tracks status of each item in the workflow session
      await client.query(`
        CREATE TABLE IF NOT EXISTS aa_workflow_item_status (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          session_id UUID NOT NULL REFERENCES aa_workflow_sessions(id) ON DELETE CASCADE,
          item_id UUID NOT NULL REFERENCES aa_workflow_items(id) ON DELETE CASCADE,
          status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'suggested', 'completed', 'skipped')),
          completed_at TIMESTAMPTZ,
          completed_by VARCHAR(50), -- "agent", "customer", "auto"
          extracted_value TEXT, -- For slots: the captured value
          confidence_score FLOAT, -- LLM confidence (0-1)
          source_transcript TEXT, -- The transcript that triggered completion
          
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          
          UNIQUE(session_id, item_id)
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_aa_workflow_item_status_session_id ON aa_workflow_item_status (session_id);
        CREATE INDEX IF NOT EXISTS idx_aa_workflow_item_status_item_id ON aa_workflow_item_status (item_id);
        CREATE INDEX IF NOT EXISTS idx_aa_workflow_item_status_status ON aa_workflow_item_status (status);
      `);

      // Allow low-confidence LLM slot captures to persist as suggested until an agent confirms/edits them
      await client.query(`
        DO $$
        DECLARE
          constraint_name text;
        BEGIN
          FOR constraint_name IN
            SELECT conname
            FROM pg_constraint
            WHERE conrelid = 'aa_workflow_item_status'::regclass
              AND contype = 'c'
              AND pg_get_constraintdef(oid) ILIKE '%status%'
              AND pg_get_constraintdef(oid) ILIKE '%pending%'
              AND pg_get_constraintdef(oid) ILIKE '%completed%'
              AND pg_get_constraintdef(oid) ILIKE '%skipped%'
          LOOP
            EXECUTE format('ALTER TABLE aa_workflow_item_status DROP CONSTRAINT %I', constraint_name);
          END LOOP;

          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'aa_workflow_item_status'::regclass
              AND conname = 'aa_workflow_item_status_status_check'
          ) THEN
            ALTER TABLE aa_workflow_item_status ADD CONSTRAINT aa_workflow_item_status_status_check
              CHECK (status IN ('pending', 'suggested', 'completed', 'skipped'));
          END IF;
        END $$;
      `);

      // Add workflow_id column to cc_queues for default workflow assignment
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'cc_queues' AND column_name = 'workflow_id'
          ) THEN
            ALTER TABLE cc_queues ADD COLUMN workflow_id UUID REFERENCES aa_workflows(id) ON DELETE SET NULL;
          END IF;
        END $$;
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_cc_queues_workflow_id ON cc_queues (workflow_id) WHERE workflow_id IS NOT NULL;
      `);

      // ============================================
      // AI to Agent Workflow Handoff - Schema Migrations
      // ============================================

      // Add Telnyx Insight IDs to aa_workflows for the 3 standard insights
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'aa_workflows' AND column_name = 'insight_group_id'
          ) THEN
            ALTER TABLE aa_workflows ADD COLUMN insight_group_id VARCHAR(255);
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'aa_workflows' AND column_name = 'insight_slots_id'
          ) THEN
            ALTER TABLE aa_workflows ADD COLUMN insight_slots_id VARCHAR(255);
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'aa_workflows' AND column_name = 'insight_summary_id'
          ) THEN
            ALTER TABLE aa_workflows ADD COLUMN insight_summary_id VARCHAR(255);
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'aa_workflows' AND column_name = 'insight_sentiment_id'
          ) THEN
            ALTER TABLE aa_workflows ADD COLUMN insight_sentiment_id VARCHAR(255);
          END IF;
        END $$;
      `);

      // Create index for lookup by insight_group_id
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_aa_workflows_insight_group_id 
        ON aa_workflows (insight_group_id) 
        WHERE insight_group_id IS NOT NULL;
      `);

      // Add AI handoff data columns to aa_workflow_sessions
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'aa_workflow_sessions' AND column_name = 'ai_summary'
          ) THEN
            ALTER TABLE aa_workflow_sessions ADD COLUMN ai_summary TEXT;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'aa_workflow_sessions' AND column_name = 'ai_sentiment'
          ) THEN
            ALTER TABLE aa_workflow_sessions ADD COLUMN ai_sentiment TEXT;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'aa_workflow_sessions' AND column_name = 'ai_handoff_received_at'
          ) THEN
            ALTER TABLE aa_workflow_sessions ADD COLUMN ai_handoff_received_at TIMESTAMPTZ;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'aa_workflow_sessions' AND column_name = 'ai_handoff_source'
          ) THEN
            ALTER TABLE aa_workflow_sessions ADD COLUMN ai_handoff_source VARCHAR(20);
          END IF;
        END $$;
      `);

      // Add completed_by column to aa_workflow_item_status if not exists
      // Note: The column already exists in the original schema, but this ensures
      // it allows 'ai' as a valid value (no check constraint in original schema)
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'aa_workflow_item_status' AND column_name = 'completed_by'
          ) THEN
            ALTER TABLE aa_workflow_item_status ADD COLUMN completed_by VARCHAR(50);
          END IF;
        END $$;
      `);

      // Quality Management tables - supervisor QA scorecards and evaluations.
      // Intentionally separate from the agent scripting form_* tables
      // (form_definitions/form_versions/form_submissions stay scripting-only).
      await client.query(`
        CREATE TABLE IF NOT EXISTS quality_forms (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          slug TEXT UNIQUE NOT NULL,
          description TEXT,
          category TEXT,
          status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
          version INTEGER NOT NULL DEFAULT 1,
          schema JSONB NOT NULL DEFAULT '{}'::jsonb,
          scoring_config JSONB NOT NULL DEFAULT '{}'::jsonb,
          ai_prompt_config JSONB NOT NULL DEFAULT '{}'::jsonb,
          is_template BOOLEAN NOT NULL DEFAULT false,
          created_by TEXT,
          updated_by TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          published_at TIMESTAMPTZ
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS quality_form_versions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          form_id UUID NOT NULL REFERENCES quality_forms(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          schema JSONB NOT NULL DEFAULT '{}'::jsonb,
          scoring_config JSONB NOT NULL DEFAULT '{}'::jsonb,
          ai_prompt_config JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_by TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(form_id, version)
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS quality_evaluations (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          interaction_id TEXT NOT NULL REFERENCES cc_interactions(id) ON DELETE CASCADE,
          form_id UUID NOT NULL REFERENCES quality_forms(id) ON DELETE RESTRICT,
          form_version INTEGER NOT NULL DEFAULT 1,
          evaluator_type TEXT NOT NULL DEFAULT 'human' CHECK (evaluator_type IN ('human', 'ai', 'hybrid')),
          evaluator_username TEXT,
          agent_username TEXT,
          queue_name TEXT,
          status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ai_processing', 'ai_draft', 'reviewed', 'final', 'disputed')),
          score_total NUMERIC(10,2),
          score_max NUMERIC(10,2),
          score_percent NUMERIC(5,2),
          answers JSONB NOT NULL DEFAULT '{}'::jsonb,
          ai_result JSONB,
          review_notes TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          finalized_at TIMESTAMPTZ
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS quality_ai_jobs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          evaluation_id UUID NOT NULL REFERENCES quality_evaluations(id) ON DELETE CASCADE,
          interaction_id TEXT,
          recording_id TEXT,
          status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'transcribing', 'evaluating', 'completed', 'failed')),
          model TEXT,
          transcription_model TEXT,
          error_message TEXT,
          started_at TIMESTAMPTZ,
          completed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_quality_forms_status ON quality_forms (status);
        CREATE INDEX IF NOT EXISTS idx_quality_forms_slug ON quality_forms (slug);
        CREATE INDEX IF NOT EXISTS idx_quality_form_versions_form_id ON quality_form_versions (form_id);
        CREATE INDEX IF NOT EXISTS idx_quality_evaluations_interaction_id ON quality_evaluations (interaction_id);
        CREATE INDEX IF NOT EXISTS idx_quality_evaluations_form_id ON quality_evaluations (form_id);
        CREATE INDEX IF NOT EXISTS idx_quality_evaluations_agent_username ON quality_evaluations (agent_username);
        CREATE INDEX IF NOT EXISTS idx_quality_evaluations_queue_name ON quality_evaluations (queue_name);
        CREATE INDEX IF NOT EXISTS idx_quality_evaluations_status ON quality_evaluations (status);
        CREATE INDEX IF NOT EXISTS idx_quality_evaluations_created_at ON quality_evaluations (created_at);
        CREATE INDEX IF NOT EXISTS idx_quality_ai_jobs_evaluation_id ON quality_ai_jobs (evaluation_id);
        CREATE INDEX IF NOT EXISTS idx_quality_ai_jobs_status ON quality_ai_jobs (status);
      `);

      // Add invite columns to users table (migration for existing databases)
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'users' AND column_name = 'invite_token'
          ) THEN
            ALTER TABLE users ADD COLUMN invite_token TEXT;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'users' AND column_name = 'invite_token_expires'
          ) THEN
            ALTER TABLE users ADD COLUMN invite_token_expires TIMESTAMPTZ;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'users' AND column_name = 'invite_sent_at'
          ) THEN
            ALTER TABLE users ADD COLUMN invite_sent_at TIMESTAMPTZ;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'users' AND column_name = 'invite_accepted_at'
          ) THEN
            ALTER TABLE users ADD COLUMN invite_accepted_at TIMESTAMPTZ;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'users' AND column_name = 'invite_status'
          ) THEN
            ALTER TABLE users ADD COLUMN invite_status TEXT DEFAULT 'none' CHECK (invite_status IN ('none', 'pending', 'accepted', 'expired'));
          END IF;
        END $$;
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_users_invite_token ON users (invite_token);
      `);

      // Seed default app settings if they don't exist (run outside transaction)
      // This is done after COMMIT to avoid transaction conflicts

      await client.query("COMMIT");
      schemaLogger.info("postgres_schema_created");

      // ── Additive migration: aa_ai_handoff_events ────────────────────────────
      // Kept outside the main transaction so it succeeds on old environments
      // that ran the schema before this table was added. A failure here won't
      // roll back any of the tables created above.
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS aa_ai_handoff_events (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            interaction_id TEXT REFERENCES cc_interactions(id) ON DELETE CASCADE,
            workflow_session_id UUID REFERENCES aa_workflow_sessions(id) ON DELETE SET NULL,
            ai_call_control_id VARCHAR(255),
            insight_group_id VARCHAR(255),
            raw_payload JSONB,
            processed_slots JSONB,
            status VARCHAR(20) DEFAULT 'pending',
            error_message TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            processed_at TIMESTAMPTZ
          );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_aa_ai_handoff_events_interaction_id ON aa_ai_handoff_events (interaction_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_aa_ai_handoff_events_ai_call_control_id ON aa_ai_handoff_events (ai_call_control_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_aa_ai_handoff_events_insight_group_id ON aa_ai_handoff_events (insight_group_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_aa_ai_handoff_events_status ON aa_ai_handoff_events (status);`);
        schemaLogger.info("aa_ai_handoff_events_table_ready");
      } catch (handoffErr) {
        schemaLogger.error("aa_ai_handoff_events_table_failed");
      }

      // Seed default app settings after transaction commits
      // This avoids transaction timeout issues
      try {
        const { seedDefaultAppSettings } = await import(
          "./seed-app-settings.mjs"
        );
        await seedDefaultAppSettings();
      } catch (seedError) {
        // Log but don't fail schema creation if seeding fails
        schemaLogger.warn("seed_app_settings_failed");



      }

      // Seed allowed email domains from environment variable
      try {
        const { seedAllowedEmailDomains } = await import("./seed-domains.mjs");
        await seedAllowedEmailDomains();
      } catch (domainSeedError) {
        // Log but don't fail schema creation if seeding fails
        schemaLogger.warn("seed_domains_failed");



      }

      // Seed default owner user from environment variables
      try {
        const { seedDefaultOwner } = await import("./seed-default-owner.mjs");
        await seedDefaultOwner();
      } catch (ownerSeedError) {
        // Log but don't fail schema creation if seeding fails
        schemaLogger.warn("seed_owner_failed");



      }

      // Seed sample workflows (support, sales, healthcare, survey)
      try {
        const { seedSampleWorkflows } = await import("./seed-sample-workflows.mjs");
        await seedSampleWorkflows();
      } catch (workflowSeedError) {
        // Log but don't fail schema creation if seeding fails
        schemaLogger.warn("seed_workflows_failed");



      }

      // Call Generator tables
      await client.query(`
        CREATE TABLE IF NOT EXISTS cg_scenarios (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          description TEXT,
          status TEXT DEFAULT 'draft',
          tasks JSONB DEFAULT '[]'::jsonb,
          config JSONB DEFAULT '{}'::jsonb,
          created_by TEXT,
          organization_id TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS cg_runs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          scenario_id UUID NOT NULL REFERENCES cg_scenarios(id) ON DELETE CASCADE,
          status TEXT DEFAULT 'pending',
          started_at TIMESTAMPTZ,
          stopped_at TIMESTAMPTZ,
          config JSONB DEFAULT '{}'::jsonb,
          stats JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS cg_call_ledger (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          run_id UUID NOT NULL REFERENCES cg_runs(id) ON DELETE CASCADE,
          call_control_id TEXT,
          call_session_id TEXT,
          to_number TEXT,
          from_number TEXT,
          status TEXT DEFAULT 'pending',
          started_at TIMESTAMPTZ,
          answered_at TIMESTAMPTZ,
          ended_at TIMESTAMPTZ,
          duration_ms INTEGER,
          result JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      await client.query(`
        CREATE OR REPLACE FUNCTION cg_scenarios_updated_at()
        RETURNS TRIGGER AS $$
        BEGIN
          NEW.updated_at = NOW();
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);

      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_trigger WHERE tgname = 'cg_scenarios_updated_at_trigger'
          ) THEN
            CREATE TRIGGER cg_scenarios_updated_at_trigger
            BEFORE UPDATE ON cg_scenarios
            FOR EACH ROW
            EXECUTE FUNCTION cg_scenarios_updated_at();
          END IF;
        END $$
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS cg_settings (
          id TEXT PRIMARY KEY DEFAULT 'default',
          settings JSONB DEFAULT '{}'::jsonb,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      // Call Generator action sequences (play media / speak / send DTMF steps)
      await client.query(`
        CREATE TABLE IF NOT EXISTS cg_actions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          description TEXT,
          steps JSONB DEFAULT '[]'::jsonb,
          created_by TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_trigger WHERE tgname = 'cg_actions_updated_at_trigger'
          ) THEN
            CREATE TRIGGER cg_actions_updated_at_trigger
            BEFORE UPDATE ON cg_actions
            FOR EACH ROW
            EXECUTE FUNCTION cg_scenarios_updated_at();
          END IF;
        END $$
      `);

      // Indexes for call generator ledger
      await client.query(`CREATE INDEX IF NOT EXISTS idx_cg_ledger_run_id ON cg_call_ledger(run_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_cg_ledger_status ON cg_call_ledger(status)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_cg_ledger_call_session ON cg_call_ledger(call_session_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_cg_ledger_created_at ON cg_call_ledger(created_at)`);

      // Hard phones provisioning inventory (Polycom / Yealink / AudioCodes).
      // Each phone carries its own Telnyx telephony credential (sip_username /
      // sip_password) injected into generated config files served per MAC.
      await client.query(`
        CREATE TABLE IF NOT EXISTS hp_phones (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          mac TEXT NOT NULL UNIQUE,
          vendor TEXT NOT NULL,
          model TEXT,
          label TEXT,
          agent_id TEXT,
          telnyx_credential_id TEXT,
          sip_username TEXT,
          sip_password TEXT,
          admin_password TEXT,
          settings JSONB DEFAULT '{}'::jsonb,
          provisioning_state TEXT DEFAULT 'pending',
          last_seen_at TIMESTAMPTZ,
          last_user_agent TEXT,
          created_by TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_trigger WHERE tgname = 'hp_phones_updated_at_trigger'
          ) THEN
            CREATE TRIGGER hp_phones_updated_at_trigger
            BEFORE UPDATE ON hp_phones
            FOR EACH ROW
            EXECUTE FUNCTION cg_scenarios_updated_at();
          END IF;
        END $$
      `);

      // Provisioning request log (boot fetches, config downloads, re-provisions)
      await client.query(`
        CREATE TABLE IF NOT EXISTS hp_provisioning_events (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          phone_id UUID,
          mac TEXT,
          event_type TEXT NOT NULL,
          detail JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_hp_events_phone_id ON hp_provisioning_events(phone_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_hp_events_created_at ON hp_provisioning_events(created_at)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_hp_phones_mac ON hp_phones(mac)`);

      // Phase 2 — CTI: phones are controlled over HTTP at their LAN IP.
      // ip_address = manual override; last_ip = auto-captured from the most
      // recent provisioning request / phone event.
      await client.query(`ALTER TABLE hp_phones ADD COLUMN IF NOT EXISTS ip_address TEXT`);
      await client.query(`ALTER TABLE hp_phones ADD COLUMN IF NOT EXISTS last_ip TEXT`);

      // CTI sessions for the Telnyx fallback driver — one row per originated
      // click-to-dial leg, status driven by the dedicated CTI webhook.
      await client.query(`
        CREATE TABLE IF NOT EXISTS hp_cti_sessions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          phone_id UUID NOT NULL,
          call_control_id TEXT,
          target TEXT,
          status TEXT DEFAULT 'originating',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_hp_cti_sessions_phone ON hp_cti_sessions(phone_id, status)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_hp_cti_sessions_ccid ON hp_cti_sessions(call_control_id)`);

      // Seed quality management evaluation form templates
      try {
        const { seedQualityForms } = await import("./seed-quality-forms.mjs");
        await seedQualityForms();
      } catch (qualitySeedError) {
        // Log but don't fail schema creation if seeding fails
        schemaLogger.warn("seed_quality_forms_failed");
      }

      return true;
    } catch (err) {
      await client.query("ROLLBACK");
      schemaLogger.error("postgres_schema_creation_failed");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    schemaLogger.error("postgres_schema_ensure_failed");
    return false;
  }
}
