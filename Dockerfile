# Production image of the service: one process per container, roles chosen by ROLES.
FROM oven/bun:1.3.14 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.14
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
# tsconfig.json is read at runtime by Bun (decorator metadata for NestJS).
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
USER bun
EXPOSE 3000
HEALTHCHECK --interval=3s --timeout=3s --start-period=10s --retries=20 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3000/health/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Exec form: bun is PID 1 and receives SIGTERM directly (graceful shutdown).
CMD ["bun", "run", "src/main.ts"]
