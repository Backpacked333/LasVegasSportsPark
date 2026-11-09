# syntax=docker/dockerfile:1.7
#
# Sportspark API and durable worker (spec §4.1, §4.12, §5.12). One image, two processes:
#   api     node dist/main.js     (default command; listens on PORT, default 3000)
#   worker  node dist/worker.js   (outbox, inbox, background workers, periodic jobs)
#   migrate node /app/packages/db/dist/cli/migrate.js [--status | --dry-run]
# Hosting is pending DEC-021; the image is host-agnostic and configured only by environment
# variables (apps/api/src/kernel/config.ts, docs/deploy/production.md).

ARG NODE_VERSION=22.22.0

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

# Install every dependency of the API and the workspace packages it uses, then compile them.
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json tsconfig.build.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@sportspark/api..."
COPY packages/contracts packages/contracts
COPY packages/db packages/db
COPY apps/api apps/api
RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm exec tsc -b packages/contracts packages/db apps/api

# Production dependencies only.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@sportspark/api..."

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG APP_VERSION=0.1.0
ARG SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.title="sportspark-api" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}"
ENV NODE_ENV=production APP_VERSION=${APP_VERSION} PORT=3000
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app /app
COPY --from=build --chown=node:node /app/packages/contracts/dist packages/contracts/dist
COPY --from=build --chown=node:node /app/packages/db/dist packages/db/dist
# Read at runtime by the migration CLI and by GET /v1/ready (schema against this build).
COPY --from=build --chown=node:node /app/packages/db/migrations packages/db/migrations
COPY --from=build --chown=node:node /app/apps/api/dist apps/api/dist
WORKDIR /app/apps/api
USER node
EXPOSE 3000
# Liveness for a plain Docker host; orchestrators should probe GET /v1/ready for readiness.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
