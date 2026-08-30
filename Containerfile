# Ropex control plane — Node 22 Alpine
FROM docker.io/library/node:22-alpine

WORKDIR /app

RUN apk add --no-cache wget

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

ENV ROPEX_ROOT=/app
EXPOSE 7780

VOLUME ["/app/.ropex"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:7780/api/v1/health || exit 1

CMD ["node", "dist/cli.js", "up", "fleets/examples/github-control-plane.yaml", "--serve", "--port", "7780"]
