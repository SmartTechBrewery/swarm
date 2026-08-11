-- Issue #631: a project's PM credential references move off the single flat
-- `credentials.pm` role map onto `credentials.pm[<providerId>]`, so a project can hold
-- GitHub Projects' and Jira's at once without either overwriting the other
-- (`src/config/pm-credentials.ts`). The role names genuinely collide across the four
-- registered providers — `apiToken` is GitHub Projects' *and* Jira's, `apiKey` both
-- Linear's and Trello's, `webhookSecret` all four's — so on the flat shape entering an
-- incoming provider's credentials destroyed the outgoing provider's.
--
-- Existing projects must keep working with nothing re-entered by hand, and the DB read
-- path cannot do it for them: `rowToProjectConfig`
-- (`src/db/repositories/projectsRepository.ts`) is deliberately a dumb re-join with no
-- validation and no normalization, so unlike a `swarm.config.json` — which the schema's
-- `adoptLegacyPmCredentials` preprocess adopts on parse — a persisted row needs this
-- one-time backfill. This is the PM twin of `0045_scm_credentials_per_provider.sql`.
--
-- The flat map is attributed to `pm_type`, the provider it was configured for — there is
-- nothing else it could have been for. No `COALESCE` default, unlike 0045's `'github'`:
-- `pm_type` is `NOT NULL DEFAULT 'github-projects'`, so every row states its provider.
--
-- The reference *names* are copied verbatim, never rewritten to the manifest's
-- conventional `envVarKey`: the secret is stored in `project_credentials` under the old
-- key, so renaming the reference without moving the row would break resolution
-- outright.
--
-- The `EXISTS` test on a *string* value is both the legacy detector and the
-- re-runnability guard, since the legacy and new shapes share the one `pm` key: a flat
-- map's values are references (strings), a per-provider map's are role blocks (objects),
-- so a row already on the new shape matches nothing and is skipped. An empty `{}` is
-- skipped too and stays `{}`, which parses fine as an empty per-provider map.
--
-- The `jsonb_object_agg` moves the string-valued entries only, so this and
-- `adoptLegacyPmCredentials` cannot disagree about a map holding both shapes at once —
-- not a state SWARM produces, but the two adoption paths should read one way. The
-- `EXISTS` guard is what guarantees the aggregate is non-NULL.
UPDATE "projects"
SET "credentials" = jsonb_set(
	"credentials",
	'{pm}',
	jsonb_build_object("pm_type", (
		SELECT jsonb_object_agg(entry.key, entry.value)
		FROM jsonb_each("credentials" -> 'pm') AS entry
		WHERE jsonb_typeof(entry.value) = 'string'
	))
)
WHERE jsonb_typeof("credentials" -> 'pm') = 'object'
	AND EXISTS (
		SELECT 1 FROM jsonb_each("credentials" -> 'pm') AS entry
		WHERE jsonb_typeof(entry.value) = 'string'
	);
