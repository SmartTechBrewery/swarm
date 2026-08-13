/**
 * Reading and editing a project's repository list from the dashboard (issue #684).
 *
 * `projects.list` / `projects.getById` serve the **record** — the project with its
 * `repositories` list — because the dashboard is the config-management surface. Every
 * *incidental* read (a PR link, a worker roster, a runs-table column) wants one
 * repository, so it goes through {@link projectRepo} rather than indexing the list at
 * the call site.
 *
 * That leaves one place naming the assumption those incidental reads make: they show
 * the project's **default** repository, its first entry. Phase 2 lifted the one-entry
 * cap, so that is a genuine narrowing rather than "the only entry" — which is fine for
 * the surfaces using it, because each one is describing the *project* rather than a
 * specific piece of work. Anything describing work reads the repository that work
 * recorded instead: a run's own `repository` column (issue #691), a queued dispatch's
 * `repo`.
 *
 * The rest of this module is the list editor (phase 3): the projection onto editable
 * rows, the add/remove/reorder/patch mutations it drives, the two rules the screen
 * enforces client-side (at least one entry, no repository twice), and the dirty check
 * and payload its Save uses. Kept out of the route component so they can be
 * unit-tested, mirroring `dashboard/src/lib/agent-targets.ts`. *Where* that editor
 * renders is not this module's concern and has moved once — the General tab in issue
 * #700, the Source Control tab in issue #729, under the provider the repositories live
 * on — with nothing here changing either time.
 */

/** The narrow shape these helpers need — anything carrying the repository list. */
interface ProjectWithRepositories {
	repositories?: Array<{ repo: string }>;
}

/**
 * One repository entry as the projects API reads and writes it
 * (`ProjectRepositorySchema`).
 *
 * No `scm`: a project has **one** SCM provider and every repository it owns lives on
 * it (issue #727). The field existed here between issues #700 and #727, and the
 * credential model is what made it incoherent rather than merely unnecessary — the
 * Source Control tab edits `credentials.scm[<project.scm>]` alone, so an overridden
 * provider's credentials had nowhere to be entered. A stored one is ignored
 * server-side, and a save from this screen drops it.
 */
export interface RepositoryEntry {
	repo: string;
	baseBranch?: string;
	branchPrefix?: string;
	/**
	 * The board card's routing token (issue #686). Authored in `swarm.config.json`
	 * and **not editable here** — this screen only carries it through, so saving the
	 * tab cannot silently drop a token nothing on it renders.
	 */
	pmRoutingToken?: string;
}

/**
 * One row of the repository editor. Every field is a string, so the form state is
 * exactly what its inputs render.
 *
 * `id` is form-only and never persisted: it is the row's React key, so a reorder moves
 * the row instead of rewriting two sets of inputs. A value-derived key — the trick
 * `targetKey` can afford, since the Agent Configuration rows are selects — would
 * change on every keystroke here and remount the input mid-edit.
 */
export interface RepositoryForm {
	id: string;
	repo: string;
	baseBranch: string;
	branchPrefix: string;
	/**
	 * Carried opaquely, never rendered (issue #686). It rides on the row rather than
	 * being looked up at save time because a save sends the whole list positionally,
	 * and a row can be reordered or removed in between — so the token has to travel
	 * with the row it belongs to, not with its old index.
	 */
	pmRoutingToken?: string;
}

/**
 * What a row added here starts on — the same values `PROJECT_DEFAULTS`
 * (`src/config/schema.ts`) applies to an entry stating neither, so a repository added
 * on this screen and one added to `swarm.config.json` land identically. Spelled out
 * rather than imported, because that module's own imports reach the node-only agent-CLI
 * harness — the same reason `agent-targets.ts` restates `AGENT_CLIS`.
 */
const NEW_REPOSITORY = { repo: '', baseBranch: 'main', branchPrefix: 'issue-' } as const;

/** A row id no row in `rows` already uses, so keys stay unique across adds and removes. */
function nextRowId(rows: RepositoryForm[]): string {
	const highest = rows.reduce((max, row) => Math.max(max, Number.parseInt(row.id, 10) || 0), 0);
	return String(highest + 1);
}

/**
 * The stored list projected onto editable rows.
 *
 * An absent or empty list yields one blank row: the schema requires at least one entry,
 * so an editor showing none would offer nothing to fix.
 */
export function toRepositoryForms(repositories: RepositoryEntry[] | undefined): RepositoryForm[] {
	const rows = (repositories ?? []).map((entry, index) => ({
		id: String(index + 1),
		repo: entry.repo,
		baseBranch: entry.baseBranch ?? '',
		branchPrefix: entry.branchPrefix ?? '',
		...(entry.pmRoutingToken ? { pmRoutingToken: entry.pmRoutingToken } : {}),
	}));
	return rows.length > 0 ? rows : [{ id: '1', ...NEW_REPOSITORY }];
}

/**
 * The `repositories` list to send on save. The whole list goes every time, because
 * `projects.update` replaces it wholesale — so a field this screen does not edit still
 * has to be written back, or saving the tab would delete it. `pmRoutingToken` (issue
 * #686) is the one such field: it is authored in `swarm.config.json`, has no input
 * here, and is carried straight through from the row it was read onto.
 *
 * A pre-#727 per-repository `scm` is deliberately *not* one of those: it is dropped
 * here exactly as the server drops it on parse, so the two surfaces agree that a
 * repository states no provider of its own.
 */
export function toRepositoryEntries(rows: RepositoryForm[]): RepositoryEntry[] {
	return rows.map((row) => ({
		repo: row.repo,
		baseBranch: row.baseBranch,
		branchPrefix: row.branchPrefix,
		...(row.pmRoutingToken ? { pmRoutingToken: row.pmRoutingToken } : {}),
	}));
}

/** Append a blank row at the end — the lowest-priority position, never the default. */
export function addRepository(rows: RepositoryForm[]): RepositoryForm[] {
	return [...rows, { id: nextRowId(rows), ...NEW_REPOSITORY }];
}

/**
 * Drop one row, unless it is the last one: a project owns at least one repository
 * (`repositories: z.array(…).min(1)`), so an empty list would be refused server-side
 * with nothing left on screen to fix. The Remove button is disabled for it too — this
 * is the rule, that is the affordance.
 */
export function removeRepository(rows: RepositoryForm[], index: number): RepositoryForm[] {
	if (rows.length <= 1) return rows;
	return rows.filter((_, i) => i !== index);
}

/**
 * Move one row one position up or down. Order is meaningful: the first entry is the
 * project's default repository, so moving a row to the top is how that is changed.
 */
export function moveRepository(
	rows: RepositoryForm[],
	index: number,
	direction: 'up' | 'down',
): RepositoryForm[] {
	const swapWith = direction === 'up' ? index - 1 : index + 1;
	if (index < 0 || index >= rows.length || swapWith < 0 || swapWith >= rows.length) {
		return rows;
	}
	const next = [...rows];
	[next[index], next[swapWith]] = [next[swapWith] as RepositoryForm, next[index] as RepositoryForm];
	return next;
}

/** Apply one field's change to a row. Out-of-range indexes are a no-op. */
export function patchRepository(
	rows: RepositoryForm[],
	index: number,
	patch: Partial<Omit<RepositoryForm, 'id'>>,
): RepositoryForm[] {
	if (!rows[index]) return rows;
	return rows.map((row, i) => (i === index ? { ...row, ...patch } : row));
}

/**
 * Repositories named by more than one row. The server's conflict guard only refuses a
 * repository *another* project owns, so a list repeating one would be accepted and leave
 * the project ambiguous about which entry a delivery belongs to — this is the check that
 * has no server-side twin, which is why Save is blocked on it client-side.
 *
 * Compared trimmed, so surrounding whitespace can't disguise the same repository twice.
 */
export function duplicateRepositories(rows: RepositoryForm[]): string[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const row of rows) {
		const repo = row.repo.trim();
		if (!repo) continue;
		if (seen.has(repo)) duplicates.add(repo);
		seen.add(repo);
	}
	return [...duplicates];
}

/**
 * Whether the edited list differs from the stored one — position included, since the
 * first entry is the project's default repository. The stored side is projected through
 * {@link toRepositoryForms} so both sides compare in the same shape.
 */
export function areRepositoriesDirty(
	rows: RepositoryForm[],
	stored: RepositoryEntry[] | undefined,
): boolean {
	const storedRows = toRepositoryForms(stored);
	if (rows.length !== storedRows.length) return true;
	return rows.some((row, i) => {
		const other = storedRows[i];
		return (
			row.repo !== other?.repo ||
			row.baseBranch !== other?.baseBranch ||
			row.branchPrefix !== other?.branchPrefix
		);
	});
}

/**
 * The repository to display for a project, or `''` when it declares none (which the
 * schema forbids, so it only happens for a partially-loaded cache entry). Callers that
 * render a link should test the result before building a URL.
 */
export function projectRepo(project: ProjectWithRepositories | null | undefined): string {
	return project?.repositories?.[0]?.repo ?? '';
}
