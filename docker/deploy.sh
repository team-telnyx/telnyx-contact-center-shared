#!/bin/bash

# Telnyx Contact Center Docker Deployment Script
# Usage: ./deploy.sh [production]                              (preserves database data)
#        ./deploy.sh production --fresh                        (recreates postgres DB from scratch)
#        ./deploy.sh production --audit-telnyx-credentials     (read-only SIP connection audit)
#        ./deploy.sh production --repair-telnyx-credentials    (confirm and repair SIP connection)

set -e

usage() {
    cat <<'EOF'
Usage:
  ./deploy.sh [production]
  ./deploy.sh production --fresh
  ./deploy.sh production --audit-telnyx-credentials [--env-file <path>] [--connection-id <id>]
  ./deploy.sh production --repair-telnyx-credentials [--env-file <path>] [--connection-id <id>] [--yes]

Telnyx audit/repair:
  The default connection id comes from TELNYX_SIP_CONNECTION_ID in
  docker/production/.env. Audit is read-only and exits with status 2 when a
  repair is needed. Repair changes only sip_uri_calling_preference and verifies
  the result with a fresh GET. Use --yes only for explicit non-interactive use.
EOF
}

ENVIRONMENT="production"
if [ "$#" -gt 0 ] && [[ "$1" != --* ]]; then
    ENVIRONMENT="$1"
    shift
fi

ACTION="deploy"
FRESH_DEPLOY=""
CONNECTION_ID=""
ASSUME_YES="false"
ENV_FILE_ARG=""
CALLING_DIR="$PWD"

while [ "$#" -gt 0 ]; do
    case "$1" in
        --fresh)
            FRESH_DEPLOY="--fresh"
            ;;
        --audit-telnyx-credentials)
            if [ "$ACTION" != "deploy" ]; then
                echo "❌ Choose only one Telnyx audit/repair action"
                exit 1
            fi
            ACTION="audit-telnyx-credentials"
            ;;
        --repair-telnyx-credentials)
            if [ "$ACTION" != "deploy" ]; then
                echo "❌ Choose only one Telnyx audit/repair action"
                exit 1
            fi
            ACTION="repair-telnyx-credentials"
            ;;
        --connection-id)
            shift
            if [ "$#" -eq 0 ] || [ -z "$1" ]; then
                echo "❌ --connection-id requires a value"
                exit 1
            fi
            CONNECTION_ID="$1"
            ;;
        --env-file)
            shift
            if [ "$#" -eq 0 ] || [ -z "$1" ]; then
                echo "❌ --env-file requires a path"
                exit 1
            fi
            ENV_FILE_ARG="$1"
            ;;
        --yes)
            ASSUME_YES="true"
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "❌ Unknown option: $1"
            usage
            exit 1
            ;;
    esac
    shift
done

if [ "$ACTION" != "deploy" ] && [ -n "$FRESH_DEPLOY" ]; then
    echo "❌ --fresh cannot be combined with a Telnyx audit/repair action"
    exit 1
fi
if [ "$ACTION" == "deploy" ] && { [ -n "$CONNECTION_ID" ] || [ "$ASSUME_YES" == "true" ] || [ -n "$ENV_FILE_ARG" ]; }; then
    echo "❌ --connection-id, --env-file, and --yes require a Telnyx audit/repair action"
    exit 1
fi
if [ "$ACTION" == "audit-telnyx-credentials" ] && [ "$ASSUME_YES" == "true" ]; then
    echo "❌ --yes is only valid with --repair-telnyx-credentials"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

ensure_docker_access() {
    echo "🔍 Checking Docker access..."
    if ! docker info > /dev/null 2>&1; then
        echo "❌ Permission denied: Cannot connect to Docker daemon"
        echo ""
        echo "💡 Solutions:"
        echo "  1. Add your user to the docker group:"
        echo "     sudo usermod -aG docker $USER"
        echo "     Then log out and log back in"
        echo ""
        echo "  2. Or run this script with sudo"
        echo ""
        echo "  3. Or check if Docker is running:"
        echo "     sudo systemctl status docker"
        exit 1
    fi
}

# Check if environment is valid
if [[ ! "$ENVIRONMENT" =~ ^(production)$ ]]; then
    echo "❌ Invalid environment. Use: production"
    exit 1
fi

# Set compose file
COMPOSE_FILE="compose.yaml"
LOCAL_COMPOSE_FILE="compose.local.yaml"

# Change to the appropriate directory
cd "$SCRIPT_DIR/$ENVIRONMENT"
COMPOSE_ARGS=(-f "$COMPOSE_FILE" -f "$LOCAL_COMPOSE_FILE")

if [ -z "$ENV_FILE_ARG" ]; then
    ENV_FILE="$SCRIPT_DIR/$ENVIRONMENT/.env"
elif [[ "$ENV_FILE_ARG" == /* ]]; then
    ENV_FILE="$ENV_FILE_ARG"
else
    ENV_FILE="$CALLING_DIR/$ENV_FILE_ARG"
fi

# Check if .env file exists
if [ ! -f "$ENV_FILE" ]; then
    echo "❌ No environment file found at: $ENV_FILE"
    echo "   Create docker/production/.env or pass --env-file <path> for Telnyx maintenance."
    echo "📝 Required variables: POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD, TELNYX_API_KEY, NEXTAUTH_SECRET"
    exit 1
fi

# Load environment variables from .env file
echo "📋 Loading environment variables from $ENV_FILE..."
# Safely load .env without evaluating values. Do not use xargs here: it treats
# apostrophes and quotes in comments/secrets as shell syntax (for example the
# perfectly valid comment "application's public URL" caused an unterminated
# quote error before the old parser even reached the comment-skip check).
line_num=0
while IFS= read -r line || [ -n "$line" ]; do
    line_num=$((line_num + 1))
    line="${line%$'\r'}"
    # Trim only surrounding whitespace; preserve the value byte-for-byte
    # otherwise, including spaces, apostrophes, #, $, and backslashes.
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    # Skip empty lines and comments
    [[ -z "$line" || "$line" =~ ^# ]] && continue
    # Check if line contains =
    if [[ "$line" == *"="* ]]; then
        # Extract key and value
        key="${line%%=*}"
        value="${line#*=}"
        key="${key#"${key%%[![:space:]]*}"}"
        key="${key%"${key##*[![:space:]]}"}"
        value="${value#"${value%%[![:space:]]*}"}"
        value="${value%"${value##*[![:space:]]}"}"
        # Remove one matching pair of outer quotes without interpreting the
        # content as shell code.
        if [[ "$value" == \"*\" ]] || [[ "$value" == \'*\' ]]; then
            value="${value:1:${#value}-2}"
        fi
        if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
            echo "⚠️  Warning: Skipping invalid variable name on line $line_num"
            continue
        fi
        # Export the variable
        export "$key=$value"
    else
        echo "⚠️  Warning: Skipping malformed line $line_num in .env: $line"
    fi
done < "$ENV_FILE"

run_telnyx_connection_tool() {
    local command_name="$1"
    local args=("$command_name")
    if [ -n "$CONNECTION_ID" ]; then
        args+=("--connection-id" "$CONNECTION_ID")
    fi
    if [ "$ASSUME_YES" == "true" ]; then
        args+=("--yes")
    fi

    local tool="$PROJECT_ROOT/deploy/cli/telnyx-credential-connection.mjs"
    if command -v node > /dev/null 2>&1; then
        node "$tool" "${args[@]}"
        return
    fi

    # Legacy Docker-only hosts may not have Node installed. Run the checked-out
    # tool with the existing app image and mount the tool source read-only. No
    # application or database service is restarted by this command, and secret
    # values are inherited by name rather than exposed as command arguments.
    ensure_docker_access
    local app_image
    app_image="$(docker inspect telnyx-contact-center-app --format '{{.Config.Image}}' 2>/dev/null || true)"
    if [ -z "$app_image" ]; then
        app_image="$(docker compose "${COMPOSE_ARGS[@]}" images -q app 2>/dev/null || true)"
    fi
    if [ -z "$app_image" ]; then
        echo "❌ Node.js is not installed and no existing app image is available"
        echo "   Install Node.js 22+, or deploy/build the app image once before running this command."
        exit 1
    fi
    local docker_args=(run --rm -i)
    if [ -t 0 ] && [ -t 1 ]; then
        docker_args+=(-t)
    fi
    docker "${docker_args[@]}" \
        -e TELNYX_API_KEY \
        -e TELNYX_SIP_CONNECTION_ID \
        -e TELNYX_BASE_PATH \
        -v "$PROJECT_ROOT/deploy/cli:/cc-deploy-cli:ro" \
        "$app_image" node /cc-deploy-cli/telnyx-credential-connection.mjs "${args[@]}"
}

if [ "$ACTION" == "audit-telnyx-credentials" ]; then
    echo "🔍 Auditing historical Telnyx Credential Connection..."
    run_telnyx_connection_tool audit
    exit $?
fi

if [ "$ACTION" == "repair-telnyx-credentials" ]; then
    echo "🛠️  Auditing and repairing historical Telnyx Credential Connection..."
    run_telnyx_connection_tool repair
    exit $?
fi

echo "🚀 Deploying Telnyx Contact Center - Environment: $ENVIRONMENT"
ensure_docker_access

echo "📦 Building and starting services..."

if [[ "$FRESH_DEPLOY" == "--fresh" ]]; then
    # Fresh deployment: remove everything including volumes (recreates postgres DB from scratch)
    echo "🛑 Stopping existing containers and removing volumes (fresh deploy)..."
    echo "⚠️  WARNING: This will DELETE all database data and recreate it from scratch!"
    docker compose "${COMPOSE_ARGS[@]}" down -v --remove-orphans
else
    # Normal deployment: preserve database (only restart app container)
    echo "🛑 Stopping and removing app container only (preserving database)..."
    echo "ℹ️  Database data will be preserved. Use --fresh flag to recreate database."
    docker compose "${COMPOSE_ARGS[@]}" stop app 2>/dev/null || true
    docker compose "${COMPOSE_ARGS[@]}" rm -f app 2>/dev/null || true
fi

# Build and start services
echo "🔨 Building and starting services..."
docker compose "${COMPOSE_ARGS[@]}" up --build -d

# Wait for services to be healthy
echo "⏳ Waiting for services to be healthy..."
sleep 10

# Check service health
echo "🔍 Checking service health..."

# Check PostgreSQL
if [ -z "$POSTGRES_USER" ] || [ -z "$POSTGRES_DB" ]; then
    echo "❌ POSTGRES_USER or POSTGRES_DB not set in .env file"
    exit 1
fi

if docker compose "${COMPOSE_ARGS[@]}" exec -T postgres sh -ec \
    'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT 1"' \
    > /dev/null 2>&1; then
    echo "✅ PostgreSQL accepts the configured password (user: $POSTGRES_USER, database: $POSTGRES_DB)"
else
    echo "❌ PostgreSQL did not accept the configured password"
    echo "   Attempted connection with user: $POSTGRES_USER, database: $POSTGRES_DB"
    docker compose "${COMPOSE_ARGS[@]}" logs postgres
    exit 1
fi

# A positive login alone would also pass with a host `trust` rule. Prove that
# the new cluster actually rejects an invalid password over TCP.
if docker compose "${COMPOSE_ARGS[@]}" exec -T postgres sh -c \
    'PGPASSWORD="__cc_intentionally_invalid_password__" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT 1"' \
    > /dev/null 2>&1; then
    echo "❌ PostgreSQL accepted an invalid password; refusing to mark the deployment healthy"
    docker compose "${COMPOSE_ARGS[@]}" logs postgres
    exit 1
else
    echo "✅ PostgreSQL rejects an invalid password (SCRAM host authentication active)"
fi

# Check application
HEALTH_PORT="3000"
if curl -f http://localhost:$HEALTH_PORT/api/health > /dev/null 2>&1; then
    echo "✅ Application is healthy"
else
    echo "⚠️  Application health check failed (may still be starting up)"
    echo "📋 Checking application logs..."
    docker compose "${COMPOSE_ARGS[@]}" logs app --tail=50
fi

echo "🎉 Deployment completed successfully!"
echo ""
echo "📊 Service Status:"
echo "  - PostgreSQL: Running on 127.0.0.1:${POSTGRES_HOST_PORT:-5432} (Local override)"
echo "  - Application: Running on port 3000"
echo "  - Health Check: http://localhost:3000/api/health"
echo ""
echo "📝 Useful commands:"
echo "  - View logs: docker compose -f compose.yaml -f compose.local.yaml logs -f"
echo "  - Stop services: docker compose -f compose.yaml -f compose.local.yaml down"
echo "  - Restart services: docker compose -f compose.yaml -f compose.local.yaml restart"
echo "  - Fresh deploy (recreate DB): ./deploy.sh production --fresh"
echo "  - Audit legacy Telnyx SIP connection: ./deploy.sh production --audit-telnyx-credentials"
echo "  - Repair legacy Telnyx SIP connection: ./deploy.sh production --repair-telnyx-credentials"
echo "  - Access database: docker compose -f compose.yaml -f compose.local.yaml exec postgres psql -U $POSTGRES_USER -d $POSTGRES_DB"
