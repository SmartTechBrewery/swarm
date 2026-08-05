-- Issue #495: `ProjectConfig.pm` became a discriminated union over the registered
-- PM providers' own config schemas, so a project's board mapping now lives under
-- the provider it belongs to — persisted as `pm_type` (the discriminator) plus
-- this one *generic* config blob, instead of a GitHub-Projects-specific sibling
-- column. A rename, not a drop-and-add: the stored JSON is untouched, so every
-- persisted board mapping keeps working and a second PM provider can persist its
-- own config here without another migration.
ALTER TABLE "projects" RENAME COLUMN "github_projects" TO "pm_config";
