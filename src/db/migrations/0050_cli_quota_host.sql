-- Issue #703: `cli_quotas` is keyed on the CLI alone, so an installation has exactly
-- three rows and every discovering host overwrites the same ones — the last probe to
-- run presents its own machine's allowance as the installation's. The host becomes part
-- of the key.
--
-- Existing rows name no host and none can be invented, so they are deleted rather than
-- backfilled with a guess (the `NOT NULL` add needs an empty table anyway). That is safe
-- and deliberate: this table is a re-derivable cache, not a record of anything. The API
-- server's `startHostMaintenance` runs discovery immediately at boot and every 6h, and
-- the CLI Quotas page's Refresh button repopulates it on demand — so the only cost is an
-- empty page between the migration and the next boot or click.
--
-- drizzle-kit could not name the primary key it is replacing (it emitted a placeholder
-- comment): `cli_quotas.cli` was declared as an inline column PK in 0017, which Postgres
-- auto-names `<table>_pkey`. The DROP is spelled out here, and the ADD CONSTRAINT moved
-- after the ADD COLUMN it depends on.
DELETE FROM "cli_quotas";--> statement-breakpoint
ALTER TABLE "cli_quotas" DROP CONSTRAINT "cli_quotas_pkey";--> statement-breakpoint
ALTER TABLE "cli_quotas" ADD COLUMN "host" text NOT NULL;--> statement-breakpoint
ALTER TABLE "cli_quotas" ADD CONSTRAINT "cli_quotas_host_cli_pk" PRIMARY KEY("host","cli");
