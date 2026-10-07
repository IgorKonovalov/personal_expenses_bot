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
# (ADR-0019): with fetch made to throw, it decodes the synthetic Serbian fixture, whose URL
# decodes to a receipt of 829.12 RSD. Only production modules from dist/ are imported.
RUN node --input-type=module -e " \
  globalThis.fetch = () => { throw new Error('the QR decoder reached the network'); }; \
  const { readFileSync } = await import('node:fs'); \
  const { decodeQr } = await import('./dist/fiscal/qr.js'); \
  const { decodeReceiptUrl } = await import('./dist/domain/receipts/index.js'); \
  const result = await decodeQr(readFileSync('src/fiscal/qr.fixtures/rs-receipt.jpg')); \
  if (result.kind !== 'decoded') process.exit(1); \
  const receipt = decodeReceiptUrl(result.texts[0] ?? ''); \
  if (receipt.kind !== 'receipt' || receipt.receipt.totalMinor !== 82912 \
    || receipt.receipt.currency !== 'RSD') process.exit(1);"
# The heavy-job child (ADR-0042) must start from dist/ on the prod node_modules: forked the way
# the bot forks it, it downloads the same fixture from a local stand-in for the Bot API's file
# host and decodes its QR.
RUN node --input-type=module -e " \
  const { readFileSync } = await import('node:fs'); \
  const { createServer } = await import('node:http'); \
  const { forkRunner } = await import('./dist/jobs/queue.js'); \
  const image = readFileSync('src/fiscal/qr.fixtures/rs-receipt.jpg'); \
  const server = createServer((_req, res) => { res.end(image); }); \
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); }); \
  const baseUrl = 'http://127.0.0.1:' + server.address().port; \
  const run = forkRunner({ download: { token: 'build-check', baseUrl } }); \
  const result = await run({ kind: 'qr', filePath: 'f.jpg' }, new AbortController().signal); \
  server.close(); \
  if (result.kind !== 'qr' || result.result.kind !== 'decoded') process.exit(1);"

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
