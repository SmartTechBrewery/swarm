-- Issue #1395: the Resolve problem phase. `runs.resolves_run_id` links a Resolve problem run to the
-- failed run it is an attempt for (SET NULL, so the attempt's record outlives that run). The two
-- phase defaults gain the new phase. Only an existing enrollment that still permits the whole
-- previous repertoire — the every-phase default, never deliberately narrowed — is backfilled with
-- it, exactly as that default would have written it. An enrollment its owner limited to particular
-- phases is left alone: this phase runs an operator-MCP agent under the owner's identity, which the
-- owner must choose for a narrowed machine. Whether the phase runs at all is still the project's own
-- opt-in (`pipeline.resolveProblem.enabled`, off by default).
ALTER TABLE "workers" ALTER COLUMN "supported_phases" SET DEFAULT '["planning","implementation","review","respond-to-review","respond-to-ci","resolve-conflicts","resolve-problem"]'::jsonb;--> statement-breakpoint
ALTER TABLE "worker_project_enrollments" ALTER COLUMN "allowed_phases" SET DEFAULT '["planning","implementation","review","respond-to-review","respond-to-ci","resolve-conflicts","resolve-problem"]'::jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "resolves_run_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_resolves_run_id_runs_id_fk" FOREIGN KEY ("resolves_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_runs_resolves_run_id" ON "runs" USING btree ("resolves_run_id");--> statement-breakpoint
UPDATE "worker_project_enrollments" SET "allowed_phases" = "allowed_phases" || '["resolve-problem"]'::jsonb WHERE NOT ("allowed_phases" @> '["resolve-problem"]'::jsonb) AND "allowed_phases" @> '["planning","implementation","review","respond-to-review","respond-to-ci","resolve-conflicts"]'::jsonb;