import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { AgentCli, AgentCliResult } from '../harness/agent-cli.js';

const execFileAsync = promisify(execFile);

// Git exports repository-local variables while running hooks. They override
// `cwd`, so carrying them into a worktree delivery can redirect commands to
// the hook's repository/index. Preserve transport/auth variables, but always
// let the requested worktree determine repository location.
const repositoryLocalGitEnvironment = [
	'GIT_ALTERNATE_OBJECT_DIRECTORIES',
	'GIT_CONFIG',
	'GIT_CONFIG_PARAMETERS',
	'GIT_OBJECT_DIRECTORY',
	'GIT_DIR',
	'GIT_WORK_TREE',
	'GIT_IMPLICIT_WORK_TREE',
	'GIT_GRAFT_FILE',
	'GIT_INDEX_FILE',
	'GIT_NO_REPLACE_OBJECTS',
	'GIT_REPLACE_REF_BASE',
	'GIT_PREFIX',
	'GIT_INTERNAL_SUPER_PREFIX',
	'GIT_SHALLOW_FILE',
	'GIT_COMMON_DIR',
] as const;

function gitEnvironmentForCwd(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of repositoryLocalGitEnvironment) delete env[key];
	return env;
}

export const VerificationSchema = z.object({
	command: z.string().min(1),
	outcome: z.literal('passed'),
});

const CommitSchema = z.object({
	commitSubject: z.string().min(1).max(200),
	verification: z.array(VerificationSchema).min(1),
});

export const ImplementationHandoffSchema = CommitSchema.extend({
	summary: z.string().min(1),
	limitations: z.array(z.string()).default([]),
	readyForDelivery: z.literal(true),
});

/**
 * A command the reviewer ran, and whether it passed. Unlike
 * {@link VerificationSchema} — which the *implementation* hand-off uses, where a
 * failing command means the work isn't deliverable — a reviewer's failing
 * command is itself evidence for a finding, so `failed` is a legitimate outcome
 * to report rather than a reason to reject the hand-off (issue #470).
 */
export const ReviewVerificationSchema = z.object({
	command: z.string().min(1),
	outcome: z.enum(['passed', 'failed']),
});

/**
 * Severity decides two things mechanically: which slots a finding must fill
 * (see {@link ReviewHandoffSchema}'s refinement) and the run's verdict. Only
 * `blocker`/`major` block a PR.
 */
export const REVIEW_FINDING_SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;
export type ReviewFindingSeverity = (typeof REVIEW_FINDING_SEVERITIES)[number];

/** Closed vocabulary, so the same defect gets the same label on every model/CLI (issue #470). */
export const REVIEW_FINDING_CATEGORIES = [
	'correctness',
	'security',
	'contract',
	'performance',
	'test-coverage',
	'docs',
	'consistency',
] as const;

/** Whether a severity blocks the PR — the single rule the verdict derives from. */
export function isBlockingSeverity(severity: ReviewFindingSeverity): boolean {
	return severity === 'blocker' || severity === 'major';
}

/** What a re-review concluded about a finding an earlier pass raised. */
export const REVIEW_CARRIED_STATUSES = ['resolved', 'partial', 'outstanding', 'regressed'] as const;

const ReviewFindingSchema = z.object({
	/** `F<n>`, minted by the pass that first raised it and carried by every later pass. */
	id: z.string().regex(/^F\d+$/, 'finding id must be F<n>'),
	title: z.string().min(1),
	severity: z.enum(REVIEW_FINDING_SEVERITIES),
	category: z.enum(REVIEW_FINDING_CATEGORIES),
	/** Required at every severity: the `file:line` anchors the claim rests on. */
	evidence: z.string().min(1),
	// Blocking tier (blocker/major) — required there, forbidden below it.
	failureScenario: z.string().min(1).optional(),
	impact: z.string().min(1).optional(),
	fixPlan: z.array(z.string().min(1)).min(1).optional(),
	tests: z.string().min(1).optional(),
	// Compact tier (minor/nit) — one paragraph instead of five slots, because the
	// suggestion *is* the plan and the full treatment turns a naming nit into 200
	// words. `downgradeRationale` is the pressure valve: it lets a reviewer justify
	// calling something minor rather than quietly parking a real defect there.
	suggestion: z.string().min(1).optional(),
	downgradeRationale: z.string().min(1).optional(),
});

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

const ReviewDocCheckSchema = z.object({
	path: z.string().min(1),
	status: z.enum(['accurate', 'updated', 'not-applicable', 'stale']),
	note: z.string().optional(),
});

export type ReviewDocCheck = z.infer<typeof ReviewDocCheckSchema>;

const ReviewCarriedSchema = z.object({
	id: z.string().regex(/^F\d+$/, 'carried finding id must be F<n>'),
	title: z.string().min(1),
	status: z.enum(REVIEW_CARRIED_STATUSES),
	detail: z.string().min(1),
});

export type ReviewCarriedFinding = z.infer<typeof ReviewCarriedSchema>;

/** Which slots each severity tier must fill, and which it must leave empty. */
const BLOCKING_SLOTS = ['failureScenario', 'impact', 'fixPlan', 'tests'] as const;
const COMPACT_SLOTS = ['suggestion', 'downgradeRationale'] as const;

/**
 * Enforce the two rendering tiers, and unique finding ids.
 *
 * Done in the schema rather than asked for in the prompt because a model can
 * neither be trusted to pad a nit into five slots nor to trace a blocker's
 * failure scenario — and the renderer (`src/pipeline/review-body.ts`) relies on
 * each tier's slots being present. Ids must be unique because a re-review's
 * disposition and the respond-to-review flow key on them, so a collision would
 * silently merge two problems into one.
 */
function checkFindingTiers(findings: readonly ReviewFinding[], ctx: z.RefinementCtx): void {
	const seen = new Set<string>();
	for (const [index, finding] of findings.entries()) {
		if (seen.has(finding.id))
			ctx.addIssue({
				code: 'custom',
				path: ['findings', index, 'id'],
				message: `duplicate finding id ${finding.id}`,
			});
		seen.add(finding.id);
		checkFindingSlots(finding, index, ctx);
	}
}

/** One finding's required/forbidden slots for its tier. Split out for the complexity budget. */
function checkFindingSlots(finding: ReviewFinding, index: number, ctx: z.RefinementCtx): void {
	const blocking = isBlockingSeverity(finding.severity);
	const required = blocking ? BLOCKING_SLOTS : ([COMPACT_SLOTS[0]] as const);
	const forbidden = blocking ? COMPACT_SLOTS : BLOCKING_SLOTS;
	const issue = (field: string, message: string) =>
		ctx.addIssue({
			code: 'custom',
			path: ['findings', index, field],
			message: `${finding.id} is ${finding.severity}, so ${field} ${message}`,
		});
	for (const field of required) if (finding[field] === undefined) issue(field, 'is required');
	for (const field of forbidden) if (finding[field] !== undefined) issue(field, 'must be omitted');
}

/**
 * Every carried item a re-review did **not** resolve must reappear in `findings`
 * under the same id.
 *
 * Without this the two lists are independent, so a re-review could render a
 * disposition table reading "F1 ❌ not addressed" above the verdict `approve` —
 * clearing the review gate and, with `pipeline.respondToReview.autoMerge` on,
 * merging a PR whose requested changes were never made. Routing the item through
 * `findings` instead of coupling it to the verdict directly is deliberate: it
 * lets {@link checkVerdictMatchesSeverities} do the verdict work from the
 * severity the reviewer assigns, so a still-outstanding *nit* from an earlier
 * pass can be approved while a still-outstanding blocker cannot. It is also what
 * makes an `F<n>` id stable across passes rather than merely unique within one.
 */
function checkCarriedItemsAreReported(
	carried: readonly ReviewCarriedFinding[],
	findings: readonly ReviewFinding[],
	ctx: z.RefinementCtx,
): void {
	const reported = new Set(findings.map((f) => f.id));
	for (const [index, item] of carried.entries()) {
		if (item.status === 'resolved' || reported.has(item.id)) continue;
		ctx.addIssue({
			code: 'custom',
			path: ['carried', index, 'status'],
			message: `${item.id} is ${item.status}, so it must also appear in findings under the same id`,
		});
	}
}

/**
 * The verdict is a pure function of the severity histogram, so it is enforced
 * rather than instructed — this is what makes "blocker" and "approve" mean the
 * same thing whichever model produced the review, which prose alone never
 * achieved.
 */
function checkVerdictMatchesSeverities(
	verdict: 'approve' | 'request-changes',
	findings: readonly ReviewFinding[],
	ctx: z.RefinementCtx,
): void {
	const blocking = findings.filter((f) => isBlockingSeverity(f.severity));
	if (blocking.length > 0 && verdict !== 'request-changes')
		ctx.addIssue({
			code: 'custom',
			path: ['verdict'],
			message: `${blocking.map((f) => f.id).join(', ')} ${blocking.length === 1 ? 'is' : 'are'} blocker/major, so the verdict must be request-changes`,
		});
	if (blocking.length === 0 && verdict === 'request-changes')
		ctx.addIssue({
			code: 'custom',
			path: ['verdict'],
			message: 'request-changes requires at least one blocker/major finding',
		});
}

/**
 * The Review phase's hand-off (issue #470). The agent fills **fields**, never
 * layout: `src/pipeline/review-body.ts` renders the posted review body from
 * these, so the structure is identical on every model and CLI. That is why there
 * is no `body` here — the previous shape had one, and having the agent author the
 * whole body was exactly what let each harness invent its own format.
 *
 * `verdict` is deliberately only `approve`/`request-changes`. The old third
 * option, `comment`, mirrored `gh pr review`'s event flags rather than any SWARM
 * state, and it closed every exit at once: no merge dispatch (only `approve`
 * persists one), no Respond-to-review run (skipped as a minor verdict under the
 * default `skipOnMinors`), a consumed slot against `REVIEW_VERDICT_CAP`, and no
 * `manual-intervention-required` signal — so the PR looked reviewed and was
 * silently terminal. A reviewer that cannot reach a verdict must fail its run,
 * which retries, rather than post a terminal non-verdict.
 */
export const ReviewHandoffSchema = z
	.object({
		verdict: z.enum(['approve', 'request-changes']),
		/** The `## Scope` paragraph: what the change is and what was confirmed. */
		summary: z.string().min(1),
		verification: z.array(ReviewVerificationSchema).min(1),
		/**
		 * One row per document the reviewed repository requires to stay current —
		 * its README plus whatever its own contributor/agent guide names. Which
		 * documents those are is the repository's business, not SWARM's: this phase
		 * reviews any project SWARM manages, so nothing here names a path.
		 */
		docsChecked: z.array(ReviewDocCheckSchema).min(1),
		/** Conditions the reviewer found but that predate this PR, so they aren't charged to it. */
		preExisting: z.array(z.string().min(1)).default([]),
		findings: z.array(ReviewFindingSchema).default([]),
		/**
		 * Re-review only: what became of each finding an earlier pass raised. Anything
		 * not `resolved` must also be reported in `findings` under the same id
		 * ({@link checkCarriedItemsAreReported}), which is what keeps the disposition
		 * table and the verdict from contradicting each other.
		 */
		carried: z.array(ReviewCarriedSchema).default([]),
	})
	.superRefine((handoff, ctx) => {
		checkFindingTiers(handoff.findings, ctx);
		checkCarriedItemsAreReported(handoff.carried, handoff.findings, ctx);
		checkVerdictMatchesSeverities(handoff.verdict, handoff.findings, ctx);
	});

export type ReviewHandoff = z.infer<typeof ReviewHandoffSchema>;

/**
 * The pre-#470 hand-off shape, accepted **only** when resuming a delivery whose
 * worktree an older agent already wrote (`src/pipeline/review.ts`). A fresh run
 * must satisfy {@link ReviewHandoffSchema}; without this fallback an in-flight
 * half-delivered review would fail validation on every retry instead of
 * completing the submission it had already started.
 */
export const LegacyReviewHandoffSchema = z.object({
	verdict: z.enum(['approve', 'request-changes', 'comment']),
	body: z.string().min(1),
	findings: z
		.array(
			z.object({
				title: z.string().min(1),
				body: z.string().min(1),
				fixPlan: z.string().min(1),
			}),
		)
		.default([]),
});

export type LegacyReviewHandoff = z.infer<typeof LegacyReviewHandoffSchema>;

export const ReviewResponseHandoffSchema = z.object({
	outcome: z.enum(['fixed', 'pushed-back', 'no-findings']),
	body: z.string().min(1),
	commitSubject: z.string().min(1).max(200).optional(),
	verification: z.array(VerificationSchema).default([]),
});

export const CiResponseHandoffSchema = z.object({
	outcome: z.enum(['fixed', 'no-fix']),
	body: z.string().min(1),
	commitSubject: z.string().min(1).max(200).optional(),
	verification: z.array(VerificationSchema).default([]),
});

export const ConflictHandoffSchema = z.object({
	status: z.literal('resolved'),
	body: z.string().min(1),
	verification: z.array(VerificationSchema).min(1),
});

export const DeliveryProgressSchema = z.object({
	deliveryId: z.string(),
	commitSha: z.string().optional(),
	pushed: z.boolean().default(false),
	pullRequestNumber: z.number().int().positive().optional(),
	pullRequestUrl: z.string().url().optional(),
	reviewId: z.number().int().positive().optional(),
	commentId: z.number().int().positive().optional(),
	/**
	 * Whether the follow-up Review for a `fixed` Respond-to-review response has
	 * already been enqueued (issue #241) — checked before
	 * {@link ScheduleFollowUpReview} runs so a resumed delivery retry doesn't
	 * re-enqueue once the checkpoint is saved (the queue's own deterministic job
	 * id already absorbs a repeat in the narrower crash window before this is
	 * written).
	 */
	followUpEnqueued: z.boolean().default(false),
});
export type DeliveryProgress = z.infer<typeof DeliveryProgressSchema>;

export interface CreatePullRequestInput {
	baseBranch: string;
	branch: string;
	title: string;
	body: string;
}

export interface ScmDeliveryProvider {
	commitIdentity: { name: string; email: string };
	findPullRequest(branch: string): Promise<{ number: number; url: string } | undefined>;
	createPullRequest(input: CreatePullRequestInput): Promise<{ number: number; url: string }>;
	pushBranch(cwd: string, branch: string, expectedSha: string): Promise<void>;
	submitReview(input: {
		prNumber: number;
		verdict: z.infer<typeof ReviewHandoffSchema>['verdict'];
		body: string;
		deliveryId: string;
	}): Promise<number>;
	postComment(input: { prNumber: number; body: string; deliveryId: string }): Promise<number>;
}

export const HANDOFF_FILENAMES = {
	implementation: 'implementation_handoff.json',
	review: 'review_handoff.json',
	respondToReview: 'respond_to_review_handoff.json',
	respondToCi: 'respond_to_ci_handoff.json',
	resolveConflicts: 'resolve_conflicts_handoff.json',
} as const;

const PROGRESS_FILENAME = '.swarm_delivery.json';
const SCRATCH_PATHSPECS = [...Object.values(HANDOFF_FILENAMES), PROGRESS_FILENAME] as const;

export class DeliveryDeferredError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'DeliveryDeferredError';
	}
}

export function resumedDeliveryAgent(cli: AgentCli): AgentCliResult {
	return {
		cli,
		exitCode: 0,
		signal: null,
		stdout: '',
		stderr: '',
		durationMs: 0,
		timedOut: false,
		aborted: false,
		outputTruncated: false,
	};
}

// Input parameter widened to `unknown` (the parsed JSON is exactly that), so a
// schema carrying defaults or a `superRefine` — whose input type differs from its
// output — still infers `T` as the *output* type rather than collapsing to the
// looser input shape.
export function readHandoff<T>(
	cwd: string,
	filename: string,
	schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): T {
	const path = join(cwd, filename);
	if (!existsSync(path)) throw new Error(`Agent did not write required hand-off ${filename}`);
	try {
		return schema.parse(JSON.parse(readFileSync(path, 'utf8')));
	} catch (error) {
		throw new Error(
			`Invalid hand-off ${filename}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function deliveryIdentity(parts: readonly string[]): string {
	return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
}

export function loadDeliveryProgress(cwd: string, deliveryId: string): DeliveryProgress {
	const path = join(cwd, PROGRESS_FILENAME);
	if (!existsSync(path)) return { deliveryId, pushed: false, followUpEnqueued: false };
	const progress = DeliveryProgressSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
	if (progress.deliveryId !== deliveryId)
		throw new Error('Delivery progress belongs to another operation');
	return progress;
}

export function saveDeliveryProgress(cwd: string, progress: DeliveryProgress): void {
	writeFileSync(join(cwd, PROGRESS_FILENAME), `${JSON.stringify(progress, null, 2)}\n`, {
		mode: 0o600,
	});
}

export function hasDeliveryProgress(cwd: string): boolean {
	return existsSync(join(cwd, PROGRESS_FILENAME));
}

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync('git', args, { cwd, env: gitEnvironmentForCwd() });
	return stdout.trim();
}

export async function validatePreparedTree(cwd: string): Promise<void> {
	const unresolved = await git(cwd, ['diff', '--name-only', '--diff-filter=U']);
	if (unresolved) throw new Error(`Unsafe delivery: unresolved conflicts in ${unresolved}`);
	const status = await git(cwd, ['status', '--porcelain']);
	if (!status) throw new Error('Unsafe delivery: expected working-tree changes but found none');
	const trackedScratch = await git(cwd, ['ls-files', '--', ...SCRATCH_PATHSPECS]);
	if (trackedScratch)
		throw new Error(`Unsafe delivery: scratch artifact is tracked (${trackedScratch})`);
}

export async function commitPreparedTree(
	cwd: string,
	subject: string,
	identity: { name: string; email: string },
): Promise<string> {
	await validatePreparedTree(cwd);
	await git(cwd, ['add', '--all', '--', '.']);
	// `git add` treats an explicitly named ignored path as an error, even when it
	// is an exclude pathspec. Unstage hand-off files after adding instead.
	await git(cwd, ['reset', '--quiet', '--', ...SCRATCH_PATHSPECS]);
	const staged = await git(cwd, ['diff', '--cached', '--name-only']);
	if (!staged)
		throw new Error(
			'Unsafe delivery: no deliverable changes remain after excluding hand-off artifacts',
		);
	await git(cwd, [
		'-c',
		`user.name=${identity.name}`,
		'-c',
		`user.email=${identity.email}`,
		'commit',
		'--no-verify',
		'-m',
		subject,
	]);
	return git(cwd, ['rev-parse', 'HEAD']);
}

export async function assertRemoteHead(
	cwd: string,
	branch: string,
	expectedSha: string,
): Promise<void> {
	await git(cwd, ['fetch', 'origin', branch]);
	const remote = await git(cwd, ['rev-parse', `origin/${branch}`]);
	if (remote !== expectedSha)
		throw new Error(`Remote head drift for ${branch}: expected ${expectedSha}, found ${remote}`);
}
