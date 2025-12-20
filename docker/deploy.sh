#!/bin/bash

# Telnyx Contact Center Docker Deployment Script
# Usage: ./deploy.sh [production]
#        ./deploy.sh production --fresh  (for fresh deployment with volume removal)

set -e

ENVIRONMENT=${1:-production}
FRESH_DEPLOY=${2:-""}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

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

echo "📦 Building and starting services..."

if [[ "$FRESH_DEPLOY" == "--fresh" ]]; then
    # Fresh deployment: remove everything including volumes
    echo "🛑 Stopping existing containers and removing volumes (fresh deploy)..."
    docker compose -f $COMPOSE_FILE down -v --remove-orphans
else
    # Normal deployment: preserve database
    echo "🛑 Stopping and removing app container only (preserving database)..."
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
if docker compose -f $COMPOSE_FILE exec -T postgres pg_isready -U ${POSTGRES_USER:-postgres} -d ${POSTGRES_DB:-telnyx_contact_center} > /dev/null 2>&1; then
    echo "✅ PostgreSQL is healthy"
else
    echo "❌ PostgreSQL is not responding"
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
echo "  - Access database: docker compose exec postgres psql -U ${POSTGRES_USER:-postgres} -d ${POSTGRES_DB:-telnyx_contact_center}"
