CREATE TABLE "checkout_discards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"project_id" text NOT NULL,
	"repository" text NOT NULL,
	"task_id" text NOT NULL,
	"worktree_root" text NOT NULL,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"settled_at" timestamp,
	"outcome" text,
	"detail" text
);
--> statement-breakpoint
ALTER TABLE "checkout_discards" ADD CONSTRAINT "checkout_discards_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_discards" ADD CONSTRAINT "checkout_discards_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_checkout_discards_worker" ON "checkout_discards" USING btree ("worker_id","settled_at");