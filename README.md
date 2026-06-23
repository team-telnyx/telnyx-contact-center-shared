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

## Production deployment architecture

Production deployments no longer build the application directly on the EC2 host with `docker compose up --build` or the legacy `docker/deploy.sh` workflow. The current production model is:

```text
GitHub repository ref
  -> GitHub Actions workflow builds the production Docker image
  -> workflow saves the image as image.tar.zst, checksum, and manifest.json
  -> workflow uploads the immutable artifact to S3
  -> FDE CLI or an SSM deployment command downloads the artifact on EC2
  -> EC2 verifies checksum, docker-loads the image, recreates the app container
  -> app connects to environment-specific PostgreSQL in Amazon RDS
```

The important rule is that the Docker image is built once and then promoted. Runtime differences such as database host, secrets, Telnyx credentials, public URL, and health-check settings live in the environment file on each EC2 node, not in a rebuilt image.

### Source repositories and deployment tooling

- Application repo: `team-telnyx/telnyx-contact-center`
- Artifact workflow: `.github/workflows/build-s3-image-artifact.yml`
- Dockerfile used by the workflow: `docker/production/Dockerfile`
- Shared artifact bucket: `s3://fde-app-artifacts-260957529682`
- Contact Center artifact prefix: `contact-center`
- Operator tool: [FDE Infra CLI](https://github.com/team-telnyx/fde-infra-cli)
- Detailed artifact guide: [`docs/S3_IMAGE_ARTIFACT_DEPLOYMENT.md`](docs/S3_IMAGE_ARTIFACT_DEPLOYMENT.md)

Use the FDE CLI for normal automated deployments. It discovers environments from EC2 `Fde*` tags, lists S3 artifacts, triggers the GitHub Actions artifact workflow when requested, deploys existing artifacts through AWS SSM, performs health checks, and supports rollback by redeploying a previous artifact.

### Runtime database model: PostgreSQL in Amazon RDS

Production environments use PostgreSQL in RDS rather than a PostgreSQL container managed by this repo. The application still runs schema initialization with `yarn ensure:pg` during container startup, but the database lifecycle belongs to RDS.

Required runtime environment variables on each node include:

```env
POSTGRES_HOST=<rds-endpoint>
POSTGRES_PORT=5432
POSTGRES_DB=<database-name>
POSTGRES_USER=<database-user>
POSTGRES_PASSWORD=<database-password>

# TLS for RDS. PGSSLMODE=require is the normal FDE setting.
PGSSLMODE=require
# Optional stricter modes if root certs are provisioned:
# PGSSLMODE=verify-ca
# PGSSLMODE=verify-full
# PGSSLROOTCERT=/path/to/rds-ca.pem
```

Do not use `POSTGRES_HOST=postgres` in production; that value only applies to local Docker Compose setups with a database service. Do not create or destroy RDS data as part of application deployment. Backups, Multi-AZ, parameter groups, and destructive database operations must be handled explicitly at the infrastructure/RDS layer.

### Runtime application configuration

Each EC2 node has an env file identified by the `FdeEnvFile` tag, for example `/opt/cc-prod/app.env` or `/opt/cc-ha/app.env`. Keep secrets and environment-specific values there:

```env
NODE_ENV=production
NEXTAUTH_URL=https://<environment-url>
APP_BASE_URL=https://<environment-url>
NEXT_PUBLIC_BASE_URL=https://<environment-url>
ALLOWED_ORIGINS=https://<environment-url>
NEXTAUTH_SECRET=<long-random-secret>

TELNYX_API_KEY=<telnyx-api-key>
TELNYX_WEBHOOK_SECRET=<webhook-secret>
TELNYX_CALL_CONTROL_ID=<call-control-connection-id>

ALLOWED_EMAIL_DOMAINS=example.com
DEFAULT_OWNER_EMAIL=owner@example.com
DEFAULT_OWNER_PASSWORD=<initial-password-change-after-login>
```

`NEXT_PUBLIC_*` variables are compiled into the browser bundle during the GitHub Actions build. Keep them shared or intentionally configured in repository/environment variables if the same image is promoted across multiple environments. Server-only values can differ per EC2 node via `FdeEnvFile`.

### FDE EC2 tag contract

FDE CLI discovers deploy targets from EC2 tags. A Contact Center node should have tags like:

```text
FdeManagedBy=fde
FdeRole=app
FdeApp=contact-center
FdeDisplayName=Contact Center
FdeEnv=cc-prod                  # or cc-ha for HA
FdeDeployMode=single-node        # or ha
FdeGithubOwner=team-telnyx
FdeGithubRepo=telnyx-contact-center
FdeGithubWorkflow=build-s3-image-artifact.yml
FdeArtifactBucket=fde-app-artifacts-260957529682
FdeArtifactPrefix=contact-center
FdeImageName=telnyx-contact-center
FdeContainer=telnyx-contact-center-app
FdeEnvFile=/opt/cc-prod/app.env
FdeAppPort=3000
FdeWsPort=3001                  # optional, when WebSocket sidecar/port is used
FdeHealthPath=/api/health
FdePublicUrl=https://<environment-url>
```

See the [FDE Infra CLI README](https://github.com/team-telnyx/fde-infra-cli#fde-ec2-app-tag-standard) for the full tag standard, required IAM permissions, and onboarding checklist.

### Build a new immutable artifact

Preferred path: use FDE CLI and select `Application artifacts` → `Build new artifact`.

Equivalent GitHub CLI command, if you are intentionally triggering a build:

```bash
gh workflow run build-s3-image-artifact.yml \
  --repo team-telnyx/telnyx-contact-center \
  -f ref=master \
  -f artifact_bucket=fde-app-artifacts-260957529682 \
  -f artifact_prefix=contact-center \
  -f aws_region=us-east-2 \
  -f image_name=telnyx-contact-center
```

The workflow creates an immutable prefix such as:

```text
s3://fde-app-artifacts-260957529682/contact-center/<short-sha>/
├── image.tar.zst
├── image.tar.zst.sha256
└── manifest.json
```

Do not manually create replacement artifacts from a workstation or EC2 host unless an operator explicitly authorizes bypassing the pipeline.

### Deploy or roll back an existing artifact

Preferred path: use FDE CLI and select `Application artifacts` → `Deploy existing artifact / rollback`.

The CLI will:

1. discover the selected environment and nodes from EC2 tags,
2. show available S3 artifact prefixes and manifests,
3. send an AWS SSM command to the target node(s),
4. download and checksum-verify the artifact,
5. load the Docker image,
6. recreate only the application container with the node's existing env file,
7. check `http://127.0.0.1:<FdeAppPort><FdeHealthPath>`, and
8. for HA environments, deploy nodes sequentially.

Rollback is the same operation using a previously successful S3 artifact prefix. The deployment path is intentionally artifact-based; do not run `docker compose up --build` on production EC2 to roll forward or roll back.

### Local development and local Docker Compose

Local development is unchanged:

```bash
yarn install
cp sample.env .env.local
# edit local PostgreSQL/Telnyx/auth settings
yarn ensure:pg
yarn dev
```

The `docker/` directory remains useful for local experiments and historical reference, but production deployment is governed by GitHub Actions artifacts, S3, RDS, EC2 tags, and FDE CLI.

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
