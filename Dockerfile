# syntax=docker/dockerfile:1

# ---- build: compiles TypeScript and the better-sqlite3 native module ----
FROM node:22-slim AS build
WORKDIR /app

# Build tools stay in this stage. better-sqlite3 downloads a prebuilt binary
# when one exists for the platform and compiles from source otherwise.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.34.4 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# Drop dev dependencies; the compiled better-sqlite3 stays in node_modules.
RUN pnpm prune --prod \
 && node -e "new (require('better-sqlite3'))(':memory:').close(); console.log('better-sqlite3 loads')"

# ---- runtime: no compiler, no pnpm, non-root ----
FROM node:22-slim
ENV NODE_ENV=production \
    PORT=8787 \
    ANTICLUS_DB=/data/anticlus.db
WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY LICENSE NOTICE ./

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "dist/cli.js"]
