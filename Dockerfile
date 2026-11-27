# Antigravity API — local gateway & offline Web Control Panel container.
#
# cloud/* models require auth.json (OAuth tokens) — mount ./data from host.
# Web-only mode: set AG_NO_CLOUD=1 (auth.json not required, only web/* models).
FROM node:22-alpine

RUN apk add --no-cache curl tini

WORKDIR /app

COPY package.json server.js README.md ./
COPY lib ./lib
COPY public ./public
COPY assets ./assets
COPY scripts ./scripts

RUN mkdir -p /data && chown -R node:node /app /data
USER node

ENV AG_DATA_DIR=/data \
    AG_HOST=0.0.0.0 \
    AG_PORT=8317 \
    NODE_ENV=production

VOLUME ["/data"]
EXPOSE 8317

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${AG_PORT}/_health" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
