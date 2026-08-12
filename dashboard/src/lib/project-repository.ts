/**
 * Reading a project's repository from the dashboard (issue #684).
 *
 * `projects.list` / `projects.getById` serve the **record** — the project with its
 * `repositories` list — because the dashboard is the config-management surface. Every
 * *incidental* read (a PR link, a worker roster, a runs-table column) wants one
 * repository, so it goes through here rather than indexing the list at the call site.
 *
 * That leaves one place to change when phase 3 gives the list a real editor, and one
 * place naming the phase-1 assumption: a project owns exactly one repository, so the
 * first entry is the one to show.
 */

/** The narrow shape these helpers need — anything carrying the repository list. */
interface ProjectWithRepositories {
	repositories?: Array<{ repo: string }>;
}

/**
 * The repository to display for a project, or `''` when it declares none (which the
 * schema forbids, so it only happens for a partially-loaded cache entry). Callers that
 * render a link should test the result before building a URL.
 */
export function projectRepo(project: ProjectWithRepositories | null | undefined): string {
	return project?.repositories?.[0]?.repo ?? '';
}
