-- Issue #880: one operator's dismissal of one **liveness unit** from the Stalled view
-- (`src/db/schema/stalledDismissals.ts`). "Stalled" is a computed view and never a
-- persisted status, so a dismissal cannot be a status write on the unit — it needs a
-- durable record of its own, which is this table.
--
-- Keyed on the **unit** rather than a run id: a unit folds up to four `task_id`s (the
-- four SCM-driven phases of one pull request mint one each) and the row the operator
-- sees is the unit, so `(project_id, repository, unit, reference)` is the identity and
-- the unique index on it is the upsert target — dismiss, move, re-stall, dismiss again
-- rotates one row rather than accumulating rows. `last_activity_at` records what the
-- operator actually saw, which is what turns "re-report it if it moves again" into a
-- comparison instead of a background job.
--
-- **No backfill, and nothing to seed.** An installation with no row here behaves exactly
-- as it does today: the read model classifies every unit as it always has, because the
-- suppression is a comparison against a row that does not exist. Additive only, and
-- reversible by dropping the table.
--
-- Nothing here references `runs` — dismissing never modifies or deletes a `runs` row
-- because it never touches that table. `unit` and `reference` are `text` rather than pg
-- enums, like `projects.scm_type`, so a third unit kind would need no migration;
-- `dismissed_by` is `on delete set null`, like `review_verdicts.dispatch_id`, because the
-- record must outlive the account that made it.
CREATE TABLE "stalled_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"repository" text NOT NULL,
	"unit" text NOT NULL,
	"reference" text NOT NULL,
	"last_activity_at" timestamp NOT NULL,
	"dismissed_at" timestamp DEFAULT now() NOT NULL,
	"dismissed_by" uuid
);
--> statement-breakpoint
ALTER TABLE "stalled_dismissals" ADD CONSTRAINT "stalled_dismissals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stalled_dismissals" ADD CONSTRAINT "stalled_dismissals_dismissed_by_users_id_fk" FOREIGN KEY ("dismissed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_stalled_dismissals_unit" ON "stalled_dismissals" USING btree ("project_id","repository","unit","reference");