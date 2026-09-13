-- Issue #940: an operator's fleet update is now a **staged rollout** rather than a
-- single fan-out — a durable record naming the machines to move and the order to
-- move them in, advanced a bounded wave at a time and stopping itself when the
-- target build turns out to be bad.
--
-- `worker_update_rollouts` is the operator action: the target every member is being
-- moved to, the `wave_size` bound in force for this rollout (stated on the row, so a
-- later change to the default cannot move a rollout already under way), the status
-- (`in_progress` | `halted` | `completed`) and the `halt_reason` recorded when it
-- stopped itself. The partial unique index is the load-bearing one: **at most one
-- `in_progress` rollout per owner**, because two overlapping rollouts over the same
-- machines would drain and undrain each other's members, and the check has to be one
-- statement with the insert or a second `swarm workers update --all` landing at the
-- same instant slips between them. `halted`/`completed` rows are exempt and
-- accumulate as history, which is what makes "start a new one" the way past a halt.
--
-- `worker_update_rollout_members` is one machine's place in it, keyed
-- `(rollout_id, worker_id)` — a machine appears at most once, and a member is always
-- read through its rollout, so there is no surrogate id to keep in step. Both FKs
-- cascade: a retired machine leaves the rollout rather than leaving a row pointing at
-- nothing. Three columns exist purely so a verdict reached *later* is reached against
-- what was true at signal time — `fencing_token_at_signal` (per-worker monotonic, so
-- a larger one afterwards is the exact "a new daemon took the lease" signal),
-- `build_commit_at_signal` (which tells "came back" from "came back on the new
-- build", since a machine that returned itself to its last known good build — issue
-- #934 — also comes back with a bumped token), and `drained_by_rollout` (so a machine
-- the operator had drained for their own reasons is left exactly as they left it).
--
-- Nothing is backfilled and nothing existing is altered: an installation that has
-- never run a rollout has two empty tables, which is indistinguishable from the
-- behaviour before they existed.
CREATE TABLE "worker_update_rollout_members" (
	"rollout_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"request_id" uuid,
	"outcome" text,
	"message" text,
	"drained_by_rollout" boolean DEFAULT false NOT NULL,
	"fencing_token_at_signal" bigint,
	"build_commit_at_signal" text,
	"signalled_at" timestamp,
	"settled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "worker_update_rollout_members_rollout_id_worker_id_pk" PRIMARY KEY("rollout_id","worker_id")
);
--> statement-breakpoint
CREATE TABLE "worker_update_rollouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"target" text NOT NULL,
	"wave_size" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"halt_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "worker_update_rollout_members" ADD CONSTRAINT "worker_update_rollout_members_rollout_id_worker_update_rollouts_id_fk" FOREIGN KEY ("rollout_id") REFERENCES "public"."worker_update_rollouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_update_rollout_members" ADD CONSTRAINT "worker_update_rollout_members_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_update_rollouts" ADD CONSTRAINT "worker_update_rollouts_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_worker_update_rollout_members_order" ON "worker_update_rollout_members" USING btree ("rollout_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_worker_update_rollouts_owner_live" ON "worker_update_rollouts" USING btree ("requested_by_user_id") WHERE "worker_update_rollouts"."status" = 'in_progress';--> statement-breakpoint
CREATE INDEX "idx_worker_update_rollouts_owner" ON "worker_update_rollouts" USING btree ("requested_by_user_id","created_at");