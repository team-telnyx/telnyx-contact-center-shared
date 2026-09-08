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

## Deployment wizard (`./deploy/cc`)

The fastest way to get a fully working, Telnyx-wired Contact Center running
is the interactive deployment wizard:

```bash
./deploy/cc up
```

It's a single CLI that walks you through choosing a target — your own
machine (Docker), AWS, Azure, or GCP — then handles everything end to end:
provisioning infrastructure (Terraform, for cloud targets), creating the
Telnyx voice app / SIP connection / phone number, generating all secrets,
building and deploying the app image, and printing a ready-to-use summary
(app URL, owner login, inbound number). It also manages the full day-2
lifecycle — `cc status`, `cc logs`, `cc update`, `cc telnyx` (repair Telnyx
resources), and `cc destroy` (tear down).

Every run is resumable (Ctrl-C or a crash picks back up where it left off)
and every external write is idempotent, so re-running the wizard never
duplicates cloud infrastructure or Telnyx resources.

For the full command reference, every deployment target's specifics, all
wizard prompts explained, non-interactive/CI usage, and troubleshooting,
see **[`deploy/README.md`](deploy/README.md)**.

The manual Docker Compose setup described below still works and is useful
if you want to manage the containers yourself instead of going through the
wizard — but for most cases, `./deploy/cc up` is the recommended path.

## Production deployment with Docker

The project includes a complete Docker setup for running the Contact Center and PostgreSQL in containers on a single machine.

### Prerequisites

- Docker Engine and Docker Compose v2
- A Telnyx account with an API key
- A Telnyx Call Control Application with its webhook URL pointing to your server

### Quick deploy

```bash
# 1. Configure environment
cp docker/production/sample.env docker/production/.env
# Edit .env with your Telnyx API key, database password, and secrets

# 2. Deploy
./docker/deploy.sh production

# 3. Verify
curl http://localhost:3000/api/health
```

The deployment script handles building the Docker image, starting PostgreSQL and the app container, running database schema initialization, and health checks. Database data is preserved between deploys; use `--fresh` to recreate the database from scratch.

### What the Docker setup includes

- **PostgreSQL 17** — database container with persistent volume
- **Next.js application** — production build served by the app container
- **Automatic schema initialization** — database tables are created on startup via `yarn ensure:pg`
- **Health checks** — both PostgreSQL and the application have Docker health checks

See [`docker/README.md`](docker/README.md) for detailed configuration, manual deployment, logs, and troubleshooting.

### Environment variables

Copy `docker/production/sample.env` to `docker/production/.env` and fill in the required values:

```env
NODE_ENV=production
NEXTAUTH_URL=https://<your-server-url>
APP_BASE_URL=https://<your-server-url>
NEXT_PUBLIC_BASE_URL=https://<your-server-url>
ALLOWED_ORIGINS=https://<your-server-url>
NEXTAUTH_SECRET=<long-random-secret>
ACCESS_JWT_SECRET=<different-long-random-secret>
REFRESH_JWT_SECRET=<different-long-random-secret>

# Telnyx credentials
TELNYX_API_KEY=<your-telnyx-api-key>
TELNYX_WEBHOOK_SECRET=<your-webhook-secret>
TELNYX_CALL_CONTROL_ID=<your-call-control-application-id>

# Database
POSTGRES_DB=telnyx_contact_center
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<secure-password>

# Initial admin user
DEFAULT_OWNER_EMAIL=admin@example.com
DEFAULT_OWNER_PASSWORD=<change-after-first-login>
ALLOWED_EMAIL_DOMAINS=example.com
```

`NEXT_PUBLIC_*` variables are compiled into the browser bundle at build time. Server-only values can be changed in `.env` without rebuilding the image.

### Streaming WebSocket (optional)

If you use AI streaming, Telnyx STT streaming, or the hardphone bridge, the app starts a streaming WebSocket server on `STREAMING_WS_PORT` (defaults to `PORT + 1`, normally `3001`). Expose this port through your reverse proxy or load balancer and set `WS_BASE_URL` to the public `wss://` URL.

For high-availability and load-balanced deployments, see [`docker/README.md`](docker/README.md).

## Database Schema

The application uses PostgreSQL with a comprehensive schema including:

### Core Tables

- **users**: User accounts with contact center configuration
- **domains**: Allowed email domains for registration (automatically seeded from `ALLOWED_EMAIL_DOMAINS` env var)
- **app_settings**: Application-wide settings and configuration
- **skills**: Available skills for skills-based routing

### Automatic Database Seeding

On first deployment or when running `yarn ensure:pg`, the following are automatically seeded:

- **Allowed Email Domains**: From `ALLOWED_EMAIL_DOMAINS` environment variable
- **Default Owner User**: From `DEFAULT_OWNER_EMAIL` and `DEFAULT_OWNER_PASSWORD` environment variables
  - Created with "owner" role and verified status (can log in immediately)
  - Password must be at least 8 characters
  - Email domain must be in the allowed domains list (or will show a warning)
  - **Important**: Change the default password after first login!

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
├── scripts/                  # Runtime scripts
│   ├── ensure-pg.mjs         # Database schema initialization (called by Dockerfile)
│   └── start-next-with-pino.mjs # Production startup wrapper (yarn start)
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

For detailed architecture documentation, see the `docs/` directory.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for
details.
