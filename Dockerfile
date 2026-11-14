# NABD AI backend / worker image (the same image runs both: `node src/server.js` and `node src/worker.js`).
# Match pg_dump with the production PostgreSQL 18 server; PostgreSQL 16 clients reject it.
FROM node:22-alpine3.24
RUN apk add --no-cache postgresql18-client tini \
    && pg_dump --version | grep -q 'PostgreSQL) 18\.'
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY public ./public
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
