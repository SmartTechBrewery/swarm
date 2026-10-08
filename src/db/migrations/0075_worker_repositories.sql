-- Issue #1056: a worker may hold a checkout of more than one repository, so the
-- control plane stops modelling it as holding exactly one. The scalar `repository`
-- column (issue #687, migration 0048) becomes `repositories`, the jsonb set of every
-- `owner/repo` the daemon declared at handshake — the union of the handshake's
-- legacy `repository` and its additive `repositories`, primary first, normalised
-- and deduplicated (`HandshakeRequestSchema`, `src/transport/protocol.ts`).
--
-- `NOT NULL` with an empty-array default, the shape `supported_phases` uses, so no
-- reader has a null case: `[]` means "no repository declared", which is what NULL
-- meant before. Each existing declaration is backfilled as a one-element set before
-- the old column is dropped, so routing and enrollment policing keep judging every
-- worker exactly as before until its daemon next reconnects and re-declares.
ALTER TABLE "workers" ADD COLUMN "repositories" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "workers" SET "repositories" = jsonb_build_array("repository") WHERE "repository" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "workers" DROP COLUMN "repository";
