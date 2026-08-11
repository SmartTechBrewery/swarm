-- Issue #628: a project's SCM credential references move off the single shared
-- `credentials.reviewer` / `credentials.webhookSecret` pair onto
-- `credentials.scm[<providerId>]`, so a project can hold GitHub's and GitLab's at once
-- without either overwriting the other (`src/config/scm-credentials.ts`).
--
-- Existing projects must keep working with nothing re-entered by hand, and the DB read
-- path cannot do it for them: `rowToProjectConfig`
-- (`src/db/repositories/projectsRepository.ts`) is deliberately a dumb re-join with no
-- validation and no normalization, so unlike a `swarm.config.json` — which the schema's
-- `adoptLegacyScmCredentials` transform adopts on parse — a persisted row needs this
-- one-time backfill.
--
-- The legacy pair is attributed to `scm_type`, the provider the project actually runs
-- on, defaulting to 'github' for a row that states none: a project naming no provider
-- has not resolved one since issue #618, and before #618 GitHub was the only
-- runtime-ready provider, so GitHub is the one safe attribution. This is the same rule
-- `sharedScmCredentialProviderFor` applies in code, so the two cannot disagree.
--
-- The reference *names* are copied verbatim, never rewritten to the manifest's
-- conventional `envVarKey`: the secret is stored in `project_credentials` under the old
-- key, so renaming the reference without moving the row would break resolution
-- outright. A project created since issue #290 therefore keeps `SCM_TOKEN_REVIEWER` /
-- `SCM_WEBHOOK_SECRET` rather than gaining `GITHUB_TOKEN_REVIEWER` /
-- `GITHUB_WEBHOOK_SECRET`, and that divergence from the manifest is by design.
--
-- The legacy keys are left in place beside the new block rather than dropped: they cost
-- nothing, they keep this trivially reversible, and phase 1's Source Control tab still
-- edits them (`src/api/routers/credentials.ts`). The `NOT ("credentials" ? 'scm')` guard
-- makes the statement re-runnable and stops it from clobbering a project already on the
-- new shape.
UPDATE "projects"
SET "credentials" = "credentials" || jsonb_build_object(
	'scm', jsonb_build_object(
		COALESCE("scm_type", 'github'),
		(CASE WHEN "credentials" ? 'reviewer'
			THEN jsonb_build_object('reviewer', "credentials" -> 'reviewer')
			ELSE '{}'::jsonb END)
		||
		(CASE WHEN "credentials" ? 'webhookSecret'
			THEN jsonb_build_object('webhookSecret', "credentials" -> 'webhookSecret')
			ELSE '{}'::jsonb END)
	)
)
WHERE NOT ("credentials" ? 'scm')
	AND ("credentials" ? 'reviewer' OR "credentials" ? 'webhookSecret');
