/**
 * Reading a project's repository from the dashboard (issue #684).
 *
 * `projects.list` / `projects.getById` serve the **record** — the project with its
 * `repositories` list — because the dashboard is the config-management surface. Every
 * *incidental* read (a PR link, a worker roster, a runs-table column) wants one
 * repository, so it goes through here rather than indexing the list at the call site.
 *
 * That leaves one place to change when phase 3 gives the list a real editor, and one
 * place naming the assumption these incidental reads make: they show the project's
 * **default** repository, its first entry. Phase 2 lifted the one-entry cap, so that is
 * now a genuine narrowing rather than "the only entry" — which is fine for the surfaces
 * left using it, because each one is describing the *project* rather than a specific
 * piece of work. Anything describing work reads the repository that work recorded
 * instead: a run's own `repository` column (issue #691), a queued dispatch's `repo`.
 */

/** The narrow shape these helpers need — anything carrying the repository list. */
interface ProjectWithRepositories {
	repositories?: Array<{ repo: string }>;
}

/** One repository entry as the projects API writes it (`ProjectRepositorySchema`). */
interface RepositoryEntry {
	repo: string;
	baseBranch?: string;
	branchPrefix?: string;
	scm?: string;
}

/**
 * The `repositories` list to send when the General tab saves its three inputs, which
 * edit the project's **default** (first) entry only.
 *
 * `projects.update` replaces the list wholesale, so a save that sent just the edited
 * entry would silently delete every other repository a project owns — reachable the
 * moment issue #684 phase 2 lifted the one-entry cap. The remaining entries are carried
 * through verbatim, and the edited one keeps its own untouched fields (a per-repository
 * `scm` override) by being spread rather than rebuilt.
 *
 * Phase 3's list editor replaces the caller, not this rule: whatever edits the list has
 * to preserve what it does not show.
 */
export function withDefaultRepositoryEdited<T extends { repositories: RepositoryEntry[] }>(
	project: T | null | undefined,
	edit: Pick<RepositoryEntry, 'repo' | 'baseBranch' | 'branchPrefix'>,
): RepositoryEntry[] {
	const [current, ...rest] = project?.repositories ?? [];
	return [{ ...current, ...edit }, ...rest];
}

/**
 * The repository to display for a project, or `''` when it declares none (which the
 * schema forbids, so it only happens for a partially-loaded cache entry). Callers that
 * render a link should test the result before building a URL.
 */
export function projectRepo(project: ProjectWithRepositories | null | undefined): string {
	return project?.repositories?.[0]?.repo ?? '';
}
