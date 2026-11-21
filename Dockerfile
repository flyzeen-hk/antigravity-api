# Antigravity API — локальный шлюз в контейнере.
#
# ВАЖНО: cloud/* модели требуют auth.json (OAuth-токены) — монтируйте его с
# хоста, внутри контейнера OAuth-браузер пройти нельзя. Без auth.json
# работают только web/* модели (нужна cookie) и /_health, /_status.
FROM node:22-alpine

# curl нужен для healthcheck, tini — чтобы SIGTERM доходил до node.
RUN apk add --no-cache curl tini

WORKDIR /app

# Зависимостей нет — копируем только код (см. .dockerignore: секреты
# auth.json/apikey.txt/cookie.txt/config.json в образ не попадают).
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY README.md ./

# Непривилегированный пользователь: контейнер не должен работать от root.
RUN mkdir -p /data && chown -R node:node /app /data
USER node

# Каталог для изменяемых файлов (config.json, usage.json, backups/).
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
