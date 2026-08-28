-- Issue #769: the installation's **default** SCM credential for one `(provider, role)`
-- slot, recorded once by an instance administrator in General Settings -> Credentials
-- (`src/db/schema/instanceScmCredentials.ts`). A third credential tier beside
-- `project_credentials` (a project's own secret, resolved through a reference key) and
-- `worker_scm_credentials` (a worker operator's own identity).
--
-- **No backfill, and nothing to seed.** An installation with no row here behaves
-- exactly as it does today: nothing reads this table at credential-resolution time —
-- `resolveScmCredentialOrNull` (`src/config/provider.ts`) keeps its no-fallback-chain
-- rule — and the value is a creation-time seed for a *new* project (phase 2/2), never a
-- fallback for an existing one. So this migration is additive only and reversible by
-- dropping the table.
--
-- No `project_id` and therefore no FK: the row outlives every project. `provider_id`
-- and `role` are `text` rather than pg enums, like `projects.scm_type`, so a fourth
-- provider opting in needs no migration; the unique index on the pair is the upsert
-- target, which makes rotating a default an update rather than a second row. `value` is
-- ciphertext under the `instance:scm:<provider_id>:<role>` AAD (`src/db/crypto.ts`).
CREATE TABLE "instance_scm_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"role" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_instance_scm_credentials_provider_role" ON "instance_scm_credentials" USING btree ("provider_id","role");