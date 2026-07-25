ALTER TABLE "runs" ADD COLUMN "produced_pr_url" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "worker_user_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_worker_user_id_users_id_fk" FOREIGN KEY ("worker_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;