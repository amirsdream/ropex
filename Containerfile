# Control plane only. Hermes and the DeepSeek harness live in the worker image.
FROM docker.io/library/node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=optional
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM docker.io/library/node:22-alpine

RUN apk add --no-cache wget docker-cli

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional
COPY --from=build /app/dist ./dist
COPY fleets ./fleets
COPY souls ./souls

ENV ROPEX_ROOT=/app
ENV ROPEX_EXECUTOR=container
ENV ROPEX_WORKER_IMAGE=ropex-worker:latest
EXPOSE 7780

VOLUME ["/app/.ropex"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:7780/api/v1/health || exit 1

CMD ["node", "dist/cli.js", "up", "fleets/examples/github-control-plane.yaml", "--serve", "--port", "7780"]
