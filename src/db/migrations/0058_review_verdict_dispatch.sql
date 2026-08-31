-- Issue #857: a `pending` review-verdict reservation now names the dispatch that
-- took it, so a slot expires with the attempt it belongs to instead of blocking
-- its pull request for ever when a hand-back is missed. `reserveReviewVerdict`
-- honours a `pending` row only while that dispatch is still in one of the active
-- states; otherwise it abandons the row and proceeds.
--
-- `set null` on delete, mirroring `dispatches.run_id` → `runs.id`: the ledger is
-- the permanent safety-cap record (issue #235) and must outlive any row it points
-- at. A null owner reads as "nothing backs this slot", the same answer a terminal
-- dispatch gives, so no special case is needed for either.
--
-- No new index: the runtime read is a primary-key lookup on `dispatches.id`.
ALTER TABLE "review_verdicts" ADD COLUMN "dispatch_id" uuid;--> statement-breakpoint
ALTER TABLE "review_verdicts" ADD CONSTRAINT "review_verdicts_dispatch_id_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."dispatches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Adopt: a reservation whose Review is genuinely in flight across this deploy
-- must keep blocking its PR, so it is given the active dispatch that is plainly
-- reviewing the same pull request. `dispatches.repository`/`pr_number` are
-- normalised columns since issue #850, so this asks the question without reaching
-- into `job_payload`.
--
-- **This step deliberately uses the PR-keyed lookup the runtime design rejects**,
-- and inherits its hole: a dispatch that has reserved a slot but has not yet
-- reached `recordDispatchResolution` (`src/worker/consumer.ts`, one statement
-- later, and best-effort besides) still carries a null `repository`/`pr_number`
-- and is not adopted here. The settle below is age-floored for exactly that
-- reason. `UPDATE … FROM` may also match several active dispatches for one
-- `(project, repository, pr_number)` and Postgres picks arbitrarily — harmless,
-- since any active owner answers the only question asked of it.
UPDATE "review_verdicts" rv
SET "dispatch_id" = d."id"
FROM "dispatches" d
WHERE rv."state" = 'pending'
  AND d."project_id" = rv."project_id"
  AND d."repository" = rv."repository"
  AND d."pr_number" = rv."pr_number"
  AND d."phase" = 'review'
  AND d."state" IN ('pending', 'leased', 'running', 'retry-scheduled');--> statement-breakpoint

-- Settle: an owner-less `pending` row is backed by nothing, which is what the five
-- leaked rows named in issue #857 are (`swarm` 415/442/555/595 and `rover` 35, the
-- oldest reserved 2026-07-24). `abandoned` rather than a new state because that is
-- already the ledger's word for "this slot never produced a verdict", and the
-- ordinal it frees was never a spent verdict — the cap counts `submitted` rows
-- only, so this hands no PR an extra review.
--
-- The one-hour floor is a guard on the adopt step above, not a policy: it protects
-- a reservation taken in the millisecond window before its dispatch recorded the
-- pull request it acts on. Anything younger and genuinely leaked is left `pending`
-- with a null owner, which the runtime rule recovers on the next reservation
-- attempt anyway — so the floor costs nothing and no age heuristic enters the
-- running system.
UPDATE "review_verdicts"
SET "state" = 'abandoned'
WHERE "state" = 'pending'
  AND "dispatch_id" IS NULL
  AND "reserved_at" < now() - interval '1 hour';
