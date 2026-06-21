# Production Dockerfile for Telnyx Contact Center
FROM node:22-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
  python3 \
  make \
  g++ \
  libcairo2-dev \
  libpango1.0-dev \
  libjpeg-dev \
  libgif-dev \
  librsvg2-dev \
  postgresql-client \
  curl \
  && rm -rf /var/lib/apt/lists/*

# Enable Corepack for Yarn
RUN corepack enable

WORKDIR /app

# Copy everything at once
COPY . .

# Install dependencies with Yarn
RUN yarn install

# NEXT_PUBLIC_* values are compiled into client bundles by `next build`. Keep
# these as explicit build args so production compose can pass the same public
# settings that are later mounted in `/app/.env` at runtime.
ARG NEXT_PUBLIC_BASE_URL
ARG NEXT_PUBLIC_RECAPTCHA_SITE_KEY
ARG NEXT_PUBLIC_STREAMING_PORT
ARG NEXT_PUBLIC_TELNYX_WEBRTC_REGION
ARG NEXT_PUBLIC_TELNYX_WEBRTC_PREFETCH_ICE_CANDIDATES
ENV NEXT_PUBLIC_BASE_URL=$NEXT_PUBLIC_BASE_URL
ENV NEXT_PUBLIC_RECAPTCHA_SITE_KEY=$NEXT_PUBLIC_RECAPTCHA_SITE_KEY
ENV NEXT_PUBLIC_STREAMING_PORT=$NEXT_PUBLIC_STREAMING_PORT
ENV NEXT_PUBLIC_TELNYX_WEBRTC_REGION=$NEXT_PUBLIC_TELNYX_WEBRTC_REGION
ENV NEXT_PUBLIC_TELNYX_WEBRTC_PREFETCH_ICE_CANDIDATES=$NEXT_PUBLIC_TELNYX_WEBRTC_PREFETCH_ICE_CANDIDATES

# Build the Next.js production bundle at image build time. Containers must start
# from this prebuilt artifact so HA rolling deploys do not take a node out for a
# multi-minute runtime build.
RUN yarn build

# Create startup script that waits for PostgreSQL, initializes schema, and starts
# the already-built application.
RUN echo '#!/bin/bash\n\
  echo "Waiting for PostgreSQL to be ready..."\n\
  until pg_isready -h $POSTGRES_HOST -p $POSTGRES_PORT -U $POSTGRES_USER; do\n\
  echo "PostgreSQL is unavailable - sleeping"\n\
  sleep 2\n\
  done\n\
  echo "PostgreSQL is ready!"\n\
  \n\
  echo "Initializing database schema..."\n\
  node scripts/ensure-pg.mjs\n\
  \n\
  echo "Starting prebuilt application..."\n\
  exec yarn start\n\
  ' > /app/start-prod.sh && chmod +x /app/start-prod.sh

EXPOSE 3000

ENV PORT=3000
ENV PROCESS_ROLE=all

# Start the application with the startup script
CMD ["/app/start-prod.sh"]
