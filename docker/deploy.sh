#!/bin/bash

# Telnyx Contact Center Docker Deployment Script
# Usage: ./deploy.sh [production]                    (preserves database data)
#        ./deploy.sh production --fresh               (recreates postgres DB from scratch)

set -e

ENVIRONMENT=${1:-production}
FRESH_DEPLOY=${2:-""}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Check Docker permissions
echo "🔍 Checking Docker access..."
if ! docker info > /dev/null 2>&1; then
    echo "❌ Permission denied: Cannot connect to Docker daemon"
    echo ""
    echo "💡 Solutions:"
    echo "  1. Add your user to the docker group:"
    echo "     sudo usermod -aG docker $USER"
    echo "     Then log out and log back in"
    echo ""
    echo "  2. Or run this script with sudo:"
    echo "     sudo ./deploy.sh $ENVIRONMENT $FRESH_DEPLOY"
    echo ""
    echo "  3. Or check if Docker is running:"
    echo "     sudo systemctl status docker"
    exit 1
fi

echo "🚀 Deploying Telnyx Contact Center - Environment: $ENVIRONMENT"

# Check if environment is valid
if [[ ! "$ENVIRONMENT" =~ ^(production)$ ]]; then
    echo "❌ Invalid environment. Use: production"
    exit 1
fi

# Set compose file
COMPOSE_FILE="compose.yaml"

# Change to the appropriate directory
cd "$SCRIPT_DIR/$ENVIRONMENT"

# Check if .env file exists
if [ ! -f ".env" ]; then
    echo "❌ No .env file found. Please create a .env file with your configuration."
    echo "📝 Required variables: POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD, TELNYX_API_KEY, NEXTAUTH_SECRET"
    exit 1
fi

# Load environment variables from .env file
echo "📋 Loading environment variables from .env file..."
# Safely load .env file, handling comments, empty lines, and special characters
line_num=0
while IFS= read -r line || [ -n "$line" ]; do
    line_num=$((line_num + 1))
    # Remove leading/trailing whitespace
    line=$(echo "$line" | xargs)
    # Skip empty lines and comments
    [[ -z "$line" || "$line" =~ ^# ]] && continue
    # Check if line contains =
    if [[ "$line" == *"="* ]]; then
        # Extract key and value
        key="${line%%=*}"
        value="${line#*=}"
        # Remove quotes if present
        value=$(echo "$value" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
        # Remove leading/trailing whitespace from key and value
        key=$(echo "$key" | xargs)
        value=$(echo "$value" | xargs)
        # Export the variable
        export "$key=$value"
    else
        echo "⚠️  Warning: Skipping malformed line $line_num in .env: $line"
    fi
done < .env

echo "📦 Building and starting services..."

if [[ "$FRESH_DEPLOY" == "--fresh" ]]; then
    # Fresh deployment: remove everything including volumes (recreates postgres DB from scratch)
    echo "🛑 Stopping existing containers and removing volumes (fresh deploy)..."
    echo "⚠️  WARNING: This will DELETE all database data and recreate it from scratch!"
    docker compose -f $COMPOSE_FILE down -v --remove-orphans
else
    # Normal deployment: preserve database (only restart app container)
    echo "🛑 Stopping and removing app container only (preserving database)..."
    echo "ℹ️  Database data will be preserved. Use --fresh flag to recreate database."
    docker compose -f $COMPOSE_FILE stop app 2>/dev/null || true
    docker compose -f $COMPOSE_FILE rm -f app 2>/dev/null || true
fi

# Build and start services
echo "🔨 Building and starting services..."
docker compose -f $COMPOSE_FILE up --build -d

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

if docker compose -f $COMPOSE_FILE exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" > /dev/null 2>&1; then
    echo "✅ PostgreSQL is healthy (user: $POSTGRES_USER, database: $POSTGRES_DB)"
else
    echo "❌ PostgreSQL is not responding"
    echo "   Attempted connection with user: $POSTGRES_USER, database: $POSTGRES_DB"
    docker compose -f $COMPOSE_FILE logs postgres
    exit 1
fi

# Check application
HEALTH_PORT="3000"
if curl -f http://localhost:$HEALTH_PORT/api/health > /dev/null 2>&1; then
    echo "✅ Application is healthy"
else
    echo "⚠️  Application health check failed (may still be starting up)"
    echo "📋 Checking application logs..."
    docker compose -f $COMPOSE_FILE logs app --tail=50
fi

echo "🎉 Deployment completed successfully!"
echo ""
echo "📊 Service Status:"
echo "  - PostgreSQL: Running on port 5432"
echo "  - Application: Running on port 3000"
echo "  - Health Check: http://localhost:3000/api/health"
echo ""
echo "📝 Useful commands:"
echo "  - View logs: docker compose logs -f"
echo "  - Stop services: docker compose down"
echo "  - Restart services: docker compose restart"
echo "  - Fresh deploy (recreate DB): ./deploy.sh production --fresh"
echo "  - Access database: docker compose exec postgres psql -U $POSTGRES_USER -d $POSTGRES_DB"
