# Both stages use the same base, pinned by digest (the multi-arch index of node:24-alpine).
# To update: resolve the new index digest for node:24-alpine and replace it in BOTH FROM lines.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS builder

# Toolchain for better-sqlite3 in case no prebuilt binary matches; builder stage only.
RUN apk add --no-cache python3 make g++
# Corepack provisions the pnpm pinned in package.json `packageManager`.
RUN corepack enable

WORKDIR /app
# pnpm-workspace.yaml carries the release-age cooldown and `allowBuilds`. Without it pnpm
# refuses better-sqlite3's build script, and the load check below fails the build.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN pnpm build
# Slim node_modules to prod-only without running lifecycle scripts (`prepare: husky`), then
# rebuild the one native dep so its binding is in the tree the runtime stage copies.
RUN pnpm install --prod --frozen-lockfile --ignore-scripts && pnpm rebuild better-sqlite3
RUN node -e "new (require('better-sqlite3'))(':memory:').close()"
# The receipt QR decoder must load its wasm from the prod node_modules, never from the network
# (ADR-0019): with fetch made to throw, it decodes the synthetic Serbian fixture to its URL.
RUN node --input-type=module -e " \
  globalThis.fetch = () => { throw new Error('the QR decoder reached the network'); }; \
  const { readFileSync } = await import('node:fs'); \
  const { decodeQr } = await import('./dist/fiscal/qr.js'); \
  const { buildRsUrl } = await import('./dist/domain/receipts/testing/buildRsVl.js'); \
  const result = await decodeQr(readFileSync('src/fiscal/qr.fixtures/rs-receipt.jpg')); \
  if (result.kind !== 'decoded' || result.texts[0] !== buildRsUrl()) process.exit(1);"

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# The base image's `node` user is uid/gid 1000, matching the VPS deploy user, so the backup
# bind mount lines up without chmod workarounds. /app/data seeds the named volume's ownership.
RUN mkdir -p /app/data && chown node:node /app/data
USER node

# Exec form: node is PID 1 and receives SIGTERM directly for the graceful shutdown.
CMD ["node", "--enable-source-maps", "dist/index.js"]
