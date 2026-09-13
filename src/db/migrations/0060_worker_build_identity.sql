-- Issue #918: a worker's daemon now declares the SWARM build it is actually
-- running — the commit its *install root* is on, plus a flag for a dirty or
-- unbuilt checkout — carried on the handshake (`HandshakeRequestSchema.build`,
-- `src/transport/protocol.ts`). Nothing else could answer it: the handshake's
-- `daemonVersion` resolves to `package.json`'s `version`, which never moves, so
-- it reads the same on every daemon whatever code it runs.
--
-- Two columns rather than one blob so each is readable on its own in `psql` and
-- comparable in SQL. Both nullable with no default, on `repository`'s contract
-- (`0048_clumsy_sphinx.sql`): NULL is "this daemon declared no build", which is
-- what every existing row says, what a daemon too old to send the field keeps
-- saying, and what a daemon whose install root is not a git checkout says. There
-- is nothing to backfill — the build of a program that is not currently connected
-- is not guessable. `build_dirty` is only meaningful beside a non-null
-- `build_commit`; the two are always written together, so the pair is never
-- half-set. No index: nothing queries by it.
ALTER TABLE "workers" ADD COLUMN "build_commit" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "build_dirty" boolean;
