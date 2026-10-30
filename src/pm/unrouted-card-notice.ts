/**
 * The notice posted on a board card that ingress refused to route because of what
 * the card itself says about its repository (issue #1237) — the routing-side twin
 * of the unresolvable-card notice `pm-status` posts (issue #1231,
 * `src/triggers/handlers/pm-status.ts`).
 *
 * Routing is decided at ingress (`src/router/webhook-receiver.ts`), before any job
 * exists, so a card it refuses never reaches the trigger that posts #1231's notice
 * and the refusal would otherwise live only in a router log line. Posted only when
 * the provider's `unrouted` answer carries a {@link RepositoryClaim} — a value a
 * person typed, which the notice can quote back next to the repositories it could
 * have named. An id-routed refusal (components, labels) carries none and stays the
 * log line it always was.
 *
 * Provider-blind like the rest of `src/pm/` (ai/RULES.md §2): everything goes
 * through the `PMProvider` contract — `getWorkItem` for the card's column and its
 * automation label, `findComment`/`addComment` for the idempotent post.
 */

import { createHash } from 'node:crypto';

import type { ProjectConfig } from '../config/schema.js';
import { logger } from '../lib/logger.js';
import { SWARM_GENERATED_FOOTER, swarmMarker } from '../scm/swarm-origin.js';
import { hasAutomationLabel, resolveAutomationLabel } from './automation-label.js';
import { type PipelinePhase, resolvePipelinePhaseForStatusKey } from './pipeline.js';
import type { PMProvider, RepositoryClaim } from './types.js';

/** The inputs one unrouted-card notice is written from, and keyed on. */
export interface UnroutedCardNotice {
	/** The phase the card's column starts — the work that did not begin. */
	phase: PipelinePhase;
	/** What the card said about its repository. */
	claim: RepositoryClaim;
	/** The project's repositories: every value the claim could have named. */
	repositories: readonly string[];
}

const PHASE_NAMES: Readonly<Record<PipelinePhase, string>> = {
	planning: 'Planning',
	implementation: 'Implementation',
};

/**
 * The idempotency marker of an unrouted-card notice: one per phase and value read,
 * so dragging the card back and forth does not repost it while a different value —
 * the operator's next attempt, still wrong — gets its own. The value is hashed
 * rather than embedded because a person typed it: whatever it holds must not be
 * able to close the hidden marker early.
 */
export function unroutedCardMarker(notice: UnroutedCardNotice): string {
	const claimKey = createHash('sha256')
		.update(`${notice.claim.source}\n${notice.claim.value}`)
		.digest('hex')
		.slice(0, 16);
	return swarmMarker('unrouted-card', `${notice.phase}:${claimKey}`);
}

/**
 * The notice itself: which phase did not start, what the card's field said, the
 * repositories it may name, and what to do — worded provider-neutrally, since the
 * claim's `source` is already the board's own name for the field.
 */
export function unroutedCardCommentBody(notice: UnroutedCardNotice): string {
	const { claim, repositories } = notice;
	const phase = PHASE_NAMES[notice.phase];
	const read = claim.value
		? `its **${claim.source}** field reads \`${claim.value}\`, which is none of this project's repositories.`
		: `its **${claim.source}** field is empty, so SWARM cannot tell which of this project's repositories it belongs to.`;
	return [
		`### SWARM could not start ${phase}`,
		'',
		`This card entered a column that starts the **${phase}** phase, but ${read}`,
		'',
		`**${claim.source}** must name one of these repositories, exactly as written:`,
		'',
		...repositories.map((repo) => `- \`${repo}\``),
		'',
		`**Nothing was started.** Set **${claim.source}** to one of them, then move the card out of this column and back in.`,
		'',
		'---',
		SWARM_GENERATED_FOOTER,
		unroutedCardMarker(notice),
	].join('\n');
}

/**
 * Post {@link unroutedCardCommentBody} on a card ingress refused to route, so the
 * operator who moved it sees why nothing happened instead of a card that silently
 * does nothing.
 *
 * Gated exactly as #1231's notice is, because it is the same kind of write: only for
 * a card whose column starts a phase (moving a card SWARM would not have worked on
 * anyway is not worth a comment), and only for a card carrying the project's
 * automation label (`resolveAutomationLabel` / `hasAutomationLabel` — a card
 * without it is one SWARM must not touch, and an empty `automationLabel` switches
 * the gate off). Idempotent on {@link unroutedCardMarker}.
 *
 * Best-effort: the refusal stands whatever happens here, so any provider failure is
 * logged and swallowed rather than turning an acknowledged refusal into a 5xx the
 * provider would redeliver.
 */
export async function surfaceUnroutedCard(
	provider: PMProvider,
	project: ProjectConfig,
	itemId: string,
	claim: RepositoryClaim,
	repositories: readonly string[],
): Promise<void> {
	try {
		const workItem = await provider.getWorkItem(itemId);
		const phase = workItem.statusKey
			? resolvePipelinePhaseForStatusKey(workItem.statusKey)
			: undefined;
		if (!phase) return;
		const automationLabel = resolveAutomationLabel(project.pipeline);
		if (automationLabel && !hasAutomationLabel(workItem, automationLabel)) return;
		const notice: UnroutedCardNotice = { phase, claim, repositories };
		if (await provider.findComment(itemId, unroutedCardMarker(notice))) return;
		await provider.addComment(itemId, unroutedCardCommentBody(notice));
	} catch (err) {
		logger.warn('Could not post the unrouted-card notice', {
			projectId: project.id,
			itemId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
