# The API as one long-running process (backend/src/server.ts) for a single server such as a DigitalOcean Droplet.
# Build from the repository root so the workspace lockfile and @bsm/permissions are in the context:
#   docker build -f infrastructure/deployment/droplet/Dockerfile -t bsm-api .
# The backend ships TypeScript and runs it with tsx (as `npm run dev` does); there is no separate compile step.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# Only the manifests first, so dependency installation is cached until a package.json or the lockfile changes.
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY packages/permissions/package.json packages/permissions/
# Root devDependencies are included on purpose: tsx (the runtime) lives there. The apps are not installed.
RUN npm ci --include=dev --include-workspace-root -w backend -w @bsm/permissions && npm cache clean --force

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages/permissions ./packages/permissions
COPY backend/package.json backend/tsconfig.json ./backend/
COPY backend/src ./backend/src
COPY backend/migrations ./backend/migrations
COPY tsconfig.base.json ./
USER node
WORKDIR /app/backend
EXPOSE 4000
# The base image has no curl; the liveness probe uses Node itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/server.ts"]
