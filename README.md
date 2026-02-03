# Telnyx Contact Center

**Version:** 0.1.0

A Next.js 15 application providing a complete contact center solution built on Telnyx Voice APIs. This application features a visual voice flow designer, skills-based call routing, real-time agent monitoring, and AI assistant integration.

## Features

### Core Functionality

- **Visual Voice Flow Designer**: Drag-and-drop flow builder using ReactFlow for creating call flows
- **Skills-Based Routing**: Intelligent call routing based on agent skills and proficiency levels
- **Agent Desktop**: Real-time call handling interface with WebRTC support
- **Queue Management**: Dynamic queue creation and management with priority-based routing
- **Real-Time Monitoring**: Live agent status, queue metrics, and call tracking
- **Call Recording & Transcription**: Built-in recording and transcription capabilities
- **AI Integration**: Telnyx AI assistant integration for call analysis and assistance

### User Features

- **Agent Configuration**: Skills, proficiency levels, and availability management
- **User Profile**: Theme switching (Light/Dark/System), avatar upload, preferences
- **Multi-Authentication**: Local auth, Google OAuth, GitHub OAuth, Facebook OAuth
- **Role-Based Access**: Multi-role support with granular permissions
- **Secrets Management**: Encrypted storage for API keys and sensitive data

### Technical Features

- **Event-Driven Architecture**: Webhook-based flow execution
- **In-Memory State Management**: High-performance caching with periodic DB sync
- **Server-Sent Events (SSE)**: Real-time updates for agent desktop
- **PostgreSQL Database**: Comprehensive schema for users, queues, interactions, and flows
- **Docker Support**: Production-ready containerization with automatic schema initialization

## Tech Stack

- Next.js 15 (App Router)
- React 19
- PostgreSQL
- Tailwind CSS
- Radix UI components
- Next Themes for dark mode

## Getting Started

### Prerequisites

- Node.js 20+
- PostgreSQL
- Yarn package manager

### Installation

1. Install dependencies:

```bash
yarn install
```

2. Set up environment variables:

```bash
cp sample.env .env.local
```

Edit `.env.local` with your configuration:

- PostgreSQL connection details
- Telnyx API credentials
- NextAuth configuration

3. Set up the database:

```bash
yarn ensure:pg
```

This will create the necessary tables including:

- `users` table with contact center configuration (skills, proficiency levels, etc.)
- `skills` table for managing available skills
- `agent_groups` table for agent group management

4. Run the development server:

```bash
yarn dev
```

The application will be available at `http://localhost:3000`.

## Docker Deployment

The application includes production-ready Docker configuration for easy deployment on virtual machines or cloud instances.

### Architecture

The Docker setup uses a multi-container architecture:

- **PostgreSQL 17**: Database container with automatic schema initialization
- **Next.js Application**: Production-optimized container with automatic build and startup
- **Automatic Schema Setup**: Database schema is created automatically on first startup
- **Health Checks**: Built-in health monitoring for both services

### Quick Start on VM

#### 1. Install Docker on Ubuntu VM

If Docker is not already installed, run the installation script:

```bash
# Make the script executable
chmod +x docker/install-docker.sh

# Run the installation script (requires sudo)
sudo ./docker/install-docker.sh
```

**Important:** After installation, you must **log out and log back in** for Docker group permissions to take effect.

#### 2. Configure Environment Variables

Create the environment file for production:

```bash
# Navigate to the docker production directory
cd docker/production

# Copy the sample.env as a reference (if available)
# Or create .env file directly
nano .env
```

Required environment variables (minimum):

```env
# Database Configuration
POSTGRES_DB=telnyx_contact_center
POSTGRES_USER=postgres
POSTGRES_PASSWORD=your_secure_password_here

# Application URLs
NEXT_PUBLIC_BASE_URL=https://your-domain.com
NEXTAUTH_URL=https://your-domain.com
APP_BASE_URL=https://your-domain.com
ALLOWED_ORIGINS=https://your-domain.com

# Authentication
NEXTAUTH_SECRET=your_secret_here_min_32_chars

# Allowed email domains for user registration (comma-separated)
# Domains will be automatically seeded to the database on startup
ALLOWED_EMAIL_DOMAINS=yourdomain.com,subdomain.yourdomain.com

# Telnyx Configuration
TELNYX_API_KEY=your_telnyx_api_key
TELNYX_WEBHOOK_SECRET=your_webhook_secret
TELNYX_CALL_CONTROL_ID=your_call_control_id

# Database Connection (for app container)
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
```

For a complete list of all environment variables, see `sample.env` in the project root.

#### 3. Deploy Using the Deployment Script

The deployment script handles building, starting, and health checking:

```bash
# Navigate to project root
cd /path/to/telnyx-contact-center

# Make the deploy script executable
chmod +x docker/deploy.sh

# Deploy to production (preserves database data)
./docker/deploy.sh production

# OR deploy with fresh database (WARNING: deletes all data)
./docker/deploy.sh production --fresh
```

**Deployment Options:**

- `./docker/deploy.sh production` - Normal deployment, preserves existing database
- `./docker/deploy.sh production --fresh` - Fresh deployment, recreates database from scratch

#### 4. Verify Deployment

After deployment, check the service status:

```bash
# Navigate to production directory
cd docker/production

# Check container status
docker compose ps

# View logs
docker compose logs -f

# Check application health
curl http://localhost:3000/api/health
```

### Manual Docker Deployment

If you prefer manual deployment without the script:

```bash
# Navigate to production directory
cd docker/production

# Build and start services
docker compose up --build -d

# View logs
docker compose logs -f

# Stop services
docker compose down

# Stop and remove volumes (WARNING: deletes database)
docker compose down -v
```

### Docker Scripts Reference

#### `docker/install-docker.sh`

Installs Docker and Docker Compose on Ubuntu/Debian systems.

**Usage:**

```bash
sudo ./docker/install-docker.sh
```

**What it does:**

- Updates system packages
- Installs Docker Engine and Docker Compose plugin
- Adds current user to docker group
- Configures firewall (UFW) for ports 22, 80, 443, 3000
- Enables Docker to start on boot

**Important:** After running, log out and log back in for docker group changes to take effect.

#### `docker/deploy.sh`

Deploys the application using Docker Compose.

**Usage:**

```bash
./docker/deploy.sh [environment] [--fresh]
```

**Parameters:**

- `environment`: Currently supports `production` only
- `--fresh`: Optional flag to recreate database from scratch (deletes all data)

**What it does:**

- Checks Docker permissions and access
- Loads environment variables from `.env` file
- Stops existing containers (preserves database unless `--fresh` is used)
- Builds and starts services
- Waits for PostgreSQL to be healthy
- Checks application health endpoint
- Provides useful commands for monitoring

**Example:**

```bash
# Normal deployment (preserves database)
./docker/deploy.sh production

# Fresh deployment (recreates database)
./docker/deploy.sh production --fresh
```

### Docker Directory Structure

```
docker/
├── production/              # Production environment configuration
│   ├── compose.yaml        # Docker Compose configuration
│   ├── Dockerfile          # Application Docker image definition
│   ├── init-schema.sql     # PostgreSQL initialization script
│   └── .env                # Environment variables (create this)
├── deploy.sh               # Deployment script
├── install-docker.sh       # Docker installation script for Ubuntu
└── README.md               # Detailed Docker documentation
```

### Docker Compose Services

#### PostgreSQL Service

- **Image:** `postgres:17-alpine`
- **Port:** `5432`
- **Volume:** `postgres_data` (persistent storage)
- **Health Check:** Automatic PostgreSQL readiness check
- **Initialization:** Runs `init-schema.sql` on first startup

#### Application Service

- **Build:** Uses `docker/production/Dockerfile`
- **Port:** `3000`
- **Dependencies:** Waits for PostgreSQL to be healthy
- **Startup Process:**
  1. Waits for PostgreSQL to be ready
  2. Initializes database schema (`yarn ensure:pg`)
  3. Builds Next.js application (`yarn build`)
  4. Starts production server (`yarn start`)
- **Health Check:** Checks `/api/health` endpoint every 30 seconds

### Docker Management Commands

#### View Logs

```bash
cd docker/production

# All services
docker compose logs -f

# Specific service
docker compose logs -f app
docker compose logs -f postgres
```

#### Check Status

```bash
cd docker/production

# Service status
docker compose ps

# Health check
curl http://localhost:3000/api/health
```

#### Database Access

```bash
cd docker/production

# Connect to database
docker compose exec postgres psql -U postgres -d telnyx_contact_center

# Run SQL command
docker compose exec postgres psql -U postgres -d telnyx_contact_center -c "SELECT COUNT(*) FROM users;"

# Create database backup
docker compose exec postgres pg_dump -U postgres telnyx_contact_center > backup.sql

# Restore database backup
docker compose exec -T postgres psql -U postgres telnyx_contact_center < backup.sql
```

#### Restart Services

```bash
cd docker/production

# Restart all services
docker compose restart

# Restart specific service
docker compose restart app
docker compose restart postgres
```

#### Stop and Clean Up

```bash
cd docker/production

# Stop services (preserves data)
docker compose stop

# Stop and remove containers (preserves volumes)
docker compose down

# Stop and remove everything including volumes (WARNING: deletes database)
docker compose down -v

# Remove images
docker compose down --rmi all
```

### Troubleshooting Docker Deployment

#### Permission Denied Errors

```bash
# Add user to docker group
sudo usermod -aG docker $USER

# Log out and log back in, then verify
docker run hello-world
```

#### Database Connection Failed

```bash
# Check if PostgreSQL is running
docker compose ps postgres

# Check PostgreSQL logs
docker compose logs postgres

# Verify environment variables
docker compose exec app env | grep POSTGRES
```

#### Application Won't Start

```bash
# Check application logs
docker compose logs app

# Verify environment variables are loaded
docker compose exec app env | grep TELNYX

# Manually run schema initialization
docker compose exec app node scripts/ensure-pg.mjs
```

#### Port Already in Use

```bash
# Check what's using the port
sudo lsof -i :3000
sudo lsof -i :5432

# Stop conflicting services or change ports in compose.yaml
```

### Production Considerations

1. **Reverse Proxy**: Use Nginx or similar for SSL termination and routing
2. **Firewall**: Configure firewall rules for ports 22 (SSH), 80 (HTTP), 443 (HTTPS)
3. **Backups**: Set up regular database backups
4. **Monitoring**: Configure log aggregation and monitoring tools
5. **Secrets**: Use Docker secrets or external secret management in production
6. **SSL/TLS**: Configure SSL certificates for HTTPS
7. **Domain Configuration**: Point your domain to the VM's public IP

For detailed Docker documentation, see `docker/README.md`.

## Database Schema

The application uses PostgreSQL with a comprehensive schema including:

### Core Tables

- **users**: User accounts with contact center configuration
- **domains**: Allowed email domains for registration (automatically seeded from `ALLOWED_EMAIL_DOMAINS` env var)
- **app_settings**: Application-wide settings and configuration
- **skills**: Available skills for skills-based routing

### Contact Center Tables

- **cc_queues**: Queue definitions with routing configuration
- **cc_queue_user_assignments**: Agent-to-queue assignments with priorities
- **cc_interactions**: Call interactions with state tracking
- **cc_agent_state**: Real-time agent availability state
- **cc_queue_state**: Real-time queue metrics

### Voice Flow Tables

- **voice_flows**: Flow definitions as ReactFlow JSONB graphs
- **voice_flow_phone_numbers**: Phone number to flow mappings
- **voice_flow_executions**: Flow execution history and state

### Authentication Tables (NextAuth)

- **auth_users**: User authentication data
- **auth_accounts**: OAuth account linkages
- **auth_sessions**: Active user sessions

### Users Table Details

The `users` table includes contact center specific fields:

- `skills` (JSONB): Skills with proficiency levels for skills-based routing
  - Format: `{"skill_uuid": proficiency_level (1-10)}`
  - Example: `{"uuid-1": 8, "uuid-2": 6, "uuid-3": 9}`
- `agent_status`: Current agent availability status (Available, Busy, Away, Offline, Break)
- `max_concurrent_calls`: Maximum concurrent calls the agent can handle
- `preferred_languages`: Array of language codes for routing
- `timezone`: Agent timezone
- `extension`: Agent extension/phone number
- `available_for_routing`: Whether agent is available for skills-based routing
- `last_activity`: Last activity timestamp
- `cc_config`: Additional contact center configuration (JSONB)

## Project Structure

```
telnyx-contact-center/
├── app/
│   ├── (portal)/              # Authenticated portal routes
│   │   ├── agent/            # Agent desktop and configuration
│   │   ├── admin/            # Admin panel (flows, queues, users)
│   │   └── profile/          # User profile management
│   ├── api/                  # API routes
│   │   ├── auth/             # NextAuth endpoints
│   │   ├── contact-center/   # Contact center APIs
│   │   ├── voice/            # Voice flow webhooks
│   │   └── ai/               # AI assistant APIs
│   ├── signin/               # Sign in page
│   ├── signup/               # Sign up page
│   └── layout.jsx            # Root layout
├── components/
│   ├── ui/                   # Radix UI components
│   ├── contact-center/       # Contact center components
│   ├── voice-flow/           # Voice flow designer components
│   └── floating-softphone.jsx # WebRTC softphone
├── config/
│   ├── menu.jsx              # Sidebar menu configuration
│   ├── user.js               # User status options
│   └── voice-flow-nodes.js   # Voice flow node definitions
├── lib/
│   ├── contact-center/       # Contact center logic
│   │   ├── routing-engine.js      # Call routing algorithms
│   │   ├── state-manager.js        # In-memory state cache
│   │   ├── queued-call-router.js   # Queue routing
│   │   └── user-status.js          # Agent status management
│   ├── voice-flow-engine.js  # Flow execution engine
│   ├── postgres.mjs          # PostgreSQL connection
│   ├── postgres-schema.mjs   # Database schema
│   ├── telnyx.js             # Telnyx API utilities
│   └── secrets.js            # Encrypted secrets management
├── docker/                   # Docker deployment files
│   ├── production/           # Production Docker config
│   ├── deploy.sh             # Deployment script
│   └── install-docker.sh     # Docker installation script
├── scripts/                  # Utility scripts
│   └── ensure-pg.mjs         # Database schema initialization
└── hooks/                    # React hooks
    └── use-mobile.js         # Mobile detection hook
```

## Menu Structure

The left sidebar includes:

- **AGENT**
  - Desktop
  - Configuration

The bottom menu provides access to:

- User Profile
- Theme switching (Light/Dark/System)

## Development

### Local Development Commands

- `yarn dev` - Start development server (hostname 0.0.0.0:3000, FAST_REFRESH disabled)
- `yarn build` - Build for production
- `yarn start` - Start production server
- `yarn lint` - Run ESLint
- `yarn ensure:pg` - Ensure PostgreSQL schema is set up

### Environment Setup

1. Copy `sample.env` to `.env.local`:

   ```bash
   cp sample.env .env.local
   ```

2. Edit `.env.local` with your configuration (see `sample.env` for detailed comments)

3. Initialize database:

   ```bash
   yarn ensure:pg
   ```

4. Start development server:
   ```bash
   yarn dev
   ```

### Key Implementation Details

#### Voice Flow Engine

- Event-driven execution model
- ReactFlow-based visual designer
- Variable substitution using `{{variable}}` notation
- Client state maintained across webhook calls
- Support for call control, audio playback, input collection, AI integration

#### Contact Center Routing

- Skills-based routing with proficiency levels (1-10)
- FIFO and priority-based queue routing
- Real-time agent state management
- In-memory caching with periodic DB sync
- Automatic queue creation via flow nodes

#### Real-Time Updates

- Server-Sent Events (SSE) for live updates
- WebSocket-like functionality for agent desktop
- Real-time call state synchronization
- Queue metrics and agent status tracking

For detailed architecture documentation, see `CLAUDE.md` and files in the `plan/` directory.

## License

Private project
