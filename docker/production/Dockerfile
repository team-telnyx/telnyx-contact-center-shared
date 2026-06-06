# Production Dockerfile for Telnyx Contact Center
FROM node:20-slim

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

# Create startup script that waits for PostgreSQL, initializes schema, and seeds data
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
  echo "Building application with database connection available..."\n\
  yarn build\n\
  \n\
  exec yarn start\n\
  ' > /app/start-prod.sh && chmod +x /app/start-prod.sh

EXPOSE 3000

ENV PORT=3000

# Start the application with the startup script
CMD ["/app/start-prod.sh"]
