-- Issue #1349: what a write tool recorded about the change it previewed, written when
-- the call settles — `phase_agents_reorder`'s previous and next target order, which
-- `phase_agents_restore` reads back. Nullable: most tools record nothing.
ALTER TABLE "operator_actions" ADD COLUMN "detail" jsonb;
