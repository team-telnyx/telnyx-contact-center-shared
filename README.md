# Telnyx Contact Center

A Next.js application for handling voice calls based on Telnyx Voice APIs. This application follows the same architecture as the telnyx-demo-portal-nextjs project.

## Features

- Agent Desktop interface for handling voice calls
- Agent Configuration management
- User Profile with theme switching
- Skills-based routing configuration
- PostgreSQL database for user and contact center configuration

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
cp .env.example .env.local
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

## Database Schema

### Users Table

The `users` table includes contact center specific fields:

- `skills` (JSONB): Skills with proficiency levels for skills-based routing
  - Format: `{"skill_name": proficiency_level (1-10)}`
  - Example: `{"sales": 8, "support": 6, "technical": 9}`
- `agent_status`: Current agent availability status
- `max_concurrent_calls`: Maximum concurrent calls the agent can handle
- `agent_groups`: Array of agent group IDs
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
│   ├── (portal)/
│   │   ├── agent/
│   │   │   ├── desktop/
│   │   │   └── configuration/
│   │   ├── profile/
│   │   └── layout.jsx
│   └── layout.jsx
├── components/
│   ├── ui/          # UI components (sidebar, buttons, etc.)
│   ├── app-sidebar.jsx
│   ├── nav-main.jsx
│   ├── nav-user.jsx
│   └── site-header.jsx
├── config/
│   ├── menu.jsx     # Menu configuration
│   └── user.js      # User status options
├── lib/
│   ├── postgres.js       # PostgreSQL connection
│   ├── postgres-schema.js # Database schema
│   └── utils.js          # Utility functions
└── hooks/
    └── use-mobile.js     # Mobile detection hook
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

- `yarn dev` - Start development server
- `yarn build` - Build for production
- `yarn start` - Start production server
- `yarn lint` - Run ESLint
- `yarn ensure:pg` - Ensure PostgreSQL schema is set up

## License

Private project
