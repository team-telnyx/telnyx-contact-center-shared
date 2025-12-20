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
          role TEXT DEFAULT 'agent', -- Legacy single role (for backward compatibility)
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
        CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);
        CREATE INDEX IF NOT EXISTS idx_users_roles ON users USING GIN (roles);
        CREATE INDEX IF NOT EXISTS idx_users_status ON users (status);
        CREATE INDEX IF NOT EXISTS idx_users_agent_status ON users (agent_status);
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

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_cc_queues_name ON cc_queues (name);
        CREATE INDEX IF NOT EXISTS idx_cc_queues_enabled ON cc_queues (enabled);
        CREATE INDEX IF NOT EXISTS idx_cc_queues_active ON cc_queues (active);
        CREATE INDEX IF NOT EXISTS idx_cc_queues_routing_strategy ON cc_queues (routing_strategy);
      `);

      // Queue-User Assignments table (many-to-many)
      await client.query(`
        CREATE TABLE IF NOT EXISTS cc_queue_user_assignments (
          id TEXT PRIMARY KEY,
          queue_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          priority INTEGER DEFAULT 0,
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
          metadata JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT fk_interactions_queue FOREIGN KEY(queue_id) REFERENCES cc_queues(id) ON DELETE SET NULL
        );
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

      // User Statuses table - manages available status types (Available, Busy, Away, Offline, Break, etc.)
      await client.query(`
        CREATE TABLE IF NOT EXISTS cc_user_statuses (
          id TEXT PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('active', 'break')),
          is_active BOOLEAN DEFAULT true,
          display_order INTEGER DEFAULT 0,
          description TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_user_statuses_type ON cc_user_statuses (type);
        CREATE INDEX IF NOT EXISTS idx_user_statuses_active ON cc_user_statuses (is_active);
        CREATE INDEX IF NOT EXISTS idx_user_statuses_display_order ON cc_user_statuses (display_order);
      `);

      // Seed default statuses
      await client.query(`
        INSERT INTO cc_user_statuses (id, name, type, is_active, display_order, description)
        VALUES 
          ('available', 'Available', 'active', true, 1, 'Agent is available to take calls'),
          ('busy', 'Busy', 'active', true, 2, 'Agent is busy handling calls'),
          ('away', 'Away', 'active', true, 3, 'Agent is away from desk'),
          ('offline', 'Offline', 'active', true, 4, 'Agent is offline'),
          ('break', 'Break', 'break', true, 5, 'Agent is on break')
        ON CONFLICT (id) DO NOTHING;
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
      `);

      // Seed default app settings if they don't exist (run outside transaction)
      // This is done after COMMIT to avoid transaction conflicts

      await client.query("COMMIT");
      console.log("[Postgres] Schema created successfully");

      // Seed default app settings after transaction commits
      // This avoids transaction timeout issues
      try {
        const { seedDefaultAppSettings } = await import(
          "./seed-app-settings.mjs"
        );
        await seedDefaultAppSettings();
      } catch (seedError) {
        // Log but don't fail schema creation if seeding fails
        console.warn(
          "[Postgres] Warning: Failed to seed app settings:",
          seedError.message
        );
      }

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
