CREATE TABLE "worker_scm_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"worker_id" uuid NOT NULL,
	"scm_provider_id" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "worker_scm_credentials" ADD CONSTRAINT "worker_scm_credentials_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_worker_scm_credentials_worker_provider" ON "worker_scm_credentials" USING btree ("worker_id","scm_provider_id");