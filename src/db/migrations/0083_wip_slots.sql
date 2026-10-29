-- Issue #1185: the per-repository WIP limit's durable record of which tickets are in
-- flight (`src/db/schema/wipSlots.ts`). Starts empty — tickets already in flight when
-- this ships hold no slot, so their next board-driven start is admitted as a new one.
CREATE TABLE "wip_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"repository" text NOT NULL,
	"task_id" text NOT NULL,
	"work_item_id" text,
	"work_item_title" text,
	"work_item_url" text,
	"opened_phase" text NOT NULL,
	"opened_dispatch_id" uuid,
	"opened_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wip_slots" ADD CONSTRAINT "wip_slots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wip_slots" ADD CONSTRAINT "wip_slots_opened_dispatch_id_dispatches_id_fk" FOREIGN KEY ("opened_dispatch_id") REFERENCES "public"."dispatches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_wip_slots_ticket" ON "wip_slots" USING btree ("project_id","repository","task_id");
