# pi web: the experimental server plus the sessions-only browser gateway.
# Development-only feature; this image builds the monorepo from source.
FROM node:22-bookworm-slim

ENV PI_EXPERIMENTAL=1 \
    PI_CODING_AGENT_DIR=/data/agent \
    PI_SERVER_DIR=/tmp/pisrv

WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json biome.json ./
COPY packages ./packages
COPY scripts ./scripts
COPY pi-test.sh ./

# Dev dependencies are needed (do not set NODE_ENV=production before this):
# the build runs tsgo, and pi web bundles the browser app with esbuild at
# startup and runs from source through tsx. --ignore-scripts skips optional
# native builds the web path never uses.
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && npm run build:offline \
 && npm cache clean --force
ENV NODE_ENV=production

COPY docker/web/entrypoint.sh /usr/local/bin/pi-web-entrypoint
RUN chmod +x /usr/local/bin/pi-web-entrypoint \
 && mkdir -p /data/agent /tmp/pisrv

# Working directory the experimental server is started from. Its .pi/settings.json
# selects the mcp-js environment; sessions never touch this directory otherwise.
WORKDIR /workspace
EXPOSE 8600
ENTRYPOINT ["pi-web-entrypoint"]
