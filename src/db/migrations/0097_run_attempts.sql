-- Issue #1400: per-attempt run history. `run_attempts` is one row per execution attempt of a run
-- (worker, CLI, start/end, outcome, error), `run_output_events.attempt_id` ties each output line to
-- the attempt that produced it, and `runs.next_attempt_*` carries an operator's Reset & restart or
-- Retry now to the attempt that executes it. Existing output keeps a null attempt (unattributed).
CREATE TABLE "run_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"dispatch_id" uuid,
	"trigger" text DEFAULT 'automatic' NOT NULL,
	"requested_at" timestamp,
	"worker_id" uuid,
	"engine" text,
	"model" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	"outcome" text,
	"error" text,
	"failure_diagnosis" jsonb,
	"next_retry_at" timestamp,
	"exit_code" integer,
	"output_bytes" integer DEFAULT 0 NOT NULL,
	"output_truncated" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_output_events" ADD COLUMN "attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "next_attempt_trigger" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "next_attempt_requested_at" timestamp;--> statement-breakpoint
ALTER TABLE "run_attempts" ADD CONSTRAINT "run_attempts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_attempts" ADD CONSTRAINT "run_attempts_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_attempts_run_seq" ON "run_attempts" USING btree ("run_id","seq");--> statement-breakpoint
ALTER TABLE "run_output_events" ADD CONSTRAINT "run_output_events_attempt_id_run_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."run_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_run_output_events_attempt" ON "run_output_events" USING btree ("run_id","attempt_id","id");