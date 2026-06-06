# Prebuilt production image for Telnyx Contact Center.
#
# This Dockerfile builds the Next.js production bundle during image build time
# (GitHub Actions/GHCR), not during EC2 container startup.

FROM node:20-slim AS base

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

RUN corepack enable
WORKDIR /app

FROM base AS deps

COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable

FROM deps AS builder

COPY . .
ENV NODE_ENV=production
RUN yarn build

FROM base AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Keep the runtime payload intentionally broad for now. The app has runtime
# scripts/schema initialization and server-side imports outside .next; copying
# the built workspace avoids missing-file surprises while still moving the
# expensive install/build work out of EC2 startup.
COPY --from=builder /app /app
COPY docker/ghcr-production/start-prod.sh /app/start-prod.sh
RUN chmod +x /app/start-prod.sh

EXPOSE 3000 3001

CMD ["/app/start-prod.sh"]
