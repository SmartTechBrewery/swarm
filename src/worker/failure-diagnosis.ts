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
	'likely-scope-exceeded' | 'provider-stalled-early'
>;

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
		case 'continuation-budget-exhausted':
			return diagnosis(
				condition,
				'Known condition: continuation budget exhausted',
				'The run was stopped involuntarily again after using every checkpoint continuation the project allows, so it was not handed off a further time.',
				'Inspect the checkpoint recorded on this run, then either raise `pipeline.maxContinuations`, narrow the task, or reset and restart the phase.',
			);
	}
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
