> **Production deployment note:** This Docker Compose documentation is retained for local experiments and historical reference. Current production deployments use GitHub Actions to build immutable Docker image artifacts, store them in S3, and deploy them with [FDE Infra CLI](https://github.com/team-telnyx/fde-infra-cli) to EC2 nodes that use PostgreSQL in RDS. Start with the root [`README.md`](../README.md) and [`docs/S3_IMAGE_ARTIFACT_DEPLOYMENT.md`](../docs/S3_IMAGE_ARTIFACT_DEPLOYMENT.md) before using any legacy Docker scripts.

# Telnyx Contact Center - Docker Deployment

This directory contains Docker configurations for deploying the Telnyx Contact Center application.

## 🏗️ Architecture

The application uses a multi-container setup with:

- **PostgreSQL 17 Database**: Stores all application data
- **Next.js Application**: The main web application
- **Automatic Schema Initialization**: Database schema is created automatically on startup

## 📁 Directory Structure

```
docker/
├── production/          # Production environment
│   ├── compose.yaml    # Docker Compose configuration
│   ├── Dockerfile      # Application Docker image
│   ├── init-schema.sql # PostgreSQL initialization script
│   └── .env.example   # Environment variables template
├── deploy.sh          # Deployment script
└── README.md          # This file
```

## 🚀 Quick Start

### Prerequisites

- Docker and Docker Compose V2 installed
- Environment variables configured

### 1. Configure Environment Variables

Copy the example environment file:

```bash
cp docker/production/.env.example docker/production/.env
```

Update the `.env` file with your actual values:

- `POSTGRES_PASSWORD`: A secure database password
- `TELNYX_API_KEY`: Your Telnyx API key
- `NEXTAUTH_SECRET`: A secure random string (minimum 32 characters)

### 2. Deploy Using the Script

```bash
# Make deploy script executable
chmod +x docker/deploy.sh

# Deploy to production
./docker/deploy.sh production
```

### 3. Manual Deployment

If you prefer manual deployment:

```bash
# Navigate to the environment directory
cd docker/production

# Start services
docker compose up --build -d

# Check logs
docker compose logs -f
```

## 🔧 Environment Configuration

### Production

- **Port**: 3000 (app), 5432 (database)
- **Database**: `telnyx_contact_center`
- **Features**: Production build, health checks, restart policies

## 🗄️ Database Schema & Seeding

The application automatically creates the following database schema on startup:

- **Core Tables**: users, domains, app_settings
- **Contact Center**: cc_queues, cc_queue_user_assignments, cc_interactions, cc_agent_state
- **Authentication**: NextAuth tables (auth_users, auth_accounts, auth_sessions)
- **Voice Flows**: voice_flows, voice_flow_phone_numbers, voice_flow_executions

### 🌱 Database Seeding

The deployment process automatically seeds the database with:

- **Default User Statuses** - Available, Busy, Away, Offline, Break
- **Default App Settings** - Theme colors and branding from globals.css

The seeding is **idempotent** - it won't create duplicate records when run multiple times.

## 🔍 Health Checks

The application includes health check endpoints:

- **Application**: `http://localhost:3000/api/health`
- **Database**: Automatic PostgreSQL health checks
- **Container**: Docker health checks for both services

## 📊 Monitoring

### View Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f app
docker compose logs -f postgres
```

### Check Status

```bash
# Service status
docker compose ps

# Health check
curl http://localhost:3000/api/health
```

### Database Access

```bash
# Connect to database
docker compose exec postgres psql -U postgres -d telnyx_contact_center

# Run database commands
docker compose exec postgres psql -U postgres -d telnyx_contact_center -c "SELECT * FROM users LIMIT 5;"
```

## 🛠️ Troubleshooting

### Common Issues

1. **Database Connection Failed**

   ```bash
   # Check if PostgreSQL is running
   docker compose ps postgres

   # Check PostgreSQL logs
   docker compose logs postgres
   ```

2. **Application Won't Start**

   ```bash
   # Check application logs
   docker compose logs app

   # Verify environment variables
   docker compose exec app env | grep POSTGRES
   ```

3. **Schema Initialization Failed**

   ```bash
   # Check if schema initialization ran
   docker compose logs app | grep "Schema created"

   # Manually run schema initialization
   docker compose exec app node scripts/ensure-pg.mjs
   ```

### Reset Everything

```bash
# Stop and remove all containers, networks, and volumes
docker compose down -v --remove-orphans

# Remove images
docker compose down --rmi all

# Start fresh
docker compose up --build -d
```

## 🔒 Security Considerations

### Production Deployment

1. **Change Default Passwords**: Update all default passwords in production
2. **Use Secrets Management**: Consider using Docker secrets or external secret management
3. **Network Security**: Configure proper firewall rules
4. **SSL/TLS**: Use reverse proxy with SSL termination (nginx recommended)
5. **Database Security**: Use strong passwords and consider encrypted connections

### Environment Variables

Never commit `.env` files to version control. Use environment-specific configurations:

```bash
# Example production .env
POSTGRES_PASSWORD=your_very_secure_password_here
NEXTAUTH_SECRET=your_very_secure_secret_here_min_32_chars
TELNYX_API_KEY=your_actual_telnyx_key
```

## 🚀 AWS EC2 Deployment

For AWS EC2 deployment:

1. **Launch EC2 Instance**: Use Ubuntu 22.04 LTS or later
2. **Install Docker**: Follow the commands in `UBUNTU_DOCKER_SETUP.md`
3. **Configure Security Groups**: Open ports 22 (SSH), 80 (HTTP), 443 (HTTPS), 3000 (App)
4. **Deploy Application**: Use the production configuration
5. **Set up Reverse Proxy**: Use Nginx for SSL termination and routing
6. **Configure Domain**: Point your domain to the EC2 instance

### Example AWS Setup

```bash
# On EC2 instance
# 1. Update system and install Docker (see UBUNTU_DOCKER_SETUP.md)

# 2. Clone your repository
git clone <your-repo-url>
cd telnyx-contact-center

# 3. Configure environment
cp docker/production/.env.example docker/production/.env
# Edit .env with your values

# 4. Deploy
chmod +x docker/deploy.sh
./docker/deploy.sh production
```

## 📝 Maintenance

### Regular Tasks

1. **Update Dependencies**: Regularly update Docker images and application dependencies
2. **Backup Database**: Set up regular database backups
3. **Monitor Logs**: Check logs for errors and performance issues
4. **Security Updates**: Keep the system updated with security patches

### Backup Database

```bash
# Create backup
docker compose exec postgres pg_dump -U postgres telnyx_contact_center > backup.sql

# Restore backup
docker compose exec -T postgres psql -U postgres telnyx_contact_center < backup.sql
```

## 🤝 Support

For issues and questions:

1. Check the logs first: `docker compose logs -f`
2. Verify environment variables are correct
3. Ensure all required services are running
4. Check the health endpoint: `curl http://localhost:3000/api/health`
