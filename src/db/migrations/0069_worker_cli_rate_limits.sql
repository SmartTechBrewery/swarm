-- Issue #981: an observed rate limit becomes a durable, self-releasing fact about a
-- (worker, CLI) pair, so the federated dispatch gate stops handing that machine more
-- work on that CLI until its allowance is expected back.
--
-- `expires_at` rather than a boolean: a boolean needs somebody to clear it, and a
-- five-hour usage window that nobody clears is a permanently wedged machine. The
-- instant stored is the shared retry policy's own answer for the deferral that
-- produced it (`retryDelayForFailure`), so it is already clamped to six hours and the
-- record lapses at exactly the moment the deferred retry is scheduled for.
--
-- Its own table rather than a column on `cli_quotas`: those rows are a probe-derived
-- display snapshot that `src/worker/target-selection.ts` warns against routing on
-- (issue #703), and rather than `workers.draining_since`, which is machine-wide and
-- operator-owned. Nothing is backfilled, so an unmigrated installation behaves exactly
-- as it does today, and no sweeper is needed: the read filters on `expires_at`, so a
-- lapsed row is already invisible and the next observation overwrites it.
CREATE TABLE "worker_cli_rate_limits" (
	"worker_id" uuid NOT NULL,
	"cli" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"observed_at" timestamp DEFAULT now() NOT NULL,
	"reset_hint" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "worker_cli_rate_limits_worker_id_cli_pk" PRIMARY KEY("worker_id","cli")
);
--> statement-breakpoint
ALTER TABLE "worker_cli_rate_limits" ADD CONSTRAINT "worker_cli_rate_limits_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;
