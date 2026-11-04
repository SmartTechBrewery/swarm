/**
 * The projects a caller may access, as id + name + the role they hold there — the
 * one read behind both `projects.listMine` (the profile's My Projects tab, issue
 * #661) and `workers.enrollableProjects` (the operator API's project picker for
 * `swarm-worker setup`, issue #1311), so the two cannot drift apart.
 *
 * Visibility is not decided here: it is `filterAccessibleProjects`, the rule
 * `projects.list` runs on — the caller's membership set, or every project for an
 * `instanceAdmin`. A `discoverable` project they have not joined is not listed.
 *
 * `role` is the membership row's role, or `null` when there is none. Only an
 * `instanceAdmin` reaches a project without one, so `null` means precisely
 * "access comes from the installation role" and is reported as the absence of a
 * membership rather than as a synthesized `projectAdmin`.
 *
 * The projection is id + name + role only — no repo path, board mapping, or
 * credential reference travels with it — which is what makes it safe to serve on
 * the internet-reachable operator router (`./operator-router.ts`).
 */

import { listAllProjectRecordsFromDb } from '../db/repositories/projectsRepository.js';
import type { ProjectRole } from '../identity/membership.js';
import { listProjectsForUser } from '../identity/membership-service.js';
import type { SwarmUser } from '../identity/schema.js';
import { filterAccessibleProjects } from './authz.js';

export interface AccessibleProjectSummary {
	id: string;
	name: string;
	role: ProjectRole | null;
}

export async function listAccessibleProjectSummaries(
	user: SwarmUser,
): Promise<AccessibleProjectSummary[]> {
	const accessible = await filterAccessibleProjects(user, await listAllProjectRecordsFromDb());
	const roleByProjectId = new Map(
		(await listProjectsForUser(user.id)).map(
			(membership) => [membership.projectId, membership.role] as const,
		),
	);
	// `listAllProjectRecordsFromDb` already orders by name, so the order is the server's.
	return accessible.map((project) => ({
		id: project.id,
		name: project.name,
		role: roleByProjectId.get(project.id) ?? null,
	}));
}
