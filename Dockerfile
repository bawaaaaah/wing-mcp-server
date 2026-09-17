# syntax=docker/dockerfile:1

# Three stages so the runtime image carries neither the toolchain nor the dashboard's build-time
# dependencies: `deps` resolves the production dependency tree on its own (it never sees the
# sources, so it only re-runs when the lockfile moves), `builder` compiles the server and the
# dashboard, and `runtime` takes just the two outputs.

ARG NODE_VERSION=24-alpine

# ---- production dependencies ----
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# web/package.json is copied but its dependencies are not installed: --workspaces=false keeps the
# workspace out of the tree, because its React dependencies are build-time only (Vite bundles them
# into web/dist) and have no business in the runtime image. The file is still copied so npm never
# has to resolve a workspace declared in the lockfile but missing from disk.
COPY web/package.json web/package.json
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --workspaces=false --ignore-scripts --no-audit --no-fund

# ---- builder ----
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/package.json
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src src
COPY web web
RUN npm run build

# ---- runtime ----
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

# Point the writable state at the volume below. These are the defaults the code would compute
# anyway from /app, but spelling them out makes it obvious what has to be persisted.
ENV NODE_ENV=production \
    PORT=8787 \
    MCP_CONFIG_PATH=/app/data/config.json \
    WING_PRESETS_DIR=/app/data/presets \
    WING_MIC_CALIBRATIONS_DIR=/app/data/mic-calibrations \
    MCP_DASHBOARD_DIST=/app/web/dist

# package.json is read at runtime for the version reported by /api/status.
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web/dist ./web/dist

RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

# 8787/tcp: dashboard, REST API and the /mcp endpoint.
# 14135/udp: the port the console *pushes* meter frames to, so it has to be reachable from the WING
# (see docs/install-docker.md — on a bridge network it needs publishing, or use host networking).
EXPOSE 8787
EXPOSE 14135/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 8787) + '/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

USER node
CMD ["node", "dist/index.js"]

LABEL org.opencontainers.image.title="wing-mcp-server" \
      org.opencontainers.image.description="MCP server and web dashboard for the Behringer WING digital mixing console" \
      org.opencontainers.image.source="https://github.com/bawaaaaah/wing-mcp-server" \
      org.opencontainers.image.documentation="https://github.com/bawaaaaah/wing-mcp-server/blob/main/docs/install-docker.md" \
      org.opencontainers.image.licenses="MIT"
