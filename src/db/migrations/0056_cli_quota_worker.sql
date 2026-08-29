-- Issue #823: `cli_quotas` is keyed on `(host, cli)`, where `host` is the `os.hostname()`
-- of whichever process ran discovery. A hostname names no user, so a row is unattributable
-- and the quota read had nothing to filter on — every signed-in user was shown the same
-- rows, describing the machine that runs the control plane. The key becomes the **worker**,
-- an identity the control plane can authenticate and that has an owner.
--
-- Existing rows name a host and no worker, and none can be invented, so they are deleted
-- rather than backfilled with a guess (the `NOT NULL` + FK add needs an empty table anyway).
-- That is safe and deliberate, exactly as in 0050: this table is a re-derivable cache, not a
-- record of anything. Unlike 0050 the page then stays empty until a worker reports its own
-- snapshot — the central writer is removed in the same change, because the control-plane
-- process is nobody's worker and cannot attribute what it probes.
--
-- drizzle-kit emitted the statements out of order (the new primary key before the column it
-- is on, and the `host` drop last); they are spelled out here in an order Postgres accepts.
DELETE FROM "cli_quotas";--> statement-breakpoint
ALTER TABLE "cli_quotas" DROP CONSTRAINT "cli_quotas_host_cli_pk";--> statement-breakpoint
ALTER TABLE "cli_quotas" DROP COLUMN "host";--> statement-breakpoint
ALTER TABLE "cli_quotas" ADD COLUMN "worker_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "cli_quotas" ADD CONSTRAINT "cli_quotas_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_quotas" ADD CONSTRAINT "cli_quotas_worker_id_cli_pk" PRIMARY KEY("worker_id","cli");
