# ADR-0006: Production runs tsc-compiled JavaScript from dist/

> **Status:** accepted (2026-09-30)
> **Date:** 2026-09-29
> **Related plan(s):** [Plan 0002](../plans/done/0002-deploy-docker-vps.md)

## Context

Plan 0001 shipped with no build step. `pnpm start` runs `tsx src/index.ts`, and `tsx` is a
devDependency. Deploy (ADR-0001: Docker Compose on a VPS) needs a production image, and that image
should carry as few packages as possible. Every package is supply-chain surface in a process
that holds financial data.

The sibling `traditional-medicine-notifier-bot` runs on the same VPS. It compiles with `tsc` in a
builder stage and runs `node dist/index.js` on prod-only `node_modules`. It has deployed that
way for months.

`runMigrations` reads `.sql` files next to `migrate.ts` via `import.meta.url`, and `tsc` does not
copy non-TS files. Whatever we choose has to ship `src/db/migrations/`.

## Decision

`pnpm build` compiles `src/` (tests excluded) with `tsc -p tsconfig.build.json` into `dist/`, then
copies `src/db/migrations/*.sql` to `dist/db/migrations/`. `pnpm start` runs
`node dist/index.js`. The Docker runtime stage holds only `dist/`, prod `node_modules` and
`package.json`. CI runs `build` in addition to `typecheck`, because emit-only errors pass
`--noEmit`. `pnpm dev` keeps using `tsx watch`.

## Consequences

### Positive
- The runtime image has no TypeScript toolchain, no `tsx` and no esbuild binary.
- It matches the sibling's proven Dockerfile, so both bots on the VPS are operated the same way.
- Boot doesn't pay a transpile cost, and stack traces point at plain JS files.

### Negative
- A second tsconfig and a copy step. Forgetting to copy a new non-TS asset breaks prod and not
  dev. The Plan 0002 done-when that boots `dist/` against a fresh DB is the guard.
- `dist/` stack traces show compiled line numbers unless source maps are emitted. Plan 0002
  turns `sourceMap` on and runs Node with `--enable-source-maps`.

## Alternatives considered

### Alternative A: Run `tsx` in production
It needs no build step, and dev and prod run identically. It lost because it ships `tsx` and
esbuild (a native binary) into the runtime image and moves them to `dependencies`, which widens
the supply-chain surface for no user-visible gain.

### Alternative B: Node's built-in type stripping (`node src/index.ts`)
It needs no build step and no extra dependency. It lost because the codebase imports `.js`
specifiers (NodeNext), which type stripping doesn't rewrite, and because it rejects TS-only
syntax such as enums and parameter properties. Adopting it means rewriting every import and
taking on a still-moving runtime feature.
