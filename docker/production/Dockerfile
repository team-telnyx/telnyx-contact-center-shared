# Production Dockerfile for Telnyx Contact Center
FROM node:22-slim

# Video AI is part of the standard application image. Use the distribution's
# Chromium instead of downloading a second browser during dependency install.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV VIDEO_AI_CHROMIUM_PATH=/app/docker/production/chromium-launcher.sh

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
  chromium \
  ffmpeg \
  tini \
  util-linux \
  && rm -rf /var/lib/apt/lists/*

# Enable Corepack for Yarn
RUN corepack enable

WORKDIR /app

# Copy everything at once
COPY . .

RUN useradd --create-home --uid 1100 --user-group cc-video \
  && chmod 755 docker/production/chromium-launcher.sh \
  && mkdir -p /app/.data/video-recordings && chmod 700 /app/.data/video-recordings

# Install dependencies with Yarn
RUN yarn install --immutable

# NEXT_PUBLIC_* values are compiled into client bundles by `next build`. Keep
# these as explicit build args so production compose can pass the same public
# settings that are later mounted in `/app/.env` at runtime.
ARG NEXT_PUBLIC_BASE_URL
ARG NEXT_PUBLIC_RECAPTCHA_SITE_KEY
ARG NEXT_PUBLIC_STREAMING_PORT
ARG NEXT_PUBLIC_TELNYX_WEBRTC_REGION
ARG NEXT_PUBLIC_TELNYX_WEBRTC_PREFETCH_ICE_CANDIDATES
# next.config.mjs republishes this one as NEXT_PUBLIC_GOOGLE_MAPS_API_KEY, so it
# has to be present at build time or the browser bundle ships without a key.
ARG GOOGLE_MAPS_KEY
ARG CC_BUILD_INFO
ENV CC_BUILD_INFO=$CC_BUILD_INFO
ENV NEXT_PUBLIC_BASE_URL=$NEXT_PUBLIC_BASE_URL
ENV NEXT_PUBLIC_RECAPTCHA_SITE_KEY=$NEXT_PUBLIC_RECAPTCHA_SITE_KEY
ENV NEXT_PUBLIC_STREAMING_PORT=$NEXT_PUBLIC_STREAMING_PORT
ENV NEXT_PUBLIC_TELNYX_WEBRTC_REGION=$NEXT_PUBLIC_TELNYX_WEBRTC_REGION
ENV NEXT_PUBLIC_TELNYX_WEBRTC_PREFETCH_ICE_CANDIDATES=$NEXT_PUBLIC_TELNYX_WEBRTC_PREFETCH_ICE_CANDIDATES
ENV GOOGLE_MAPS_KEY=$GOOGLE_MAPS_KEY

# Build the Next.js production bundle at image build time. Containers must start
# from this prebuilt artifact so HA rolling deploys do not take a node out for a
# multi-minute runtime build.
ARG CC_BUILD_WORKERS=2
RUN CC_BUILD_WORKERS=$CC_BUILD_WORKERS yarn build

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
  exec node scripts/start-next-with-pino.mjs\n\
  ' > /app/start-prod.sh && chmod +x /app/start-prod.sh

EXPOSE 3000

ENV PORT=3000
ENV PROCESS_ROLE=all
ENV NODE_ENV=production

# Reap Chromium descendants and forward shutdown to the application launcher.
ENTRYPOINT ["/usr/bin/tini", "--"]

# Start the application with the startup script
CMD ["/app/start-prod.sh"]
