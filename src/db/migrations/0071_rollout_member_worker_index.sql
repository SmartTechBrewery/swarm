-- Issue #1023: a halted rollout is advanceable again, so two of an operator's
-- rollouts can hold the same machine at once — the halted one still settling the
-- members it had committed to, and the new one the operator started to replace it.
-- Settling a member and taking one into a wave therefore both have to ask "does
-- another rollout still hold this machine", which is a `worker_id` search over a
-- table whose primary key leads with `rollout_id` and so cannot serve it. Without
-- this index that search is a sequential scan growing with the whole rollout
-- history. Deliberately not unique: a machine is in as many rollouts as its owner
-- has started over it.
CREATE INDEX "idx_worker_update_rollout_members_worker" ON "worker_update_rollout_members" USING btree ("worker_id");
