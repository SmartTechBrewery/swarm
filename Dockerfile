# SWARM image — the all-in-one control plane (src/serve/index.ts): router, API and
# the built dashboard on one port. Published to ghcr.io by
# .github/workflows/publish-image.yml; see docs/MANUAL.md. Dockerfile.router (the
# router-only image the local Compose stack builds) is separate and unchanged.
FROM node:22-slim AS builder
WORKDIR /app

# --ignore-scripts skips the lefthook `prepare` hook, which needs a git repo. Dev
# dependencies are needed: tsc, and the dashboard's type-check of ../src/api.
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY dashboard/package*.json ./dashboard/
RUN npm ci --prefix dashboard

# The dashboard imports types from src/ (its tsconfig includes ../src/api) and the
# root package.json, so both builds run in this one stage.
COPY tsconfig.json ./
COPY src ./src
COPY dashboard ./dashboard
RUN npm run build && npm run build:dashboard

FROM node:22-slim AS production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist
# Migration SQL isn't TypeScript, so tsc never emits it; src/db/migrate.ts reads it
# cwd-relative, and the all-in-one entrypoint applies it before binding the port.
COPY --from=builder /app/src/db/migrations ./src/db/migrations
# createApiApp serves the SPA from ./dashboard/dist (cwd-relative).
COPY --from=builder /app/dashboard/dist ./dashboard/dist

# No .git in the image, so src/lib/build-identity.ts declares no commit; the source
# commit is the org.opencontainers.image.revision label CI stamps on the image.
USER node
ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/serve/index.js"]
