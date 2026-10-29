-- Issue #1192: the pull request a WIP slot holder opened, recorded once a pull
-- request-driven phase for its branch resolves, so the dashboard WIP read model
-- (`src/queue/wip-usage.ts`) can fold that pull request's liveness onto the holder.
ALTER TABLE "wip_slots" ADD COLUMN "pr_number" text;
