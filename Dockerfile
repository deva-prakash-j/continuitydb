FROM node:22.20.0-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22.20.0-bookworm-slim
ENV NODE_ENV=production \
    CONTINUITYDB_HOME=/data \
    CONTINUITYDB_HOST=0.0.0.0 \
    CONTINUITYDB_PORT=7331
RUN groupadd --gid 10001 continuitydb \
    && useradd --uid 10001 --gid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin continuitydb \
    && mkdir -p /data \
    && chown continuitydb:continuitydb /data
WORKDIR /app
COPY --from=dependencies --chown=continuitydb:continuitydb /app/node_modules ./node_modules
COPY --chown=continuitydb:continuitydb package.json package-lock.json ./
COPY --chown=continuitydb:continuitydb src ./src
USER 10001:10001
EXPOSE 7331
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:7331/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "src/http-server.js"]
