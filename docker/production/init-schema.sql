-- PostgreSQL Database Initialization Script
-- This script runs when the PostgreSQL container starts for the first time

-- Note: PostgreSQL automatically creates the database and user from environment variables
-- POSTGRES_DB, POSTGRES_USER, and POSTGRES_PASSWORD

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- The actual schema will be created by the Node.js application
-- using the ensurePostgresSchema() function from lib/postgres-schema.mjs
-- This ensures the schema is always up-to-date with the application code
