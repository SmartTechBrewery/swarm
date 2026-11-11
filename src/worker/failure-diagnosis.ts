import { z } from 'zod';
import type { ReportedAgentResult } from '../harness/agent-cli.js';
import type { AgentFailureKind } from '../harness/agent-failure.js';
import type { ProposedScope } from '../pipeline/planning.js';

export const FailureDiagnosisKindSchema = z.enum([
	'likely-scope-exceeded',
	'provider-stalled-early',
	'provider-rate-limit',
	'provider-capacity',
	'launch-or-authentication',
	'worker-shutdown',
	'user-terminated',
	'continuation-budget-exhausted',
	'continuation-no-progress',
	'commit-unavailable',
	'nothing-to-deliver',
	'merge-verification-refused',
	'review-waiting-for-checks',
	'review-provider-unreachable',
]);

export type FailureDiagnosisKind = z.infer<typeof FailureDiagnosisKindSchema>;

/**
 * A concise, evidence-based explanation for a terminal run failure. The raw
 * error remains on the run independently, so this is safe to render in the
 * dashboard and board comment without replacing diagnostic detail.
 */
export const FailureDiagnosisSchema = z.object({
	kind: FailureDiagnosisKindSchema,
	title: z.string(),
	message: z.string(),
	recovery: z.string(),
});

export type FailureDiagnosis = z.infer<typeof FailureDiagnosisSchema>;

export type KnownFailureCondition = Exclude<
	FailureDiagnosisKind,
	| 'likely-scope-exceeded'
	| 'provider-stalled-early'
	| 'review-waiting-for-checks'
	| 'review-provider-unreachable'
>;

/**
 * The opening words of the failure Implementation raises when its agent changed
 * no repository file (issue #1335, `src/pipeline/implementation.ts`). The
 * `nothing-to-deliver` diagnosis keys on them rather than on the error class,
 * because a DB-free worker's failure reaches the control plane as its message
 * alone.
 */
export const IMPLEMENTATION_NOTHING_TO_DELIVER = 'Implementation found nothing to deliver';

/** Whether a failure message is Implementation's nothing-to-deliver failure. */
export function isImplementationNothingToDeliverFailure(error: string): boolean {
	return error.includes(IMPLEMENTATION_NOTHING_TO_DELIVER);
}

/**
 * The words of the refusal Resolve-conflicts raises when its agent's hand-off
 * records a `failed` verification entry (issues #924, #1422,
 * `src/pipeline/resolve-conflicts.ts`). Keyed on by the `merge-verification-refused`
 * diagnosis for the same reason as {@link IMPLEMENTATION_NOTHING_TO_DELIVER}: a
 * DB-free worker's failure reaches the control plane as its message alone.
 */
export const MERGE_VERIFICATION_REFUSED =
	'fails verification the agent attributes to the merge itself';

/** Whether a failure message is Resolve-conflicts' refusal of a failed-verification hand-off. */
export function isMergeVerificationRefusal(error: string): boolean {
	return error.includes(MERGE_VERIFICATION_REFUSED);
}

export interface DiagnoseFailureInput {
	failureKind?: AgentFailureKind;
	agent?: ReportedAgentResult;
	planningScope?: ProposedScope;
	knownCondition?: KnownFailureCondition;
}

const RESPONSE_STALL_BANNER_RE = /(?:\r?\n)?[^\r\n]*timeout waiting for response\s*$/i;
export const MIN_SCOPE_STALL_DURATION_MS = 10 * 60 * 1000;
export const MIN_SCOPE_STALL_OUTPUT_BYTES = 1_000;

function diagnosis(
	kind: FailureDiagnosisKind,
	title: string,
	message: string,
	recovery: string,
): FailureDiagnosis {
	return { kind, title, message, recovery };
}

function knownDiagnosis(condition: KnownFailureCondition): FailureDiagnosis {
	switch (condition) {
		case 'provider-rate-limit':
			return diagnosis(
				condition,
				'Known provider condition: quota or rate limit',
				'The agent provider reached a quota or rate limit before the phase could complete.',
				'Wait for the provider limit to reset, then retry the phase.',
			);
		case 'provider-capacity':
			return diagnosis(
				condition,
				'Known provider condition: model capacity',
				'The selected model was reported at capacity by the provider (not a usage/quota limit).',
				'Configure a different model for this phase or project, then retry the phase.',
			);
		case 'launch-or-authentication':
			return diagnosis(
				condition,
				'Known provider condition: launch or authentication',
				'The agent CLI could not launch or authenticate with its provider.',
				'Restore the CLI installation or authentication, then retry the phase.',
			);
		case 'worker-shutdown':
			return diagnosis(
				condition,
				'Known condition: worker shutdown',
				'The worker shut down while the agent was running.',
				'Restart the worker, then retry the phase.',
			);
		case 'user-terminated':
			return diagnosis(
				condition,
				'Known condition: user termination',
				'The run was terminated by a user request.',
				'Retry the phase only if you want to run it again.',
			);
		case 'commit-unavailable':
			return diagnosis(
				condition,
				'Known condition: the worker cannot get the commit or branch from origin',
				"The phase needs a commit or the pull request's branch from the remote, and the worker could not get it: a `git fetch origin` failed, so either the checkout could not be created (a commit or branch absent from that clone) or the agent's own sync of the branch with origin failed and it stopped. The run error names the failed git commands verbatim. This is a fact about that machine's access to the remote, not about the pull request, the branch or the SHA.",
				"Check that machine's network access and credentials for the remote (`git fetch origin` in its checkout), or enroll a worker that can reach it, then retry the phase.",
			);
		case 'nothing-to-deliver':
			return diagnosis(
				condition,
				'Known condition: nothing to deliver',
				"The implementer agent finished without changing any repository file, so nothing was committed and no pull request was opened. The work is most likely already on the base branch, or the card's acceptance criteria are already met. SWARM moves the card out of In progress to Backlog, where nothing starts it again by itself; the run error says whether that move succeeded.",
				"Update the card's scope if work remains, or close it if the work is already done. Re-running Implementation on the card as it stands would find nothing to change again.",
			);
		case 'merge-verification-refused':
			return diagnosis(
				condition,
				'Known condition: the merge failed its own verification',
				"The Resolve-conflicts agent staged a merge but its hand-off records a `failed` verification entry — a failure the agent attributes to the merge itself — so SWARM refused to deliver it. This is a refusal of the agent's hand-off, not a transient condition: a delivery retry would only re-read the same hand-off and refuse it again, so the run was not deferred and the checkout was released. The run error names the failed commands and the agent's own detail.",
				'Check whether the failure is really caused by the merge. One caused by the worker\'s environment — for example a shared test database still holding an earlier migration of this branch — needs fixing on that machine first. Then "Retry now" runs the agent again on a fresh checkout, so it resolves and re-verifies the merge.',
			);
		case 'continuation-budget-exhausted':
			return diagnosis(
				condition,
				'Known condition: continuation ceiling reached',
				'The run kept progressing, but it was stopped involuntarily again after using every checkpoint continuation `pipeline.maxContinuations` allows, so it was not handed off a further time.',
				'Inspect the checkpoint recorded on this run. "Retry now" continues it once more from that checkpoint on the machine holding it; otherwise raise `pipeline.maxContinuations`, narrow the task, or use "Reset & restart" to start the phase over.',
			);
		case 'continuation-no-progress':
			return diagnosis(
				condition,
				'Known condition: checkpoint continuations made no progress',
				'The checkpoint did not advance across as many consecutive continuations as `pipeline.maxContinuationsWithoutProgress` allows — no new completed step, no fewer remaining steps, no new working-tree path — so the run was not handed off a further time.',
				'Inspect the checkpoint recorded on this run. "Retry now" continues it once more from that checkpoint on the machine holding it; otherwise raise `pipeline.maxContinuationsWithoutProgress`, narrow the task, or use "Reset & restart" to start the phase over.',
			);
	}
}

/**
 * The two Review give-ups an operator should read in plain terms (issue #1203),
 * each carrying the one value its copy names.
 */
export type AbandonedReviewDiagnosisInput =
	| { kind: 'review-waiting-for-checks'; waitMinutes: number }
	| { kind: 'review-provider-unreachable'; providerLabel: string };

function describeMinutes(minutes: number): string {
	return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/**
 * The headline of an abandoned Review run (issue #1203). The `kind` is the
 * recorded fact about the abandonment — which recheck budget ran out, and for
 * `review-waiting-for-checks` that the head's checks were still running — and the
 * WIP read model (`src/queue/wip-usage.ts`) reads that kind, never the run's
 * `error`, to tell a Review that resumes by itself when CI finishes from one that
 * waits on the operator.
 */
export function abandonedReviewDiagnosis(input: AbandonedReviewDiagnosisInput): FailureDiagnosis {
	if (input.kind === 'review-waiting-for-checks') {
		const minutes = describeMinutes(input.waitMinutes);
		return diagnosis(
			input.kind,
			`Review didn't start yet — CI was still running after ${minutes}`,
			'Review starts automatically when the checks finish.',
			`None needed now. If CI in this repository usually takes longer than ${minutes}, raise its Check Wait under Source Control → Repositories.`,
		);
	}
	return diagnosis(
		input.kind,
		`${input.providerLabel} didn't respond while SWARM was checking this pull request`,
		'SWARM stopped waiting, so this Review will not start by itself.',
		`Use Retry now once ${input.providerLabel} is reachable.`,
	);
}

function progressOutputBytes(agent: ReportedAgentResult): number {
	const cleanStdout = agent.stdout.replace(RESPONSE_STALL_BANNER_RE, '');
	const cleanStderr = agent.stderr.replace(RESPONSE_STALL_BANNER_RE, '');
	return Buffer.byteLength(cleanStdout, 'utf8') + Buffer.byteLength(cleanStderr, 'utf8');
}

/**
 * Diagnose a terminal agent failure without turning incomplete evidence into a
 * task-size claim. A scope diagnosis needs all three independent signals:
 * recognised response stall, substantial observed progress, and a prior
 * planning scope that declares multiple independent concerns.
 */
export function diagnoseFailure(input: DiagnoseFailureInput): FailureDiagnosis | undefined {
	if (input.knownCondition) return knownDiagnosis(input.knownCondition);

	if (input.failureKind !== 'stalled' && input.failureKind !== 'timeout') return undefined;

	const agent = input.agent;
	const hasScopeEvidence = (input.planningScope?.independentConcerns.length ?? 0) > 1;
	const hasSubstantialProgress =
		agent !== undefined &&
		// A stand-in whose frame never reported a duration (issue #596) is no evidence
		// of substantial progress, so it must not support a scope claim.
		(agent.durationMs ?? 0) >= MIN_SCOPE_STALL_DURATION_MS &&
		progressOutputBytes(agent) >= MIN_SCOPE_STALL_OUTPUT_BYTES;

	if (input.failureKind === 'stalled' && hasScopeEvidence && hasSubstantialProgress) {
		return diagnosis(
			'likely-scope-exceeded',
			'Likely scope exceeded',
			'The agent stalled after substantial progress. This task likely exceeds the single-task scope; narrow or split it before retrying.',
			'Narrow or split the task before retrying.',
		);
	}

	return diagnosis(
		'provider-stalled-early',
		'Provider stalled early',
		'The agent provider stalled before meaningful work began; retry later or use another configured provider.',
		'Retry later or use another configured provider.',
	);
}
